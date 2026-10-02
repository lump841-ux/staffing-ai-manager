const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const { rows } = await db.query(
    `SELECT id, organization_id, branch_id, role, name, email, password_hash, active, avatar_url
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );
  const user = rows[0];
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  req.session.user = {
    id: user.id,
    organizationId: user.organization_id,
    branchId: user.branch_id,
    role: user.role,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatar_url || null,
  };
  res.json({ ok: true, user: req.session.user });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not signed in' });
  res.json(req.session.user);
});


// ---- Recruiter invite / password reset ----
// Public endpoints intentionally return minimal information. Setup tokens are
// single-use, expire after 48 hours, and never contain a password.
router.get('/worker-access', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing access token' });

  const { rows } = await db.query(
    `SELECT wat.id, wat.worker_id, wat.purpose, wat.status, wat.expires_at,
            u.name, u.email, u.active
     FROM worker_access_tokens wat
     JOIN users u ON u.id = wat.worker_id
     WHERE wat.token = $1 AND u.role = 'worker'
     LIMIT 1`,
    [token]
  );
  const row = rows[0];
  if (!row || row.status !== 'pending' || new Date(row.expires_at) <= new Date()) {
    return res.status(400).json({ error: 'This setup link is invalid or has expired.' });
  }
  res.json({
    ok: true,
    purpose: row.purpose,
    worker: { name: row.name, email: row.email },
    expiresAt: row.expires_at,
  });
});

router.post('/worker-set-password', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');
  if (!token) return res.status(400).json({ error: 'Missing access token' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const { rows } = await db.query(
    `SELECT wat.id, wat.worker_id, wat.status, wat.expires_at, u.email
     FROM worker_access_tokens wat
     JOIN users u ON u.id = wat.worker_id
     WHERE wat.token = $1 AND u.role = 'worker'
     LIMIT 1`,
    [token]
  );
  const row = rows[0];
  if (!row || row.status !== 'pending' || new Date(row.expires_at) <= new Date()) {
    return res.status(400).json({ error: 'This setup link is invalid or has expired.' });
  }

  const hash = await bcrypt.hash(password, 10);
  await db.query('BEGIN');
  try {
    await db.query(
      `UPDATE users SET password_hash = $1, active = TRUE WHERE id = $2 AND role = 'worker'`,
      [hash, row.worker_id]
    );
    await db.query(
      `UPDATE worker_access_tokens SET status = 'used', used_at = NOW() WHERE id = $1`,
      [row.id]
    );
    await db.query(
      `UPDATE worker_access_tokens SET status = 'expired'
       WHERE worker_id = $1 AND status = 'pending' AND id <> $2`,
      [row.worker_id, row.id]
    );
    await db.query(
      `UPDATE worker_access_requests SET status='resolved', resolved_at=NOW()
       WHERE worker_id=$1 AND status='pending'`,
      [row.worker_id]
    );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  res.json({ ok: true, email: row.email });
});

router.post('/worker-forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const { rows } = await db.query(
    `SELECT id, organization_id FROM users WHERE email = $1 AND role = 'worker' LIMIT 1`,
    [email]
  );
  const worker = rows[0];

  // Always return the same message so the endpoint does not reveal whether
  // an address is registered.
  if (worker) {
    const { rows: pending } = await db.query(
      `SELECT id FROM worker_access_requests
       WHERE worker_id = $1 AND status = 'pending' LIMIT 1`,
      [worker.id]
    );
    if (!pending.length) {
      await db.query(
        `INSERT INTO worker_access_requests (organization_id, worker_id)
         VALUES ($1, $2)`,
        [worker.organization_id, worker.id]
      );
    }
  }

  res.json({
    ok: true,
    message: 'If that email belongs to a recruiter account, your manager will see the access request and can send you a secure reset link.',
  });
});

module.exports = router;
