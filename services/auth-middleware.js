function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Not permitted for this role' });
    next();
  };
}

module.exports = { requireLogin, requireRole };
