// Session gate for the Only A Job Super Admin area. Deliberately a totally
// separate session key (req.session.platformAdmin) from the staffing-agency
// session (req.session.user) used everywhere else — a platform admin
// session can never satisfy an agency route's requireRole check, and vice
// versa, because they read different keys entirely.
function requirePlatformAdmin(req, res, next) {
  if (!req.session || !req.session.platformAdmin) return res.status(401).json({ error: 'Not signed in' });
  next();
}

module.exports = { requirePlatformAdmin };
