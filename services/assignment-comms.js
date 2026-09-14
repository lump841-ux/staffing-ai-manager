// The Assignment Communication Network's core engine. Every structured
// workforce event (late notice, absence, time issue, workplace issue,
// emergency, check-on, shift-complete, free-text message) flows through
// createEvent() here — this is what turns "a worker pressed a button"
// into "the correct people were notified and there's a timestamped record
// of it" (spec §6, §17, §20). Nothing in this file is a chat feature;
// there is no generic "send message to anyone" path — every event is
// always attached to one assignment, and recipients are always derived
// from that assignment's known relationships, never picked by hand.
const db = require('./db');
const contactRouting = require('./contact-routing');

// Temp Chat is the paid upgrade gating free-text messaging (event_type
// 'message') between a temp, their recruiter/lead, and the client company.
// Structured events (late notice, absence, etc.) are never gated — only
// the open-ended "message" event type checks this flag. Off by default for
// brand-new agencies (see routes/signup.js); existing/demo orgs default to
// enabled in the schema so nothing already built breaks.
async function isTempChatEnabled(orgId) {
  const { rows } = await db.query(`SELECT temp_chat_enabled FROM organizations WHERE id = $1`, [orgId]);
  return !!(rows[0] && rows[0].temp_chat_enabled);
}

async function getAssignment(orgId, assignmentId) {
  const { rows } = await db.query(
    `SELECT a.*, cc.name AS client_company_name, cl.name AS client_location_name, cl.address AS client_location_address,
            sc.name AS supervisor_name, sc.phone AS supervisor_phone, sc.email AS supervisor_email,
            w.name AS worker_name, w.phone AS worker_phone, w.email AS worker_email,
            ac.name AS agency_contact_name
     FROM assignments a
     JOIN client_companies cc ON cc.id = a.client_company_id
     LEFT JOIN client_locations cl ON cl.id = a.client_location_id
     LEFT JOIN client_contacts sc ON sc.id = a.supervisor_contact_id
     JOIN users w ON w.id = a.worker_id
     LEFT JOIN users ac ON ac.id = a.agency_contact_user_id
     WHERE a.organization_id = $1 AND a.id = $2`,
    [orgId, assignmentId]
  );
  return rows[0] || null;
}

// Builds the recipient list for an event based on who's involved in the
// assignment plus the event's visibility level (spec §15 — not everything
// is shared with the client company by default).
async function defaultRecipients(orgId, assignment, { visibility, excludeCreator }) {
  const recipients = [];

  const addAgency = async (emergency) => {
    let contact = null;
    if (assignment.agency_contact_user_id) {
      contact = { userId: assignment.agency_contact_user_id, name: assignment.agency_contact_name };
    } else {
      contact = await contactRouting.resolveAgencyContact(orgId, { emergency });
    }
    if (!contact) {
      const fallbacks = await contactRouting.fallbackAgencyContacts(orgId);
      if (fallbacks[0]) contact = { userId: fallbacks[0].id, name: fallbacks[0].name };
    }
    if (contact) recipients.push({ type: 'agency_user', id: contact.userId, name: contact.name });
  };

  const addSupervisor = () => {
    if (assignment.supervisor_contact_id) {
      recipients.push({ type: 'client_contact', id: assignment.supervisor_contact_id, name: assignment.supervisor_name });
    }
  };

  const addWorker = () => {
    recipients.push({ type: 'worker', id: assignment.worker_id, name: assignment.worker_name });
  };

  if (visibility === 'worker_agency') {
    await addAgency(false);
  } else if (visibility === 'worker_client') {
    addSupervisor();
  } else if (visibility === 'agency_client') {
    await addAgency(false);
    addSupervisor();
  } else {
    // 'shared' — the default for attendance events: worker + agency + supervisor
    await addAgency(false);
    addSupervisor();
    addWorker();
  }

  if (excludeCreator) {
    return recipients.filter((r) => !(r.type === excludeCreator.type && r.id === excludeCreator.id));
  }
  return recipients;
}

