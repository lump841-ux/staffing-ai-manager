const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const reporting = require('../services/reporting');
const discrepancyEngine = require('../services/discrepancy');
const ai = require('../services/ai');
const comms = require('../services/assignment-comms');
const { requireRole } = require('../services/auth-middleware');
const router = express.Router();

router.use(requireRole('manager', 'owner'));

// Temp/assignment/client-company data (the Assignment Communication
// Network) is owner-only for now. Leads ("manager" role) and Recruiters
// only see recruiter/workforce data. This can become a paid upgrade for
// Leads later — for now it's a flat 403.
function requireOwner(req, res, next) {
  if (req.session.user.role !== 'owner') {
    return res.status(403).json({ error: 'This is only available to the agency owner right now.' });
  }
  next();
}

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

// ════════════════════════════════════════════════════════════════════
// ASSIGNMENT COMMUNICATION NETWORK — manager/owner side.
// Client companies, assignments, the "what needs attention?" feed
// (spec §22), and per-agency contact routing configuration.
// ════════════════════════════════════════════════════════════════════

// ---- Temps ----
// The "temp" account type. NOT the same account as the "worker" role
// above, which is now labeled "Recruiter" (they track their own daily
// numbers — Contracts, Meetings, etc.). A Temp is the person the agency
// actually sends out
// to a client company's job site — they only exist to be assigned shifts
// and use the Assignment Communication Network. The manager/owner creates
// their login here, the same way client contacts are created below — no
// self-signup.

router.get('/temps', requireOwner, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, email, phone, avatar_url, active, created_at FROM users
     WHERE organization_id = $1 AND role = 'temp' ORDER BY name ASC`,
    [req.session.user.organizationId]
  );
  res.json(rows);
});

router.post('/temps-new', requireOwner, async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (organization_id, branch_id, role, name, email, phone, password_hash)
       VALUES ($1, $2, 'temp', $3, $4, $5, $6) RETURNING id, name, email, phone`,
      [req.session.user.organizationId, req.session.user.branchId, name, email.toLowerCase().trim(), phone || null, hash]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'A user with that email may already exist' });
  }
});

// ---- Client companies & locations ----

// Billing/pricing fields are owner-only. Strip them out of any response
// unless the requesting session is role === 'owner'. Server-side, not just
// hidden in the UI — a manager session can never receive these values.
const CLIENT_BILLING_FIELDS = ['bill_rate_hourly', 'pay_rate_hourly', 'contract_value', 'billing_notes'];
function scrubBillingFields(row, req) {
  if (!row) return row;
  if (req.session.user.role === 'owner') return row;
  const clean = { ...row };
  for (const f of CLIENT_BILLING_FIELDS) delete clean[f];
  return clean;
}

router.get('/client-companies', requireOwner, async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM client_companies WHERE organization_id = $1 ORDER BY name ASC`,
    [req.session.user.organizationId]
  );
  res.json(rows.map((r) => scrubBillingFields(r, req)));
});

router.post('/client-companies', requireOwner, async (req, res) => {
  const { name, notes } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const { rows } = await db.query(
    `INSERT INTO client_companies (organization_id, name, notes) VALUES ($1,$2,$3) RETURNING *`,
    [req.session.user.organizationId, name.trim(), notes || null]
  );
  res.json(scrubBillingFields(rows[0], req));
});

router.get('/client-companies/:id', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const { rows: companyRows } = await db.query(
    `SELECT * FROM client_companies WHERE organization_id = $1 AND id = $2`, [orgId, req.params.id]
  );
  if (!companyRows.length) return res.status(404).json({ error: 'Client company not found' });
  const { rows: locations } = await db.query(
    `SELECT * FROM client_locations WHERE organization_id = $1 AND client_company_id = $2 ORDER BY name ASC`,
    [orgId, req.params.id]
  );
  const { rows: contacts } = await db.query(
    `SELECT id, name, email, phone, role, active, created_at FROM client_contacts
     WHERE organization_id = $1 AND client_company_id = $2 ORDER BY name ASC`,
    [orgId, req.params.id]
  );
  res.json({ ...scrubBillingFields(companyRows[0], req), locations, contacts });
});

// Owner-only: set/update what the agency bills this client. requireRole
// above the router already limits this file to manager+owner sessions, so
// enforce owner specifically here.
router.put('/client-companies/:id/billing', async (req, res) => {
  if (req.session.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can view or edit client billing information' });
  }
  const orgId = req.session.user.organizationId;
  const { billRateHourly, payRateHourly, contractValue, billingNotes } = req.body || {};
  const { rows } = await db.query(
    `UPDATE client_companies
     SET bill_rate_hourly = $1, pay_rate_hourly = $2, contract_value = $3, billing_notes = $4
     WHERE organization_id = $5 AND id = $6 RETURNING *`,
    [billRateHourly || null, payRateHourly || null, contractValue || null, billingNotes || null, orgId, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Client company not found' });
  res.json(rows[0]);
});

router.post('/client-companies/:id/locations', requireOwner, async (req, res) => {
  const { name, address } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const { rows } = await db.query(
    `INSERT INTO client_locations (organization_id, client_company_id, name, address) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.session.user.organizationId, req.params.id, name.trim(), address || null]
  );
  res.json(rows[0]);
});

