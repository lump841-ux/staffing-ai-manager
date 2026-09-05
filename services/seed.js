// Demo data so the app is immediately clickable. Idempotent — only seeds
// if the organizations table is empty, so it's safe to call on every boot
// (needed for the pg-mem local mode, which starts fresh every run) and
// harmless against a real, already-seeded Postgres database.
const bcrypt = require('bcryptjs');
const db = require('./db');
const reporting = require('./reporting');

const DEFAULT_CATEGORIES = [
  { key: 'calls_made', label: 'Calls made', description: 'Outbound calls to prospects or clients' },
  { key: 'contacts_made', label: 'Contacts made', description: 'Calls that reached a real conversation' },
  { key: 'leads_generated', label: 'Leads generated', description: 'New candidate or client leads' },
  { key: 'applications', label: 'Applications', description: 'Candidate applications received' },
  { key: 'interviews', label: 'Interviews', description: 'Interviews conducted' },
  { key: 'placements', label: 'Placements', description: 'Successful placements made' },
  { key: 'new_accounts', label: 'New accounts', description: 'Brand-new client accounts opened' },
  { key: 'follow_ups', label: 'Follow-ups', description: 'Follow-up touches on existing leads or clients' },
  { key: 'client_outreach', label: 'Client outreach', description: 'Outreach specifically to existing or target client accounts' },
];

const GOALS = {
  calls_made: 25, contacts_made: 15, leads_generated: 5, applications: 3,
  interviews: 3, placements: 1, new_accounts: 1, follow_ups: 8, client_outreach: 4,
};

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

async function seedRandomDay(orgId, workerId, categories, date, rand, qualityFactor) {
  const values = {};
  for (const c of categories) {
    const base = GOALS[c.key] || 5;
    const noise = 0.5 + rand() * 1.0;
    values[c.id] = Math.max(0, Math.round(base * qualityFactor * noise));
  }
  const { rows } = await db.query(
    `INSERT INTO daily_reports (organization_id, worker_id, report_date, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (worker_id, report_date) DO NOTHING
     RETURNING id`,
    [orgId, workerId, date, null]
  );
  if (!rows.length) return;
  const reportId = rows[0].id;
  for (const [catId, v] of Object.entries(values)) {
    await db.query(`INSERT INTO daily_report_values (daily_report_id, category_id, value) VALUES ($1,$2,$3)`, [reportId, Number(catId), v]);
  }
  return { reportId, values };
}

