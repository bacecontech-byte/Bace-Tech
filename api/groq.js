// Vercel Serverless Function - /api/groq.js
// Keeps the Groq API key hidden from the public GitHub repo.
// The key lives in Vercel's environment variables, never in the browser.

import { applyRateLimit } from './_rate-limit.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  // Rate limit: 30 AI chat requests per minute per IP
  // Protects Groq API budget from bot abuse
  if (!applyRateLimit(req, res, 'groq', 30)) return;

  const GROQ_KEY = process.env.GROQ_API_KEY;

  if (!GROQ_KEY) {
    // This tells us clearly if the env var is missing on Vercel
    return res.status(500).json({
      error: { message: 'Server misconfigured: GROQ_API_KEY environment variable is not set on Vercel.' }
    });
  }

  try {
    const { model, messages, max_tokens } = req.body || {};

    if (!model || !messages) {
      return res.status(400).json({ error: { message: 'Missing model or messages in request body.' } });
    }

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({ model, messages, max_tokens: max_tokens || 1024 })
    });

    const data = await groqRes.json();
    return res.status(groqRes.status).json(data);
  } catch (err) {
    return res.status(500).json({
      error: { message: 'Server error calling Groq: ' + (err.message || 'unknown') }
    });
  }
}
