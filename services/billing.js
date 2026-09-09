// Plan catalog + pricing math for the Only A Job SaaS billing layer.
// Kept as pure data + pure functions so routes/signup.js, routes/billing.js,
// and routes/platform-admin.js all read from one source of truth.
const db = require('./db');

const FOUNDING_PARTNER_LIMIT = 25;

// Enterprise has no fixed price — it's "Contact Sales" only, handled by
// routes/signup.js posting to enterprise_leads instead of a checkout flow.
const PLANS = {
  founding: {
    key: 'founding',
    name: 'Founding Agency',
    priceCents: 29900,
    setupFeeCents: 50000,
    tagline: 'FOUNDING PARTNER RATE',
    blurb: `Limited to the first ${FOUNDING_PARTNER_LIMIT} agencies. Core Only A Job Staffing Intelligence platform with generous limits for a smaller agency. Your $299/month rate is locked in for as long as your account stays active and in good standing.`,
    limited: true,
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

async function countFoundingPartners() {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM organizations WHERE is_founding_partner = TRUE`
  );
  return rows[0].n;
}

async function foundingSlotsRemaining() {
  const used = await countFoundingPartners();
  return Math.max(0, FOUNDING_PARTNER_LIMIT - used);
}

function nextBillingDateFrom(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  PLANS,
  FOUNDING_PARTNER_LIMIT,
  getPlan,
  listCheckoutPlans,
  formatCents,
  countFoundingPartners,
  foundingSlotsRemaining,
  nextBillingDateFrom,
};
