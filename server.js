const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./services/db');

const app = express();
app.use(express.json());
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
