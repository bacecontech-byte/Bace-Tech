// Vercel Serverless Function - /api/groq.js
// This keeps your Groq API key hidden from the public GitHub repo.
// The key lives in Vercel's environment variables, never in the browser.

export default async function handler(req, res) {
  // Allow requests from your app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;

  if (!GROQ_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: missing GROQ_API_KEY' });
  }

  try {
    const { model, messages, max_tokens } = req.body;

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
    console.error('Groq proxy error:', err);
    return res.status(500).json({ error: { message: 'Internal server error calling Groq' } });
  }
}