async function notify(orgId, recipients, { title, body, link, eventId, assignmentId }) {
  for (const r of recipients) {
    await db.query(
      `INSERT INTO notifications (organization_id, recipient_type, recipient_id, title, body, link, event_id, assignment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orgId, r.type, r.id, title, body || null, link || null, eventId || null, assignmentId || null]
    );
  }
}

// Creates a structured event, computes recipients (unless the caller
// supplies its own — e.g. a supervisor's check-on only needs to reach the
// worker), records the notify-fanout as event_recipients, and pushes an
// in-app notification to each. Returns the full event row plus recipients
// so the caller can hand a "successfully sent" confirmation back to the UI.
async function createEvent({
  orgId, assignmentId, eventType, severity = 'normal', visibility = 'shared',
  summary, details, metadata, createdByType, createdById, createdByName,
  recipients, emergency = false,
}) {
  const assignment = await getAssignment(orgId, assignmentId);
  if (!assignment) throw new Error('Assignment not found');

  const { rows } = await db.query(
    `INSERT INTO assignment_events
       (organization_id, assignment_id, event_type, severity, status, visibility, summary, details, metadata,
        created_by_type, created_by_id, created_by_name)
     VALUES ($1,$2,$3,$4,'delivered',$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [orgId, assignmentId, eventType, severity, visibility, summary, details || null,
      metadata ? JSON.stringify(metadata) : null, createdByType, createdById || null, createdByName || null]
  );
  const event = rows[0];

  const finalRecipients = recipients && recipients.length
    ? recipients
    : await defaultRecipients(orgId, assignment, { visibility, excludeCreator: { type: createdByType, id: createdById } });

  for (const r of finalRecipients) {
    await db.query(
      `INSERT INTO event_recipients (event_id, recipient_type, recipient_id, recipient_name) VALUES ($1,$2,$3,$4)`,
      [event.id, r.type, r.id, r.name || null]
    );
  }

  const linkByType = {
    worker: `/dashboard/field#assignment-${assignmentId}`,
    client_contact: `/client/dashboard.html#assignment-${assignmentId}`,
    agency_user: `/dashboard/manager#attention`,
  };
  for (const r of finalRecipients) {
    await notify(orgId, [r], {
      title: summary,
      body: details || null,
      link: linkByType[r.type],
      eventId: event.id,
      assignmentId,
    });
  }

  return { event, assignment, recipients: finalRecipients };
}

async function recordAction(orgId, eventId, actor, action, note) {
  const { rows: eventRows } = await db.query(
    `SELECT * FROM assignment_events WHERE id = $1 AND organization_id = $2`,
    [eventId, orgId]
  );
  const event = eventRows[0];
  if (!event) throw new Error('Event not found');

  await db.query(
    `INSERT INTO event_acknowledgments (event_id, actor_type, actor_id, actor_name, action, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [eventId, actor.type, actor.id, actor.name || null, action, note || null]
  );

  // Status only ever moves forward: viewed < acknowledged < in_progress < resolved.
  // An escalated event can still be acknowledged/resolved afterward.
  const rank = { new: 0, delivered: 1, viewed: 2, acknowledged: 3, in_progress: 4, resolved: 5, escalated: 3 };
  const nextStatus = rank[action] >= rank[event.status] || event.status === 'escalated' ? action : event.status;

  // Computed in JS rather than a SQL CASE/NOW() expression — pg-mem's type
  // reconciler rejects mixing a timestamptz NOW() with a timestamp column
  // inside CASE, and this is simpler anyway.
  const resolvedAtParam = nextStatus === 'resolved' ? new Date() : null;
  await db.query(
    `UPDATE assignment_events SET status = $1, resolved_at = COALESCE($3, resolved_at) WHERE id = $2`,
    [nextStatus, eventId, resolvedAtParam]
  );

  return { ok: true };
}

async function eventHistory(orgId, assignmentId) {
  const { rows: events } = await db.query(
    `SELECT * FROM assignment_events WHERE organization_id = $1 AND assignment_id = $2 ORDER BY created_at ASC`,
    [orgId, assignmentId]
  );
  if (!events.length) return [];

  const ids = events.map((e) => e.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: recipients } = await db.query(
    `SELECT * FROM event_recipients WHERE event_id IN (${placeholders}) ORDER BY notified_at ASC`,
    ids
  );
  const { rows: acks } = await db.query(
    `SELECT * FROM event_acknowledgments WHERE event_id IN (${placeholders}) ORDER BY created_at ASC`,
    ids
  );

  const byEvent = {};
  for (const e of events) byEvent[e.id] = { ...e, recipients: [], acknowledgments: [] };
  for (const r of recipients) if (byEvent[r.event_id]) byEvent[r.event_id].recipients.push(r);
  for (const a of acks) if (byEvent[a.event_id]) byEvent[a.event_id].acknowledgments.push(a);

  return Object.values(byEvent);
}

module.exports = { getAssignment, createEvent, recordAction, eventHistory, notify, defaultRecipients, isTempChatEnabled };
