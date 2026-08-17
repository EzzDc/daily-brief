import clients from "../clients.json";

const TO_EMAIL = "ezz.dissi@tryoto.com";   // <-- change this
const FROM_EMAIL = "onboarding@resend.dev";

const json = obj => new Response(JSON.stringify(obj, null, 2), {
  headers: { "content-type": "application/json; charset=utf-8" }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const days = url.searchParams.get("days") || "2";
    const send = url.searchParams.get("send") === "1";

    if (!env.BRIEF) return json({ error: "KV binding BRIEF is missing" });

    const results = await getAllNews(env, days);

    // Default is a dry run: see what WOULD be sent, without sending.
    if (!send) return json({ dryRun: true, results, html: buildHtml(results) });

    return json(await sendBrief(env, results));
  }
};

// ---------- search ----------

async function searchClient(env, client, days) {
  const prompt = `Search the web for news about this company from the last ${days} days:

Company: ${client.name}
Also known as: ${(client.aliases || []).join(", ")}
Focus: ${client.focus || "all news about this company"}
Context: ${client.notes || ""}
Website: ${client.domain || ""}

Rules:
- Only real news. Ignore coupon sites, discount roundups, job postings, and store-listing pages.
- Ignore anything about a different company with a similar name.
- Search in both English and Arabic.

Format: [{"title":"","summary":"one sentence","url":"","date":"YYYY-MM-DD","source":""}]
If there is nothing, return []

Output the JSON array and nothing else. No preamble, no explanation, no markdown fences.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
    })
  });

  if (!res.ok) {
    return { error: `API ${res.status}`, detail: (await res.text()).slice(0, 300), items: [] };
  }

  const data = await res.json();
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("").trim();

  const parsed = extractArray(text);
  if (!parsed) return { error: "could not parse", raw: text.slice(0, 600), items: [] };
  return { items: parsed };
}

function extractArray(text) {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

// ---------- dedupe ----------

function fingerprints(item) {
  const keys = [];
  if (item.url) {
    const clean = String(item.url).toLowerCase().split("?")[0]
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
    if (clean) keys.push("seen:url:" + clean.slice(0, 400));
  }
  if (item.title) {
    const clean = String(item.title).toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (clean) keys.push("seen:title:" + clean);
  }
  return keys;
}

async function isSeen(env, item) {
  for (const key of fingerprints(item)) {
    if (await env.BRIEF.get(key) !== null) return true;
  }
  return false;
}

async function markSeen(env, item) {
  for (const key of fingerprints(item)) {
    await env.BRIEF.put(key, "1", { expirationTtl: 2592000 });
  }
}

// ---------- email ----------

const esc = s => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function buildHtml(results) {
  const withNews = results.filter(r => r.items.length > 0);

  if (withNews.length === 0) {
    return `<p style="font-family:sans-serif;color:#666">No client news today.</p>`;
  }

  const sections = withNews.map(r => {
    const items = r.items.map(i => `
      <li style="margin-bottom:14px">
        <a href="${esc(i.url)}" style="color:#0b5cad;text-decoration:none;font-weight:600" dir="auto">${esc(i.title)}</a>
        <div style="color:#333;margin-top:3px" dir="auto">${esc(i.summary)}</div>
        <div style="color:#888;font-size:12px;margin-top:3px">${esc(i.source)} · ${esc(i.date)}</div>
      </li>`).join("");

    return `<h3 style="margin:22px 0 8px;padding-bottom:4px;border-bottom:1px solid #eee">${esc(r.client)}</h3>
      <ul style="padding-left:18px;margin:0">${items}</ul>`;
  }).join("");

  const errors = results.filter(r => r.error);
  const errBlock = errors.length
    ? `<p style="color:#999;font-size:11px;margin-top:26px">Issues: ${errors.map(e => esc(e.client)).join(", ")}</p>`
    : "";

  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;max-width:640px">
    ${sections}${errBlock}
  </div>`;
}

async function sendBrief(env, results) {
  const html = buildHtml(results);
  const total = results.reduce((n, r) => n + r.items.length, 0);
  const today = new Date().toISOString().slice(0, 10);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject: total > 0 ? `Client brief — ${today} (${total})` : `Client brief — ${today} (nothing new)`,
      html
    })
  });

  const body = await res.text();

  // ORDER MATTERS: only mark items as seen once the send actually succeeded.
  if (!res.ok) {
    return { sent: false, status: res.status, detail: body.slice(0, 300), marked: 0 };
  }

  let marked = 0;
  for (const r of results) {
    for (const item of r.items) {
      await markSeen(env, item);
      marked++;
    }
  }

  return { sent: true, itemsSent: total, marked };
}

// ---------- main ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAllNews(env, days) {
  const out = [];

  for (const client of clients) {
    const res = await searchClient(env, client, days);

    const bad = (client.exclude || []).map(w => w.toLowerCase());
    const kept = res.items.filter(i =>
      !bad.some(w => String(i.title || "").toLowerCase().includes(w))
    );

    const fresh = [];
    for (const item of kept) {
      if (!await isSeen(env, item)) fresh.push(item);
    }

    out.push({
      client: client.name,
      found: res.items.length,
      items: fresh,
      error: res.error,
      raw: res.raw || res.detail
    });

    await sleep(500);
  }

  return out;
}
