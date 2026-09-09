// Public (unauthenticated) routes that let a brand-new staffing agency
// discover Only A Job, pick a plan, "pay", and land inside their own
// fresh, fully isolated agency account — without any Only A Job staff
// manually provisioning anything.
//
// Payment note: no real card-processor integration is wired up in this
// environment (no Stripe keys configured). This route never accepts or
// stores a raw card number — the checkout UI only ever sends a demo
// payment-method label (e.g. "Visa •••• 4242"), the same shape a real
// Stripe Elements / Payment Element token would collapse to client-side.
// Swapping in real Stripe later means: create a PaymentIntent/Subscription
// here instead of trusting the client-sent label, everything else
// (org creation, seat provisioning, billing_events ledger) stays the same.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const billing = require('../services/billing');
const seed = require('../services/seed');
const router = express.Router();

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

router.get('/plans', async (req, res) => {
  const remaining = await billing.foundingSlotsRemaining();
  res.json({
    plans: billing.listCheckoutPlans().map((p) => ({
      ...p,
      priceDisplay: billing.formatCents(p.priceCents),
      setupFeeDisplay: billing.formatCents(p.setupFeeCents),
      slotsRemaining: p.key === 'founding' ? remaining : null,
    })),
    foundingSlotsRemaining: remaining,
  });
});

// Step-by-step wizard posts everything at once on final submit; the
// client is responsible for the multi-screen UX (Company -> Contact ->
// Billing -> Review). This endpoint does the actual provisioning.
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
    paymentMethodLabel,
    tosAccepted,
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
    return res.status(400).json({ error: 'Please choose Founding, Growth, or Professional to sign up directly. Enterprise is Contact Sales.' });
  }

  const { rows: existing } = await db.query(`SELECT id FROM users WHERE email = $1`, [contactEmail.toLowerCase().trim()]);
  if (existing.length) {
    return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
  }

  let isFounding = false;
  if (plan.key === 'founding') {
    const remaining = await billing.foundingSlotsRemaining();
    if (remaining <= 0) {
      return res.status(409).json({ error: 'All Founding Agency spots are taken. Please choose Growth or Professional instead.' });
    }
    isFounding = true;
  }

  const today = new Date().toISOString().slice(0, 10);
  const nextBilling = billing.nextBillingDateFrom(today);
  const cardLabel = typeof paymentMethodLabel === 'string' && paymentMethodLabel.trim()
    ? paymentMethodLabel.trim()
    : 'Demo card on file';

  const { rows: orgRows } = await db.query(
    `INSERT INTO organizations
       (name, plan, plan_price_cents, billing_status, is_founding_partner,
        setup_fee_cents, setup_fee_waived, setup_fee_paid, next_billing_date,
        payment_method_label, billing_contact_name, billing_email, signup_source)
     VALUES ($1,$2,$3,'active',$4,$5,FALSE,TRUE,$6,$7,$8,$9,'self_signup')
     RETURNING id`,
    [
      companyName.trim(), plan.key, plan.priceCents, isFounding,
      plan.setupFeeCents, nextBilling, cardLabel, contactName.trim(), contactEmail.toLowerCase().trim(),
    ]
  );
  const orgId = orgRows[0].id;

  const { rows: branchRows } = await db.query(
    `INSERT INTO branches (organization_id, name, address) VALUES ($1,$2,$3) RETURNING id`,
    [orgId, (officeName || 'Main Office').trim(), officeAddress || null]
  );
  const branchId = branchRows[0].id;

  const hash = await bcrypt.hash(password, 10);
  const { rows: ownerRows } = await db.query(
    `INSERT INTO users (organization_id, branch_id, role, name, email, password_hash)
     VALUES ($1,$2,'owner',$3,$4,$5) RETURNING id, organization_id, branch_id, role, name, email, avatar_url`,
    [orgId, branchId, contactName.trim(), contactEmail.toLowerCase().trim(), hash]
  );
  const owner = ownerRows[0];

  // Seed the same default reporting categories every demo org gets, so a
  // brand-new agency's dashboard isn't empty on first login.
  let sortOrder = 0;
  for (const c of seed.DEFAULT_CATEGORIES) {
    await db.query(
      `INSERT INTO activity_categories (organization_id, key, label, description, sort_order)
       VALUES ($1,$2,$3,$4,$5)`,
      [orgId, c.key, c.label, c.description, sortOrder++]
    );
  }

  // Billing ledger: setup fee (paid today, since this is a demo checkout —
  // real Stripe would only paid=TRUE after webhook confirmation) + first
  // month's subscription charge.
  await db.query(
    `INSERT INTO billing_events (organization_id, type, amount_cents, description, status)
     VALUES ($1,'setup_fee',$2,$3,'paid')`,
    [orgId, plan.setupFeeCents, `${plan.name} onboarding/configuration fee`]
  );
  await db.query(
    `INSERT INTO billing_events (organization_id, type, amount_cents, description, status)
     VALUES ($1,'subscription_charge',$2,$3,'paid')`,
    [orgId, plan.priceCents, `${plan.name} — first month`]
  );

  req.session.user = {
    id: owner.id,
    organizationId: owner.organization_id,
    branchId: owner.branch_id,
    role: owner.role,
    name: owner.name,
    email: owner.email,
    avatarUrl: owner.avatar_url || null,
  };

  res.json({
    ok: true,
    user: req.session.user,
    organization: { id: orgId, name: companyName.trim(), plan: plan.key, isFoundingPartner: isFounding },
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
