// Agency Billing Dashboard — owner-only. Reads/writes are always scoped to
// req.session.user.organizationId, so one agency can never see or touch
// another agency's plan, invoices, or payment method.
const express = require('express');
const db = require('../services/db');
const billingSvc = require('../services/billing');
const { requireRole } = require('../services/auth-middleware');
const { getStripe, isConfigured, baseUrlFrom } = require('../services/stripe');
const router = express.Router();

router.use(requireRole('owner'));

router.get('/summary', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const { rows } = await db.query(
    `SELECT plan, plan_price_cents, billing_status, next_billing_date,
            payment_method_label, setup_fee_cents, setup_fee_waived, setup_fee_paid
     FROM organizations WHERE id = $1`,
    [orgId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Organization not found' });
  const org = rows[0];
  const plan = billingSvc.getPlan(org.plan) || { name: 'Legacy plan' };

  // Pricing has not been finalized yet, so nothing dollar-amount-bearing —
  // current price, invoices, or upgrade-option prices — is ever sent to the
  // client. Self-serve plan changes and invoicing stay disabled until the
  // owner decides what to charge.
  const upgradeOptions = billingSvc.listCheckoutPlans()
    .filter((p) => p.key !== org.plan)
    .map((p) => ({ key: p.key, name: p.name }));

  res.json({
    plan: org.plan,
    planName: plan.name || org.plan,
    billingStatus: org.billing_status,
    nextBillingDate: org.next_billing_date,
    paymentMethodLabel: org.payment_method_label,
    invoices: [],
    upgradeOptions,
  });
});

router.post('/upgrade', async (req, res) => {
  // Self-serve plan changes are disabled while pricing is still being
  // finalized — no plan/price update and no billing_events row are ever
  // written from this endpoint.
  res.status(400).json({ error: 'Plan changes aren’t available yet. Pricing hasn’t been finalized — check back soon.' });
});

// Hands the owner off to Stripe's own hosted Billing Portal — update card
// on file, view Stripe-side invoices, or cancel. Only works for agencies
// that actually have a stripe_customer_id (i.e. signed up through real
// Stripe Checkout); pre-Stripe/legacy demo orgs won't have one yet.
router.post('/portal', async (req, res) => {
  const orgId = req.session.user.organizationId;
  if (!isConfigured()) return res.status(503).json({ error: 'Payment processing is not configured on this server yet.' });

  const { rows } = await db.query(`SELECT stripe_customer_id FROM organizations WHERE id = $1`, [orgId]);
  if (!rows.length || !rows[0].stripe_customer_id) {
    return res.status(400).json({ error: 'No Stripe billing account on file yet for this agency.' });
  }

  try {
    const stripe = getStripe();
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: rows[0].stripe_customer_id,
      return_url: `${baseUrlFrom(req)}/dashboard/manager`,
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Stripe billing portal session failed:', err.message);
    res.status(502).json({ error: 'Could not open the billing portal right now.' });
  }
});

module.exports = router;
