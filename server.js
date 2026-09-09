const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./services/db');

const app = express();
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
app.use('/api/manager', require('./routes/manager'));
app.use('/api/signup', require('./routes/signup'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/platform-admin', require('./routes/platform-admin'));

// Role-gated page routes — serving the same static files but only after
// checking the session, so a direct URL hit or refresh behaves correctly.
function requirePageRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect(role === 'worker' ? '/worker/login.html' : '/manager/login.html');
    if (req.session.user.role !== role && !(role === 'manager' && req.session.user.role === 'owner')) {
      return res.redirect(role === 'worker' ? '/worker/login.html' : '/manager/login.html');
    }
    next();
  };
}

app.get('/dashboard/worker', requirePageRole('worker'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'worker', 'dashboard.html'));
});
app.get('/dashboard/manager', requirePageRole('manager'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager', 'dashboard.html'));
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
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
