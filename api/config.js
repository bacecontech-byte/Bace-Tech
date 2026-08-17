// ═══════════════════════════════════════════════════════════════════
// /api/config.js — Serves public frontend config from Vercel env vars
//
// PURPOSE: The Turnstile SITE KEY (which is technically public but must
// match your Cloudflare-registered domain) is kept in Vercel env vars
// instead of the source code. This means it survives code updates and
// can be rotated without a deploy.
//
// SETUP:
//   Vercel Dashboard → Settings → Environment Variables → Add:
//   Key: TURNSTILE_SITE_KEY
//   Value: (paste your Cloudflare Turnstile SITE key, starts with 0x...)
//   Apply to: Production, Preview, Development
//
// The frontend loads this script early in <head>:
//   <script src="/api/config.js"></script>
// Which sets: window.PILLIER_CONFIG = { turnstileSiteKey: '...' }
// ═══════════════════════════════════════════════════════════════════

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  // Cache 5 minutes on the CDN, but let browser check for freshness
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const turnstileSiteKey = (process.env.TURNSTILE_SITE_KEY || '').replace(/[^\w-]/g, '');

  // Build a safe JS assignment (no template strings from env; strict char whitelist above)
  const js = 'window.PILLIER_CONFIG = { turnstileSiteKey: "' + turnstileSiteKey + '" };';

  res.status(200).send(js);
}
