// Thin, lazy wrapper around the Stripe SDK. Lazy so that a server without
// STRIPE_SECRET_KEY configured (local dev, smoke tests) can still boot and
// run every existing feature — Stripe is only ever touched when a route
// that actually needs it (signup checkout, billing portal, webhook) is hit.
let _stripe = null;

function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured on this server.');
    }
    const Stripe = require('stripe');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Every outbound Stripe URL (Checkout success/cancel, Billing Portal
// return) needs an absolute base URL. Prefer an explicit BASE_URL env var
// (set this on Render); fall back to deriving it from the request so local
// dev / any host works without extra config.
function baseUrlFrom(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = { getStripe, isConfigured, baseUrlFrom };
