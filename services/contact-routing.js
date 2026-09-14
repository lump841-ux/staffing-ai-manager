// Resolves "who should this go to right now" so a temp never has
// to know who's on call. Two callers: assignment-comms.js (deciding
// recipients for an event) and routes/temp.js ("Contact my staffing
// agency" button).
const db = require('./db');

function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// Matches agency_contact_rules rows by time-of-day window. Wraps past
// midnight correctly (e.g. 23:00–07:00 overnight coverage).
function inWindow(hhmm, start, end) {
  if (start <= end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end; // overnight wrap
}

// Returns { userId, name, label } for the agency contact who should
// currently receive routine communication for this org, or null if the
// agency hasn't configured any rules (caller should fall back to the
// assignment's own agency_contact_user_id, then any owner/manager).
async function resolveAgencyContact(orgId, { emergency = false } = {}) {
  const { rows } = await db.query(
    `SELECT r.id, r.label, r.start_time, r.end_time, r.is_emergency_contact, r.sort_order,
            u.id AS user_id, u.name AS user_name
     FROM agency_contact_rules r JOIN users u ON u.id = r.contact_user_id
     WHERE r.organization_id = $1 AND u.active = TRUE
     ORDER BY r.sort_order ASC, r.id ASC`,
    [orgId]
  );
  if (!rows.length) return null;

  const hhmm = nowHHMM();
  const candidates = emergency ? rows.filter((r) => r.is_emergency_contact) : rows;
  const pool = candidates.length ? candidates : rows;

  const active = pool.find((r) => inWindow(hhmm, r.start_time, r.end_time));
  const chosen = active || pool[0]; // no window matches -> first configured contact rather than nobody
  return { userId: chosen.user_id, name: chosen.user_name, label: chosen.label };
}

async function fallbackAgencyContacts(orgId) {
  const { rows } = await db.query(
    `SELECT id, name FROM users WHERE organization_id = $1 AND role IN ('owner','manager') AND active = TRUE ORDER BY role = 'owner' DESC, id ASC`,
    [orgId]
  );
  return rows;
}

module.exports = { resolveAgencyContact, fallbackAgencyContacts };