async function run() {
  const { rows: orgCheck } = await db.query(`SELECT id FROM organizations LIMIT 1`);
  if (orgCheck.length) return; // already seeded

  const { rows: orgRows } = await db.query(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
    ['Summit Staffing Group']
  );
  const orgId = orgRows[0].id;

  const { rows: branchRows } = await db.query(
    `INSERT INTO branches (organization_id, name, address) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, 'Main Branch', '100 Commerce Way, Springfield']
  );
  const branchId = branchRows[0].id;

  const managerHash = await bcrypt.hash('manager123', 10);
  const { rows: managerRows } = await db.query(
    `INSERT INTO users (organization_id, branch_id, role, name, email, password_hash)
     VALUES ($1, $2, 'manager', $3, $4, $5) RETURNING id`,
    [orgId, branchId, 'Alex Rivera', 'manager@summitstaffing.demo', managerHash]
  );
  const managerId = managerRows[0].id;

  const categoryIds = [];
  let sortOrder = 0;
  for (const c of DEFAULT_CATEGORIES) {
    const { rows } = await db.query(
      `INSERT INTO activity_categories (organization_id, key, label, description, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, key`,
      [orgId, c.key, c.label, c.description, sortOrder++]
    );
    categoryIds.push(rows[0]);
  }

  const workerHash = await bcrypt.hash('worker123', 10);
  const workerNames = ['Sarah Chen', 'David Kim', 'Maria Lopez', 'James Patterson', 'Nina Ortiz'];
  const workerIds = [];
  for (const name of workerNames) {
    const email = name.toLowerCase().replace(/\s+/g, '.') + '@summitstaffing.demo';
    const { rows } = await db.query(
      `INSERT INTO users (organization_id, branch_id, role, name, email, password_hash)
       VALUES ($1, $2, 'worker', $3, $4, $5) RETURNING id`,
      [orgId, branchId, name, email, workerHash]
    );
    workerIds.push({ id: rows[0].id, name, email });

    for (const c of categoryIds) {
      await db.query(
        `INSERT INTO worker_goals (worker_id, category_id, daily_target, set_by_user_id) VALUES ($1,$2,$3,$4)`,
        [rows[0].id, c.id, GOALS[c.key] || 5, managerId]
      );
    }
  }

  // Two weeks of history (last week + this week through today), with each
  // worker given a distinct performance "personality" so the dashboard,
  // trends, and discrepancy engine all have something real to show.
  const today = reporting.dateStr(new Date());
  const twoWeeksAgoMonday = reporting.addDays(reporting.mondayOf(today), -7);
  const personalities = [1.15, 0.95, 0.55, 1.0, 0.85]; // Sarah strong, David improving, Maria below goal, James steady, Nina solid

  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const date = reporting.addDays(twoWeeksAgoMonday, dayOffset);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekends off
    if (date > today) break;

    for (let wi = 0; wi < workerIds.length; wi++) {
      const w = workerIds[wi];
      const rand = seededRandom(wi * 97 + dayOffset * 13 + 1);
      let quality = personalities[wi];
      // David Kim (index 1) trends upward across the two weeks.
      if (wi === 1) quality = 0.75 + (dayOffset / 13) * 0.5;
      if (date === today && rand() < 0.15) continue; // occasional missing-today for realism
      await seedRandomDay(orgId, w.id, categoryIds, date, rand, quality);
    }
  }

  // Intentionally seed one clean discrepancy example: Maria logs a placement
  // with no interview activity today (or the most recent day she reported).
  const mariaId = workerIds[2].id;
  const { rows: mariaReport } = await db.query(
    `SELECT id, report_date FROM daily_reports WHERE worker_id = $1 ORDER BY report_date DESC LIMIT 1`,
    [mariaId]
  );
  if (mariaReport.length) {
    const placementsCat = categoryIds.find((c) => c.key === 'placements');
    const interviewsCat = categoryIds.find((c) => c.key === 'interviews');
    await db.query(
      `UPDATE daily_report_values SET value = 2 WHERE daily_report_id = $1 AND category_id = $2`,
      [mariaReport[0].id, placementsCat.id]
    );
    await db.query(
      `UPDATE daily_report_values SET value = 0 WHERE daily_report_id = $1 AND category_id = $2`,
      [mariaReport[0].id, interviewsCat.id]
    );
    const discrepancyEngine = require('./discrepancy');
    const { rows: vals } = await db.query(
      `SELECT category_id, value FROM daily_report_values WHERE daily_report_id = $1`,
      [mariaReport[0].id]
    );
    const valuesByCategoryId = {};
    for (const v of vals) valuesByCategoryId[v.category_id] = v.value;
    await db.query(`DELETE FROM discrepancies WHERE daily_report_id = $1`, [mariaReport[0].id]);
    await discrepancyEngine.runChecks(orgId, mariaReport[0].id, mariaId, mariaReport[0].report_date, valuesByCategoryId);
  }

  // A sample manager task.
  await db.query(
    `INSERT INTO manager_tasks (organization_id, manager_id, related_worker_id, title, due_date, source)
     VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [orgId, managerId, mariaId, 'Check in with Maria about placement/interview mismatch', today]
  );

  console.log('Seeded demo organization "Summit Staffing Group".');
  console.log('Manager login: manager@summitstaffing.demo / manager123');
  console.log('Worker logins (any of):');
  for (const w of workerIds) console.log(`  ${w.email} / worker123  (${w.name})`);
}

module.exports = { run };
