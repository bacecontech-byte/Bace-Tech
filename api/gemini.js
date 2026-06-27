// Vercel Serverless Function - /api/gemini.js
// Handles all vision/image analysis calls using Google Gemini 2.0 Flash.
// The key lives in Vercel's environment variables (GEMINI_API_KEY), never in the browser.

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

  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_KEY) {
    return res.status(500).json({
      error: { message: 'Server misconfigured: GEMINI_API_KEY environment variable is not set on Vercel.' }
    });
  }

  try {
    const { messages, max_tokens } = req.body || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Missing or invalid messages array in request body.' } });
    }

    // Convert OpenAI-style messages to Gemini format
    const geminiContents = messages.map(msg => {
      if (typeof msg.content === 'string') {
        return { role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] };
      }
      // Array content (with image_url parts)
      const parts = msg.content.map(part => {
        if (part.type === 'text') {
          return { text: part.text };
        }
        if (part.type === 'image_url') {
          const url = part.image_url?.url || '';
          // Handle base64 data URLs: data:image/jpeg;base64,XXXXX
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            return {
              inlineData: {
                mimeType: match[1],
                data: match[2]
              }
            };
          }
          // Plain URL (less common in this app)
          return { text: `[Image URL: ${url}]` };
        }
        return { text: '' };
      }).filter(p => p.text !== '' || p.inlineData);

      return { role: msg.role === 'assistant' ? 'model' : 'user', parts };
    });

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: geminiContents,
          generationConfig: {
            maxOutputTokens: max_tokens || 4096,
            temperature: 0.2,
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({
        error: { message: data?.error?.message || 'Gemini API error' }
      });
    }

    // Convert Gemini response to OpenAI-compatible format so bace.html needs no change in response parsing
    // Gemini 2.5 Flash may return multiple parts (thinking + response) — grab all text parts and join
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .filter(p => p.text && !p.thought)  // exclude thinking parts
      .map(p => p.text)
      .join('\n')
      .trim() || '';
    return res.status(200).json({
      choices: [{ message: { role: 'assistant', content: text } }]
    });

  } catch (err) {
    return res.status(500).json({
      error: { message: 'Server error calling Gemini: ' + (err.message || 'unknown') }
    });
  }
}
