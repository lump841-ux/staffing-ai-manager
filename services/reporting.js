// Shared read-side calculations used by both the manager routes and the
// AI layer. Everything here computes live from daily_reports /
// daily_report_values — nothing is cached, so the dashboard is never stale.
const db = require('./db');

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

// Normalizes anything that represents a calendar date — a JS Date object
// (pg-mem/pg sometimes return DATE columns as Date), or a 'YYYY-MM-DD'
// string, or a full ISO timestamp string — into a plain 'YYYY-MM-DD'
// string. All date math in this file works off that normalized form.
function normalizeDateStr(input) {
  if (input instanceof Date) return dateStr(input);
  if (typeof input === 'string') return input.slice(0, 10);
  throw new Error('Unrecognized date value: ' + input);
}

function mondayOf(dateInput) {
  const norm = normalizeDateStr(dateInput);
  const d = new Date(norm + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return dateStr(d);
}

function addDays(dateStrIn, n) {
  const norm = normalizeDateStr(dateStrIn);
  const d = new Date(norm + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return dateStr(d);
}

async function getActiveCategories(orgId) {
  const { rows } = await db.query(
    `SELECT id, key, label, description, sort_order FROM activity_categories
     WHERE organization_id = $1 AND is_active = TRUE ORDER BY sort_order, id`,
    [orgId]
  );
  return rows;
}

async function getWorkers(orgId) {
  const { rows } = await db.query(
    `SELECT id, name, email FROM users
     WHERE organization_id = $1 AND role = 'worker' AND active = TRUE ORDER BY name`,
    [orgId]
  );
  return rows;
}

async function getWorkerGoals(orgId) {
  const { rows } = await db.query(
    `SELECT wg.worker_id, wg.category_id, wg.daily_target
     FROM worker_goals wg
     JOIN users u ON u.id = wg.worker_id
     WHERE u.organization_id = $1`,
    [orgId]
  );
  return rows;
}

// Map of worker_id -> { report_date -> { category_id -> value } } plus report meta
async function getReportsInRange(orgId, startDate, endDate) {
  const { rows } = await db.query(
    `SELECT dr.id as report_id, dr.worker_id, dr.report_date, dr.notes, dr.obstacles,
            drv.category_id, drv.value
     FROM daily_reports dr
     LEFT JOIN daily_report_values drv ON drv.daily_report_id = dr.id
     WHERE dr.organization_id = $1 AND dr.report_date BETWEEN $2 AND $3
     ORDER BY dr.report_date, dr.worker_id`,
    [orgId, startDate, endDate]
  );
  const byWorker = {};
  for (const r of rows) {
    const rd = normalizeDateStr(r.report_date);
    byWorker[r.worker_id] = byWorker[r.worker_id] || {};
    byWorker[r.worker_id][rd] = byWorker[r.worker_id][rd] || {
      reportId: r.report_id,
      notes: r.notes,
      obstacles: r.obstacles,
      values: {},
      total: 0,
    };
    if (r.category_id != null) {
      byWorker[r.worker_id][rd].values[r.category_id] = r.value;
      byWorker[r.worker_id][rd].total += r.value;
    }
  }
  return byWorker;
}

async function computeTodaySummary(orgId, date) {
  const [workers, categories, reports, goals] = await Promise.all([
    getWorkers(orgId),
    getActiveCategories(orgId),
    getReportsInRange(orgId, date, date),
    getWorkerGoals(orgId),
  ]);

  const goalTotalPerWorker = {};
  for (const g of goals) {
    goalTotalPerWorker[g.worker_id] = (goalTotalPerWorker[g.worker_id] || 0) + g.daily_target;
  }

  let totalActivity = 0;
  let totalGoal = 0;
  const reporting = [];
  const missing = [];
  const belowGoal = [];
  let topWorker = null;

  for (const w of workers) {
    const today = reports[w.id] && reports[w.id][date];
    const goal = goalTotalPerWorker[w.id] || 0;
    totalGoal += goal;
    if (today) {
      reporting.push(w);
      totalActivity += today.total;
      const pct = goal > 0 ? today.total / goal : null;
      if (pct !== null && pct < 1) belowGoal.push({ worker: w, total: today.total, goal, pct });
      if (!topWorker || today.total > topWorker.total) topWorker = { worker: w, total: today.total };
    } else {
      missing.push(w);
    }
  }

  const goalCompletionPct = totalGoal > 0 ? Math.round((totalActivity / totalGoal) * 100) : null;

  return {
    date,
    totalActivity,
    totalGoal,
    goalCompletionPct,
    workersReporting: reporting.length,
    workersMissing: missing.map((w) => ({ id: w.id, name: w.name })),
    topPerformer: topWorker ? { id: topWorker.worker.id, name: topWorker.worker.name, total: topWorker.total } : null,
    workersBelowGoal: belowGoal.map((b) => ({ id: b.worker.id, name: b.worker.name, total: b.total, goal: b.goal, pct: Math.round(b.pct * 100) })),
    totalWorkers: workers.length,
  };
}

async function computeWeekSummary(orgId, weekStart) {
  const weekEnd = addDays(weekStart, 4); // Mon..Fri
  const priorWeekStart = addDays(weekStart, -7);
  const priorWeekEnd = addDays(weekStart, -3);

  const [reports, priorReports, workers] = await Promise.all([
    getReportsInRange(orgId, weekStart, weekEnd),
    getReportsInRange(orgId, priorWeekStart, priorWeekEnd),
    getWorkers(orgId),
  ]);

  const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  const dailyTotals = {};
  let weekTotal = 0;
  const perWorkerWeekTotal = {};

  for (let i = 0; i < 5; i++) {
    const d = addDays(weekStart, i);
    let dayTotal = 0;
    for (const w of workers) {
      const rec = reports[w.id] && reports[w.id][d];
      if (rec) {
        dayTotal += rec.total;
        perWorkerWeekTotal[w.id] = (perWorkerWeekTotal[w.id] || 0) + rec.total;
      }
    }
    dailyTotals[days[i]] = dayTotal;
    weekTotal += dayTotal;
  }

  let priorWeekTotal = 0;
  const priorPerWorkerTotal = {};
  for (let i = 0; i < 5; i++) {
    const d = addDays(priorWeekStart, i);
    for (const w of workers) {
      const rec = priorReports[w.id] && priorReports[w.id][d];
      if (rec) {
        priorWeekTotal += rec.total;
        priorPerWorkerTotal[w.id] = (priorPerWorkerTotal[w.id] || 0) + rec.total;
      }
    }
  }

  const pctChange = priorWeekTotal > 0 ? Math.round(((weekTotal - priorWeekTotal) / priorWeekTotal) * 1000) / 10 : null;

  let bestDay = null;
  let worstDay = null;
  for (const [day, total] of Object.entries(dailyTotals)) {
    if (!bestDay || total > dailyTotals[bestDay]) bestDay = day;
    if (!worstDay || total < dailyTotals[worstDay]) worstDay = day;
  }

  let topWorker = null;
  let mostImproved = null;
  let mostImprovedDelta = -Infinity;
  for (const w of workers) {
    const total = perWorkerWeekTotal[w.id] || 0;
    if (!topWorker || total > topWorker.total) topWorker = { id: w.id, name: w.name, total };
    const prior = priorPerWorkerTotal[w.id] || 0;
    const delta = total - prior;
    if (prior > 0 && delta > mostImprovedDelta) {
      mostImprovedDelta = delta;
      mostImproved = { id: w.id, name: w.name, total, prior, delta };
    }
  }

  return {
    weekStart,
    weekEnd,
    dailyTotals,
    weekTotal,
    priorWeekTotal,
    pctChange,
    bestDay,
    worstDay,
    topWorker,
    mostImproved,
    dailyAverage: Math.round((weekTotal / 5) * 10) / 10,
    workerAverage: workers.length ? Math.round((weekTotal / workers.length) * 10) / 10 : 0,
  };
}

async function getWorkerTrailingAverage(orgId, workerId, categoryId, beforeDate, days = 7) {
  const start = addDays(beforeDate, -days);
  const end = addDays(beforeDate, -1);
  const { rows } = await db.query(
    `SELECT AVG(drv.value)::float as avg_value, COUNT(*)::int as n
     FROM daily_reports dr
     JOIN daily_report_values drv ON drv.daily_report_id = dr.id
     WHERE dr.organization_id = $1 AND dr.worker_id = $2 AND drv.category_id = $3
       AND dr.report_date BETWEEN $4 AND $5`,
    [orgId, workerId, categoryId, start, end]
  );
  return rows[0] || { avg_value: null, n: 0 };
}

module.exports = {
  dateStr,
  normalizeDateStr,
  mondayOf,
  addDays,
  getActiveCategories,
  getWorkers,
  getWorkerGoals,
  getReportsInRange,
  computeTodaySummary,
  computeWeekSummary,
  getWorkerTrailingAverage,
};
