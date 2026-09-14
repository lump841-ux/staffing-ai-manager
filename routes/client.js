// Client company portal — supervisors/HR at a company that receives
// temp workers from an agency using this platform. Every query here is
// scoped to req.session.clientContact.clientCompanyId in addition to
// organizationId, so one client company can never see another client
// company's workforce even within the same agency.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../services/db');
const comms = require('../services/assignment-comms');
const { requireClientContact } = require('../services/client-auth');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const { rows } = await db.query(
    `SELECT cc.*, co.name AS client_company_name FROM client_contacts cc
     JOIN client_companies co ON co.id = cc.client_company_id
     WHERE cc.email = $1`,
    [email.toLowerCase().trim()]
  );
  const contact = rows[0];
  if (!contact || !contact.active) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, contact.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  req.session.clientContact = {
    id: contact.id,
    organizationId: contact.organization_id,
    clientCompanyId: contact.client_company_id,
    clientCompanyName: contact.client_company_name,
    role: contact.role,
    name: contact.name,
    email: contact.email,
  };
  res.json({ ok: true, contact: req.session.clientContact });
});

router.post('/logout', (req, res) => {
  delete req.session.clientContact;
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.clientContact) return res.status(401).json({ error: 'Not signed in' });
  res.json(req.session.clientContact);
});

router.use(requireClientContact);

// ---- Cross-agency connections ----
// A client already on Twanova can invite a staffing agency that isn't yet.
// The agency signs up (and pays for its own subscription — see
// routes/signup.js) via a link carrying this token; on successful signup
// they get their own client_companies record for this client, and this
// same login is granted visibility into it (see client_contact_org_links)
// without ever creating a second account or password.
router.post('/invite-agency', async (req, res) => {
  const { organizationId, clientCompanyId, id } = req.session.clientContact;
  const { agencyNameHint } = req.body || {};
  const token = crypto.randomBytes(16).toString('hex');
  await db.query(
    `INSERT INTO agency_invites (token, inviting_organization_id, inviting_client_company_id, inviting_client_contact_id, agency_name_hint)
     VALUES ($1,$2,$3,$4,$5)`,
    [token, organizationId, clientCompanyId, id, (agencyNameHint || '').trim() || null]
  );
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const inviteUrl = `${proto}://${req.get('host')}/signup.html?invite=${token}`;
  res.json({ ok: true, token, inviteUrl });
});

router.get('/invites', async (req, res) => {
  const { id } = req.session.clientContact;
  const { rows } = await db.query(
    `SELECT ai.*, o.name AS claimed_by_organization_name
     FROM agency_invites ai
     LEFT JOIN organizations o ON o.id = ai.claimed_by_organization_id
     WHERE ai.inviting_client_contact_id = $1
     ORDER BY ai.created_at DESC`,
    [id]
  );
  res.json(rows);
});

// Other agencies this same login has been connected to (via an invite
// someone claimed), beyond the "home" agency they originally signed in
// under. The client dashboard uses this to offer a "switch agency" view.
router.get('/linked-orgs', async (req, res) => {
  const { id, organizationId, clientCompanyId } = req.session.clientContact;
  const { rows } = await db.query(
    `SELECT l.organization_id, o.name AS organization_name, l.client_company_id, cc.name AS client_company_name
     FROM client_contact_org_links l
     JOIN organizations o ON o.id = l.organization_id
     JOIN client_companies cc ON cc.id = l.client_company_id
     WHERE l.client_contact_id = $1
     ORDER BY o.name ASC`,
    [id]
  );
  res.json({
    home: { organizationId, clientCompanyId },
    linked: rows.map((r) => ({
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      clientCompanyId: r.client_company_id,
      clientCompanyName: r.client_company_name,
    })),
  });
});

// Re-scope this same login's session to a different agency/client-company
// pairing it's been connected to (its home org, or one granted via an
// accepted invite). Never trusts the client's word — always re-verified
// against client_contact_org_links (or the contact's own home row) here.
router.post('/switch-org', async (req, res) => {
  const contact = req.session.clientContact;
  const { organizationId, clientCompanyId } = req.body || {};
  if (!organizationId || !clientCompanyId) {
    return res.status(400).json({ error: 'organizationId and clientCompanyId are required' });
  }

  const { rows: homeRows } = await db.query(
    `SELECT cc.*, co.name AS client_company_name FROM client_contacts cc
     JOIN client_companies co ON co.id = cc.client_company_id
     WHERE cc.id = $1 AND cc.organization_id = $2 AND cc.client_company_id = $3`,
    [contact.id, organizationId, clientCompanyId]
  );
  if (homeRows.length) {
    req.session.clientContact = {
      ...contact,
      organizationId: homeRows[0].organization_id,
      clientCompanyId: homeRows[0].client_company_id,
      clientCompanyName: homeRows[0].client_company_name,
    };
    return res.json({ ok: true, contact: req.session.clientContact });
  }

  const { rows: linkRows } = await db.query(
    `SELECT l.*, o.name AS organization_name, cc.name AS client_company_name
     FROM client_contact_org_links l
     JOIN organizations o ON o.id = l.organization_id
     JOIN client_companies cc ON cc.id = l.client_company_id
     WHERE l.client_contact_id = $1 AND l.organization_id = $2 AND l.client_company_id = $3`,
    [contact.id, organizationId, clientCompanyId]
  );
  if (!linkRows.length) return res.status(403).json({ error: 'You are not connected to that agency.' });

  req.session.clientContact = {
    ...contact,
    organizationId: linkRows[0].organization_id,
    clientCompanyId: linkRows[0].client_company_id,
    clientCompanyName: linkRows[0].client_company_name,
  };
  res.json({ ok: true, contact: req.session.clientContact });
});

