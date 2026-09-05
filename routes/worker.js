// Worker-only routes. These queries are ALWAYS scoped to req.session.user.id
// for the worker's own data — there is no code path here that can read
// another worker's numbers or any manager-only table (worker_time_entries
// is never imported or queried in this file at all).
const express = require('express');
const db = require('../services/db');
const reporting = require('../services/reporting');
const discrepancyEngine = require('../services/discrepancy');
const { requireRole } = require('../services/auth-middleware');
const router = express.Router();

router.use(requireRole('worker'));

router.get('/today', async (req, res) => {
  const workerId = req.session.user.id;
  const orgId = req.session.user.organizationId;
  const today = reporting.dateStr(new Date());

  const categories = await reporting.getActiveCategories(orgId);
  const { rows: goalRows } = await db.query(
    `SELECT category_id, daily_target FROM worker_goals WHERE worker_id = $1`,
    [workerId]
  );
  const goals = {};
  for (const g of goalRows) goals[g.category_id] = g.daily_target;

  const { rows: reportRows } = await db.query(
    `SELECT dr.id, dr.notes, dr.obstacles, drv.category_id, drv.value
     FROM daily_reports dr
     LEFT JOIN daily_report_values drv ON drv.daily_report_id = dr.id
     WHERE dr.worker_id = $1 AND dr.report_date = $2`,
    [workerId, today]
  );

  const submittedValues = {};
  let alreadySubmitted = false;
  let notes = '';
  let obstacles = '';
  for (const r of reportRows) {
    alreadySubmitted = true;
    notes = r.notes || '';
    obstacles = r.obstacles || '';
    if (r.category_id != null) submittedValues[r.category_id] = r.value;
  }

  res.json({
    date: today,
    alreadySubmitted,
    notes,
    obstacles,
    categories: categories.map((c) => ({
      id: c.id,
      key: c.key,
      label: c.label,
      target: goals[c.id] || 0,
      value: submittedValues[c.id] != null ? submittedValues[c.id] : null,
    })),
  });
});

router.post('/submit', async (req, res) => {
  const workerId = req.session.user.id;
  const orgId = req.session.user.organizationId;
  const today = reporting.dateStr(new Date());
  const { values, notes, obstacles } = req.body || {};

  if (!values || typeof values !== 'object') return res.status(400).json({ error: 'values object is required' });

  const categories = await reporting.getActiveCategories(orgId);
  const validIds = new Set(categories.map((c) => c.id));

  for (const [catId, v] of Object.entries(values)) {
    if (!validIds.has(Number(catId))) return res.status(400).json({ error: `Unknown category id ${catId}` });
    if (typeof v !== 'number' || v < 0 || !Number.isFinite(v)) return res.status(400).json({ error: 'Values must be non-negative numbers' });
  }

  const { rows } = await db.query(
    `INSERT INTO daily_reports (organization_id, worker_id, report_date, notes, obstacles)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (worker_id, report_date) DO UPDATE SET notes = $4, obstacles = $5, submitted_at = NOW()
     RETURNING id`,
    [orgId, workerId, today, notes || null, obstacles || null]
  );
  const reportId = rows[0].id;

  await db.query(`DELETE FROM daily_report_values WHERE daily_report_id = $1`, [reportId]);
  for (const [catId, v] of Object.entries(values)) {
    await db.query(
      `INSERT INTO daily_report_values (daily_report_id, category_id, value) VALUES ($1, $2, $3)`,
      [reportId, Number(catId), v]
    );
  }

  const valuesByCategoryId = {};
  for (const [catId, v] of Object.entries(values)) valuesByCategoryId[Number(catId)] = v;
  await discrepancyEngine.runChecks(orgId, reportId, workerId, today, valuesByCategoryId);

  res.json({ ok: true });
});

// Profile photo upload. Client resizes/compresses to a small JPEG data URL
// before sending, so this just validates shape/size and stores it — no
// external file storage needed for the demo (works fine with pg-mem too).
router.post('/avatar', async (req, res) => {
  const workerId = req.session.user.id;
  const { dataUrl } = req.body || {};
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) {
    return res.status(400).json({ error: 'Please upload a PNG, JPEG, or WebP image.' });
  }
  if (dataUrl.length > 900 * 1024) {
    return res.status(400).json({ error: 'That image is too large. Try a smaller photo.' });
  }
  await db.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [dataUrl, workerId]);
  req.session.user.avatarUrl = dataUrl;
  res.json({ ok: true, avatarUrl: dataUrl });
});

router.get('/history', async (req, res) => {
  const workerId = req.session.user.id;
  const orgId = req.session.user.organizationId;
  const today = reporting.dateStr(new Date());
  const start = reporting.addDays(today, -13);
  const all = await reporting.getReportsInRange(orgId, start, today);
  const mine = all[workerId] || {};
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = reporting.addDays(today, -i);
    days.push({ date: d, total: mine[d] ? mine[d].total : null });
  }
  res.json({ days });
});

module.exports = router;
