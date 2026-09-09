// Agency Billing Dashboard — owner-only. Reads/writes are always scoped to
// req.session.user.organizationId, so one agency can never see or touch
// another agency's plan, invoices, or payment method.
const express = require('express');
const db = require('../services/db');
const billingSvc = require('../services/billing');
const { requireRole } = require('../services/auth-middleware');
const router = express.Router();

router.use(requireRole('owner'));

router.get('/summary', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const { rows } = await db.query(
    `SELECT plan, plan_price_cents, billing_status, is_founding_partner, next_billing_date,
            payment_method_label, setup_fee_cents, setup_fee_waived, setup_fee_paid
     FROM organizations WHERE id = $1`,
    [orgId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Organization not found' });
  const org = rows[0];
  const plan = billingSvc.getPlan(org.plan) || { name: 'Legacy plan' };

  const { rows: invoices } = await db.query(
    `SELECT type, amount_cents, description, status, created_at
     FROM billing_events WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [orgId]
  );

  const upgradeOptions = billingSvc.listCheckoutPlans()
    .filter((p) => p.priceCents > (org.plan_price_cents || 0))
    .map((p) => ({ key: p.key, name: p.name, priceDisplay: billingSvc.formatCents(p.priceCents) }));

  res.json({
    plan: org.plan,
    planName: plan.name || org.plan,
    priceDisplay: billingSvc.formatCents(org.plan_price_cents),
    billingStatus: org.billing_status,
    isFoundingPartner: org.is_founding_partner,
    nextBillingDate: org.next_billing_date,
    paymentMethodLabel: org.payment_method_label,
    setupFeeDisplay: billingSvc.formatCents(org.setup_fee_cents),
    setupFeeWaived: org.setup_fee_waived,
    setupFeePaid: org.setup_fee_paid,
    invoices,
    upgradeOptions,
  });
});

router.post('/upgrade', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const { plan: planKey } = req.body || {};
  const plan = billingSvc.getPlan(planKey);
  if (!plan || plan.contactSalesOnly) return res.status(400).json({ error: 'Not a self-serve plan.' });

  const { rows } = await db.query(`SELECT plan, is_founding_partner FROM organizations WHERE id = $1`, [orgId]);
  if (!rows.length) return res.status(404).json({ error: 'Organization not found' });

  // Upgrading off Founding permanently gives up the locked-in rate, same
  // as real subscription products — worth a clear signal in the ledger.
  const wasFounding = rows[0].is_founding_partner;
  await db.query(
    `UPDATE organizations SET plan = $1, plan_price_cents = $2, is_founding_partner = FALSE
     WHERE id = $3`,
    [plan.key, plan.priceCents, orgId]
  );
  await db.query(
    `INSERT INTO billing_events (organization_id, type, amount_cents, description, status)
     VALUES ($1,'plan_change',$2,$3,'paid')`,
    [orgId, plan.priceCents, `Changed plan to ${plan.name}${wasFounding ? ' (gave up Founding Partner rate)' : ''}`]
  );
  res.json({ ok: true, plan: plan.key });
});

module.exports = router;
