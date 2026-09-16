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
    ok(res.status === 200 && res.json.user.role === 'worker', 'Worker (recruiter) logs in successfully');
    const workerCookie = getCookie(res);

    res = await request(port, 'POST', '/api/auth/login', { email: 'marcus.webb@summitstaffing.demo', password: 'temp123' });
    ok(res.status === 200 && res.json.user.role === 'temp', 'Field worker logs in successfully, separate account type from the recruiter worker');
    const tempCookie = getCookie(res);

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

    console.log('\n── Add / remove sales team member ──');
    res = await request(port, 'POST', '/api/manager/workers-new', { name: 'Smoke Test Worker', email: 'smoke.test.worker@summitstaffing.demo', password: 'temp123' }, managerCookie);
    ok(res.status === 200 && res.json.id, 'Manager can add a sales team member');
    const smokeWorkerId = res.json.id;

    res = await request(port, 'GET', '/api/manager/workers', null, managerCookie);
    ok(res.status === 200 && res.json.length === 6 && res.json.some((w) => w.id === smokeWorkerId), 'New sales team member appears on the roster');

    res = await request(port, 'POST', '/api/manager/workers-new', { name: 'Dup', email: 'smoke.test.worker@summitstaffing.demo', password: 'temp123' }, managerCookie);
    ok(res.status === 400, 'Adding a duplicate email is rejected with a clear error, not a silent failure');

    res = await request(port, 'DELETE', `/api/manager/workers/${smokeWorkerId}`, null, workerCookie);
    ok(res.status === 403, 'Worker cannot remove a sales team member');

    res = await request(port, 'DELETE', `/api/manager/workers/${smokeWorkerId}`, null, managerCookie);
    ok(res.status === 200 && res.json.ok === true, 'Manager can remove a sales team member');

    res = await request(port, 'GET', '/api/manager/workers', null, managerCookie);
    ok(res.status === 200 && res.json.length === 5 && !res.json.some((w) => w.id === smokeWorkerId), 'Removed sales team member drops off the roster immediately');

    res = await request(port, 'DELETE', `/api/manager/workers/${smokeWorkerId}`, null, managerCookie);
    ok(res.status === 404, 'Removing an already-removed sales team member returns 404, not a crash');

    console.log('\n── Category manager ──');
    res = await request(port, 'POST', '/api/manager/categories', { key: 'test_cat', label: 'Test category' }, managerCookie);
    ok(res.status === 200 && res.json.key === 'test_cat', 'Manager can add a custom category');
    const testCategoryId = res.json.id;

    res = await request(port, 'POST', '/api/manager/categories', { key: 'x', label: 'x' }, workerCookie);
    ok(res.status === 403, 'Worker cannot add categories');

    console.log('\n── Task assignment (category -> specific sales team members) ──');
    res = await request(port, 'GET', '/api/manager/categories', null, managerCookie);
    ok(res.status === 200 && res.json.every((c) => Array.isArray(c.assignedWorkerIds)), 'Every category includes an assignedWorkerIds array');
    ok(res.json.find((c) => c.id === testCategoryId).assignedWorkerIds.length === 0, 'New category starts unassigned (applies to everyone)');

    res = await request(port, 'GET', '/api/manager/workers', null, managerCookie);
    const assignWorkerId = res.json[0].id;

    res = await request(port, 'PUT', `/api/manager/categories/${testCategoryId}/assign`, { workerIds: [assignWorkerId] }, managerCookie);
    ok(res.status === 200 && res.json.workerIds.includes(assignWorkerId), 'Manager can assign a category to a specific sales team member');

    res = await request(port, 'GET', '/api/manager/categories', null, managerCookie);
    ok(JSON.stringify(res.json.find((c) => c.id === testCategoryId).assignedWorkerIds) === JSON.stringify([assignWorkerId]), 'Assignment is reflected back on the category list');

    res = await request(port, 'PUT', `/api/manager/categories/${testCategoryId}/assign`, { workerIds: [] }, managerCookie);
    ok(res.status === 200, 'Manager can clear an assignment back to everyone');
    res = await request(port, 'GET', '/api/manager/categories', null, managerCookie);
    ok(res.json.find((c) => c.id === testCategoryId).assignedWorkerIds.length === 0, 'Cleared category shows no assignments again');

    res = await request(port, 'PUT', `/api/manager/categories/${testCategoryId}/assign`, { workerIds: [999999] }, managerCookie);
    ok(res.status === 200 && res.json.workerIds.length === 1, 'Assign accepts the request even with a bogus worker id (silently ignored)');
    res = await request(port, 'GET', '/api/manager/categories', null, managerCookie);
    ok(res.json.find((c) => c.id === testCategoryId).assignedWorkerIds.length === 0, 'Bogus worker id is not actually persisted as an assignment');

    res = await request(port, 'PUT', `/api/manager/categories/${testCategoryId}/assign`, { workerIds: [assignWorkerId] }, workerCookie);
    ok(res.status === 403, 'Worker cannot assign categories to themselves or others');

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

    console.log('\n── Recruiter vs. temp: account types never cross over ──');
    res = await request(port, 'GET', '/api/temp/assignment/today', null, workerCookie);
    ok(res.status === 403, 'A recruiter (worker role) is forbidden from the temp assignment API');
    res = await request(port, 'GET', '/api/worker/today', null, tempCookie);
    ok(res.status === 403, 'A temp is forbidden from the recruiter daily-numbers API');

    console.log('\n── ACN: temp sees today\'s seeded assignment ──');
    res = await request(port, 'GET', '/api/temp/assignment/today', null, tempCookie);
    ok(res.status === 200 && res.json.assignment && res.json.assignment.client_company_name === 'Meridian Distribution Center', "Marcus Webb's Today's Assignment shows the seeded Meridian placement");
    const assignmentId = res.json.assignment.id;
    ok(res.json.assignment.status === 'scheduled', 'Seeded assignment starts as scheduled');

    console.log('\n── ACN: full workflow loop (spec §34) ──');
    res = await request(port, 'POST', `/api/temp/assignment/${assignmentId}/status`, { status: 'on_my_way' }, tempCookie);
    ok(res.status === 200 && res.json.event.status === 'delivered', 'Field worker confirms ON MY WAY, creating a delivered event');

    res = await request(port, 'POST', '/api/client/login', { email: 'supervisor@meridiandc.demo', password: 'client123' });
    ok(res.status === 200 && res.json.contact.clientCompanyName === 'Meridian Distribution Center', 'Client supervisor logs in to their own portal');
    const clientCookie = getCookie(res);

    res = await request(port, 'GET', '/api/client/today', null, clientCookie);
    ok(res.status === 200 && res.json.assignments.some((a) => a.id === assignmentId && a.status === 'on_my_way'), "Client supervisor sees Marcus Webb's status live, without needing a manager relay");

    res = await request(port, 'POST', `/api/temp/assignment/${assignmentId}/late`, { minutes: 15, message: 'Traffic on the interstate' }, tempCookie);
    ok(res.status === 200 && res.json.event.event_type === 'running_late', 'Field worker reports RUNNING LATE with a preset minute option');
    const lateEventId = res.json.event.id;
    ok(res.json.recipients.some((r) => r.type === 'client_contact') && res.json.recipients.some((r) => r.type === 'agency_user'), 'Late notice automatically routes to both the client supervisor and the agency contact — temp never picks recipients');

    res = await request(port, 'GET', '/api/manager/attention', null, managerCookie);
    ok(res.status === 403, 'Lead (manager role) is blocked from the temp-facing "Needs Attention" screen — owner-only for now');

    res = await request(port, 'GET', '/api/manager/attention', null, ownerCookie);
    ok(res.status === 200 && res.json.needsAttention.some((e) => e.id === lateEventId), 'Owner\'s "Needs Attention" screen surfaces the late notice (not an inbox — a counts-and-cards feed)');
    ok(res.json.runningLate >= 1, 'Attention KPI counts the running-late assignment');

    res = await request(port, 'GET', `/api/client/assignments/${assignmentId}`, null, clientCookie);
    ok(res.status === 200 && res.json.events.some((e) => e.id === lateEventId), 'Client supervisor sees the late notice on the assignment record');

    res = await request(port, 'POST', `/api/client/events/${lateEventId}/acknowledge`, { action: 'acknowledged' }, clientCookie);
    ok(res.status === 200, 'Client supervisor acknowledges the late notice');

    res = await request(port, 'POST', `/api/manager/events/${lateEventId}/acknowledge`, { action: 'resolved' }, managerCookie);
    ok(res.status === 403, 'Lead (manager role) cannot acknowledge/resolve temp assignment events — owner-only for now');

    res = await request(port, 'POST', `/api/manager/events/${lateEventId}/acknowledge`, { action: 'resolved' }, ownerCookie);
    ok(res.status === 200, 'Owner marks the late notice resolved');

    res = await request(port, 'GET', `/api/temp/assignment/${assignmentId}`, null, tempCookie);
    const lateEventAfter = res.json.events.find((e) => e.id === lateEventId);
    ok(lateEventAfter && lateEventAfter.status === 'resolved', 'Field worker sees the acknowledgment/resolution on their own Communication Record');
    ok(lateEventAfter.acknowledgments.some((a) => a.actor_type === 'client_contact' && a.action === 'acknowledged'), 'Full timestamped chain (client ack) is preserved in the event history');
    ok(lateEventAfter.acknowledgments.some((a) => a.actor_type === 'agency_user' && a.action === 'resolved'), 'Full timestamped chain (agency resolve) is preserved in the event history');

    console.log('\n── ACN: contact routing (temp never picks who to contact) ──');
    res = await request(port, 'GET', '/api/temp/agency-contact', null, tempCookie);
    ok(res.status === 200 && res.json.contact && !!res.json.contact.name, 'Field worker\'s "Contact My Staffing Agency" resolves to a real person automatically, with no channel picker');

    console.log('\n── ACN: time issue never touches payroll records ──');
    res = await request(port, 'POST', `/api/temp/assignment/${assignmentId}/time-issue`, { issueType: 'clock_in_incorrect', explanation: 'Clocked in but system shows nothing' }, tempCookie);
    ok(res.status === 200 && res.json.event.visibility === 'agency_client', 'Time/punch issue creates a reviewable event (agency + client), never an automatic payroll change');

    console.log('\n── ACN: workplace issue privacy (spec §13) ──');
    res = await request(port, 'POST', `/api/temp/assignment/${assignmentId}/workplace-issue`, { category: 'harassment_behavior', explanation: 'Sensitive report — should stay private' }, tempCookie);
    ok(res.status === 200 && res.json.event.visibility === 'worker_agency', 'Harassment/behavior category is private worker<->agency by default');
    const privateEventId = res.json.event.id;

    res = await request(port, 'GET', `/api/client/assignments/${assignmentId}`, null, clientCookie);
    ok(!res.json.events.some((e) => e.id === privateEventId), 'Client portal never receives the private worker<->agency event, even when reading the same assignment');

    res = await request(port, 'GET', `/api/manager/assignments/${assignmentId}`, null, managerCookie);
    ok(res.status === 403, 'Lead (manager role) cannot view assignment detail (including the private workplace issue) — owner-only for now');

    res = await request(port, 'GET', `/api/manager/assignments/${assignmentId}`, null, ownerCookie);
    ok(res.json.events.some((e) => e.id === privateEventId), 'Owner does see the private workplace issue');

    console.log('\n── ACN: emergency disclaimer (spec §12) ──');
    res = await request(port, 'POST', `/api/temp/assignment/${assignmentId}/emergency`, { category: 'unsafe_situation', explanation: 'Test emergency event' }, tempCookie);
    ok(res.status === 200 && res.json.event.severity === 'emergency', 'Emergency report is created with emergency severity');
    ok(typeof res.json.disclaimer === 'string' && res.json.disclaimer.includes('911'), 'Emergency response always carries the 911/emergency-services disclaimer');

    console.log('\n── ACN: leaving-early approve/deny flow ──');
    res = await request(port, 'POST', `/api/temp/assignment/${assignmentId}/leaving-early`, { departureTime: '14:00', message: 'Doctor appointment' }, tempCookie);
    ok(res.status === 200, 'Field worker requests to leave early');

    res = await request(port, 'POST', `/api/manager/assignments/${assignmentId}/leaving-early-response`, { decision: 'approved', note: 'Approved, thanks for the heads up' }, managerCookie);
    ok(res.status === 403, 'Lead (manager role) cannot respond to a leave-early request — owner-only for now');

    res = await request(port, 'POST', `/api/manager/assignments/${assignmentId}/leaving-early-response`, { decision: 'approved', note: 'Approved, thanks for the heads up' }, ownerCookie);
    ok(res.status === 200, 'Owner can approve a leave-early request');

    res = await request(port, 'GET', `/api/temp/assignment/${assignmentId}`, null, tempCookie);
    ok(res.json.assignment.status === 'leaving_early_approved', "Assignment status reflects the manager's approval");

    console.log('\n── ACN: manager creates a brand-new assignment end-to-end ──');
    res = await request(port, 'GET', '/api/manager/workers', null, managerCookie);
    const davidId = res.json.find((w) => w.name === 'David Kim').id;

    res = await request(port, 'POST', '/api/manager/temps-new', { name: 'Test Temp', email: 'test.temp@summitstaffing.demo', phone: '555-0100', password: 'temp123' }, managerCookie);
    ok(res.status === 403, 'Lead (manager role) is blocked from creating temp accounts — owner-only for now, could become a paid Lead upgrade later');

    res = await request(port, 'GET', '/api/manager/temps', null, managerCookie);
    ok(res.status === 403, 'Lead (manager role) is blocked from the temp roster — owner-only for now');

    res = await request(port, 'POST', '/api/manager/temps-new', { name: 'Test Temp', email: 'test.temp@summitstaffing.demo', phone: '555-0100', password: 'temp123' }, ownerCookie);
    ok(res.status === 200 && !!res.json.id, 'Owner can create a new temp account');
    const newTempId = res.json.id;

    res = await request(port, 'GET', '/api/manager/temps', null, ownerCookie);
    ok(res.status === 200 && res.json.some((w) => w.id === newTempId), 'New temp shows up in the temp roster');

    res = await request(port, 'POST', '/api/manager/client-companies', { name: 'Test Client Co', notes: 'Created by smoke test' }, managerCookie);
    ok(res.status === 403, 'Lead (manager role) is blocked from creating client companies — owner-only for now');

    res = await request(port, 'POST', '/api/manager/client-companies', { name: 'Test Client Co', notes: 'Created by smoke test' }, ownerCookie);
    ok(res.status === 200 && !!res.json.id, 'Owner can create a new client company');
    const newClientId = res.json.id;

    console.log('\n── Client billing — owner-only visibility ──');
    res = await request(port, 'PUT', `/api/manager/client-companies/${newClientId}/billing`, { billRateHourly: 28.5, payRateHourly: 18, contractValue: 50000, billingNotes: 'Net 30' }, ownerCookie);
    ok(res.status === 200 && Number(res.json.bill_rate_hourly) === 28.5, 'Owner can set client billing rates');

    res = await request(port, 'PUT', `/api/manager/client-companies/${newClientId}/billing`, { billRateHourly: 99 }, managerCookie);
    ok(res.status === 403, 'Manager is blocked from editing client billing rates');

    res = await request(port, 'GET', `/api/manager/client-companies/${newClientId}`, null, managerCookie);
    ok(res.status === 403, 'Lead (manager role) cannot view client company detail at all now — owner-only for now (was previously scrubbed, now fully hidden)');

    res = await request(port, 'GET', '/api/manager/client-companies', null, managerCookie);
    ok(res.status === 403, 'Lead (manager role) cannot list client companies at all now — owner-only for now');

    res = await request(port, 'GET', `/api/manager/client-companies/${newClientId}`, null, ownerCookie);
    ok(res.status === 200 && Number(res.json.bill_rate_hourly) === 28.5 && res.json.billing_notes === 'Net 30', 'Owner can see the client billing rates they set');

    res = await request(port, 'POST', `/api/manager/client-companies/${newClientId}/contacts`, { name: 'Test Contact', email: 'testcontact@testclientco.demo', password: 'contact123', role: 'client_supervisor' }, managerCookie);
    ok(res.status === 403, 'Lead (manager role) cannot add a client contact login — owner-only for now');

    res = await request(port, 'POST', `/api/manager/client-companies/${newClientId}/contacts`, { name: 'Test Contact', email: 'testcontact@testclientco.demo', password: 'contact123', role: 'client_supervisor' }, ownerCookie);
    ok(res.status === 200, 'Owner can add a client contact login');

    res = await request(port, 'POST', '/api/manager/assignments', {
      workerId: davidId, clientCompanyId: newClientId, shiftDate: (new Date(Date.now() + 24 * 60 * 60 * 1000)).toISOString().slice(0, 10), startTime: '09:00', endTime: '17:00',
    }, managerCookie);
    ok(res.status === 403, 'Lead (manager role) cannot create assignments at all — owner-only for now');

    res = await request(port, 'POST', '/api/manager/assignments', {
      workerId: davidId, clientCompanyId: newClientId, shiftDate: (new Date(Date.now() + 24 * 60 * 60 * 1000)).toISOString().slice(0, 10), startTime: '09:00', endTime: '17:00',
    }, ownerCookie);
    ok(res.status === 400, 'Owner cannot assign a shift to a recruiter (David Kim) — workerId must be an actual temp');

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    res = await request(port, 'POST', '/api/manager/assignments', {
      workerId: newTempId, clientCompanyId: newClientId, shiftDate: tomorrow, startTime: '09:00', endTime: '17:00',
    }, ownerCookie);
    ok(res.status === 200 && res.json.client_company_name === 'Test Client Co', 'Owner creates a new assignment for the new temp');
    const newAssignmentId = res.json.id;

    res = await request(port, 'POST', '/api/auth/login', { email: 'test.temp@summitstaffing.demo', password: 'temp123' });
    const newTempCookie = getCookie(res);
    res = await request(port, 'GET', `/api/temp/assignment/${newAssignmentId}`, null, newTempCookie);
    ok(res.status === 200 && res.json.assignment.id === newAssignmentId, 'The new temp can see the assignment the manager just created');

    console.log('\n── ACN: tenant isolation on client portal ──');
    res = await request(port, 'GET', `/api/client/assignments/${assignmentId}`, null, getCookie(await request(port, 'POST', '/api/client/login', { email: 'testcontact@testclientco.demo', password: 'contact123' })));
    ok(res.status === 404, "A different client company's contact cannot read Meridian's assignment — cross-client isolation holds");

    console.log('\n── Cross-agency invites ──');
    res = await request(port, 'GET', '/api/client/linked-orgs', null, clientCookie);
    ok(res.status === 200 && res.json.linked.length === 0, 'Client with no cross-agency connections sees an empty linked-orgs list');

    res = await request(port, 'POST', '/api/client/invite-agency', { agencyNameHint: "Priya's other vendor" }, clientCookie);
    ok(res.status === 200 && !!res.json.token && res.json.inviteUrl.includes('/signup.html?invite='), 'Client can generate an agency invite link');
    const inviteToken = res.json.token;

    res = await request(port, 'GET', '/api/client/invites', null, clientCookie);
    ok(res.status === 200 && res.json.some((i) => i.token === inviteToken && i.status === 'pending'), 'Client sees the invite they just created, still pending');

    res = await request(port, 'POST', '/api/client/switch-org', { organizationId: 99999, clientCompanyId: 99999 }, clientCookie);
    ok(res.status === 403, 'Client cannot switch into an agency/client-company pairing they have no connection to');

    res = await request(port, 'GET', '/api/client/me', null, clientCookie);
    res = await request(port, 'POST', '/api/client/switch-org', { organizationId: res.json.organizationId, clientCompanyId: res.json.clientCompanyId }, clientCookie);
    ok(res.status === 200 && res.json.contact.clientCompanyName === 'Meridian Distribution Center', 'Client can always switch back into their own home agency/client-company pairing');

    console.log('\n── Temp Chat (paid upgrade) gating ──');
    // Demo/seed orgs default temp_chat_enabled = TRUE (see schema.sql), so
    // messaging should work out of the box for Summit Staffing.
    res = await request(port, 'POST', `/api/temp/assignment/${newAssignmentId}/message`, { to: 'agency', body: 'Running a few minutes behind.' }, newTempCookie);
    ok(res.status === 200, 'Temp can send a free-text message when Temp Chat is enabled for the agency');

    res = await request(port, 'POST', `/api/manager/assignments/${newAssignmentId}/message`, { body: 'Got it, thanks for the heads up.' }, managerCookie);
    ok(res.status === 403, 'Lead (manager role) cannot send assignment messages — owner-only for now');

    res = await request(port, 'POST', `/api/manager/assignments/${newAssignmentId}/message`, { body: 'Got it, thanks for the heads up.' }, ownerCookie);
    ok(res.status === 200, 'Owner can send a free-text message back when Temp Chat is enabled');

    res = await request(port, 'POST', '/api/platform-admin/login', { email: 'admin@twanova.platform', password: 'platform123' });
    ok(res.status === 200, 'Super Admin logs in');
    const platformAdminCookie = getCookie(res);

    res = await request(port, 'GET', '/api/platform-admin/agencies', null, platformAdminCookie);
    const summitOrgId = res.json.find((a) => a.name && a.name.includes('Summit'))?.id || res.json[0].id;

    res = await request(port, 'POST', `/api/platform-admin/agencies/${summitOrgId}/temp-chat`, { enabled: false }, platformAdminCookie);
    ok(res.status === 200 && res.json.temp_chat_enabled === false, 'Super Admin can disable Temp Chat for an agency');

    res = await request(port, 'POST', `/api/temp/assignment/${newAssignmentId}/message`, { to: 'agency', body: 'Anyone there?' }, newTempCookie);
    ok(res.status === 403, 'Temp messaging is blocked once Temp Chat is disabled for the agency');

    res = await request(port, 'POST', `/api/manager/assignments/${newAssignmentId}/message`, { body: 'Still here.' }, ownerCookie);
    ok(res.status === 403, 'Owner messaging is blocked once Temp Chat is disabled for the agency');

    res = await request(port, 'POST', `/api/platform-admin/agencies/${summitOrgId}/temp-chat`, { enabled: true }, platformAdminCookie);
    ok(res.status === 200 && res.json.temp_chat_enabled === true, 'Super Admin can re-enable Temp Chat for an agency');

    res = await request(port, 'POST', `/api/temp/assignment/${newAssignmentId}/message`, { to: 'agency', body: 'Back online.' }, newTempCookie);
    ok(res.status === 200, 'Temp messaging works again once Temp Chat is re-enabled');

    console.log('\n── Page routing / RBAC on pages ──');
    res = await request(port, 'GET', '/dashboard/manager', null, workerCookie);
    ok(res.status === 302, 'Worker hitting the manager dashboard page is redirected, not shown the page');

    res = await request(port, 'GET', '/dashboard/worker', null, managerCookie);
    ok(res.status === 302, 'Manager hitting the worker dashboard page is redirected, not shown the page');

    res = await request(port, 'GET', '/dashboard/temp', null, workerCookie);
    ok(res.status === 302, 'A recruiter (worker role) hitting the temp dashboard page is redirected, not shown the page');

    res = await request(port, 'GET', '/dashboard/worker', null, tempCookie);
    ok(res.status === 302, 'A temp hitting the recruiter dashboard page is redirected, not shown the page');

    res = await request(port, 'GET', '/dashboard/temp', null, tempCookie);
    ok(res.status === 200, 'A signed-in temp can load their own dashboard page');

    res = await request(port, 'GET', '/dashboard/temp', null, null);
    ok(res.status === 302, 'Anonymous visitor hitting the temp dashboard page is redirected to temp login');

    res = await request(port, 'GET', '/dashboard/client', null, null);
    ok(res.status === 302, 'Anonymous visitor hitting the client dashboard page is redirected to client login');

    res = await request(port, 'GET', '/dashboard/client', null, clientCookie);
    ok(res.status === 200, 'A signed-in client contact can load their own dashboard page');

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