// Creates a client-side login (supervisor or HR). Password is set here by
// the agency and should be handed to the client contact out of band —
// there's no self-signup path for client contacts, by design.
router.post('/client-companies/:id/contacts', requireOwner, async (req, res) => {
  const { name, email, phone, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  const roleValue = role === 'client_hr' ? 'client_hr' : 'client_supervisor';
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await db.query(
      `INSERT INTO client_contacts (organization_id, client_company_id, role, name, email, phone, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, email, phone, role, active, created_at`,
      [req.session.user.organizationId, req.params.id, roleValue, name, email.toLowerCase().trim(), phone || null, hash]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'A contact with that email may already exist' });
  }
});

// ---- Assignments ----

router.get('/assignments', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const { date, status } = req.query;
  const clauses = ['a.organization_id = $1'];
  const params = [orgId];
  if (date) { params.push(date); clauses.push(`a.shift_date = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`a.status = $${params.length}`); }

  const { rows } = await db.query(
    `SELECT a.*, w.name AS worker_name, cc.name AS client_company_name, cl.name AS client_location_name
     FROM assignments a
     JOIN users w ON w.id = a.worker_id
     JOIN client_companies cc ON cc.id = a.client_company_id
     LEFT JOIN client_locations cl ON cl.id = a.client_location_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY a.shift_date DESC, a.start_time ASC LIMIT 300`,
    params
  );
  res.json(rows);
});

router.post('/assignments', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const {
    workerId, clientCompanyId, clientLocationId, department, supervisorContactId,
    agencyContactUserId, shiftDate, startTime, endTime, notes,
  } = req.body || {};

  if (!workerId || !clientCompanyId || !shiftDate || !startTime || !endTime) {
    return res.status(400).json({ error: 'workerId, clientCompanyId, shiftDate, startTime, and endTime are required' });
  }

  const { rows: tempCheck } = await db.query(
    `SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = 'temp'`,
    [workerId, orgId]
  );
  if (!tempCheck.length) return res.status(400).json({ error: 'workerId must be an existing temp' });

  const { rows } = await db.query(
    `INSERT INTO assignments
       (organization_id, worker_id, client_company_id, client_location_id, department,
        supervisor_contact_id, agency_contact_user_id, shift_date, start_time, end_time, notes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [orgId, workerId, clientCompanyId, clientLocationId || null, department || null,
      supervisorContactId || null, agencyContactUserId || req.session.user.id, shiftDate, startTime, endTime,
      notes || null, req.session.user.id]
  );
  const assignment = await comms.getAssignment(orgId, rows[0].id);

  await db.query(
    `INSERT INTO notifications (organization_id, recipient_type, recipient_id, title, body, link, assignment_id)
     VALUES ($1,'worker',$2,$3,$4,$5,$6)`,
    [orgId, workerId, `New assignment: ${assignment.client_company_name}`,
      `${shiftDate} · ${startTime}–${endTime}`, '/dashboard/temp#assignment', assignment.id]
  );

  res.json(assignment);
});

router.get('/assignments/:id', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const assignment = await comms.getAssignment(orgId, req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  const events = await comms.eventHistory(orgId, req.params.id);
  res.json({ assignment, events });
});

router.post('/assignments/:id/cancel', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const assignment = await comms.getAssignment(orgId, req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  await db.query(`UPDATE assignments SET status = 'cancelled', status_updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// A manager/owner can respond to a worker's "leaving early" request.
router.post('/assignments/:id/leaving-early-response', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const assignment = await comms.getAssignment(orgId, req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  const { decision, note } = req.body || {};
  const allowed = ['approved', 'denied', 'more_info'];
  if (!allowed.includes(decision)) return res.status(400).json({ error: `decision must be one of ${allowed.join(', ')}` });

  const newStatus = decision === 'approved' ? 'leaving_early_approved' : assignment.status;
  await db.query(`UPDATE assignments SET status = $1, status_updated_at = NOW() WHERE id = $2`, [newStatus, req.params.id]);

  const result = await comms.createEvent({
    orgId,
    assignmentId: assignment.id,
    eventType: 'leaving_early_response',
    severity: 'normal',
    visibility: 'shared',
    summary: `Early departure request: ${decision.replace(/_/g, ' ')}`,
    details: note || null,
    createdByType: 'agency_user',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
    recipients: [{ type: 'worker', id: assignment.worker_id, name: assignment.worker_name }],
  });
  res.json({ ok: true, event: result.event });
});

// A manager marking a no-show manually (spec §9 — after all reporting
// channels have failed and the worker never responded).
router.post('/assignments/:id/mark-no-show', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const assignment = await comms.getAssignment(orgId, req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  await db.query(`UPDATE assignments SET status = 'no_show', status_updated_at = NOW() WHERE id = $1`, [req.params.id]);
  const result = await comms.createEvent({
    orgId,
    assignmentId: assignment.id,
    eventType: 'no_show_flag',
    severity: 'urgent',
    visibility: 'shared',
    summary: `No-call/no-show recorded by ${req.session.user.name}`,
    createdByType: 'agency_user',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event });
});

// Free-text message from the lead/recruiter side to the temp and client on
// an assignment — this is the "speak back and forth" piece of Temp Chat
// (the paid upgrade). Structured events above (leaving-early-response,
// mark-no-show) are never gated; only this open-ended message path checks
// temp_chat_enabled.
router.post('/assignments/:id/message', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const assignment = await comms.getAssignment(orgId, req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  const chatEnabled = await comms.isTempChatEnabled(orgId);
  if (!chatEnabled) return res.status(403).json({ error: 'Messaging isn\'t available for your agency yet.' });
  const { body, includeClient } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

  const result = await comms.createEvent({
    orgId,
    assignmentId: assignment.id,
    eventType: 'message',
    severity: 'normal',
    visibility: includeClient ? 'shared' : 'worker_agency',
    summary: `Message from ${req.session.user.name}`,
    details: body.trim(),
    createdByType: 'agency_user',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event });
});

router.post('/events/:id/acknowledge', requireOwner, async (req, res) => {
  const { action, note } = req.body || {};
  const allowed = ['viewed', 'acknowledged', 'in_progress', 'resolved'];
  if (!allowed.includes(action)) return res.status(400).json({ error: `action must be one of ${allowed.join(', ')}` });
  await comms.recordAction(
    req.session.user.organizationId, req.params.id,
    { type: 'agency_user', id: req.session.user.id, name: req.session.user.name }, action, note
  );
  res.json({ ok: true });
});

// ---- Attention Required (spec §22 — the primary manager screen) ----

router.get('/attention', requireOwner, async (req, res) => {
  const orgId = req.session.user.organizationId;
  const today = reporting.dateStr(new Date());

  const { rows: todayAssignments } = await db.query(
    `SELECT status, COUNT(*)::int AS c FROM assignments WHERE organization_id = $1 AND shift_date = $2 GROUP BY status`,
    [orgId, today]
  );
  const counts = {};
  let scheduledToday = 0;
  for (const r of todayAssignments) { counts[r.status] = r.c; scheduledToday += r.c; }

  const { rows: openEvents } = await db.query(
    `SELECT ae.*, a.shift_date, a.start_time, a.worker_id, w.name AS worker_name, cc.name AS client_company_name
     FROM assignment_events ae
     JOIN assignments a ON a.id = ae.assignment_id
     JOIN users w ON w.id = a.worker_id
     JOIN client_companies cc ON cc.id = a.client_company_id
     WHERE ae.organization_id = $1 AND ae.status NOT IN ('resolved')
       AND ae.event_type IN ('running_late','absence','no_show_flag','check_in_request','time_issue','workplace_issue','emergency','leaving_early_request')
     ORDER BY (ae.severity = 'emergency') DESC, (ae.status = 'escalated') DESC, ae.created_at DESC
     LIMIT 100`,
    [orgId]
  );

  res.json({
    scheduledToday,
    confirmedOrWorking: (counts.confirmed || 0) + (counts.on_my_way || 0) + (counts.arrived || 0) + (counts.in_progress || 0),
    runningLate: counts.running_late || 0,
    absences: counts.absent || 0,
    possibleNoShows: counts.possible_no_show || 0,
    noShows: counts.no_show || 0,
    needsAttention: openEvents,
  });
});

// ---- Agency contact routing rules (spec §16) ----

router.get('/contact-rules', requireOwner, async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.*, u.name AS contact_name FROM agency_contact_rules r
     JOIN users u ON u.id = r.contact_user_id
     WHERE r.organization_id = $1 ORDER BY r.sort_order ASC, r.id ASC`,
    [req.session.user.organizationId]
  );
  res.json(rows);
});

router.post('/contact-rules', requireOwner, async (req, res) => {
  const { label, startTime, endTime, contactUserId, isEmergencyContact, sortOrder } = req.body || {};
  if (!label || !startTime || !endTime || !contactUserId) {
    return res.status(400).json({ error: 'label, startTime, endTime, and contactUserId are required' });
  }
  const { rows } = await db.query(
    `INSERT INTO agency_contact_rules (organization_id, label, start_time, end_time, contact_user_id, is_emergency_contact, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.session.user.organizationId, label, startTime, endTime, contactUserId, !!isEmergencyContact, sortOrder || 0]
  );
  res.json(rows[0]);
});

router.delete('/contact-rules/:id', requireOwner, async (req, res) => {
  await db.query(`DELETE FROM agency_contact_rules WHERE id = $1 AND organization_id = $2`, [req.params.id, req.session.user.organizationId]);
  res.json({ ok: true });
});

router.get('/notifications', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM notifications WHERE organization_id = $1 AND recipient_type = 'agency_user' AND recipient_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [req.session.user.organizationId, req.session.user.id]
  );
  res.json(rows);
});

module.exports = router;
