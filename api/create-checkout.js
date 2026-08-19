// /api/create-checkout.js — Create a Stripe Checkout Session for a paid plan.
// Requires Vercel env vars: STRIPE_SECRET_KEY and the price IDs
// STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM.
// Uses Stripe's REST API directly (no npm dependency).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(200).json({ ok: false, error: 'not_configured' });

  const { plan, email, trial } = req.body || {};
  const priceMap = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    team: process.env.STRIPE_PRICE_TEAM
  };
  const price = priceMap[plan];
  if (!price) return res.status(200).json({ ok: false, error: 'no_price' });

  const isTrial = !!trial;
  const origin = req.headers.origin || ('https://' + (req.headers.host || 'pillier.com.br'));
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', price);
  params.append('line_items[0][quantity]', '1');
  params.append('allow_promotion_codes', 'true');
  // Always collect a card up front — even for the free trial (no charge today).
  params.append('payment_method_collection', 'always');
  if (isTrial) {
    // 30-day free trial: card required now, first charge after the trial ends.
    params.append('subscription_data[trial_period_days]', '30');
    // If the card is later removed/invalid, cancel rather than leave unpaid.
    params.append('subscription_data[trial_settings][end_behavior][missing_payment_method]', 'cancel');
  }
  // Tag the plan on both the session and the subscription so the webhook can
  // resolve it without a price lookup.
  params.append('metadata[plan]', plan);
  params.append('subscription_data[metadata][plan]', plan);
  params.append('subscription_data[metadata][app]', 'pillier');
  params.append('success_url', origin + '/?checkout=success&plan=' + encodeURIComponent(plan) + (isTrial ? '&trial=1' : ''));
  params.append('cancel_url', origin + '/?checkout=cancel');
  if (email) params.append('customer_email', email);

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const data = await r.json();
    if (data && data.url) return res.status(200).json({ ok: true, url: data.url });
    return res.status(200).json({ ok: false, error: (data && data.error && data.error.message) || 'stripe_error' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'server error: ' + (err.message || 'unknown') });
  }
}
