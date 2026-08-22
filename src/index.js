import clients from "../clients.json";

const TO_EMAIL = "ezz.aldissi@gmail.com";   // <-- your address
const FROM_EMAIL = "onboarding@resend.dev";
const BASE_DAYS = 8;

const SONNET = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5";

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

    if (url.pathname === "/dashboard") {
      return handleDashboard(request, env, url);
    }

    // Anything besides "/" is a stray browser/crawler request (favicon.ico, robots.txt, etc.) —
    // never worth burning a paid Claude API call on. Only "/" runs the actual search.
    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
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

// ---------- search (Claude + web_search tool) ----------

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

  if (!env.ANTHROPIC_API_KEY) {
    return { error: "ANTHROPIC_API_KEY not configured", items: [] };
  }

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
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
      }),
      signal: AbortSignal.timeout(30000)
    });
  } catch (err) {
    return { error: String((err && err.message) || err), items: [] };
  }

  if (!res.ok) {
    return { error: `API ${res.status}`, detail: (await res.text()).slice(0, 300), items: [] };
  }

  const data = await res.json();
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("").trim();

  const parsed = extractArray(text);
  if (!parsed) return { error: "could not parse", detail: text.slice(0, 600), items: [] };

  const bad = (client.exclude || []).map(w => w.toLowerCase());
  const items = parsed.filter(i =>
    i && i.title && i.url && !bad.some(w => String(i.title).toLowerCase().includes(w))
  );

  return { items: items.slice(0, 15) };
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

// ---------- permanent history (for the dashboard) ----------

async function saveHistory(env, clientId, clientName, item) {
  const ts = Date.now();
  const key = `hist:${clientId}:${ts}:${Math.random().toString(36).slice(2, 8)}`;
  await env.BRIEF.put(key, JSON.stringify({
    title: item.title, summary: item.summary, url: item.url,
    date: item.date, source: item.source,
    client: clientName, foundAt: new Date(ts).toISOString()
  }));
}

async function listHistory(env, clientId, limit = 200) {
  const prefix = `hist:${clientId}:`;
  let cursor, keys = [];
  do {
    const res = await env.BRIEF.list({ prefix, cursor, limit: 1000 });
    keys = keys.concat(res.keys);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);

  keys.sort((a, b) => b.name.localeCompare(a.name)); // newest first (ts embedded in key)
  const top = keys.slice(0, limit);
  const items = await Promise.all(top.map(async k => {
    const raw = await env.BRIEF.get(k.name);
    try { return JSON.parse(raw); } catch { return null; }
  }));
  return { count: keys.length, items: items.filter(Boolean) };
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
      await saveHistory(env, r.id || r.client, r.client, item);
      marked++;
    }
  }

  return { sent: true, itemsSent: total, marked };
}

// ---------- main ----------

