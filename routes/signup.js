// Public (unauthenticated) routes that let a brand-new staffing agency
// discover Twanova, pick a plan, pay through real Stripe Checkout, and
// land inside their own fresh, fully isolated agency account — without any
// Twanova staff manually provisioning anything.
//
// Payment note: this server never collects or stores a raw card number.
// The signup wizard hands the browser off to Stripe-hosted Checkout, which
// takes the card directly. Only after Stripe confirms payment_status ===
// 'paid' (verified server-to-server via GET /confirm) does an
// organizations/users row ever get created — see pending_signups in
// schema.sql for the "waiting room" this sits in until then.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const billing = require('../services/billing');
const seed = require('../services/seed');
const { getStripe, isConfigured, baseUrlFrom } = require('../services/stripe');
const router = express.Router();

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function toSessionUser(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    branchId: row.branch_id,
    role: row.role,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url || null,
  };
}

router.get('/plans', async (req, res) => {
  res.json({
    plans: billing.listCheckoutPlans().map((p) => ({
      ...p,
      priceDisplay: billing.formatCents(p.priceCents),
      setupFeeDisplay: billing.formatCents(p.setupFeeCents),
    })),
  });
});

// Step 1 of real payment: validate everything the wizard collected, park it
// in pending_signups, and hand back a Stripe Checkout URL. No agency
// account exists yet — that only happens in GET /confirm once Stripe says
// the charge went through.
router.post('/agency', async (req, res) => {
  const {
    companyName,
    contactName,
    contactEmail,
    contactPhone,
    officeName,
    officeAddress,
    plan: planKey,
    password,
    tosAccepted,
    inviteToken,
  } = req.body || {};

  if (!companyName || !contactName || !isEmail(contactEmail) || !password) {
    return res.status(400).json({ error: 'Company name, contact name, a valid email, and a password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!tosAccepted) {
    return res.status(400).json({ error: 'You must accept the Terms of Service, Privacy Policy, and Subscription/Billing Terms to continue.' });
  }
  const plan = billing.getPlan(planKey);
  if (!plan || plan.contactSalesOnly) {
    return res.status(400).json({ error: 'Please choose Starter, Growth, or Professional to sign up directly. Enterprise is Contact Sales.' });
  }
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Payment processing is not configured on this server yet. Please contact Twanova.' });
  }

  const { rows: existing } = await db.query(`SELECT id FROM users WHERE email = $1`, [contactEmail.toLowerCase().trim()]);
  if (existing.length) {
    return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
  }

  // If this signup arrived via a client's "invite your staffing agency"
  // link, confirm the token is real and unclaimed before proceeding —
  // it gets re-checked (and actually consumed) again in GET /confirm,
  // this is just an early, friendly failure.
  let invite = null;
  if (inviteToken) {
    const { rows: inviteRows } = await db.query(
      `SELECT * FROM agency_invites WHERE token = $1 AND status = 'pending'`,
      [inviteToken]
    );
    if (!inviteRows.length) {
      return res.status(400).json({ error: 'This invite link is no longer valid. Ask the client to send a new one, or sign up without it.' });
    }
    invite = inviteRows[0];
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows: pendingRows } = await db.query(
    `INSERT INTO pending_signups
       (company_name, office_name, office_address, contact_name, contact_email, contact_phone, password_hash, plan, invite_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      companyName.trim(), (officeName || 'Main Office').trim(), officeAddress || null,
      contactName.trim(), contactEmail.toLowerCase().trim(), contactPhone || null, hash, plan.key,
      invite ? invite.token : null,
    ]
  );
  const pendingId = pendingRows[0].id;

  const base = baseUrlFrom(req);
  const stripe = getStripe();

  const lineItems = [
    {
      price_data: {
        currency: 'usd',
        product_data: { name: `${plan.name} — Twanova monthly subscription` },
        recurring: { interval: 'month' },
        unit_amount: plan.priceCents,
      },
      quantity: 1,
    },
  ];
  if (plan.setupFeeCents > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: `${plan.name} — one-time onboarding/configuration fee` },
        unit_amount: plan.setupFeeCents,
      },
      quantity: 1,
    });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: contactEmail.toLowerCase().trim(),
      line_items: lineItems,
      success_url: `${base}/signup.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/signup.html?canceled=1`,
      metadata: { pendingSignupId: String(pendingId), plan: plan.key },
      subscription_data: { metadata: { pendingSignupId: String(pendingId), plan: plan.key } },
    });
  } catch (err) {
    console.error('Stripe Checkout session creation failed:', err.message);
    return res.status(502).json({ error: 'Could not start checkout with Stripe. Please try again in a moment.' });
  }

  await db.query(`UPDATE pending_signups SET stripe_checkout_session_id = $1 WHERE id = $2`, [session.id, pendingId]);

  res.json({ ok: true, checkoutUrl: session.url });
});

// Step 2: the browser lands back here (via Stripe's success_url) carrying
// the Checkout Session id. We verify payment_status directly with Stripe
// (server-to-server, so this can't be spoofed by the client) before ever
// creating the organization. Idempotent — safe to call twice (page
// refresh) because it checks pending_signups.organization_id first.
router.get('/confirm', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing session_id.' });
  }
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Payment processing is not configured on this server yet.' });
  }
  const stripe = getStripe();

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
  } catch (err) {
    return res.status(400).json({ error: 'Could not verify this payment with Stripe.' });
  }
  if (session.payment_status !== 'paid') {
    return res.status(402).json({ error: 'Payment has not completed yet.' });
  }

  const pendingId = Number(session.metadata && session.metadata.pendingSignupId);
  const { rows: pendingRows } = await db.query(`SELECT * FROM pending_signups WHERE id = $1`, [pendingId]);
  if (!pendingRows.length) {
    return res.status(404).json({ error: 'We could not find this signup. Please contact Twanova.' });
  }
  const pending = pendingRows[0];

  // Already provisioned (refresh, or the webhook beat us to it) — just
  // sign the owner back in rather than creating a duplicate agency.
  if (pending.organization_id) {
    const { rows: ownerRows } = await db.query(
      `SELECT id, organization_id, branch_id, role, name, email, avatar_url
       FROM users WHERE organization_id = $1 AND role = 'owner' LIMIT 1`,
      [pending.organization_id]
    );
    if (ownerRows.length) {
      req.session.user = toSessionUser(ownerRows[0]);
      return res.json({ ok: true, user: req.session.user, redirectTo: '/dashboard/manager' });
    }
  }

  const plan = billing.getPlan(pending.plan);

  const subscription = session.subscription;
  const today = new Date().toISOString().slice(0, 10);
  const nextBilling = subscription && subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString().slice(0, 10)
    : billing.nextBillingDateFrom(today);

  const { rows: orgRows } = await db.query(
    // temp_chat_enabled is explicitly FALSE here — Temp Chat (the two-way
    // messaging upgrade) is off by default for brand-new agencies until they
    // pay for it; only a platform Super Admin can turn it on (see
    // routes/platform-admin.js). The schema-level default stays TRUE so
    // existing/demo orgs created before this feature keep working.
    `INSERT INTO organizations
       (name, plan, plan_price_cents, billing_status, is_founding_partner,
        setup_fee_cents, setup_fee_waived, setup_fee_paid, next_billing_date,
        payment_method_label, billing_contact_name, billing_email, signup_source,
        stripe_customer_id, stripe_subscription_id, temp_chat_enabled)
     VALUES ($1,$2,$3,'active',FALSE,$4,FALSE,TRUE,$5,$6,$7,$8,'self_signup',$9,$10,FALSE)
     RETURNING id`,
    [
      pending.company_name, plan.key, plan.priceCents,
      plan.setupFeeCents, nextBilling, 'Card on file via Stripe',
      pending.contact_name, pending.contact_email,
      session.customer || null, subscription ? subscription.id : null,
    ]
  );
  const orgId = orgRows[0].id;

  const { rows: branchRows } = await db.query(
    `INSERT INTO branches (organization_id, name, address) VALUES ($1,$2,$3) RETURNING id`,
    [orgId, pending.office_name || 'Main Office', pending.office_address || null]
  );
  const branchId = branchRows[0].id;

  const { rows: ownerRows } = await db.query(
    `INSERT INTO users (organization_id, branch_id, role, name, email, password_hash)
     VALUES ($1,$2,'owner',$3,$4,$5) RETURNING id, organization_id, branch_id, role, name, email, avatar_url`,
    [orgId, branchId, pending.contact_name, pending.contact_email, pending.password_hash]
  );
  const owner = ownerRows[0];

  let sortOrder = 0;
  for (const c of seed.DEFAULT_CATEGORIES) {
    await db.query(
      `INSERT INTO activity_categories (organization_id, key, label, description, sort_order)
       VALUES ($1,$2,$3,$4,$5)`,
      [orgId, c.key, c.label, c.description, sortOrder++]
    );
  }

  if (plan.setupFeeCents > 0) {
    await db.query(
      `INSERT INTO billing_events (organization_id, type, amount_cents, description, status)
       VALUES ($1,'setup_fee',$2,$3,'paid')`,
      [orgId, plan.setupFeeCents, `${plan.name} onboarding/configuration fee`]
    );
  }
  await db.query(
    `INSERT INTO billing_events (organization_id, type, amount_cents, description, status)
     VALUES ($1,'subscription_charge',$2,$3,'paid')`,
    [orgId, plan.priceCents, `${plan.name} — first month`]
  );

  await db.query(
    `UPDATE pending_signups SET organization_id = $1, consumed_at = NOW() WHERE id = $2`,
    [orgId, pending.id]
  );

  // Claim the invite, if this signup arrived via a client's "invite your
  // staffing agency" link. Re-checks status = 'pending' here (not just in
  // POST /agency) so a token can never be claimed twice even if two
  // checkout sessions race. Creates a client_companies row for the new
  // agency (their own operational record for this client — locations,
  // bill rates, assignments all live under their own org, same as any
  // other client) and grants the ORIGINAL inviting contact's existing
  // login visibility into it via client_contact_org_links — no duplicate
  // account, no second password.
  if (pending.invite_token) {
    const { rows: inviteRows } = await db.query(
      `SELECT * FROM agency_invites WHERE token = $1 AND status = 'pending'`,
      [pending.invite_token]
    );
    if (inviteRows.length) {
      const invite = inviteRows[0];
      const { rows: clientCoRows } = await db.query(
        `SELECT name FROM client_companies WHERE id = $1`,
        [invite.inviting_client_company_id]
      );
      const clientName = clientCoRows.length ? clientCoRows[0].name : 'Connected client';

      const { rows: newClientCoRows } = await db.query(
        `INSERT INTO client_companies (organization_id, name, notes) VALUES ($1,$2,$3) RETURNING id`,
        [orgId, clientName, 'Connected via client-initiated Twanova invite.']
      );
      const newClientCompanyId = newClientCoRows[0].id;

      await db.query(
        `INSERT INTO client_contact_org_links (client_contact_id, organization_id, client_company_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [invite.inviting_client_contact_id, orgId, newClientCompanyId]
      );

      await db.query(
        `UPDATE agency_invites SET status = 'claimed', claimed_by_organization_id = $1, claimed_at = NOW() WHERE id = $2`,
        [orgId, invite.id]
      );
      await db.query(
        `UPDATE organizations SET connected_via_invite_id = $1 WHERE id = $2`,
        [invite.id, orgId]
      );
    }
  }

  req.session.user = toSessionUser(owner);

  res.json({
    ok: true,
    user: req.session.user,
    organization: { id: orgId, name: pending.company_name, plan: plan.key },
    redirectTo: '/dashboard/manager',
  });
});

router.post('/enterprise-lead', async (req, res) => {
  const { company, contactName, email, phone, officeCount, employeeCount, requirements } = req.body || {};
  if (!company || !contactName || !isEmail(email)) {
    return res.status(400).json({ error: 'Company, contact name, and a valid email are required.' });
  }
  const { rows } = await db.query(
    `INSERT INTO enterprise_leads (company, contact_name, email, phone, office_count, employee_count, requirements)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [company.trim(), contactName.trim(), email.toLowerCase().trim(), phone || null, officeCount || null, employeeCount || null, requirements || null]
  );
  res.json({ ok: true, id: rows[0].id });
});

module.exports = router;
