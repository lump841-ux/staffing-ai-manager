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
  { key: 'applications', label: 'Contracts', description: 'Candidate contracts received' },
  { key: 'interviews', label: 'Meetings', description: 'Meetings conducted' },
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

// Deletes the fake sales team ("...@summitstaffing.demo" worker/temp
// accounts), their report history, the demo client company/assignment,
// and the demo manager task — in FK-safe order. Idempotent: no-ops once
// nothing demo-shaped is left. This runs as a startup safety net so that
// if the app was ever booted against a fresh real Postgres database
// before this file existed (which happened once), the fake roster gets
// cleaned out automatically instead of sitting there forever.
// pg-mem (used for local/smoke runs) doesn't reliably match `= ANY($1::int[])`
// against a parameterized array, so ids — always our own trusted integers
// from a prior SELECT, never user input — are inlined as a plain IN (...)
// list, which behaves correctly on both pg-mem and real Postgres.
function inClause(ids) {
  return ids.map((id) => Number(id)).join(',');
}

async function cleanupDemoContent(orgId) {
  const { rows: demoWorkers } = await db.query(
    `SELECT id FROM users WHERE organization_id = $1 AND role IN ('worker','temp') AND email LIKE '%@summitstaffing.demo'`,
    [orgId]
  );
  const demoWorkerIds = demoWorkers.map((r) => r.id);
  if (demoWorkerIds.length) {
    const ids = inClause(demoWorkerIds);
    await db.query(
      `DELETE FROM discrepancies WHERE daily_report_id IN (SELECT id FROM daily_reports WHERE worker_id IN (${ids}))`
    );
    await db.query(
      `DELETE FROM daily_report_values WHERE daily_report_id IN (SELECT id FROM daily_reports WHERE worker_id IN (${ids}))`
    );
    await db.query(`DELETE FROM daily_reports WHERE worker_id IN (${ids})`);
    await db.query(`DELETE FROM worker_goals WHERE worker_id IN (${ids})`);
    await db.query(`DELETE FROM manager_tasks WHERE related_worker_id IN (${ids})`);
    await db.query(
      `DELETE FROM event_acknowledgments WHERE event_id IN (SELECT id FROM assignment_events WHERE assignment_id IN (SELECT id FROM assignments WHERE worker_id IN (${ids})))`
    );
    await db.query(
      `DELETE FROM event_recipients WHERE event_id IN (SELECT id FROM assignment_events WHERE assignment_id IN (SELECT id FROM assignments WHERE worker_id IN (${ids})))`
    );
    await db.query(
      `DELETE FROM notifications WHERE assignment_id IN (SELECT id FROM assignments WHERE worker_id IN (${ids}))`
    );
    await db.query(
      `DELETE FROM assignment_events WHERE assignment_id IN (SELECT id FROM assignments WHERE worker_id IN (${ids}))`
    );
    await db.query(`DELETE FROM assignments WHERE worker_id IN (${ids})`);
  }

  const { rows: demoCompanies } = await db.query(
    `SELECT id FROM client_companies WHERE organization_id = $1 AND name = 'Meridian Distribution Center'`,
    [orgId]
  );
  const demoCompanyIds = demoCompanies.map((r) => r.id);
  if (demoCompanyIds.length) {
    const ids = inClause(demoCompanyIds);
    await db.query(`DELETE FROM assignments WHERE client_company_id IN (${ids})`);
    await db.query(`DELETE FROM client_contact_org_links WHERE client_company_id IN (${ids})`);
    await db.query(`DELETE FROM client_contacts WHERE client_company_id IN (${ids})`);
    await db.query(`DELETE FROM client_locations WHERE client_company_id IN (${ids})`);
    await db.query(`DELETE FROM client_companies WHERE id IN (${ids})`);
  }

  if (demoWorkerIds.length || demoCompanyIds.length) {
    await db.query(`DELETE FROM agency_contact_rules WHERE organization_id = $1`, [orgId]);
  }
  if (demoWorkerIds.length) {
    await db.query(`DELETE FROM users WHERE id IN (${inClause(demoWorkerIds)})`);
    console.log(`Cleaned up ${demoWorkerIds.length} demo sales team / temp account(s) and their history from the live database.`);
  }
}

