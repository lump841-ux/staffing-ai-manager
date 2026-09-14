// Session gate for client-side people (supervisors / HR), mirroring
// services/platform-auth.js exactly: a completely separate session key
// (req.session.clientContact) from both the agency session (req.session.user)
// and the platform admin session (req.session.platformAdmin). A client
// login can never satisfy requireRole() or requirePlatformAdmin().
function requireClientContact(req, res, next) {
  if (!req.session || !req.session.clientContact) return res.status(401).json({ error: 'Not signed in' });
  next();
}

module.exports = { requireClientContact };
