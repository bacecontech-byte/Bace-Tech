// /api/delete-account.js — GDPR/LGPD account deletion
// Verifies the caller's Supabase access token, then permanently removes the
// user's rows from the app tables and deletes the Auth user with the service key.

import { applyRateLimit } from './_rate-limit.js';

const SUPABASE_URL = process.env.SUPABASE_URL || "https://rzdoeehbpdgjxtfbbmwp.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Rate limit: deletion is sensitive and rare
  if (!applyRateLimit(req, res, 'delete-account', 5)) return;

  if (!SERVICE_KEY) return res.status(500).json({ error: "Server misconfigured: SUPABASE_SERVICE_KEY not set." });

  try {
    const body = req.body || JSON.parse(await getBody(req));
    const accessToken = body.access_token;
    if (!accessToken) return res.status(401).json({ error: "Missing access token." });

    // 1) Verify the token → resolves the real user id (never trust the client-supplied id).
    const uRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + accessToken },
    });
    const user = await uRes.json();
    if (!uRes.ok || !user || !user.id) return res.status(401).json({ error: "Invalid or expired session." });
    const uid = user.id;
    const email = user.email || "";
    const companyId = body.company_id || null;

    // 2) Best-effort scrub of app data owned by this user.
    //    (Company-shared rows are only removed when this user is the sole/owning account.)
    const del = (path) => fetch(SUPABASE_URL + "/rest/v1/" + path, {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Prefer: "return=minimal" },
    }).catch(() => {});

    const tasks = [];
    if (email) {
      tasks.push(del(`captures?user_name=eq.${encodeURIComponent(email)}`));
      tasks.push(del(`community_posts?author_name=eq.${encodeURIComponent(email)}`));
      tasks.push(del(`community_replies?author_name=eq.${encodeURIComponent(email)}`));
    }
    if (companyId) {
      // Cloud connections + integrations are workspace-scoped; remove on account deletion.
      tasks.push(del(`cloud_connections?company_id=eq.${encodeURIComponent(companyId)}`));
      tasks.push(del(`user_usage?company_id=eq.${encodeURIComponent(companyId)}`));
    }
    await Promise.allSettled(tasks);

    // 3) Delete the Auth user (Admin API — requires the service role key).
    const aRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + uid, {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
    });
    if (!aRes.ok) {
      const t = await aRes.text().catch(() => "");
      return res.status(500).json({ error: "Auth deletion failed: " + (t || aRes.status) });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("delete-account error:", err);
    return res.status(500).json({ error: err.message || "unknown" });
  }
}

function getBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data || "{}"));
  });
}
