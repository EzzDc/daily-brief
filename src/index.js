import clients from "../clients.json";

const TO_EMAIL = "ezz.aldissi@gmail.com";   // <-- your address
const FROM_EMAIL = "onboarding@resend.dev";
const BASE_DAYS = 8;

const SONNET = "claude-sonnet-5";
const HAIKU  = "claude-haiku-4-5-20251001";

const json = obj => new Response(JSON.stringify(obj, null, 2), {
  headers: { "content-type": "application/json; charset=utf-8" }
});

export default {
  // Sundays 05:30 UTC = 08:30 Amman
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBrief(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const send = url.searchParams.get("send") === "1";
    const adaptive = url.searchParams.get("adaptive") === "1";
    const days = url.searchParams.get("days");

    if (!env.BRIEF) return json({ error: "KV binding BRIEF is missing" });

    if (send && url.searchParams.get("token") !== env.TRIGGER_TOKEN) {
      return json({ error: "unauthorized" });
    }

    // Manual runs check every client unless you ask for adaptive.
    const results = await getAllNews(env, { adaptive, forceDays: days });
    if (!send) return json({ dryRun: true, results, html: buildHtml(results) });
    return json(await sendBrief(env, results));
  }
};

async function runBrief(env) {
  try {
    const results = await getAllNews(env, { adaptive: true });
    await sendBrief(env, results);
  } catch (err) {
    await alertFailure(env, err);
  }
}

async function alertFailure(env, err) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject: "⚠️ Client brief failed",
      html: `<pre>${esc(String((err && err.stack) || err))}</pre>`
    })
  });
}

// ---------- cadence state ----------

async function getState(env, id) {
  const raw = await env.BRIEF.get("state:" + id);
  if (!raw) return { misses: 0, next: 0 };
  try { return JSON.parse(raw); } catch { return { misses: 0, next: 0 }; }
}

// how many runs to wait before checking again
function backoff(misses) {
  if (misses < 2) return 1;
  return Math.min(misses, 4);
}

// ---------- search ----------

async function searchClient(env, client, days, model) {
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
      model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]
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
    return `<p style="font-family:sans-serif;color:#666">No client news this week.</p>`;
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
      subject: total > 0
        ? `Weekly client brief — ${today} (${total})`
        : `Weekly client brief — ${today} (nothing new)`,
      html
    })
  });

  const body = await res.text();

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

async function getAllNews(env, { adaptive = false, forceDays = null } = {}) {
  const out = [];

  // global run counter, only advances on adaptive runs
  let runIndex = Number(await env.BRIEF.get("run:index") || "0");
  if (adaptive) {
    runIndex += 1;
    await env.BRIEF.put("run:index", String(runIndex));
  }

  for (const client of clients) {
    const id = client.id || client.name;
    const state = await getState(env, id);

    // --- skip if this client is in backoff ---
    if (adaptive && runIndex < state.next) {
      out.push({
        client: client.name,
        skipped: true,
        nextRun: state.next,
        items: []
      });
      continue;
    }

    // cover every week since this client was last checked
    const runsWaited = adaptive && state.lastRun ? runIndex - state.lastRun : 1;
    const days = forceDays || String(Math.min(BASE_DAYS + (runsWaited - 1) * 7, 40));

    // quiet clients get the cheaper model
    const model = state.misses >= 2 ? HAIKU : SONNET;

    const res = await searchClient(env, client, days, model);

    const bad = (client.exclude || []).map(w => w.toLowerCase());
    const kept = res.items.filter(i =>
      !bad.some(w => String(i.title || "").toLowerCase().includes(w))
    );

    const fresh = [];
    for (const item of kept) {
      if (!await isSeen(env, item)) fresh.push(item);
    }

    // --- update cadence state ---
    if (adaptive) {
      const misses = res.items.length > 0 ? 0 : state.misses + 1;
      await env.BRIEF.put("state:" + id, JSON.stringify({
        misses,
        lastRun: runIndex,
        next: runIndex + backoff(misses)
      }));
    }

    out.push({
      client: client.name,
      model: model === HAIKU ? "haiku" : "sonnet",
      days,
      found: res.items.length,
      items: fresh,
      error: res.error,
      raw: res.raw || res.detail
    });

    await sleep(500);
  }

  return out;
}
