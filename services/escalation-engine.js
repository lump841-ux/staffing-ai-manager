// Background sweep, run on an interval from server.js. Two jobs:
//  1. Possible no-show detection (spec §9) — a scheduled/confirmed
//     assignment whose shift start has passed the agency's configured
//     grace period with no worker-reported status becomes a
//     "possible_no_show" and creates a check-in-request event.
//  2. Escalation (spec §18) — any urgent/emergency event still sitting at
//     delivered/viewed past the agency's configured escalation window
//     gets bumped a tier and re-notified to the next contact.
// Thresholds are read per-organization from the columns added in
// schema.sql — never hard-coded, per the spec's explicit instruction.
const db = require('./db');
const comms = require('./assignment-comms');
const contactRouting = require('./contact-routing');

// shift_date comes back as a Date (midnight UTC) or 'YYYY-MM-DD' string
// depending on adapter; start_time is 'HH:MM'. Combine into a real epoch ms.
function shiftStartMs(shiftDate, startTime) {
  if (!shiftDate || !startTime) return null;
  const dateStr = shiftDate instanceof Date ? shiftDate.toISOString().slice(0, 10) : String(shiftDate).slice(0, 10);
  const t = /^\d{2}:\d{2}/.test(startTime) ? startTime.slice(0, 5) : '00:00';
  const d = new Date(`${dateStr}T${t}:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// Human-readable "8:00 AM on Tuesday, September 9" for event copy — the
// naive `${a.start_time} on ${a.shift_date}` used to interpolate a raw JS
// Date object, which stringifies to something like "Tue Sep 08 2026
// 20:00:00 GMT-0400 (Eastern Daylight Time)". This formats from the same
// date-only string used by shiftStartMs so it doesn't pick up a spurious
// time-of-day from the Date's UTC-midnight representation.
function formatShiftDateTime(shiftDate, startTime) {
  const dateStr = shiftDate instanceof Date ? shiftDate.toISOString().slice(0, 10) : String(shiftDate).slice(0, 10);
  const [y, m, d] = dateStr.split('-').map(Number);
  const dateOnly = new Date(y, (m || 1) - 1, d || 1);
  const datePart = Number.isNaN(dateOnly.getTime())
    ? dateStr
    : dateOnly.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const t = /^\d{2}:\d{2}/.test(startTime) ? startTime.slice(0, 5) : null;
  if (!t) return datePart;
  const [hh, mm] = t.split(':').map(Number);
  const timePart = new Date(2000, 0, 1, hh, mm).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${timePart} on ${datePart}`;
}

async function scanForPossibleNoShows() {
  const { rows: orgs } = await db.query(`SELECT id, no_show_grace_minutes FROM organizations`);
  let flagged = 0;

  for (const org of orgs) {
    // Computed in JS rather than in SQL — pg-mem's interval/date-math
    // support is limited, and this keeps the logic identical whether
    // running against pg-mem locally or real Postgres in production.
    const { rows: all } = await db.query(
      `SELECT * FROM assignments WHERE organization_id = $1 AND status IN ('scheduled','confirmed')`,
      [org.id]
    );
    const now = Date.now();
    const graceMs = org.no_show_grace_minutes * 60 * 1000;
    const candidates = all.filter((a) => {
      const shiftStart = shiftStartMs(a.shift_date, a.start_time);
      return shiftStart != null && now - shiftStart >= graceMs;
    });

    for (const a of candidates) {
      await db.query(`UPDATE assignments SET status = 'possible_no_show', status_updated_at = NOW() WHERE id = $1`, [a.id]);
      await comms.createEvent({
        orgId: org.id,
        assignmentId: a.id,
        eventType: 'check_in_request',
        severity: 'urgent',
        visibility: 'shared',
        summary: 'Possible no-show — no status received before shift start',
        details: `Shift was scheduled for ${formatShiftDateTime(a.shift_date, a.start_time)}. No arrival/status update was received within the configured grace period.`,
        createdByType: 'system',
        createdById: null,
        createdByName: 'Twanova — automated check',
      });
      flagged++;
    }
  }
  return flagged;
}

async function scanForEscalations() {
  const { rows: orgs } = await db.query(`SELECT id, escalation_minutes FROM organizations`);
  let escalated = 0;

  for (const org of orgs) {
    const { rows: candidates } = await db.query(
      `SELECT * FROM assignment_events
       WHERE organization_id = $1 AND severity IN ('urgent','emergency')
         AND status IN ('delivered','viewed') AND escalation_tier < 2`,
      [org.id]
    );
    const now = Date.now();
    const windowMs = org.escalation_minutes * 60 * 1000;
    const stale = candidates.filter((ev) => now - new Date(ev.created_at).getTime() >= windowMs);

    for (const ev of stale) {
      const nextTier = ev.escalation_tier + 1;
      const contact = await contactRouting.resolveAgencyContact(org.id, { emergency: ev.severity === 'emergency' });
      let recipients = [];
      if (contact) recipients = [{ type: 'agency_user', id: contact.userId, name: contact.name }];
      else {
        const fallbacks = await contactRouting.fallbackAgencyContacts(org.id);
        recipients = fallbacks.slice(0, 1).map((f) => ({ type: 'agency_user', id: f.id, name: f.name }));
      }

      await db.query(
        `UPDATE assignment_events SET status = 'escalated', escalation_tier = $1, escalated_at = NOW() WHERE id = $2`,
        [nextTier, ev.id]
      );
      await db.query(
        `INSERT INTO audit_log (organization_id, action, entity_type, entity_id, metadata)
         VALUES ($1,'event_escalated','assignment_event',$2,$3)`,
        [org.id, ev.id, JSON.stringify({ tier: nextTier, summary: ev.summary })]
      );
      if (recipients.length) {
        await comms.notify(org.id, recipients, {
          title: `Escalated (Tier ${nextTier}): ${ev.summary}`,
          body: ev.details || 'This has not been acknowledged and has been escalated.',
          link: '/dashboard/manager#attention',
          eventId: ev.id,
          assignmentId: ev.assignment_id,
        });
      }
      escalated++;
    }
  }
  return escalated;
}

function start(app, intervalMs = 60 * 1000) {
  setInterval(() => {
    scanForPossibleNoShows().catch((e) => console.error('[no-show scan]', e));
    scanForEscalations().catch((e) => console.error('[escalation scan]', e));
  }, intervalMs);
}

module.exports = { scanForPossibleNoShows, scanForEscalations, start };
