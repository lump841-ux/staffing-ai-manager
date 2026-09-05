const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const { rows } = await db.query(
    `SELECT id, organization_id, branch_id, role, name, email, password_hash, active
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

module.exports = router;
