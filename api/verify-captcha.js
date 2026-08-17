// ═══════════════════════════════════════════════════════════════════
// /api/verify-captcha.js — Server-side Cloudflare Turnstile verification
//
// The client submits a token; we verify it with Cloudflare's API
// using our SECRET key (stored in Vercel env vars, never in browser).
//
// SETUP REQUIRED:
// 1. Create a Turnstile site at https://dash.cloudflare.com/?to=/:account/turnstile
// 2. Copy the SITE KEY into TURNSTILE_SITE_KEY in index.html (top of main script block)
// 3. Copy the SECRET KEY into Vercel → Settings → Environment Variables → TURNSTILE_SECRET_KEY
// 4. Redeploy Vercel (auto-happens on git push)
// ═══════════════════════════════════════════════════════════════════

import { applyRateLimit } from './_rate-limit.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Rate limit: 20 CAPTCHA verifications per minute per IP
  // (Users normally verify once per login/signup — anything higher is abuse)
  if (!applyRateLimit(req, res, 'captcha', 20)) return;

  const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;

  // Graceful degradation: if secret not configured yet, allow the request
  // This lets you deploy this endpoint before configuring Turnstile in Cloudflare
  if (!TURNSTILE_SECRET) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      warning: 'TURNSTILE_SECRET_KEY not configured on Vercel — CAPTCHA verification skipped'
    });
  }

  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'Missing CAPTCHA token' });

    // Get client IP (Cloudflare uses this for additional validation)
    const clientIP =
      req.headers['cf-connecting-ip'] ||
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.headers['x-real-ip'] ||
      '';

    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET);
    formData.append('response', token);
    if (clientIP) formData.append('remoteip', clientIP);

    const cfResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData
    });

    const result = await cfResponse.json();

    if (result.success) {
      return res.status(200).json({ ok: true });
    } else {
      console.warn('[CAPTCHA] Verification failed:', result['error-codes']);
      return res.status(200).json({
        ok: false,
        error: 'CAPTCHA verification failed. Please try again.',
        codes: result['error-codes'] || []
      });
    }
  } catch (err) {
    console.error('[CAPTCHA] Server error:', err);
    return res.status(500).json({ ok: false, error: 'Server error verifying CAPTCHA' });
  }
}
