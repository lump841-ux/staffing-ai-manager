const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const reporting = require('../services/reporting');
const discrepancyEngine = require('../services/discrepancy');
const ai = require('../services/ai');
const { requireRole } = require('../services/auth-middleware');
const router = express.Router();

router.use(requireRole('manager', 'owner'));

// ---- Today / Week dashboard ----

router.get('/today', async (req, res) => {
  const summary = await reporting.computeTodaySummary(req.session.user.organizationId, reporting.dateStr(new Date()));
  const openDiscrepancies = await discrepancyEngine.listOpen(req.session.user.organizationId, 'open');
  res.json({ ...summary, needsAttention: openDiscrepancies.length });
});

router.get('/week', async (req, res) => {
  const weekStart = req.query.start || reporting.mondayOf(reporting.dateStr(new Date()));
  const summary = await reporting.computeWeekSummary(req.session.user.organizationId, weekStart);
  res.json(summary);
});

// ---- Worker roster ----

router.get('/workers', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const workers = await reporting.getWorkers(orgId);
  const today = reporting.dateStr(new Date());
  const reports = await reporting.getReportsInRange(orgId, today, today);
  const out = workers.map((w) => ({
    id: w.id,
    name: w.name,
    email: w.email,
    avatarUrl: w.avatar_url || null,
    submittedToday: !!(reports[w.id] && reports[w.id][today]),
    todayTotal: reports[w.id] && reports[w.id][today] ? reports[w.id][today].total : 0,
  }));
  res.json(out);
});

router.get('/workers/:id', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const workerId = Number(req.params.id);
  const { rows } = await db.query(
    `SELECT id, name, email, avatar_url FROM users WHERE id = $1 AND organization_id = $2 AND role = 'worker'`,
    [workerId, orgId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Worker not found' });

  const today = reporting.dateStr(new Date());
  const start = reporting.addDays(today, -13);
  const reports = await reporting.getReportsInRange(orgId, start, today);
  const mine = reports[workerId] || {};
  const history = [];
  for (let i = 13; i >= 0; i--) {
    const d = reporting.addDays(today, -i);
    history.push({ date: d, total: mine[d] ? mine[d].total : null });
  }

  const categories = await reporting.getActiveCategories(orgId);
  const { rows: goalRows } = await db.query(`SELECT category_id, daily_target FROM worker_goals WHERE worker_id = $1`, [workerId]);
  const goalsByCat = {};
  for (const g of goalRows) goalsByCat[g.category_id] = g.daily_target;

  res.json({
    worker: rows[0],
    history,
    goals: categories.map((c) => ({ categoryId: c.id, key: c.key, label: c.label, target: goalsByCat[c.id] || 0 })),
  });
});

router.put('/workers/:id/goals', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const workerId = Number(req.params.id);
  const { goals } = req.body || {}; // [{categoryId, dailyTarget}]
  if (!Array.isArray(goals)) return res.status(400).json({ error: 'goals array is required' });

  const { rows } = await db.query(`SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = 'worker'`, [workerId, orgId]);
  if (!rows.length) return res.status(404).json({ error: 'Worker not found' });

  for (const g of goals) {
    await db.query(
      `INSERT INTO worker_goals (worker_id, category_id, daily_target, set_by_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (worker_id, category_id) DO UPDATE SET daily_target = $3, set_by_user_id = $4`,
      [workerId, g.categoryId, g.dailyTarget, req.session.user.id]
    );
  }
  res.json({ ok: true });
});

// ---- Category manager ----

router.get('/categories', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, key, label, description, sort_order, is_active FROM activity_categories
     WHERE organization_id = $1 ORDER BY sort_order, id`,
    [req.session.user.organizationId]
  );
  res.json(rows);
});

router.post('/categories', async (req, res) => {
  const { key, label, description, sortOrder } = req.body || {};
  if (!key || !label) return res.status(400).json({ error: 'key and label are required' });
  const cleanKey = String(key).toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
  const { rows } = await db.query(
    `INSERT INTO activity_categories (organization_id, key, label, description, sort_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.session.user.organizationId, cleanKey, label, description || null, sortOrder || 0]
  );
  res.json(rows[0]);
});

