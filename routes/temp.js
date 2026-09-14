// Temp routes — the Assignment Communication Network. A temp is NOT the
// same person as a "worker" in routes/worker.js (that role is actually a
// recruiter/staffing-coordinator on the agency's own payroll, tracking
// calls made / placements / etc.). A temp is someone the agency places at
// a client company's job site — this is their entire portal: today's
// assignment, status updates, and every structured workforce event that
// can come off it. Every route below re-verifies the assignment belongs
// to this temp before doing anything, same scoping discipline as
// routes/worker.js.
const express = require('express');
const db = require('../services/db');
const reporting = require('../services/reporting');
const comms = require('../services/assignment-comms');
const contactRouting = require('../services/contact-routing');
const { requireRole } = require('../services/auth-middleware');
const router = express.Router();

router.use(requireRole('temp'));

async function ownedAssignment(req, res) {
  const orgId = req.session.user.organizationId;
  const workerId = req.session.user.id;
  const assignment = await comms.getAssignment(orgId, req.params.id);
  if (!assignment || assignment.worker_id !== workerId) {
    res.status(404).json({ error: 'Assignment not found' });
    return null;
  }
  return assignment;
}

// Today's (or, if none today, the next upcoming) assignment — this is
// what drives the primary mobile-first screen (spec §3).
router.get('/assignment/today', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const workerId = req.session.user.id;
  const today = reporting.dateStr(new Date());

  const { rows: todayRows } = await db.query(
    `SELECT id FROM assignments WHERE organization_id = $1 AND worker_id = $2 AND shift_date = $3
     AND status NOT IN ('cancelled') ORDER BY start_time ASC LIMIT 1`,
    [orgId, workerId, today]
  );
  let assignmentId = todayRows[0] && todayRows[0].id;

  if (!assignmentId) {
    const { rows: upcoming } = await db.query(
      `SELECT id FROM assignments WHERE organization_id = $1 AND worker_id = $2 AND shift_date > $3
       AND status NOT IN ('cancelled') ORDER BY shift_date ASC, start_time ASC LIMIT 1`,
      [orgId, workerId, today]
    );
    assignmentId = upcoming[0] && upcoming[0].id;
  }

  if (!assignmentId) return res.json({ assignment: null });

  const assignment = await comms.getAssignment(orgId, assignmentId);
  const events = await comms.eventHistory(orgId, assignmentId);
  res.json({ assignment, events, serverNow: new Date().toISOString() });
});

router.get('/assignment/:id', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const events = await comms.eventHistory(req.session.user.organizationId, assignment.id);
  res.json({ assignment, events });
});

router.get('/assignments/upcoming', async (req, res) => {
  const orgId = req.session.user.organizationId;
  const workerId = req.session.user.id;
  const today = reporting.dateStr(new Date());
  const { rows } = await db.query(
    `SELECT a.*, cc.name AS client_company_name FROM assignments a
     JOIN client_companies cc ON cc.id = a.client_company_id
     WHERE a.organization_id = $1 AND a.worker_id = $2 AND a.shift_date >= $3 AND a.status NOT IN ('cancelled','shift_complete','no_show')
     ORDER BY a.shift_date ASC, a.start_time ASC LIMIT 20`,
    [orgId, workerId, today]
  );
  res.json(rows);
});

// Simple one-tap status changes: on_my_way, arrived, in_progress, shift_complete.
// Also how a temp answers a supervisor's "are you coming?" check-on.
const SIMPLE_STATUSES = { on_my_way: 'On my way', arrived: 'Arrived on site', shift_complete: 'Shift complete' };
router.post('/assignment/:id/status', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const { status } = req.body || {};
  if (!SIMPLE_STATUSES[status]) return res.status(400).json({ error: `status must be one of ${Object.keys(SIMPLE_STATUSES).join(', ')}` });

  await db.query(`UPDATE assignments SET status = $1, status_updated_at = NOW() WHERE id = $2`, [status, assignment.id]);
  const result = await comms.createEvent({
    orgId: req.session.user.organizationId,
    assignmentId: assignment.id,
    eventType: status === 'shift_complete' ? 'shift_complete' : status,
    severity: 'normal',
    visibility: 'shared',
    summary: `${req.session.user.name}: ${SIMPLE_STATUSES[status]}`,
    createdByType: 'worker',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event, status });
});

