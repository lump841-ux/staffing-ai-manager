const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./services/db');

const app = express();

// Safety net: route handlers here are `async (req, res) => {...}` without
// try/catch, so a rejected promise (e.g. a bad query) becomes an unhandled
// rejection — which crashes the whole Node process by default (Node 15+).
// One bad request should return a 500, not take down the entire server for
// every other signed-in user. This is a backstop, not a substitute for
// fixing the underlying query/logic error.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server stayed up):', err);
});
// Needed on Render (behind a reverse proxy) so req.protocol reflects the
// original https, not the internal http hop — Stripe success/cancel URLs
// and session cookies depend on this being correct.
app.set('trust proxy', 1);

// Stripe webhook needs the exact raw request body to verify its signature,
// so it must be mounted BEFORE express.json() below (which would otherwise
// consume and parse the body first).
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), require('./routes/stripe-webhook'));

// Raised from the 100kb default so worker profile-photo uploads (base64
// data URLs, capped at ~900kb in routes/worker.js) fit in the request body.
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 },
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/worker', require('./routes/worker'));
app.use('/api/field', require('./routes/field'));
app.use('/api/manager', require('./routes/manager'));
app.use('/api/client', require('./routes/client'));
app.use('/api/signup', require('./routes/signup'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/platform-admin', require('./routes/platform-admin'));

// Role-gated page routes — serving the same static files but only after
// checking the session, so a direct URL hit or refresh behaves correctly.
// NOTE: 'worker' = recruiter/staffing-coordinator (own login, own
// dashboard, tracks their own numbers). 'field_worker' = the person the
// agency places at a client job site (Assignment Communication Network) —
// a completely separate account and login page, never conflated with
// 'worker' even though the underlying users table is shared.
const LOGIN_PAGE_BY_ROLE = {
  worker: '/worker/login.html',
  field_worker: '/field/login.html',
  manager: '/manager/login.html',
};
function requirePageRole(role) {
  return (req, res, next) => {
    const loginPage = LOGIN_PAGE_BY_ROLE[role] || '/manager/login.html';
    if (!req.session.user) return res.redirect(loginPage);
    if (req.session.user.role !== role && !(role === 'manager' && req.session.user.role === 'owner')) {
      return res.redirect(loginPage);
    }
    next();
  };
}

app.get('/dashboard/worker', requirePageRole('worker'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'worker', 'dashboard.html'));
});
app.get('/dashboard/field', requirePageRole('field_worker'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'field', 'dashboard.html'));
});
app.get('/dashboard/manager', requirePageRole('manager'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager', 'dashboard.html'));
});
app.get('/dashboard/client', (req, res) => {
  if (!req.session.clientContact) return res.redirect('/client/login.html');
  res.sendFile(path.join(__dirname, 'public', 'client', 'dashboard.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/manager/login.html'));

const PORT = process.env.PORT || 4000;

db.init()
  .then(() => require('./services/seed').run())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Staffing AI Manager running at http://localhost:${PORT}`);
      console.log(db.isUsingMemory() ? 'Using in-memory database (no setup needed).' : 'Using Postgres via DATABASE_URL.');
      require('./services/escalation-engine').start(app);
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