router.put('/categories/:id', async (req, res) => {
  const { label, description, sortOrder, isActive } = req.body || {};
  const { rows } = await db.query(
    `UPDATE activity_categories SET
       label = COALESCE($1, label),
       description = COALESCE($2, description),
       sort_order = COALESCE($3, sort_order),
       is_active = COALESCE($4, is_active)
     WHERE id = $5 AND organization_id = $6 RETURNING *`,
    [label, description, sortOrder, isActive, req.params.id, req.session.user.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Category not found' });
  res.json(rows[0]);
});

// ---- Manager-only time entry ----

router.get('/time-entries', async (req, res) => {
  const { workerId } = req.query;
  const params = [req.session.user.organizationId];
  let where = 'organization_id = $1';
  if (workerId) {
    params.push(Number(workerId));
    where += ` AND worker_id = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT te.id, te.worker_id, u.name as worker_name, te.entry_date, te.hours_worked, te.entry_type, te.notes
     FROM worker_time_entries te
     JOIN users u ON u.id = te.worker_id
     WHERE te.${where} ORDER BY te.entry_date DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

router.post('/time-entries', async (req, res) => {
  const { workerId, entryDate, hoursWorked, entryType, notes } = req.body || {};
  if (!workerId || !entryDate) return res.status(400).json({ error: 'workerId and entryDate are required' });

  const { rows: workerRows } = await db.query(
    `SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = 'worker'`,
    [workerId, req.session.user.organizationId]
  );
  if (!workerRows.length) return res.status(404).json({ error: 'Worker not found' });

  const { rows } = await db.query(
    `INSERT INTO worker_time_entries (organization_id, worker_id, entry_date, hours_worked, entry_type, notes, entered_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.session.user.organizationId, workerId, entryDate, hoursWorked || null, entryType || 'regular', notes || null, req.session.user.id]
  );
  res.json(rows[0]);
});

// ---- Needs review (discrepancies) ----

router.get('/discrepancies', async (req, res) => {
  const rows = await discrepancyEngine.listOpen(req.session.user.organizationId, req.query.status || null);
  res.json(rows);
});

router.put('/discrepancies/:id', async (req, res) => {
  const { status } = req.body || {};
  const valid = ['open', 'reviewed', 'correct', 'needs_correction', 'follow_up', 'resolved'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  const row = await discrepancyEngine.setStatus(req.session.user.organizationId, req.params.id, status, req.session.user.id);
  if (!row) return res.status(404).json({ error: 'Discrepancy not found' });
  res.json(row);
});

// ---- Friday final report ----

router.get('/friday-report', async (req, res) => {
  const weekStart = req.query.weekStart || reporting.mondayOf(reporting.dateStr(new Date()));
  const week = await reporting.computeWeekSummary(req.session.user.organizationId, weekStart);
  const exec = await ai.fridayExecutiveSummary(req.session.user.organizationId, weekStart);
  res.json({ week, executiveSummary: exec });
});

// ---- AI assistant ----

router.post('/ai/ask', async (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question is required' });
  const orgId = req.session.user.organizationId;
  const answer = await ai.answerQuestion(orgId, question);
  await db.query(`INSERT INTO ai_conversations (organization_id, user_id, role, message) VALUES ($1,$2,'user',$3)`, [orgId, req.session.user.id, question]);
  await db.query(`INSERT INTO ai_conversations (organization_id, user_id, role, message) VALUES ($1,$2,'assistant',$3)`, [orgId, req.session.user.id, answer.interpretation]);
  res.json({ ...answer, llmActive: ai.hasLLM() });
});

router.get('/ai/morning-briefing', async (req, res) => {
  res.json(await ai.morningBriefing(req.session.user.organizationId));
});

router.get('/ai/eod-briefing', async (req, res) => {
  res.json(await ai.endOfDayBriefing(req.session.user.organizationId, req.query.date));
});

// ---- Manager task center ----

router.get('/tasks', async (req, res) => {
  const { status } = req.query;
  const params = [req.session.user.organizationId];
  let where = 'organization_id = $1';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT t.id, t.title, t.notes, t.due_date, t.status, t.source, t.created_at, t.completed_at,
            u.name as related_worker_name
     FROM manager_tasks t
     LEFT JOIN users u ON u.id = t.related_worker_id
     WHERE t.${where} ORDER BY t.due_date NULLS LAST, t.created_at DESC`,
    params
  );
  res.json(rows);
});

router.post('/tasks', async (req, res) => {
  const { title, notes, dueDate, relatedWorkerId } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const { rows } = await db.query(
    `INSERT INTO manager_tasks (organization_id, manager_id, related_worker_id, title, notes, due_date)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.session.user.organizationId, req.session.user.id, relatedWorkerId || null, title, notes || null, dueDate || null]
  );
  res.json(rows[0]);
});

router.post('/tasks/parse', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  const workers = await reporting.getWorkers(req.session.user.organizationId);
  const parsed = ai.parseTaskFromText(text, workers);
  const { rows } = await db.query(
    `INSERT INTO manager_tasks (organization_id, manager_id, related_worker_id, title, due_date, source)
     VALUES ($1, $2, $3, $4, $5, 'ai_created') RETURNING *`,
    [req.session.user.organizationId, req.session.user.id, parsed.relatedWorkerId, parsed.title, parsed.dueDate]
  );
  res.json({ ...rows[0], related_worker_name: parsed.relatedWorkerName });
});

