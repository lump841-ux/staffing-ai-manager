// Twanova's own Super Admin area — for the platform operator, never for
// a staffing agency. Auth lives in platform_admins, a table completely
// separate from the agency users table; nothing here is reachable by an
// agency owner/manager/worker session.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const billing = require('../services/billing');
const { requirePlatformAdmin } = require('../services/platform-auth');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const { rows } = await db.query(`SELECT * FROM platform_admins WHERE email = $1`, [email.toLowerCase().trim()]);
  const admin = rows[0];
  if (!admin) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.platformAdmin = { id: admin.id, name: admin.name, email: admin.email };
  res.json({ ok: true, admin: req.session.platformAdmin });
});

router.post('/logout', (req, res) => {
  delete req.session.platformAdmin;
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.platformAdmin) return res.status(401).json({ error: 'Not signed in' });
  res.json(req.session.platformAdmin);
});

router.use(requirePlatformAdmin);

router.get('/overview', async (req, res) => {
  const { rows: agencies } = await db.query(
    `SELECT id, name, plan, plan_price_cents, billing_status,
            setup_fee_cents, setup_fee_waived, setup_fee_paid, signup_source, created_at
     FROM organizations ORDER BY created_at DESC`
  );

  const totalAgencies = agencies.length;
  const activeSubs = agencies.filter((a) => a.billing_status === 'active' || a.billing_status === 'trialing').length;
  const canceled = agencies.filter((a) => a.billing_status === 'canceled').length;
  const pastDue = agencies.filter((a) => a.billing_status === 'past_due').length;
  const suspended = agencies.filter((a) => a.billing_status === 'suspended').length;
  const mrrCents = agencies
    .filter((a) => a.billing_status === 'active' || a.billing_status === 'trialing')
    .reduce((sum, a) => sum + (a.plan_price_cents || 0), 0);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const newSignups30d = agencies.filter((a) => new Date(a.created_at) >= thirtyDaysAgo).length;

  const { rows: setupFeeRows } = await db.query(
    `SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'setup_fee' AND status = 'paid'), 0)::int AS collected_cents,
       COUNT(*) FILTER (WHERE type = 'setup_fee' AND status = 'waived')::int AS waived_count
     FROM billing_events`
  );

  res.json({
    totalAgencies,
    activeSubscriptions: activeSubs,
    mrrDisplay: billing.formatCents(mrrCents),
    newSignups30d,
    canceled,
    pastDue,
    suspended,
    setupFeesCollectedDisplay: billing.formatCents(setupFeeRows[0].collected_cents),
    setupFeesWaivedCount: setupFeeRows[0].waived_count,
  });
});

router.get('/agencies', async (req, res) => {
  // Note: counts are fetched separately and merged in JS rather than as
  // correlated subqueries in the SELECT list — pg-mem (the in-memory dev DB)
  // doesn't reliably support correlated subqueries referencing the outer
  // table alias, which was crashing this route. Two extra round trips is a
  // fine tradeoff for a Super Admin listing that isn't hit on a hot path.
  const { rows: orgs } = await db.query(
    `SELECT id, name, plan, plan_price_cents, billing_status,
            setup_fee_cents, setup_fee_waived, setup_fee_paid, signup_source, next_billing_date,
            created_at
     FROM organizations
     ORDER BY created_at DESC`
  );
  const { rows: officeCounts } = await db.query(
    `SELECT organization_id, COUNT(*)::int AS n FROM branches GROUP BY organization_id`
  );
  const { rows: userCounts } = await db.query(
    `SELECT organization_id, COUNT(*)::int AS n FROM users GROUP BY organization_id`
  );
  const officeMap = new Map(officeCounts.map((r) => [r.organization_id, r.n]));
  const userMap = new Map(userCounts.map((r) => [r.organization_id, r.n]));
  const rows = orgs.map((o) => ({
    ...o,
    office_count: officeMap.get(o.id) || 0,
    user_count: userMap.get(o.id) || 0,
  }));
  res.json(rows);
});

router.get('/agencies/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.query(`SELECT * FROM organizations WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Agency not found' });
  const org = rows[0];

  const { rows: officeCount } = await db.query(`SELECT COUNT(*)::int AS n FROM branches WHERE organization_id = $1`, [id]);
  const { rows: userCounts } = await db.query(
    `SELECT role, COUNT(*)::int AS n FROM users WHERE organization_id = $1 GROUP BY role`, [id]
  );
  const { rows: invoices } = await db.query(
    `SELECT * FROM billing_events WHERE organization_id = $1 ORDER BY created_at DESC`, [id]
  );

  res.json({
    organization: org,
    officeCount: officeCount[0].n,
    userCountsByRole: userCounts,
    invoices,
  });
});

router.post('/agencies/:id/waive-setup-fee', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.query(
    `UPDATE organizations SET setup_fee_waived = TRUE, setup_fee_paid = FALSE WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agency not found' });
  await db.query(
    `INSERT INTO billing_events (organization_id, type, amount_cents, description, status, created_by_admin_id)
     VALUES ($1,'waiver',0,'Onboarding/configuration fee waived by Super Admin','waived',$2)`,
    [id, req.session.platformAdmin.id]
  );
  res.json(rows[0]);
});

router.post('/agencies/:id/promo-price', async (req, res) => {
  const id = Number(req.params.id);
  const { priceCents } = req.body || {};
  if (!Number.isFinite(priceCents) || priceCents < 0) return res.status(400).json({ error: 'priceCents must be a non-negative number' });
  const { rows } = await db.query(
    `UPDATE organizations SET plan_price_cents = $1 WHERE id = $2 RETURNING *`,
    [priceCents, id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agency not found' });
  await db.query(
    `INSERT INTO billing_events (organization_id, type, amount_cents, description, status, created_by_admin_id)
     VALUES ($1,'plan_change',$2,'Promotional pricing applied by Super Admin','paid',$3)`,
    [id, priceCents, req.session.platformAdmin.id]
  );
  res.json(rows[0]);
});

router.post('/agencies/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const valid = ['trialing', 'active', 'past_due', 'canceled', 'suspended'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  const { rows } = await db.query(
    `UPDATE organizations SET billing_status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agency not found' });
  res.json(rows[0]);
});

router.post('/agencies/:id/plan', async (req, res) => {
  const id = Number(req.params.id);
  const { plan: planKey } = req.body || {};
  const plan = billing.getPlan(planKey);
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });
  const { rows } = await db.query(
    `UPDATE organizations SET plan = $1, plan_price_cents = $2 WHERE id = $3 RETURNING *`,
    [plan.key, plan.priceCents || 0, id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agency not found' });
  res.json(rows[0]);
});

// Temp Chat is the paid two-way messaging upgrade (temp <-> recruiter/lead
// <-> client). No real billing is wired up for it yet — the Super Admin
// flips this manually per agency until pricing is finalized.
router.post('/agencies/:id/temp-chat', async (req, res) => {
  const id = Number(req.params.id);
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  const { rows } = await db.query(
    `UPDATE organizations SET temp_chat_enabled = $1 WHERE id = $2 RETURNING *`,
    [enabled, id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Agency not found' });
  res.json(rows[0]);
});

router.get('/enterprise-leads', async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM enterprise_leads ORDER BY created_at DESC`);
  res.json(rows);
});

router.put('/enterprise-leads/:id', async (req, res) => {
  const { status } = req.body || {};
  const valid = ['new', 'contacted', 'closed'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  const { rows } = await db.query(
    `UPDATE enterprise_leads SET status = $1 WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
  res.json(rows[0]);
});

module.exports = router;