const LATE_OPTIONS = [5, 10, 15, 30, 45, 60];
router.post('/assignment/:id/late', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const { minutes, message } = req.body || {};
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: 'minutes must be a positive number' });

  await db.query(`UPDATE assignments SET status = 'running_late', status_updated_at = NOW() WHERE id = $1`, [assignment.id]);
  const result = await comms.createEvent({
    orgId: req.session.user.organizationId,
    assignmentId: assignment.id,
    eventType: 'running_late',
    severity: 'urgent',
    visibility: 'shared',
    summary: `${req.session.user.name} is running approximately ${m} minute${m === 1 ? '' : 's'} late`,
    details: message || null,
    metadata: { minutes: m, presetOptions: LATE_OPTIONS },
    createdByType: 'worker',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event, recipients: result.recipients });
});

const ABSENCE_REASONS = ['sick', 'family_emergency', 'transportation', 'childcare', 'personal_emergency', 'other'];
router.post('/assignment/:id/absence', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const { reason, message } = req.body || {};
  if (!ABSENCE_REASONS.includes(reason)) return res.status(400).json({ error: `reason must be one of ${ABSENCE_REASONS.join(', ')}` });

  await db.query(`UPDATE assignments SET status = 'absent', status_updated_at = NOW() WHERE id = $1`, [assignment.id]);
  const result = await comms.createEvent({
    orgId: req.session.user.organizationId,
    assignmentId: assignment.id,
    eventType: 'absence',
    severity: 'urgent',
    visibility: 'shared',
    summary: `${req.session.user.name} reported an absence (${reason.replace(/_/g, ' ')})`,
    details: message || null,
    metadata: { reason },
    createdByType: 'worker',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event, recipients: result.recipients });
});

router.post('/assignment/:id/leaving-early', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const { departureTime, reason, message } = req.body || {};
  if (!departureTime) return res.status(400).json({ error: 'departureTime is required' });

  await db.query(`UPDATE assignments SET status = 'leaving_early_requested', status_updated_at = NOW() WHERE id = $1`, [assignment.id]);
  const result = await comms.createEvent({
    orgId: req.session.user.organizationId,
    assignmentId: assignment.id,
    eventType: 'leaving_early_request',
    severity: 'normal',
    visibility: 'shared',
    summary: `${req.session.user.name} requests to leave early at ${departureTime}`,
    details: message || null,
    metadata: { departureTime, reason: reason || null },
    createdByType: 'worker',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event });
});

const TIME_ISSUE_TYPES = ['clock_in_incorrect', 'clock_out_incorrect', 'missing_punch', 'break_issue', 'hours_incorrect', 'other'];
router.post('/assignment/:id/time-issue', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const { issueType, displayedTime, claimedTime, explanation } = req.body || {};
  if (!TIME_ISSUE_TYPES.includes(issueType)) return res.status(400).json({ error: `issueType must be one of ${TIME_ISSUE_TYPES.join(', ')}` });
  if (!explanation || !explanation.trim()) return res.status(400).json({ error: 'A brief explanation is required' });

  // Deliberately does not touch worker_time_entries (payroll-facing,
  // manager-only) — this creates a reviewable issue, never an automatic
  // correction, per the spec's explicit instruction (§11).
  const result = await comms.createEvent({
    orgId: req.session.user.organizationId,
    assignmentId: assignment.id,
    eventType: 'time_issue',
    severity: 'normal',
    visibility: 'agency_client',
    summary: `Time/punch issue: ${issueType.replace(/_/g, ' ')}`,
    details: explanation.trim(),
    metadata: { issueType, displayedTime: displayedTime || null, claimedTime: claimedTime || null },
    createdByType: 'worker',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event });
});

