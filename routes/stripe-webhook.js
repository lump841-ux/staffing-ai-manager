// Stripe webhook — keeps an agency's billing_status in sync with what
// actually happens on the card over time (a renewal fails, the customer
// cancels in the Stripe billing portal, etc). Account *creation* does not
// happen here — that's GET /api/signup/confirm, which the browser calls
// right after Stripe redirects back, so a new owner isn't stuck waiting on
// a webhook to log in. This route is the ongoing lifecycle keeper.
//
// Mounted in server.js with express.raw() (not express.json()) because
// Stripe signature verification needs the exact raw request body.
const express = require('express');
const db = require('../services/db');
const { getStripe, isConfigured } = require('../services/stripe');
const router = express.Router();

const SUB_STATUS_MAP = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'past_due',
  incomplete_expired: 'canceled',
};

router.post('/', async (req, res) => {
  if (!isConfigured()) return res.status(503).send('Stripe not configured');

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    const stripe = getStripe();
    if (secret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } else {
      // No signing secret registered yet (e.g. before the endpoint has
      // been added in the Stripe dashboard) — accept unsigned so local/
      // early testing still works, but this should always have a secret
      // once live.
      event = JSON.parse(req.body.toString('utf8'));
    }
  } catch (err) {
    console.error('Stripe webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const status = SUB_STATUS_MAP[sub.status] || 'active';
        await db.query(
          `UPDATE organizations SET billing_status = $1 WHERE stripe_subscription_id = $2`,
          [status, sub.id]
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await db.query(
            `UPDATE organizations SET billing_status = 'past_due' WHERE stripe_subscription_id = $1`,
            [invoice.subscription]
          );
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        // Only log renewals here (the first invoice is already recorded by
        // GET /confirm) — recognizable because it's not the very first one.
        if (invoice.subscription && invoice.billing_reason === 'subscription_cycle') {
          const { rows } = await db.query(
            `SELECT id FROM organizations WHERE stripe_subscription_id = $1`,
            [invoice.subscription]
          );
          if (rows.length) {
            await db.query(
              `INSERT INTO billing_events (organization_id, type, amount_cents, description, status)
               VALUES ($1,'subscription_charge',$2,'Monthly subscription renewal','paid')`,
              [rows[0].id, invoice.amount_paid || 0]
            );
            await db.query(
              `UPDATE organizations SET billing_status = 'active' WHERE id = $1`,
              [rows[0].id]
            );
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('Stripe webhook handling error:', err);
  }

  res.json({ received: true });
});

module.exports = router;
