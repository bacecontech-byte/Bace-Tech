// /api/stripe-webhook.js — Stripe webhook: keep the app's plan state in sync
// with Stripe (trial → active, payment failed, canceled, etc.).
//
// It verifies Stripe's signature (no npm dependency) and writes the resulting
// plan into the existing `user_usage` table (current month), which the client
// already reads on load via loadPillierUsage().
//
// Required Vercel env vars:
//   STRIPE_SECRET_KEY        (sk_… — used to look up the customer's email)
//   STRIPE_WEBHOOK_SECRET    (whsec_… — from the Stripe webhook you create)
//   SUPABASE_URL             (defaults to the project URL below)
//   SUPABASE_SERVICE_KEY     (service-role key, server-side only)
//   STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM
//
// In the Stripe Dashboard → Developers → Webhooks → Add endpoint:
//   URL:    https://pillier.com.br/api/stripe-webhook
//   Events: checkout.session.completed, customer.subscription.created,
//           customer.subscription.updated, customer.subscription.deleted,
//           invoice.payment_failed
// Copy the "Signing secret" (whsec_…) into STRIPE_WEBHOOK_SECRET.

import crypto from 'crypto';

// Vercel parses JSON bodies by default; we need the raw bytes to verify the
// signature, so disable the body parser for this route.
export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Verify the Stripe-Signature header against the raw payload (HMAC-SHA256).
function verifySignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  // Reject events older than 5 minutes (replay protection).
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(t, 10)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + payload, 'utf8').digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function priceToPlan(id) {
  if (id && id === process.env.STRIPE_PRICE_STARTER) return 'starter';
  if (id && id === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (id && id === process.env.STRIPE_PRICE_TEAM) return 'team';
  return null;
}

function currentMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

async function stripeGet(path, skey) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + skey }
  });
  return r.json();
}

async function customerEmail(custId, skey) {
  if (!custId || !skey) return null;
  const c = await stripeGet('/customers/' + custId, skey);
  return (c && !c.deleted && c.email) ? c.email : null;
}

// Write the plan into user_usage for the current month (the client's source of
// truth). Updates the existing row; inserts one only if none exists yet.
async function setPlan(email, plan) {
  const url = process.env.SUPABASE_URL || 'https://rzdoeehbpdgjxtfbbmwp.supabase.co';
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key || !email) return;
  const month = currentMonth();
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
  const q = '?user_email=eq.' + encodeURIComponent(email) + '&month=eq.' + encodeURIComponent(month);
  const patch = await fetch(url + '/rest/v1/user_usage' + q, {
    method: 'PATCH', headers, body: JSON.stringify({ plan: plan })
  });
  let rows = [];
  try { rows = await patch.json(); } catch (e) { rows = []; }
  if (Array.isArray(rows) && rows.length > 0) return;
  // No row for this month yet — create a minimal one.
  await fetch(url + '/rest/v1/user_usage', {
    method: 'POST', headers,
    body: JSON.stringify({ user_email: email, month: month, plan: plan })
  });
}

async function handleEvent(event, skey) {
  const obj = (event.data && event.data.object) || {};
  const type = event.type;

  if (type === 'checkout.session.completed') {
    const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email;
    const plan = (obj.metadata && obj.metadata.plan) || null;
    if (email && plan) await setPlan(email, plan);
    return;
  }

  if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
    const status = obj.status; // trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired
    const item = obj.items && obj.items.data && obj.items.data[0];
    const plan = (obj.metadata && obj.metadata.plan) || (item && priceToPlan(item.price && item.price.id));
    const email = await customerEmail(obj.customer, skey);
    if (!email) return;
    if (status === 'active' || status === 'trialing' || status === 'past_due') {
      if (plan) await setPlan(email, plan);
    } else if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
      await setPlan(email, 'free');
    }
    return;
  }

  if (type === 'customer.subscription.deleted') {
    const email = await customerEmail(obj.customer, skey);
    if (email) await setPlan(email, 'free');
    return;
  }

  // invoice.payment_failed: Stripe retries automatically and will emit a
  // subscription.updated (past_due → canceled) if it ultimately gives up, so
  // we let those events drive the final state rather than downgrading here.
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const skey = process.env.STRIPE_SECRET_KEY;
  if (!secret) return res.status(200).json({ ok: false, error: 'not_configured' });

  const raw = await readRaw(req);
  if (!verifySignature(raw, req.headers['stripe-signature'], secret)) {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  let event;
  try { event = JSON.parse(raw); } catch (e) { return res.status(400).json({ error: 'invalid_json' }); }

  try {
    await handleEvent(event, skey);
  } catch (e) {
    // Log but still 200 so Stripe doesn't hammer retries on a transient error.
    console.error('stripe-webhook handleEvent error:', e && e.message);
  }
  return res.status(200).json({ received: true });
}
