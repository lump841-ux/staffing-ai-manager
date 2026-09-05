# Only A Job — Staffing Agencies — local test build

A working first version of the worker portal + manager command center, for your son to click through, test, and tell you what to change. It runs entirely on your machine with demo data already loaded — no database setup, no API keys, no cost.

## Run it

You need [Node.js](https://nodejs.org) installed (any recent version). Then, in Terminal:

```
cd staffing-ai-manager
npm install
npm start
```

You'll see:

```
Staffing AI Manager running at http://localhost:4000
```

Leave that terminal window open — that's the running app. Open a browser to:

- Manager Command Center: **http://localhost:4000/manager/login.html** (login is pre-filled — just click Sign in)
- Worker Portal: **http://localhost:4000/worker/login.html**

## Demo logins

**Manager:** `manager@summitstaffing.demo` / `manager123`

**Workers** (all password `worker123`):
- `sarah.chen@summitstaffing.demo` — strong performer
- `david.kim@summitstaffing.demo` — trending upward this week
- `maria.lopez@summitstaffing.demo` — below goal, and has a flagged discrepancy in Needs Review on purpose, so you can see how that looks
- `james.patterson@summitstaffing.demo` — steady
- `nina.ortiz@summitstaffing.demo` — solid

Two weeks of realistic history is pre-loaded so the weekly view, trends, and Friday report all have real numbers to show. Every time you run `npm start`, the data resets fresh (it's stored in memory, not saved to a file) — so it's safe to click around and break things.

## What to click through

- **Worker Portal → Today**: progress rings per category, submit daily numbers, notes/obstacles.
- **Manager → Today**: KPI cards, morning briefing, who's below goal or missing.
- **Manager → This Week**: Monday–Friday bar chart, week total, comparison to last week.
- **Manager → Workers**: click "View" on any worker for their 14-day trend and to adjust their daily goals.
- **Manager → Categories**: add/rename/deactivate what workers report on — try adding one.
- **Manager → Time Entry**: manager-only hours tracking. Workers have no access to this anywhere in the app.
- **Manager → Needs Review**: Maria Lopez has one flagged item (placement logged with no meeting) — try marking it Reviewed, Correct, Needs Correction, Follow Up, or Resolved.
- **Manager → Friday Report**: full weekly report with facts and a separate AI interpretation section.
- **Manager → Tasks**: type something like "Remind me to talk to Sarah tomorrow" and it'll parse the name and date automatically.
- **Manager → AI Assistant**: click the suggested questions, or type your own. It's answering from the real seeded data — not generic text.

## About the AI

Right now the AI assistant, briefings, and Friday summary run in **rule-based mode** — they compute real answers from the actual data without needing an API key, so this build works completely free and offline. Once you decide this is the right direction, we can wire in a real OpenAI or Anthropic key for fully open-ended natural language — the interface won't change, just the sophistication of the answers.

## What's next

This is the MVP slice from the full architecture plan (worker submissions, manager dashboard, categories, time entry, discrepancy detection, Friday report, AI assistant, task center). Not yet built: email/SMS notifications, the manager's end-of-day debrief conversation, and multi-branch/regional views — all queued for after your son gives feedback on this version.

Send over notes on what to change — layout, wording, what categories make sense for how the agency actually works, anything that feels off — and we'll iterate.