const WORKPLACE_ISSUE_CATEGORIES = [
  'assignment_confusion', 'supervisor_issue', 'schedule_issue', 'work_conditions',
  'equipment_problem', 'safety_concern', 'harassment_behavior', 'other',
];
router.post('/assignment/:id/workplace-issue', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const { category, explanation, keepPrivate } = req.body || {};
  if (!WORKPLACE_ISSUE_CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of ${WORKPLACE_ISSUE_CATEGORIES.join(', ')}` });
  if (!explanation || !explanation.trim()) return res.status(400).json({ error: 'Please describe what happened' });

  // Some categories (harassment/behavior, or anything the temp marks
  // private) never reach the client company — worker<->agency only
  // (spec §13). Everything else defaults to a shared record.
  const sensitiveByDefault = category === 'harassment_behavior' || category === 'supervisor_issue';
  const visibility = keepPrivate || sensitiveByDefault ? 'worker_agency' : 'shared';

  const result = await comms.createEvent({
    orgId: req.session.user.organizationId,
    assignmentId: assignment.id,
    eventType: 'workplace_issue',
    severity: 'normal',
    visibility,
    summary: `Workplace issue reported: ${category.replace(/_/g, ' ')}`,
    details: explanation.trim(),
    metadata: { category },
    createdByType: 'worker',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event });
});

const EMERGENCY_CATEGORIES = ['workplace_injury', 'unsafe_situation', 'serious_conflict', 'need_to_leave_immediately', 'other_urgent'];
router.post('/assignment/:id/emergency', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const { category, explanation } = req.body || {};
  if (!EMERGENCY_CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of ${EMERGENCY_CATEGORIES.join(', ')}` });

  const result = await comms.createEvent({
    orgId: req.session.user.organizationId,
    assignmentId: assignment.id,
    eventType: 'emergency',
    severity: 'emergency',
    visibility: 'shared',
    summary: `URGENT — ${req.session.user.name}: ${category.replace(/_/g, ' ')}`,
    details: explanation || null,
    metadata: { category },
    createdByType: 'worker',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
    emergency: true,
  });
  res.json({
    ok: true,
    event: result.event,
    disclaimer: 'If there is immediate danger or a medical emergency, contact 911/emergency services. This portal is not a substitute for emergency services.',
  });
});

// "Contact my staffing agency" — the temp never needs to know who's on
// call; this resolves it for them (spec §16).
router.get('/agency-contact', async (req, res) => {
  const orgId = req.session.user.organizationId;
  let contact = await contactRouting.resolveAgencyContact(orgId, { emergency: false });
  if (!contact) {
    const fallbacks = await contactRouting.fallbackAgencyContacts(orgId);
    contact = fallbacks[0] ? { userId: fallbacks[0].id, name: fallbacks[0].name, label: 'Staffing Agency' } : null;
  }
  res.json({ contact });
});

router.post('/assignment/:id/message', async (req, res) => {
  const assignment = await ownedAssignment(req, res);
  if (!assignment) return;
  const chatEnabled = await comms.isTempChatEnabled(req.session.user.organizationId);
  if (!chatEnabled) return res.status(403).json({ error: 'Messaging isn\'t available for your agency yet.' });
  const { to, body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });
  const visibility = to === 'supervisor' ? 'worker_client' : 'worker_agency';

  const result = await comms.createEvent({
    orgId: req.session.user.organizationId,
    assignmentId: assignment.id,
    eventType: 'message',
    severity: 'normal',
    visibility,
    summary: `Message from ${req.session.user.name}`,
    details: body.trim(),
    createdByType: 'worker',
    createdById: req.session.user.id,
    createdByName: req.session.user.name,
  });
  res.json({ ok: true, event: result.event });
});

router.post('/events/:id/acknowledge', async (req, res) => {
  const { action, note } = req.body || {};
  const allowed = ['viewed', 'acknowledged'];
  if (!allowed.includes(action)) return res.status(400).json({ error: `action must be one of ${allowed.join(', ')}` });
  await comms.recordAction(
    req.session.user.organizationId, req.params.id,
    { type: 'worker', id: req.session.user.id, name: req.session.user.name }, action, note
  );
  res.json({ ok: true });
});

router.get('/notifications', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM notifications WHERE organization_id = $1 AND recipient_type = 'worker' AND recipient_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [req.session.user.organizationId, req.session.user.id]
  );
  res.json(rows);
});

router.post('/notifications/:id/read', async (req, res) => {
  await db.query(
    `UPDATE notifications SET read = TRUE WHERE id = $1 AND organization_id = $2 AND recipient_type = 'worker' AND recipient_id = $3`,
    [req.params.id, req.session.user.organizationId, req.session.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;
