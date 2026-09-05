// Deterministic discrepancy rule engine. The AI layer only ever phrases the
// human-readable explanation of a rule that already fired here — it never
// invents or accuses on its own. Every flag is stored as
// "Possible Discrepancy — Manager Review Required" and needs a manager
// action to move off "open".
const db = require('./db');
const reporting = require('./reporting');

async function insertFlag(orgId, dailyReportId, workerId, ruleKey, explanation) {
  await db.query(
    `INSERT INTO discrepancies (organization_id, daily_report_id, worker_id, rule_key, explanation)
     VALUES ($1, $2, $3, $4, $5)`,
    [orgId, dailyReportId, workerId, ruleKey, explanation]
  );
}

async function getCategoryMap(orgId) {
  const cats = await reporting.getActiveCategories(orgId);
  const byKey = {};
  const byId = {};
  for (const c of cats) {
    byKey[c.key] = c;
    byId[c.id] = c;
  }
  return { byKey, byId };
}

// Runs after a worker submits a daily report. valuesByCategoryId: {categoryId: number}
async function runChecks(orgId, dailyReportId, workerId, reportDate, valuesByCategoryId) {
  const { byKey, byId } = await getCategoryMap(orgId);

  const val = (key) => {
    const cat = byKey[key];
    if (!cat) return null;
    return valuesByCategoryId[cat.id] != null ? valuesByCategoryId[cat.id] : null;
  };

  // Rule 1: missing required fields — an active category with no value submitted at all.
  for (const cat of Object.values(byId)) {
    if (valuesByCategoryId[cat.id] === undefined) {
      await insertFlag(
        orgId, dailyReportId, workerId, 'missing_field',
        `"${cat.label}" was not submitted for this day, even though it's an active reporting category.`
      );
    }
  }

  // Rule 2: placements with no interview activity.
  const placements = val('placements');
  const interviews = val('interviews');
  if (placements != null && placements > 0 && (interviews == null || interviews === 0)) {
    await insertFlag(
      orgId, dailyReportId, workerId, 'placements_no_interviews',
      `${placements} placement${placements === 1 ? '' : 's'} reported, but no interview activity logged the same day.`
    );
  }

  // Rule 3: follow-ups exceed contacts made by a wide margin.
  const contacts = val('contacts_made');
  const followUps = val('follow_ups');
  if (followUps != null && followUps > 0 && contacts != null && followUps > contacts * 1.5 && contacts >= 1) {
    await insertFlag(
      orgId, dailyReportId, workerId, 'followups_exceed_contacts',
      `${followUps} follow-ups reported against only ${contacts} contacts made — follow-ups are usually a subset of contacts.`
    );
  }
  if (followUps != null && followUps > 0 && (contacts == null || contacts === 0)) {
    await insertFlag(
      orgId, dailyReportId, workerId, 'followups_no_contacts',
      `${followUps} follow-ups reported with zero contacts made logged for the day.`
    );
  }

  // Rule 4: statistical deviation from the worker's own trailing 7-day average per category.
  for (const cat of Object.values(byId)) {
    const today = valuesByCategoryId[cat.id];
    if (today == null) continue;
    const trailing = await reporting.getWorkerTrailingAverage(orgId, workerId, cat.id, reportDate, 7);
    if (trailing.n >= 3 && trailing.avg_value != null && trailing.avg_value >= 3) {
      if (today < trailing.avg_value * 0.3) {
        await insertFlag(
          orgId, dailyReportId, workerId, 'unusually_low',
          `"${cat.label}" was ${today} today vs. a recent average of ${Math.round(trailing.avg_value)} — noticeably lower than this worker's normal pattern.`
        );
      } else if (today > trailing.avg_value * 3) {
        await insertFlag(
          orgId, dailyReportId, workerId, 'unusually_high',
          `"${cat.label}" was ${today} today vs. a recent average of ${Math.round(trailing.avg_value)} — noticeably higher than this worker's normal pattern. Worth a quick confirm.`
        );
      }
    }
  }
}

async function listOpen(orgId, status) {
  const where = status ? `AND d.status = $2` : '';
  const params = status ? [orgId, status] : [orgId];
  const { rows } = await db.query(
    `SELECT d.id, d.rule_key, d.explanation, d.status, d.created_at, d.reviewed_at,
            dr.report_date, u.id as worker_id, u.name as worker_name
     FROM discrepancies d
     JOIN daily_reports dr ON dr.id = d.daily_report_id
     JOIN users u ON u.id = d.worker_id
     WHERE d.organization_id = $1 ${where}
     ORDER BY d.created_at DESC`,
    params
  );
  // Normalize report_date to a plain 'YYYY-MM-DD' string — pg-mem/pg can
  // return DATE columns as JS Date objects, and every caller (AI layer,
  // manager routes, the dashboard's date formatting) expects a string.
  return rows.map((r) => ({
    ...r,
    report_date: r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : String(r.report_date).slice(0, 10),
  }));
}

async function setStatus(orgId, id, status, reviewedByUserId) {
  const { rows } = await db.query(
    `UPDATE discrepancies SET status = $1, reviewed_by_user_id = $2, reviewed_at = NOW()
     WHERE id = $3 AND organization_id = $4 RETURNING *`,
    [status, reviewedByUserId, id, orgId]
  );
  return rows[0];
}

module.exports = { runChecks, listOpen, setStatus };
