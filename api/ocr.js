// /api/ocr.js — Google Document AI OCR for precise text extraction from plan tiles.
// Layers a real OCR engine on top of the vision model so dimensions, callouts and
// title-block text are read reliably.
//
// Auth: a Google service account (no npm deps — we mint an OAuth token by signing
// a JWT with Node's crypto). Required Vercel env vars:
//   GCP_PROJECT_ID          your Google Cloud project id
//   DOCAI_LOCATION          processor region: "us" or "eu"
//   DOCAI_PROCESSOR_ID      the Document OCR processor id
//   GOOGLE_SA_CLIENT_EMAIL  service-account email
//   GOOGLE_SA_PRIVATE_KEY   service-account private key (PEM; \n may be escaped)
//
// Setup: Google Cloud → Document AI → create a "Document OCR" processor, copy its
// ID + region; create a service account with role "Document AI API User", download
// its JSON key, and paste client_email + private_key into the env vars above.

import crypto from 'crypto';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  const jwt = unsigned + '.' + b64url(signature);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt)
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(d.error_description || d.error || 'token exchange failed');
  return d.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const project = process.env.GCP_PROJECT_ID;
  const location = process.env.DOCAI_LOCATION || 'us';
  const processorId = process.env.DOCAI_PROCESSOR_ID;
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_SA_PRIVATE_KEY || '';
  privateKey = privateKey.replace(/\\n/g, '\n'); // env vars often store \n escaped

  if (!project || !processorId || !clientEmail || !privateKey) {
    return res.status(200).json({ ok: false, error: 'not_configured' });
  }

  try {
    let { imageBase64, mimeType } = req.body || {};
    if (!imageBase64) return res.status(400).json({ ok: false, error: 'missing_image' });
    // Accept a data URL or raw base64
    const comma = imageBase64.indexOf(',');
    if (imageBase64.slice(0, 5) === 'data:' && comma > -1) imageBase64 = imageBase64.slice(comma + 1);

    const token = await getAccessToken(clientEmail, privateKey);
    const url = 'https://' + location + '-documentai.googleapis.com/v1/projects/' + project +
      '/locations/' + location + '/processors/' + processorId + ':process';
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawDocument: { content: imageBase64, mimeType: mimeType || 'image/jpeg' } })
    });
    const d = await r.json();
    if (d && d.document && typeof d.document.text === 'string') {
      return res.status(200).json({ ok: true, text: d.document.text });
    }
    return res.status(200).json({ ok: false, error: (d && d.error && d.error.message) || 'ocr_error' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'server error: ' + (err.message || 'unknown') });
  }
}
