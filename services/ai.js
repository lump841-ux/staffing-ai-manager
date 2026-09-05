// Provider-agnostic AI layer. Every function here assembles real data from
// the database FIRST, then formats it into an answer. If OPENAI_API_KEY or
// ANTHROPIC_API_KEY is set, that structured data + the question would be
// handed to the LLM for a more natural-language answer (see callLLM below —
// currently a stub); until then, a deterministic rule-based formatter
// produces a real, grounded answer from the same data. Either way the
// manager never gets a generic, made-up response.
const reporting = require('./reporting');
const discrepancy = require('./discrepancy');
const db = require('./db');

function hasLLM() {
  return !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

// Stub — wire in a real fetch() to OpenAI/Anthropic here once a key exists.
// Keeping this as a single seam means swapping providers is a one-function change.
async function callLLM(systemPrompt, userQuestion, groundingData) {
  throw new Error('No LLM provider configured — falling back to rule-based mode');
}

async function safeLLMOrRuleBased(systemPrompt, question, groundingData, ruleBasedFn) {
  if (hasLLM()) {
    try {
      return await callLLM(systemPrompt, question, groundingData);
    } catch (e) {
      // fall through to rule-based
    }
  }
  return ruleBasedFn(groundingData);
}

function pct(n) {
  return `${Math.round(n)}%`;
}

async function morningBriefing(orgId) {
  const today = reporting.dateStr(new Date());
  const yesterday = reporting.addDays(today, -1);
  const yesterdaySummary = await reporting.computeTodaySummary(orgId, yesterday);
  const openDiscrepancies = (await discrepancy.listOpen(orgId, 'open')).filter(
    (d) => d.report_date === yesterday
  );

  const facts = {
    date: yesterday,
    goalCompletionPct: yesterdaySummary.goalCompletionPct,
    workersAboveGoal: yesterdaySummary.totalWorkers - yesterdaySummary.workersMissing.length - yesterdaySummary.workersBelowGoal.length,
    workersBelowGoal: yesterdaySummary.workersBelowGoal,
    workersMissing: yesterdaySummary.workersMissing,
    openDiscrepancyCount: openDiscrepancies.length,
  };

  const lines = [];
  lines.push('Good morning.');
  if (facts.goalCompletionPct != null) {
    lines.push(`Yesterday your team completed ${pct(facts.goalCompletionPct)} of its target.`);
  } else {
    lines.push(`Yesterday's numbers are in, but no goals are set yet to measure against.`);
  }
  if (facts.workersAboveGoal > 0) {
    lines.push(`${facts.workersAboveGoal} worker${facts.workersAboveGoal === 1 ? '' : 's'} met or exceeded goal.`);
  }
  if (facts.workersBelowGoal.length) {
    lines.push(`${facts.workersBelowGoal.length} worker${facts.workersBelowGoal.length === 1 ? ' was' : 's were'} below target: ${facts.workersBelowGoal.map((w) => w.name).join(', ')}.`);
  }
  if (facts.openDiscrepancyCount > 0) {
    lines.push(`${facts.openDiscrepancyCount} item${facts.openDiscrepancyCount === 1 ? '' : 's'} from yesterday appear inconsistent and should be reviewed.`);
  }
  const recommendations = [];
  for (const w of facts.workersBelowGoal.slice(0, 2)) {
    recommendations.push(`Follow up with ${w.name} — ${w.pct}% of goal yesterday.`);
  }
  for (const w of facts.workersMissing.slice(0, 2)) {
    recommendations.push(`Check in with ${w.name} — no report submitted yesterday.`);
  }
  if (facts.openDiscrepancyCount > 0) {
    recommendations.push(`Review ${facts.openDiscrepancyCount} flagged item${facts.openDiscrepancyCount === 1 ? '' : 's'} in Needs Review.`);
  }

  const text = lines.join(' ');
  return { facts, text, recommendations };
}

async function endOfDayBriefing(orgId, date) {
  date = date || reporting.dateStr(new Date());
  const yesterday = reporting.addDays(date, -1);
  const todaySummary = await reporting.computeTodaySummary(orgId, date);
  const yesterdaySummary = await reporting.computeTodaySummary(orgId, yesterday);
  const flags = (await discrepancy.listOpen(orgId, 'open')).filter((d) => d.report_date === date);

  const changeFromYesterday = yesterdaySummary.totalActivity > 0
    ? Math.round(((todaySummary.totalActivity - yesterdaySummary.totalActivity) / yesterdaySummary.totalActivity) * 100)
    : null;

  const facts = {
    date,
    totalActivity: todaySummary.totalActivity,
    goalCompletionPct: todaySummary.goalCompletionPct,
    topPerformer: todaySummary.topPerformer,
    workersBelowGoal: todaySummary.workersBelowGoal,
    workersMissing: todaySummary.workersMissing,
    unusualCount: flags.length,
    changeFromYesterdayPct: changeFromYesterday,
  };

  const lines = [];
  lines.push(`Today's total: ${facts.totalActivity} activities.`);
  if (facts.goalCompletionPct != null) lines.push(`Goal completion: ${pct(facts.goalCompletionPct)}.`);
  if (facts.topPerformer) lines.push(`Top performer: ${facts.topPerformer.name} (${facts.topPerformer.total}).`);
  if (facts.workersBelowGoal.length) lines.push(`${facts.workersBelowGoal.length} below goal: ${facts.workersBelowGoal.map((w) => w.name).join(', ')}.`);
  if (facts.workersMissing.length) lines.push(`${facts.workersMissing.length} missing submission${facts.workersMissing.length === 1 ? '' : 's'}: ${facts.workersMissing.map((w) => w.name).join(', ')}.`);
  if (facts.unusualCount) lines.push(`${facts.unusualCount} item${facts.unusualCount === 1 ? '' : 's'} flagged for review today.`);
  if (facts.changeFromYesterdayPct != null) {
    lines.push(`That's ${facts.changeFromYesterdayPct >= 0 ? 'up' : 'down'} ${Math.abs(facts.changeFromYesterdayPct)}% from yesterday.`);
  }

  return { facts, text: lines.join(' ') };
}

async function fridayExecutiveSummary(orgId, weekStart) {
  const week = await reporting.computeWeekSummary(orgId, weekStart);
  const flags = await discrepancy.listOpen(orgId, null);
  const weekFlags = flags.filter((f) => f.report_date >= weekStart && f.report_date <= week.weekEnd);
  const missing = [];
  const workers = await reporting.getWorkers(orgId);
  const reports = await reporting.getReportsInRange(orgId, weekStart, week.weekEnd);
  for (const w of workers) {
    let count = 0;
    for (let i = 0; i < 5; i++) {
      const d = reporting.addDays(weekStart, i);
      if (reports[w.id] && reports[w.id][d]) count++;
    }
    if (count < 5) missing.push({ name: w.name, missedDays: 5 - count });
  }

  const facts = {
    weekTotal: week.weekTotal,
    priorWeekTotal: week.priorWeekTotal,
    pctChange: week.pctChange,
    bestDay: week.bestDay,
    worstDay: week.worstDay,
    topWorker: week.topWorker,
    mostImproved: week.mostImproved,
    missedSubmissions: missing,
    discrepancyCount: weekFlags.length,
  };

  const interpretationLines = [];
  if (facts.pctChange != null) {
    interpretationLines.push(
      facts.pctChange >= 0
        ? `Activity is trending up week over week — worth reinforcing whatever changed.`
        : `Activity dipped from last week — check whether it's tied to specific workers or specific categories before assuming a broad slowdown.`
    );
  }
  if (facts.missedSubmissions.length) {
    interpretationLines.push(`Missed submissions this week may be undercounting real activity — those workers' numbers could be higher than shown.`);
  }
  if (facts.discrepancyCount > 0) {
    interpretationLines.push(`${facts.discrepancyCount} flagged item${facts.discrepancyCount === 1 ? '' : 's'} this week should be cleared before trusting the totals fully.`);
  }

  const priorities = [];
  if (facts.worstDay) priorities.push(`Look at what was different on ${facts.worstDay.toLowerCase()} vs. ${facts.bestDay ? facts.bestDay.toLowerCase() : 'the best day'}.`);
  if (facts.missedSubmissions.length) priorities.push(`Follow up on ${facts.missedSubmissions.length} missed submission${facts.missedSubmissions.length === 1 ? '' : 's'}.`);
  if (facts.discrepancyCount > 0) priorities.push(`Clear the Needs Review queue (${facts.discrepancyCount} open).`);

  return { facts, interpretation: interpretationLines, priorities };
}

// Handles the manager's typed/spoken questions. Pattern-matches intent,
// pulls real data for that intent, and returns {facts, interpretation}.
async function answerQuestion(orgId, question) {
  const q = question.toLowerCase();
  const today = reporting.dateStr(new Date());
  const weekStart = reporting.mondayOf(today);

  if (/how are we doing|today/.test(q) && !/week/.test(q)) {
    const s = await reporting.computeTodaySummary(orgId, today);
    return {
      facts: s,
      interpretation: s.goalCompletionPct == null
        ? `No goals are set yet, so I can only show raw totals.`
        : s.goalCompletionPct >= 90
        ? `That's a strong day — close to full goal completion.`
        : s.goalCompletionPct >= 70
        ? `Solid but not quite on pace — worth a nudge on the categories lagging most.`
        : `Below where you'd want to be today — worth checking in with whoever's furthest behind.`,
    };
  }

  if (/hasn'?t submitted|missing|who.*not report/.test(q)) {
    const s = await reporting.computeTodaySummary(orgId, today);
    return {
      facts: { workersMissing: s.workersMissing },
      interpretation: s.workersMissing.length
        ? `${s.workersMissing.map((w) => w.name).join(', ')} ha${s.workersMissing.length === 1 ? 's' : 've'} not submitted today's numbers yet.`
        : `Everyone has submitted today.`,
    };
  }

  if (/falling behind|below goal|struggling/.test(q)) {
    const s = await reporting.computeTodaySummary(orgId, today);
    return {
      facts: { workersBelowGoal: s.workersBelowGoal },
      interpretation: s.workersBelowGoal.length
        ? `${s.workersBelowGoal.map((w) => `${w.name} (${w.pct}% of goal)`).join(', ')} are currently below target.`
        : `No one is below goal right now.`,
    };
  }

  if (/compare.*week|week.*compare|vs\.? last week|last week/.test(q)) {
    const week = await reporting.computeWeekSummary(orgId, weekStart);
    return {
      facts: week,
      interpretation: week.pctChange == null
        ? `Not enough prior-week data yet to compare.`
        : `This week is ${week.pctChange >= 0 ? 'up' : 'down'} ${Math.abs(week.pctChange)}% vs. last week (${week.weekTotal} vs. ${week.priorWeekTotal}).`,
    };
  }

  if (/why.*down|why.*numbers|decline|dropped/.test(q)) {
    const week = await reporting.computeWeekSummary(orgId, weekStart);
    const s = await reporting.computeTodaySummary(orgId, today);
    const reasons = [];
    if (s.workersMissing.length) reasons.push(`${s.workersMissing.length} worker${s.workersMissing.length === 1 ? '' : 's'} haven't submitted today, which understates the total.`);
    if (s.workersBelowGoal.length) reasons.push(`${s.workersBelowGoal.map((w) => w.name).join(', ')} ${s.workersBelowGoal.length === 1 ? 'is' : 'are'} tracking below goal.`);
    return {
      facts: { week, today: s },
      interpretation: reasons.length ? reasons.join(' ') : `Numbers look on pace — nothing obvious is pulling the total down right now.`,
    };
  }

  if (/who improved|most improved/.test(q)) {
    const week = await reporting.computeWeekSummary(orgId, weekStart);
    return {
      facts: { mostImproved: week.mostImproved },
      interpretation: week.mostImproved
        ? `${week.mostImproved.name} improved the most this week: ${week.mostImproved.total} vs. ${week.mostImproved.prior} last week (+${week.mostImproved.delta}).`
        : `Not enough prior-week data yet to determine most improved.`,
    };
  }

  if (/doesn'?t add up|discrepan|needs review|inconsisten/.test(q)) {
    const open = await discrepancy.listOpen(orgId, 'open');
    return {
      facts: { open },
      interpretation: open.length
        ? `${open.length} item${open.length === 1 ? '' : 's'} flagged for review: ${open.slice(0, 3).map((d) => `${d.worker_name} — ${d.explanation}`).join(' | ')}${open.length > 3 ? ', and more.' : ''}`
        : `Nothing is currently flagged for review.`,
    };
  }

  if (/concentrate.*tomorrow|focus.*tomorrow|tomorrow/.test(q)) {
    const s = await reporting.computeTodaySummary(orgId, today);
    const open = await discrepancy.listOpen(orgId, 'open');
    const items = [];
    for (const w of s.workersBelowGoal.slice(0, 2)) items.push(`Follow up with ${w.name} on today's shortfall.`);
    for (const w of s.workersMissing.slice(0, 2)) items.push(`Check in with ${w.name} — no report today.`);
    if (open.length) items.push(`Clear ${open.length} item${open.length === 1 ? '' : 's'} in Needs Review.`);
    return { facts: { workersBelowGoal: s.workersBelowGoal, workersMissing: s.workersMissing, openDiscrepancies: open.length }, interpretation: items.length ? items.join(' ') : `No urgent follow-ups — good day to work ahead on next week.` };
  }

  if (/friday report|weekly report|executive summary/.test(q)) {
    const summary = await fridayExecutiveSummary(orgId, weekStart);
    return { facts: summary.facts, interpretation: summary.interpretation.join(' ') };
  }

  if (/coaching|need.*help|struggl/.test(q)) {
    const week = await reporting.computeWeekSummary(orgId, weekStart);
    const s = await reporting.computeTodaySummary(orgId, today);
    const candidates = s.workersBelowGoal.map((w) => w.name);
    return {
      facts: { candidates },
      interpretation: candidates.length
        ? `${candidates.join(', ')} may benefit from coaching based on today's below-goal numbers. Check their trend over the last week before deciding on a topic.`
        : `No one stands out for coaching today based on the numbers.`,
    };
  }

  return {
    facts: {},
    interpretation: `I can answer questions about today's numbers, this week vs. last week, who's missing or below goal, discrepancies, and the Friday report. Try asking one of those directly.`,
  };
}

// Very simple rule-based parser for "Remind me to talk to John tomorrow" style requests.
// Never fabricates a date it can't find — falls back to no due date rather than guessing.
function parseTaskFromText(text, workers) {
  const lower = text.toLowerCase();
  const today = new Date();
  let dueDate = null;

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    dueDate = d.toISOString().slice(0, 10);
  } else if (/\btoday\b/.test(lower)) {
    dueDate = today.toISOString().slice(0, 10);
  } else {
    for (let i = 0; i < dayNames.length; i++) {
      if (lower.includes(dayNames[i])) {
        const d = new Date(today);
        const diff = (i - d.getDay() + 7) % 7 || 7;
        d.setDate(d.getDate() + diff);
        dueDate = d.toISOString().slice(0, 10);
        break;
      }
    }
  }

  let relatedWorkerId = null;
  let relatedWorkerName = null;
  for (const w of workers) {
    const first = w.name.split(' ')[0].toLowerCase();
    if (lower.includes(first)) {
      relatedWorkerId = w.id;
      relatedWorkerName = w.name;
      break;
    }
  }

  const title = text.replace(/^remind me to /i, '').replace(/^create a? ?/i, '').trim();

  return { title: title || text, dueDate, relatedWorkerId, relatedWorkerName };
}

module.exports = {
  hasLLM,
  morningBriefing,
  endOfDayBriefing,
  fridayExecutiveSummary,
  answerQuestion,
  parseTaskFromText,
};