router.put('/tasks/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!['open', 'completed'].includes(status)) return res.status(400).json({ error: 'status must be open or completed' });
  const { rows } = await db.query(
    `UPDATE manager_tasks SET status = $1, completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE NULL END
     WHERE id = $2 AND organization_id = $3 RETURNING *`,
    [status, req.params.id, req.session.user.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json(rows[0]);
});

// ---- Manager daily debrief ----

router.post('/debrief', async (req, res) => {
  const { wentWell, problems, otherNotes } = req.body || {};
  const today = reporting.dateStr(new Date());
  const { rows } = await db.query(
    `INSERT INTO manager_debriefs (organization_id, manager_id, debrief_date, went_well, problems, other_notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (manager_id, debrief_date) DO UPDATE SET went_well = $4, problems = $5, other_notes = $6
     RETURNING *`,
    [req.session.user.organizationId, req.session.user.id, today, wentWell || null, problems || null, otherNotes || null]
  );
  res.json(rows[0]);
});

// ---- Photo proof review ----
// Verification can only ever be set here, never by the worker's own routes.

router.get('/activity-proofs', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const { status } = req.query;
  const params = [orgId];
  let where = 'ap.organization_id = $1';
  if (status) {
    params.push(status);
    where += ` AND ap.status = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT ap.id, ap.worker_id, u.name AS worker_name, ap.title, ap.note, ap.photo_data_url,
            ap.status, ap.submitted_at, ap.reviewed_at, ap.review_comment,
            ac.label AS category_label, r.name AS reviewed_by_name
     FROM activity_proofs ap
     JOIN users u ON u.id = ap.worker_id
     LEFT JOIN activity_categories ac ON ac.id = ap.category_id
     LEFT JOIN users r ON r.id = ap.reviewed_by_user_id
     WHERE ${where}
     ORDER BY ap.submitted_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

router.put('/activity-proofs/:id', async (req, res) => {
  const { status, comment } = req.body || {};
  const valid = ['verified', 'needs_review'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  const { rows } = await db.query(
    `UPDATE activity_proofs SET status = $1, review_comment = $2, reviewed_by_user_id = $3, reviewed_at = NOW()
     WHERE id = $4 AND organization_id = $5 RETURNING *`,
    [status, comment || null, req.session.user.id, req.params.id, req.session.user.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Submission not found' });
  res.json(rows[0]);
});

// ---- Agency settings ----
// Currently just the self clock-in switch. Any manager can view it;
// changing it is owner-only, since it's an org-wide policy decision.

router.get('/settings', async (req, res) => {
  const { rows } = await db.query(
    `SELECT self_clockin_enabled FROM organizations WHERE id = $1`,
    [req.session.user.organizationId]
  );
  res.json({ selfClockinEnabled: !!(rows[0] && rows[0].self_clockin_enabled) });
});

router.put('/settings', async (req, res) => {
  if (req.session.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the agency owner can change this setting.' });
  }
  const { selfClockinEnabled } = req.body || {};
  await db.query(
    `UPDATE organizations SET self_clockin_enabled = $1 WHERE id = $2`,
    [!!selfClockinEnabled, req.session.user.organizationId]
  );
  res.json({ ok: true, selfClockinEnabled: !!selfClockinEnabled });
});

// ---- Manager: create a worker account ----

router.post('/workers-new', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (organization_id, branch_id, role, name, email, password_hash)
       VALUES ($1, $2, 'worker', $3, $4, $5) RETURNING id, name, email`,
      [req.session.user.organizationId, req.session.user.branchId, name, email.toLowerCase().trim(), hash]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'A user with that email may already exist' });
  }
});

module.exports = router;
