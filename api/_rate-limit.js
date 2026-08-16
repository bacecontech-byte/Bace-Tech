// ═══════════════════════════════════════════════════════════════════
// /api/_rate-limit.js — Shared server-side rate limiter for Pillier
//
// In-memory rate limiter using a Map. Persists within Vercel's warm
// serverless container lifetime (typically 5-15 minutes). When the
// container cold-starts, the Map resets — which is fine for our purpose:
// bot attacks that span across cold starts are also spread over time,
// so limits still work in aggregate.
//
// For stronger protection across serverless instances, we could later
// swap this for Vercel KV or Upstash Redis with zero API changes.
//
// The leading underscore in the filename (_rate-limit.js) tells Vercel
// NOT to expose this file as an API endpoint.
// ═══════════════════════════════════════════════════════════════════

const buckets = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute sliding window
const CLEANUP_INTERVAL = 500; // Clean stale entries every 500 requests

let requestCounter = 0;

/**
 * Check and record a rate-limited request.
 * @param {string} identifier - Unique key (e.g., "groq:1.2.3.4")
 * @param {number} maxPerMinute - Max requests allowed per minute
 * @returns {{ok: boolean, retryAfter?: number, remaining?: number}}
 */
export function checkRateLimit(identifier, maxPerMinute) {
  const now = Date.now();

  // Opportunistic cleanup to prevent memory bloat
  requestCounter++;
  if (requestCounter % CLEANUP_INTERVAL === 0) {
    for (const [key, times] of buckets) {
      const stillFresh = times.filter(t => now - t < WINDOW_MS);
      if (stillFresh.length === 0) buckets.delete(key);
      else buckets.set(key, stillFresh);
    }
  }

  const times = buckets.get(identifier) || [];
  const recent = times.filter(t => now - t < WINDOW_MS);

  if (recent.length >= maxPerMinute) {
    const oldest = recent[0];
    const retryAfter = Math.ceil((WINDOW_MS - (now - oldest)) / 1000);
    return { ok: false, retryAfter, remaining: 0 };
  }

  recent.push(now);
  buckets.set(identifier, recent);
  return { ok: true, remaining: maxPerMinute - recent.length };
}

/**
 * Extract client IP from Vercel edge request headers.
 * Handles proxy chains via x-forwarded-for correctly.
 */
export function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return (
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Apply rate limiting to a request. Returns true if request should proceed.
 * If limited, sends 429 response and returns false.
 *
 * Usage:
 *   if (!applyRateLimit(req, res, 'groq', 30)) return;
 *   // ...rest of handler
 */
export function applyRateLimit(req, res, endpoint, maxPerMinute) {
  const ip = getClientIP(req);
  const key = `${endpoint}:${ip}`;
  const result = checkRateLimit(key, maxPerMinute);

  // Add rate limit info headers on every response
  res.setHeader('X-RateLimit-Limit', String(maxPerMinute));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining || 0));

  if (!result.ok) {
    console.warn(`[RATE-LIMIT] ${endpoint} blocked ${ip} — retry in ${result.retryAfter}s`);
    res.setHeader('Retry-After', String(result.retryAfter));
    res.status(429).json({
      error: {
        message: `Too many requests. Please slow down. Retry in ${result.retryAfter} seconds.`,
        retryAfter: result.retryAfter
      }
    });
    return false;
  }
  return true;
}