async function getAllNews(env, { adaptive = false, forceDays = null } = {}) {
  // global run counter, only advances on adaptive runs
  let runIndex = Number(await env.BRIEF.get("run:index") || "0");
  if (adaptive) {
    runIndex += 1;
    await env.BRIEF.put("run:index", String(runIndex));
  }

  // Run clients concurrently (so they don't queue up behind each other's latency) but capped,
  // to stay comfortably under Anthropic's per-minute rate limits.
  return mapWithConcurrency(clients, 3, client =>
    processClient(env, client, { adaptive, forceDays, runIndex }));
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function processClient(env, client, { adaptive, forceDays, runIndex }) {
  const id = client.id || client.name;
  const state = await getState(env, id);

  // --- skip if this client is in backoff ---
  if (adaptive && runIndex < state.next) {
    return { client: client.name, id, skipped: true, nextRun: state.next, items: [] };
  }

  // cover every week since this client was last checked
  const runsWaited = adaptive && state.lastRun ? runIndex - state.lastRun : 1;
  const days = forceDays || String(Math.min(BASE_DAYS + (runsWaited - 1) * 7, 40));

  // quiet clients get the cheaper model
  const model = state.misses >= 2 ? HAIKU : SONNET;

  const res = await searchClient(env, client, days, model);

  const fresh = [];
  for (const item of res.items) {
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

  return {
    client: client.name,
    id,
    model: model === HAIKU ? "haiku" : "sonnet",
    days,
    found: res.items.length,
    items: fresh,
    error: res.error,
    detail: res.detail
  };
}

// ---------- dashboard ----------

async function handleDashboard(request, env, url) {
  if (!env.BRIEF) return json({ error: "KV binding BRIEF is missing" });

  const clientId = url.searchParams.get("client");
  const html = clientId
    ? await renderClientPage(env, clientId)
    : await renderIndexPage(env);

  if (!html) return new Response("Not found", { status: 404 });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const PAGE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 60px; background:#f5f6f8; color:#1a1d24;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  a { color:#0b5cad; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:#666; font-size:13px; margin-bottom:28px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px; }
  .card { background:#fff; border:1px solid #e6e8eb; border-radius:10px; padding:16px; }
  .card h3 { margin:0 0 6px; font-size:15px; }
  .card .domain { color:#888; font-size:12px; margin-bottom:8px; }
  .card .summary { font-size:13px; color:#333; margin-bottom:10px; line-height:1.4; min-height:36px; }
  .stats { display:flex; gap:14px; font-size:12px; color:#666; }
  .stats b { color:#1a1d24; }
  .backlink { display:inline-block; margin-bottom:18px; font-size:13px; }
  ul.hist { list-style:none; padding:0; margin:0; }
  ul.hist li { padding:14px 0; border-bottom:1px solid #eee; }
  ul.hist .meta { font-size:12px; color:#888; margin-top:3px; }
  .empty { color:#888; font-size:13px; padding:18px 0; }
`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><style>${PAGE_CSS}</style></head>
  <body><div class="wrap">${body}</div></body></html>`;
}

async function renderIndexPage(env) {
  const cards = await Promise.all(clients.map(async client => {
    const id = client.id || client.name;
    const hist = await listHistory(env, id, 1);
    const latest = hist.items[0];

    return `<a class="card" href="/dashboard?client=${encodeURIComponent(id)}">
      <h3>${esc(client.name)}</h3>
      <div class="domain">${esc(client.domain || "")}</div>
      <div class="summary">${esc(client.notes || "")}</div>
      <div class="stats">
        <span><b>${hist.count}</b> news items</span>
        <span>${latest ? "last " + esc(latest.date || latest.foundAt.slice(0,10)) : "no history yet"}</span>
      </div>
    </a>`;
  }));

  return page("Client Intelligence Dashboard", `
    <h1>Client Intelligence Dashboard</h1>
    <div class="sub">${clients.length} accounts · full news history</div>
    <div class="grid">${cards.join("")}</div>
  `);
}

async function renderClientPage(env, clientId) {
  const client = clients.find(c => (c.id || c.name) === clientId);
  if (!client) return null;

  const hist = await listHistory(env, clientId, 200);

  const histItems = hist.items.length
    ? `<ul class="hist">${hist.items.map(i => `
        <li>
          <a href="${esc(i.url)}" dir="auto"><b>${esc(i.title)}</b></a>
          <div dir="auto">${esc(i.summary)}</div>
          <div class="meta">${esc(i.source)} · ${esc(i.date)} · found ${esc((i.foundAt || "").slice(0, 10))}</div>
        </li>`).join("")}</ul>`
    : `<div class="empty">No news history recorded yet — it fills in as the weekly brief runs.</div>`;

  return page(client.name, `
    <a class="backlink" href="/dashboard">&larr; All accounts</a>
    <h1>${esc(client.name)}</h1>
    <div class="sub">${esc(client.domain || "")}</div>
    <p>${esc(client.notes || "")}</p>
    <h3>News history (${hist.count})</h3>
    ${histItems}
  `);
}