async function run() {
  // Demo sales team members, report history, client company, assignment,
  // and manager task are only seeded against the in-memory pg-mem adapter
  // (local dev / smoke tests). Against a real Postgres database (production),
  // we still create the org + owner/manager logins + default task categories
  // so the app is immediately usable, but leave the roster empty so the
  // real agency owner can add their own real sales team.
  const seedDemoContent = db.isUsingMemory() || process.env.SEED_DEMO_DATA === 'true';

  const { rows: orgCheck } = await db.query(`SELECT id FROM organizations LIMIT 1`);
  if (orgCheck.length) {
    if (!seedDemoContent) await cleanupDemoContent(orgCheck[0].id);
    return; // already seeded
  }

  // Demo agency on the simple Starter tier — $299/month, $500 onboarding
  // fee waived by the Super Admin.
  const { rows: orgRows } = await db.query(
    `INSERT INTO organizations
       (name, plan, plan_price_cents, billing_status, is_founding_partner,
        setup_fee_cents, setup_fee_waived, setup_fee_paid, next_billing_date,
        payment_method_label, billing_contact_name, billing_email, signup_source)
     VALUES ($1,'founding',29900,'active',FALSE,50000,TRUE,FALSE,$2,'Demo card ending in 4242','Jordan Rivera','owner@summitstaffing.demo','manual')
     RETURNING id`,
    ['Twanova — Staffing Solutions', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)]
  );
  const orgId = orgRows[0].id;
  await db.query(
    `INSERT INTO billing_events (organization_id, type, amount_cents, description, status)
     VALUES ($1,'waiver',0,'Onboarding fee waived (initial demo agency)','waived')`,
    [orgId]
  );

  const { rows: branchRows } = await db.query(
    `INSERT INTO branches (organization_id, name, address) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, 'Main Branch', '100 Commerce Way, Springfield']
  );
  const branchId = branchRows[0].id;

  // Agency Owner/Admin — separate from the Manager account below, so the
  // Billing & Subscription page (owner-only) has someone to log in as.
  const ownerHash = await bcrypt.hash('owner123', 10);
  await db.query(
    `INSERT INTO users (organization_id, branch_id, role, name, email, password_hash)
     VALUES ($1, $2, 'owner', $3, $4, $5)`,
    [orgId, branchId, 'Jordan Rivera', 'owner@summitstaffing.demo', ownerHash]
  );

  const managerHash = await bcrypt.hash('manager123', 10);
  const { rows: managerRows } = await db.query(
    `INSERT INTO users (organization_id, branch_id, role, name, email, password_hash)
     VALUES ($1, $2, 'manager', $3, $4, $5) RETURNING id`,
    [orgId, branchId, 'Alex Rivera', 'manager@summitstaffing.demo', managerHash]
  );
  const managerId = managerRows[0].id;

  // Twanova's own platform operator login (Super Admin area).
  const platformHash = await bcrypt.hash('platform123', 10);
  await db.query(
    `INSERT INTO platform_admins (name, email, password_hash) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO NOTHING`,
    ['Twanova HQ', 'admin@twanova.platform', platformHash]
  );

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

  const workerIds = [];
  const tempIds = [];

  if (seedDemoContent) {
  const workerHash = await bcrypt.hash('worker123', 10);
  const workerNames = ['Sarah Chen', 'David Kim', 'Maria Lopez', 'James Patterson', 'Nina Ortiz'];
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
    [orgId, managerId, mariaId, 'Check in with Maria about placement/meeting mismatch', today]
  );

  // ════════════════════════════════════════════════════════════════════
  // ASSIGNMENT COMMUNICATION NETWORK — demo client company, contact,
  // on-call routing rule, and one live assignment for today so the full
  // worker → agency/client → acknowledgment loop is clickable immediately.
  // ════════════════════════════════════════════════════════════════════
  const { rows: clientRows } = await db.query(
    `INSERT INTO client_companies (organization_id, name, notes) VALUES ($1,$2,$3) RETURNING id`,
    [orgId, 'Meridian Distribution Center', 'Warehouse and light-industrial placements']
  );
  const clientCompanyId = clientRows[0].id;

  const { rows: locationRows } = await db.query(
    `INSERT INTO client_locations (organization_id, client_company_id, name, address) VALUES ($1,$2,$3,$4) RETURNING id`,
    [orgId, clientCompanyId, 'Building 3 — Receiving Dock', '4400 Freight Way, Springfield']
  );
  const clientLocationId = locationRows[0].id;

  const clientContactHash = await bcrypt.hash('client123', 10);
  const { rows: clientContactRows } = await db.query(
    `INSERT INTO client_contacts (organization_id, client_company_id, role, name, email, phone, password_hash)
     VALUES ($1,$2,'client_supervisor',$3,$4,$5,$6) RETURNING id`,
    [orgId, clientCompanyId, 'Priya Nair', 'supervisor@meridiandc.demo', '555-0142', clientContactHash]
  );
  const supervisorContactId = clientContactRows[0].id;

  // After-hours routing: the manager covers days, the owner covers
  // evenings and is also the emergency contact — configurable per agency,
  // never hard-coded (spec §16).
  await db.query(
    `INSERT INTO agency_contact_rules (organization_id, label, start_time, end_time, contact_user_id, is_emergency_contact, sort_order)
     VALUES ($1,'Daytime dispatch','06:00','18:00',$2,FALSE,0)`,
    [orgId, managerId]
  );
  const { rows: ownerRows } = await db.query(`SELECT id FROM users WHERE organization_id = $1 AND role = 'owner' LIMIT 1`, [orgId]);
  await db.query(
    `INSERT INTO agency_contact_rules (organization_id, label, start_time, end_time, contact_user_id, is_emergency_contact, sort_order)
     VALUES ($1,'Evening / emergency on-call','18:00','06:00',$2,TRUE,1)`,
    [orgId, ownerRows[0].id]
  );

  // Temps — a completely separate account type from the recruiter
  // "worker" role above. These are the people the agency actually sends
  // out to a client company's job site; they only use the Assignment
  // Communication Network (Today's Assignment screen), never the
  // recruiter dashboard, and vice versa.
  const tempHash = await bcrypt.hash('temp123', 10);
  const tempRoster = [
    { name: 'Marcus Webb', phone: '555-0198' },
    { name: 'Renee Alvarez', phone: '555-0173' },
  ];
  for (const fw of tempRoster) {
    const email = fw.name.toLowerCase().replace(/\s+/g, '.') + '@summitstaffing.demo';
    const { rows } = await db.query(
      `INSERT INTO users (organization_id, branch_id, role, name, email, phone, password_hash)
       VALUES ($1, $2, 'temp', $3, $4, $5, $6) RETURNING id`,
      [orgId, branchId, fw.name, email, fw.phone, tempHash]
    );
    tempIds.push({ id: rows[0].id, name: fw.name, email });
  }

  // Marcus Webb is on a live assignment today so the temp's
  // Today's Assignment screen and the manager/client views all have
  // something real to click through end-to-end.
  const marcusId = tempIds[0].id;
  await db.query(
    `INSERT INTO assignments
       (organization_id, worker_id, client_company_id, client_location_id, department,
        supervisor_contact_id, agency_contact_user_id, shift_date, start_time, end_time, notes, created_by_user_id)
     VALUES ($1,$2,$3,$4,'Receiving',$5,$6,$7,'08:00','16:30','First day on this placement — badge is at the front desk.',$8)`,
    [orgId, marcusId, clientCompanyId, clientLocationId, supervisorContactId, managerId, today, managerId]
  );
  } // end if (seedDemoContent)

  console.log(seedDemoContent
    ? 'Seeded demo organization "Twanova — Staffing Solutions" (Starter plan) with demo content.'
    : 'Seeded organization "Twanova — Staffing Solutions" (structure only — no demo sales team, reports, or assignments).');
  console.log('Owner login (billing dashboard): owner@summitstaffing.demo / owner123');
  console.log('Manager login: manager@summitstaffing.demo / manager123');
  if (workerIds.length) {
    console.log('Worker (recruiter) logins (any of):');
    for (const w of workerIds) console.log(`  ${w.email} / worker123  (${w.name})`);
  }
  if (tempIds.length) {
    console.log('Temp logins (/temp/login.html) — separate account type, used only for assignments:');
    for (const fw of tempIds) console.log(`  ${fw.email} / temp123  (${fw.name})`);
  }
  console.log('Super Admin login (/platform-admin/login.html): admin@twanova.platform / platform123');
  if (seedDemoContent) {
    console.log('Client company login (/client/login.html): supervisor@meridiandc.demo / client123  (Priya Nair, Meridian Distribution Center)');
    console.log(`Marcus Webb (temp) has a live assignment today at Meridian Distribution Center (8:00am-4:30pm).`);
  }
}

module.exports = { run, DEFAULT_CATEGORIES, GOALS };
