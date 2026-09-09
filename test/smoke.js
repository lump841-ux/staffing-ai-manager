// Lightweight smoke suite — no external framework. Boots the app with the
// in-memory adapter, seeds demo data, and hits the real HTTP endpoints.
process.env.PG_TEST_ADAPTER = 'pgmem';
process.env.SESSION_SECRET = 'test-secret';

const http = require('http');
const path = require('path');

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

function request(port, method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: 'localhost', port, path: urlPath, method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) {}
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getCookie(res) {
  const sc = res.headers['set-cookie'];
  return sc ? sc[0].split(';')[0] : null;
}

async function main() {
  delete require.cache[require.resolve(path.join(__dirname, '..', 'server.js'))];

  // Load server as a child process instead of require, to get a clean port.
  const { spawn } = require('child_process');
  const port = 4501;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'pipe',
  });

  await new Promise((resolve, reject) => {
    let out = '';
    const timeout = setTimeout(() => reject(new Error('Server did not start in time. Output: ' + out)), 8000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('running at')) { clearTimeout(timeout); resolve(); }
    });
    server.stderr.on('data', (d) => (out += d.toString()));
  });

  try {
    console.log('\n── Auth + RBAC ──');
    let res = await request(port, 'POST', '/api/auth/login', { email: 'manager@summitstaffing.demo', password: 'wrong' });
    ok(res.status === 401, 'Wrong password is rejected');

    res = await request(port, 'POST', '/api/auth/login', { email: 'manager@summitstaffing.demo', password: 'manager123' });
    ok(res.status === 200 && res.json.user.role === 'manager', 'Manager logs in successfully');
    const managerCookie = getCookie(res);

    res = await request(port, 'POST', '/api/auth/login', { email: 'sarah.chen@summitstaffing.demo', password: 'worker123' });
    ok(res.status === 200 && res.json.user.role === 'worker', 'Worker logs in successfully');
    const workerCookie = getCookie(res);

    res = await request(port, 'GET', '/api/manager/today', null, workerCookie);
    ok(res.status === 403, 'Worker is forbidden from manager/today');

    res = await request(port, 'GET', '/api/worker/today', null, managerCookie);
    ok(res.status === 403, 'Manager is forbidden from worker/today (separate role space)');

    res = await request(port, 'GET', '/api/manager/time-entries', null, workerCookie);
    ok(res.status === 403, 'Worker cannot read manager-only time entries');

    console.log('\n── Worker daily submission ──');
    res = await request(port, 'GET', '/api/worker/today', null, workerCookie);
    ok(res.status === 200 && Array.isArray(res.json.categories) && res.json.categories.length > 0, 'Worker sees active categories with goals');
    const categoryIds = res.json.categories.map((c) => c.id);

    const values = {};
    for (const id of categoryIds) values[id] = 5;
    res = await request(port, 'POST', '/api/worker/submit', { values, notes: 'test note', obstacles: '' }, workerCookie);
    ok(res.status === 200, 'Worker can submit today\'s numbers');

    res = await request(port, 'GET', '/api/worker/today', null, workerCookie);
    ok(res.json.alreadySubmitted === true, 'Today shows as already submitted after posting');

    console.log('\n── Manager dashboard reads real data ──');
    res = await request(port, 'GET', '/api/manager/today', null, managerCookie);
    ok(res.status === 200 && typeof res.json.totalActivity === 'number', 'Manager today summary computes a real total');
    ok(res.json.totalWorkers === 5, 'Manager today summary sees all 5 seeded workers');

    res = await request(port, 'GET', '/api/manager/week', null, managerCookie);
    ok(res.status === 200 && typeof res.json.weekTotal === 'number', 'Manager week summary computes a real week total');

    res = await request(port, 'GET', '/api/manager/workers', null, managerCookie);
    ok(res.status === 200 && res.json.length === 5, 'Manager roster lists all 5 workers');

    console.log('\n── Category manager ──');
    res = await request(port, 'POST', '/api/manager/categories', { key: 'test_cat', label: 'Test category' }, managerCookie);
    ok(res.status === 200 && res.json.key === 'test_cat', 'Manager can add a custom category');

    res = await request(port, 'POST', '/api/manager/categories', { key: 'x', label: 'x' }, workerCookie);
    ok(res.status === 403, 'Worker cannot add categories');

    console.log('\n── Manager time entry (strictly separate from worker portal) ──');
    res = await request(port, 'GET', '/api/manager/workers', null, managerCookie);
    const someWorkerId = res.json[0].id;
    res = await request(port, 'POST', '/api/manager/time-entries', { workerId: someWorkerId, entryDate: '2026-01-05', hoursWorked: 8, entryType: 'regular' }, managerCookie);
    ok(res.status === 200, 'Manager can add a time entry');

    res = await request(port, 'GET', '/api/manager/time-entries', null, managerCookie);
    ok(res.json.some((e) => e.worker_id === someWorkerId), 'Time entry appears in manager list');

    console.log('\n── Discrepancy detection ──');
    res = await request(port, 'GET', '/api/manager/discrepancies?status=open', null, managerCookie);
    ok(res.status === 200 && Array.isArray(res.json), 'Discrepancy queue is readable');
    ok(res.json.every((d) => typeof d.explanation === 'string' && d.explanation.length > 0), 'Every flagged item has a human-readable explanation');

    if (res.json.length) {
      const id = res.json[0].id;
      const setRes = await request(port, 'PUT', '/api/manager/discrepancies/' + id, { status: 'reviewed' }, managerCookie);
      ok(setRes.status === 200 && setRes.json.status === 'reviewed', 'Manager can mark a discrepancy reviewed');
    }

    console.log('\n── Friday report + AI assistant (grounded, no LLM key) ──');
    res = await request(port, 'GET', '/api/manager/friday-report', null, managerCookie);
    ok(res.status === 200 && res.json.week && res.json.executiveSummary, 'Friday report returns week data + executive summary');

    res = await request(port, 'POST', '/api/manager/ai/ask', { question: "Who hasn't submitted their numbers?" }, managerCookie);
    ok(res.status === 200 && typeof res.json.interpretation === 'string', 'AI assistant answers a grounded question');
    ok(res.json.llmActive === false, 'AI reports it is running in rule-based mode with no key configured');

    console.log('\n── Manager task center ──');
    res = await request(port, 'POST', '/api/manager/tasks/parse', { text: 'Remind me to talk to Sarah tomorrow' }, managerCookie);
    ok(res.status === 200 && res.json.related_worker_name === 'Sarah Chen', 'AI task parser links the task to the right worker by name');
    ok(!!res.json.due_date, 'AI task parser resolves "tomorrow" to a real date');

    res = await request(port, 'GET', '/api/manager/tasks', null, managerCookie);
    ok(res.json.length >= 2, 'Task list includes the seeded task and the newly created one');

    console.log('\n── Worker work history ──');
    res = await request(port, 'GET', '/api/worker/work-history', null, workerCookie);
    ok(res.status === 200 && Array.isArray(res.json.dailyReports), 'Worker can read their own work history');
    ok(res.json.dailyReports.some((r) => r.notes === 'test note'), "Today's submission appears in the worker's own history, notes intact");
    ok(res.json.selfClockinEnabled === false, 'Self clock-in reports as off by default');

    console.log('\n── Self clock-in (off-by-default, owner-controlled toggle) ──');
    res = await request(port, 'GET', '/api/manager/settings', null, managerCookie);
    ok(res.status === 200 && res.json.selfClockinEnabled === false, 'Settings show self clock-in off by default');

    res = await request(port, 'POST', '/api/worker/clock-in', {}, workerCookie);
    ok(res.status === 403, 'Worker cannot clock in while the feature is off');

    res = await request(port, 'PUT', '/api/manager/settings', { selfClockinEnabled: true }, managerCookie);
    ok(res.status === 403, 'Non-owner manager cannot change the self clock-in setting');

    res = await request(port, 'POST', '/api/auth/login', { email: 'owner@summitstaffing.demo', password: 'owner123' });
    ok(res.status === 200 && res.json.user.role === 'owner', 'Owner logs in successfully');
    const ownerCookie = getCookie(res);

    res = await request(port, 'PUT', '/api/manager/settings', { selfClockinEnabled: true }, ownerCookie);
    ok(res.status === 200 && res.json.selfClockinEnabled === true, 'Owner can turn self clock-in on');

    res = await request(port, 'GET', '/api/worker/clock-status', null, workerCookie);
    ok(res.status === 200 && res.json.enabled === true && res.json.openEntry === null, 'Worker sees clock-in now enabled, nothing open yet');

    res = await request(port, 'POST', '/api/worker/clock-in', {}, workerCookie);
    ok(res.status === 200 && !!res.json.entry.clock_in_at, 'Worker can clock in once the feature is on');

    res = await request(port, 'POST', '/api/worker/clock-in', {}, workerCookie);
    ok(res.status === 400, 'Worker cannot clock in twice in a row');

    console.log('\n── Breaks (within a clock-in) ──');
    res = await request(port, 'POST', '/api/worker/break-end', {}, workerCookie);
    ok(res.status === 400, 'Worker cannot end a break with none open');

    res = await request(port, 'POST', '/api/worker/break-start', {}, workerCookie);
    ok(res.status === 200 && !!res.json.breakEntry.break_start_at, 'Worker can start a break while clocked in');

    res = await request(port, 'POST', '/api/worker/break-start', {}, workerCookie);
    ok(res.status === 400, 'Worker cannot start a second break while already on one');

    res = await request(port, 'GET', '/api/worker/clock-status', null, workerCookie);
    ok(res.status === 200 && res.json.openBreak !== null, 'Clock status reflects the open break');

    res = await request(port, 'POST', '/api/worker/break-end', {}, workerCookie);
    ok(res.status === 200 && !!res.json.breakEntry.break_end_at, 'Worker can end the break');

    res = await request(port, 'GET', '/api/worker/clock-status', null, workerCookie);
    ok(res.status === 200 && res.json.openBreak === null, 'Clock status shows no open break after ending it');

    // Start a second break and clock out without ending it — clock-out must
    // auto-close any dangling open break.
    res = await request(port, 'POST', '/api/worker/break-start', {}, workerCookie);
    ok(res.status === 200, 'Worker can start another break');

    res = await request(port, 'POST', '/api/worker/clock-out', {}, workerCookie);
    ok(res.status === 200 && !!res.json.entry.clock_out_at, 'Worker can clock out');

    res = await request(port, 'GET', '/api/worker/work-history', null, workerCookie);
    ok(res.json.selfClockinEnabled === true && res.json.clockEntries.length === 1, "Clock entry shows up in the worker's own history once enabled");
    const clockEntryWithBreaks = res.json.clockEntries[0];
    ok(Array.isArray(clockEntryWithBreaks.breaks) && clockEntryWithBreaks.breaks.length === 2, 'Both breaks appear nested under the clock entry in work history');
    ok(clockEntryWithBreaks.breaks.every((b) => !!b.break_end_at), 'Clocking out auto-closed the dangling open break');

    console.log('\n── Page routing / RBAC on pages ──');
    res = await request(port, 'GET', '/dashboard/manager', null, workerCookie);
    ok(res.status === 302, 'Worker hitting the manager dashboard page is redirected, not shown the page');

    res = await request(port, 'GET', '/dashboard/worker', null, managerCookie);
    ok(res.status === 302, 'Manager hitting the worker dashboard page is redirected, not shown the page');

  } finally {
    server.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
