// Plan catalog + pricing math for the Twanova SaaS billing layer.
// Kept as pure data + pure functions so routes/signup.js, routes/billing.js,
// and routes/platform-admin.js all read from one source of truth.
const db = require('./db');

// Enterprise has no fixed price — it's "Contact Sales" only, handled by
// routes/signup.js posting to enterprise_leads instead of a checkout flow.
// NOTE: the 'founding' key is kept as-is internally (it's the value stored
// in organizations.plan and covered by that column's CHECK constraint) —
// only the user-facing name/copy changed. This is now a plain, simple
// tier like the others: no partner branding, no limited-slots scarcity.
const PLANS = {
  founding: {
    key: 'founding',
    name: 'Starter',
    priceCents: 29900,
    setupFeeCents: 50000,
    tagline: 'STARTER',
    blurb: 'Core Twanova Staffing Solutions platform with generous limits for a smaller agency.',
    limited: false,
  },
  growth: {
    key: 'growth',
    name: 'Growth',
    priceCents: 49900,
    setupFeeCents: 50000,
    tagline: 'GROWTH',
    blurb: 'For growing staffing agencies that need additional management, reporting, AI intelligence, and operational capacity.',
    limited: false,
  },
  professional: {
    key: 'professional',
    name: 'Professional',
    priceCents: 69900,
    setupFeeCents: 50000,
    tagline: 'PROFESSIONAL',
    blurb: 'For larger staffing organizations needing more offices, managers, workers, reporting, AI insights, and administrative controls.',
    limited: false,
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    priceCents: null,
    setupFeeCents: null,
    tagline: 'CUSTOM PRICING',
    blurb: 'For large staffing companies, regional organizations, franchises, or organizations requiring custom implementation.',
    limited: false,
    contactSalesOnly: true,
  },
};

function getPlan(key) {
  return PLANS[key] || null;
}

function listCheckoutPlans() {
  // Enterprise is excluded — it never goes through the checkout flow.
  return ['founding', 'growth', 'professional'].map((k) => PLANS[k]);
}

function formatCents(cents) {
  if (cents == null) return null;
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function nextBillingDateFrom(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  PLANS,
  getPlan,
  listCheckoutPlans,
  formatCents,
  nextBillingDateFrom,
};
