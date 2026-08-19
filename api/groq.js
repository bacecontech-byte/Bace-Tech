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
    const body = req.body || {};

    // --- Speech-to-text (Whisper) branch ---
    if (body.action === 'transcribe') {
      const audioBase64 = body.audioBase64;
      if (!audioBase64) {
        return res.status(400).json({ error: { message: 'Missing audioBase64 for transcription.' } });
      }
      const buf = Buffer.from(audioBase64, 'base64');
      const form = new FormData();
      form.append('file', new Blob([buf], { type: body.mimeType || 'audio/webm' }), body.filename || 'audio.webm');
      form.append('model', body.model || 'whisper-large-v3-turbo');
      form.append('response_format', 'json');
      if (body.language) form.append('language', body.language);
      const wr = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
        body: form
      });
      const wd = await wr.json();
      return res.status(wr.status).json(wd);
    }

    const { model, messages, max_tokens, reasoning_effort, temperature } = body;

    if (!model || !messages) {
      return res.status(400).json({ error: { message: 'Missing model or messages in request body.' } });
    }

    const payload = { model, messages, max_tokens: max_tokens || 1024 };
    // Reasoning models (e.g. openai/gpt-oss-120b) spend tokens on hidden
    // reasoning first; letting callers request low effort leaves room for the
    // actual answer instead of an empty content field.
    if (reasoning_effort) payload.reasoning_effort = reasoning_effort;
    if (typeof temperature === 'number') payload.temperature = temperature;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const data = await groqRes.json();
    return res.status(groqRes.status).json(data);
  } catch (err) {
    return res.status(500).json({
      error: { message: 'Server error calling Groq: ' + (err.message || 'unknown') }
    });
  }
}
