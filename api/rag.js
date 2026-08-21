// /api/rag.js — Semantic search (RAG) over incidents + documents using pgvector.
// Embeddings come from Google Gemini (text-embedding-004, 768 dims), vectors are
// stored in Supabase (doc_chunks) and searched with the match_chunks RPC.
//
// Actions:
//   { action:"index",  company_id, source_type, source_id, project, title, content }
//       → chunk + embed the content and (re)store its vectors.
//   { action:"search", company_id, query, k }
//       → embed the query and return the most relevant chunks.
//
// Env (Vercel): GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.
// One-time DB setup: run supabase/pgvector.sql in the Supabase SQL editor.

const EMBED_MODEL = 'models/text-embedding-004';
const EMBED_DIM = 768;

function ok(res, obj) { return res.status(200).json(obj); }

async function embedTexts(texts, key) {
  // Gemini batch embeddings
  const body = { requests: texts.map(t => ({ model: EMBED_MODEL, content: { parts: [{ text: (t || '').slice(0, 8000) }] } })) };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/' + EMBED_MODEL + ':batchEmbedContents?key=' + key, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok || !d.embeddings) throw new Error((d.error && d.error.message) || 'embed_failed');
  return d.embeddings.map(e => e.values);
}

function toVectorLiteral(vals) { return '[' + vals.join(',') + ']'; }

function chunkText(text, size, maxChunks) {
  text = (text || '').replace(/\r/g, '').trim();
  if (!text) return [];
  const paras = text.split(/\n{2,}/);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > size && buf) { chunks.push(buf.trim()); buf = p; }
    else { buf = buf ? buf + '\n\n' + p : p; }
    if (chunks.length >= maxChunks) break;
  }
  if (buf && chunks.length < maxChunks) chunks.push(buf.trim());
  // Hard-split any oversize single chunk
  const out = [];
  for (const c of chunks) {
    if (c.length <= size * 1.5) out.push(c);
    else for (let i = 0; i < c.length && out.length < maxChunks; i += size) out.push(c.slice(i, i + size));
  }
  return out.slice(0, maxChunks);
}

async function sb(method, path, key, url, body) {
  const r = await fetch(url + '/rest/v1/' + path, {
    method,
    headers: {
      apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=minimal' : undefined
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { okStatus: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const geminiKey = process.env.GEMINI_API_KEY;
  const sbUrl = process.env.SUPABASE_URL || 'https://rzdoeehbpdgjxtfbbmwp.supabase.co';
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!geminiKey || !sbKey) return ok(res, { ok: false, error: 'not_configured' });

  const b = req.body || {};
  const action = b.action;

  try {
    if (action === 'index') {
      const { company_id, source_type, source_id, project, title, content } = b;
      if (!company_id || !source_id || !content) return ok(res, { ok: false, error: 'missing_fields' });
      const chunks = chunkText(content, 1500, 25);
      if (!chunks.length) return ok(res, { ok: true, chunks: 0 });
      const vectors = await embedTexts(chunks, geminiKey);
      // Replace any existing chunks for this source, then insert fresh
      await sb('DELETE', 'doc_chunks?company_id=eq.' + encodeURIComponent(company_id) +
        '&source_type=eq.' + encodeURIComponent(source_type || 'document') +
        '&source_id=eq.' + encodeURIComponent(source_id), sbKey, sbUrl);
      const rows = chunks.map((c, i) => ({
        company_id, source_type: source_type || 'document', source_id: String(source_id),
        project: project || '', title: title || '', content: c, embedding: toVectorLiteral(vectors[i])
      }));
      const ins = await sb('POST', 'doc_chunks', sbKey, sbUrl, rows);
      if (!ins.okStatus) return ok(res, { ok: false, error: 'insert_failed', detail: ins.data });
      return ok(res, { ok: true, chunks: chunks.length });
    }

    if (action === 'search') {
      const { company_id, query, k } = b;
      if (!company_id || !query) return ok(res, { ok: false, error: 'missing_fields' });
      const vec = (await embedTexts([query], geminiKey))[0];
      const r = await sb('POST', 'rpc/match_chunks', sbKey, sbUrl, {
        query_embedding: toVectorLiteral(vec), match_company: company_id, match_count: Math.min(Math.max(k || 6, 1), 12)
      });
      if (!r.okStatus) return ok(res, { ok: false, error: 'search_failed', detail: r.data });
      return ok(res, { ok: true, matches: Array.isArray(r.data) ? r.data : [] });
    }

    return ok(res, { ok: false, error: 'unknown_action' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'server error: ' + (err.message || 'unknown') });
  }
}