// ---- Today's temp workforce (spec §23) ----
router.get('/today', async (req, res) => {
  const { organizationId, clientCompanyId } = req.session.clientContact;
  const { date } = req.query;
  const shiftDate = date || new Date().toISOString().slice(0, 10);

  const { rows } = await db.query(
    `SELECT a.*, w.name AS worker_name, w.phone AS worker_phone, cl.name AS client_location_name
     FROM assignments a
     JOIN users w ON w.id = a.worker_id
     LEFT JOIN client_locations cl ON cl.id = a.client_location_id
     WHERE a.organization_id = $1 AND a.client_company_id = $2 AND a.shift_date = $3
     ORDER BY a.start_time ASC`,
    [organizationId, clientCompanyId, shiftDate]
  );
  res.json({ date: shiftDate, assignments: rows });
});

router.get('/assignments/:id', async (req, res) => {
  const { organizationId, clientCompanyId } = req.session.clientContact;
  const assignment = await comms.getAssignment(organizationId, req.params.id);
  if (!assignment || assignment.client_company_id !== clientCompanyId) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  const events = await comms.eventHistory(organizationId, req.params.id);
  // Client visibility: never show worker_agency-only events (private worker<->agency conversations).
  const visible = events.filter((e) => e.visibility !== 'worker_agency');
  res.json({ assignment, events: visible });
});

// ---- "ARE YOU COMING?" check-on (spec §7) ----
router.post('/assignments/:id/check-on', async (req, res) => {
  const { organizationId, clientCompanyId, id, name } = req.session.clientContact;
  const assignment = await comms.getAssignment(organizationId, req.params.id);
  if (!assignment || assignment.client_company_id !== clientCompanyId) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  const result = await comms.createEvent({
    orgId: organizationId,
    assignmentId: assignment.id,
    eventType: 'check_in_request',
    severity: 'normal',
    visibility: 'shared',
    summary: `${assignment.client_company_name} is checking on your arrival`,
    details: `Checking on your status for today's ${assignment.start_time} shift.`,
    createdByType: 'client_contact',
    createdById: id,
    createdByName: name,
    recipients: [{ type: 'worker', id: assignment.worker_id, name: assignment.worker_name }],
  });
  res.json({ ok: true, event: result.event });
});

// ---- Free-text message to worker + agency (spec §15 — shared conversation) ----
router.post('/assignments/:id/message', async (req, res) => {
  const { organizationId, clientCompanyId, id, name } = req.session.clientContact;
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

  const assignment = await comms.getAssignment(organizationId, req.params.id);
  if (!assignment || assignment.client_company_id !== clientCompanyId) {
    return res.status(404).json({ error: 'Assignment not found' });
  }
  const chatEnabled = await comms.isTempChatEnabled(organizationId);
  if (!chatEnabled) return res.status(403).json({ error: 'Messaging isn\'t available for this agency yet.' });

  const result = await comms.createEvent({
    orgId: organizationId,
    assignmentId: assignment.id,
    eventType: 'message',
    severity: 'normal',
    visibility: 'agency_client',
    summary: `Message from ${assignment.client_company_name}`,
    details: body.trim(),
    createdByType: 'client_contact',
    createdById: id,
    createdByName: name,
  });
  res.json({ ok: true, event: result.event });
});

router.post('/events/:id/acknowledge', async (req, res) => {
  const { id, name } = req.session.clientContact;
  const { action, note } = req.body || {};
  const allowed = ['viewed', 'acknowledged', 'in_progress', 'resolved'];
  if (!allowed.includes(action)) return res.status(400).json({ error: `action must be one of ${allowed.join(', ')}` });
  await comms.recordAction(req.session.clientContact.organizationId, req.params.id, { type: 'client_contact', id, name }, action, note);
  res.json({ ok: true });
});

router.get('/notifications', async (req, res) => {
  const { organizationId, id } = req.session.clientContact;
  const { rows } = await db.query(
    `SELECT * FROM notifications WHERE organization_id = $1 AND recipient_type = 'client_contact' AND recipient_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [organizationId, id]
  );
  res.json(rows);
});

router.post('/notifications/:id/read', async (req, res) => {
  const { organizationId, id } = req.session.clientContact;
  await db.query(
    `UPDATE notifications SET read = TRUE WHERE id = $1 AND organization_id = $2 AND recipient_type = 'client_contact' AND recipient_id = $3`,
    [req.params.id, organizationId, id]
  );
  res.json({ ok: true });
});

module.exports = router;
