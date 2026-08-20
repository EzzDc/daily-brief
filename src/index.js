import clients from "../clients.json";

const TO_EMAIL = "ezz.aldissi@gmail.com";   // <-- your address
const FROM_EMAIL = "onboarding@resend.dev";
const BASE_DAYS = 8;
const WIKI_UA = "daily-brief-worker/1.0 (contact: ezz.aldissi@gmail.com)";

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
    // never worth burning CSE quota on. Only "/" runs the actual search.
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

// ---------- search (Google Custom Search JSON API — free up to 100 queries/day) ----------

async function searchClient(env, client, days) {
  const names = [client.name, ...(client.aliases || [])].filter(Boolean);
  const query = names.map(n => `"${n}"`).join(" OR ");

  const res = await fetchGoogleCse(env, query, days);
  if (res.error) return { error: res.error, detail: res.detail, items: [] };

  const bad = (client.exclude || []).map(w => w.toLowerCase());
  const seenUrls = new Set();
  const items = [];
  for (const item of res.items) {
    if (!item.title || !item.url) continue;
    if (seenUrls.has(item.url)) continue;
    if (bad.some(w => item.title.toLowerCase().includes(w))) continue;
    seenUrls.add(item.url);
    items.push(item);
  }

  return { items: items.slice(0, 15) };
}

async function fetchGoogleCse(env, query, days) {
  if (!env.GOOGLE_CSE_KEY || !env.GOOGLE_CSE_CX) {
    return { error: "GOOGLE_CSE_KEY/GOOGLE_CSE_CX not configured", items: [] };
  }

  const params = new URLSearchParams({
    key: env.GOOGLE_CSE_KEY,
    cx: env.GOOGLE_CSE_CX,
    q: query,
    num: "10",
    dateRestrict: `d${days}`
  });

  try {
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      return { error: `CSE ${res.status}`, detail: (await res.text()).slice(0, 300), items: [] };
    }
    const data = await res.json();
    return { items: (data.items || []).map(toCseItem) };
  } catch (err) {
    return { error: String((err && err.message) || err), items: [] };
  }
}

function toCseItem(entry) {
  const meta = entry.pagemap && entry.pagemap.metatags && entry.pagemap.metatags[0];
  const rawDate = meta && (meta["article:published_time"] || meta["og:updated_time"]
    || meta["date"] || meta["datepublished"]);

  return {
    title: entry.title || "",
    url: entry.link || "",
    date: rawDate ? String(rawDate).slice(0, 10) : "",
    summary: entry.snippet ? entry.snippet.replace(/\s+/g, " ").trim() : "",
    source: entry.displayLink || ""
  };
}

// ---------- company background profile (free Wikipedia summary) ----------

async function fetchProfile(client) {
  const candidates = [client.name, ...(client.aliases || [])].filter(Boolean);

  for (const name of candidates) {
    try {
      const title = name.trim().replace(/\s+/g, "_");
      const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
        headers: { "user-agent": WIKI_UA }
      });
      if (!res.ok) continue;

      const data = await res.json();
      if (data.type === "disambiguation" || !data.extract) continue;

      return {
        summary: data.extract,
        wikiTitle: data.title,
        sourceUrl: (data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page)
          || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        generatedAt: new Date().toISOString()
      };
    } catch { /* try next candidate */ }
  }

  return { error: "no matching Wikipedia article found", generatedAt: new Date().toISOString() };
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

  // Run clients concurrently (so they don't queue up behind each other's network latency)
  // but capped — firing all 28 RSS requests in one burst reads as scraping to Google and gets 503'd.
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

  const res = await searchClient(env, client, days);

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

  const token = url.searchParams.get("token");
  const authorized = !!(token && env.TRIGGER_TOKEN && token === env.TRIGGER_TOKEN);
  const clientId = url.searchParams.get("client");

  if (url.searchParams.get("refresh-profile") === "1" && clientId) {
    if (!authorized) return json({ error: "unauthorized" });
    const client = clients.find(c => (c.id || c.name) === clientId);
    if (!client) return new Response("Not found", { status: 404 });
    const profile = await fetchProfile(client);
    await env.BRIEF.put("profile:" + clientId, JSON.stringify(profile));
  }

  if (url.searchParams.get("generate-missing") === "1" && !clientId) {
    if (!authorized) return json({ error: "unauthorized" });
    const batch = Math.min(Number(url.searchParams.get("limit") || "5"), 14);
    let done = 0;
    for (const client of clients) {
      if (done >= batch) break;
      const id = client.id || client.name;
      const existing = await env.BRIEF.get("profile:" + id);
      if (existing) continue;
      const profile = await fetchProfile(client);
      await env.BRIEF.put("profile:" + id, JSON.stringify(profile));
      done++;
    }
  }

  const html = clientId
    ? await renderClientPage(env, clientId, authorized, token)
    : await renderIndexPage(env, authorized, token);

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
  .badge { display:inline-block; font-size:11px; padding:2px 7px; border-radius:20px; background:#eef2f8; color:#456; margin-bottom:8px; }
  .badge.missing { background:#fdf0ee; color:#a33; }
  .backlink { display:inline-block; margin-bottom:18px; font-size:13px; }
  .hint { font-size:12px; color:#999; margin-top:6px; }
  ul.hist { list-style:none; padding:0; margin:0; }
  ul.hist li { padding:14px 0; border-bottom:1px solid #eee; }
  ul.hist .meta { font-size:12px; color:#888; margin-top:3px; }
  .empty { color:#888; font-size:13px; padding:18px 0; }
  .actions { margin:10px 0 20px; font-size:13px; }
`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><style>${PAGE_CSS}</style></head>
  <body><div class="wrap">${body}</div></body></html>`;
}

function withToken(qs, token) {
  return token ? `${qs}&token=${encodeURIComponent(token)}` : qs;
}

async function renderIndexPage(env, authorized, token) {
  const cards = await Promise.all(clients.map(async client => {
    const id = client.id || client.name;
    const [profileRaw, hist] = await Promise.all([
      env.BRIEF.get("profile:" + id),
      listHistory(env, id, 1)
    ]);
    const profile = profileRaw ? JSON.parse(profileRaw) : null;
    const latest = hist.items[0];

    return `<a class="card" href="/dashboard?client=${encodeURIComponent(id)}${token ? "&token=" + encodeURIComponent(token) : ""}">
      <span class="badge ${profile && !profile.error ? "" : "missing"}">${profile && !profile.error ? "Profile ready" : "No profile yet"}</span>
      <h3>${esc(client.name)}</h3>
      <div class="domain">${esc(client.domain || "")}</div>
      <div class="summary">${esc(profile && profile.summary ? profile.summary : (client.notes || ""))}</div>
      <div class="stats">
        <span><b>${hist.count}</b> news items</span>
        <span>${latest ? "last " + esc(latest.date || latest.foundAt.slice(0,10)) : "no history yet"}</span>
      </div>
    </a>`;
  }));

  const actions = authorized
    ? `<div class="actions">
        <a href="/dashboard?generate-missing=1${withToken("", token)}">Generate profiles for clients missing one (5 at a time, free)</a>
      </div>`
    : `<div class="hint">Add ?token=YOUR_TRIGGER_TOKEN to the URL to unlock profile generation.</div>`;

  return page("Client Intelligence Dashboard", `
    <h1>Client Intelligence Dashboard</h1>
    <div class="sub">${clients.length} accounts · Wikipedia background profiles + full news history</div>
    ${actions}
    <div class="grid">${cards.join("")}</div>
  `);
}

async function renderClientPage(env, clientId, authorized, token) {
  const client = clients.find(c => (c.id || c.name) === clientId);
  if (!client) return null;

  const [profileRaw, hist] = await Promise.all([
    env.BRIEF.get("profile:" + clientId),
    listHistory(env, clientId, 200)
  ]);
  const profile = profileRaw ? JSON.parse(profileRaw) : null;

  const backLink = `<a class="backlink" href="/dashboard${token ? "?token=" + encodeURIComponent(token) : ""}">&larr; All accounts</a>`;
  const refreshLink = `/dashboard?client=${encodeURIComponent(clientId)}&refresh-profile=1${withToken("", token)}`;

  let profileBlock;
  if (!profile) {
    profileBlock = `<div class="empty">No background profile yet.</div>` +
      (authorized ? `<div class="actions"><a href="${refreshLink}">Look up on Wikipedia</a></div>` : "");
  } else if (profile.error) {
    profileBlock = `<div class="empty">${esc(profile.error)}</div>` +
      (authorized ? `<div class="actions"><a href="${refreshLink}">Retry</a></div>` : "");
  } else {
    profileBlock = `
      <p>${esc(profile.summary || "")}</p>
      <div class="hint">Source: <a href="${esc(profile.sourceUrl)}">${esc(profile.wikiTitle || "Wikipedia")}</a>
        · fetched ${esc((profile.generatedAt || "").slice(0, 10))}
        ${authorized ? ` · <a href="${refreshLink}">Refresh</a>` : ""}
      </div>`;
  }

  const histItems = hist.items.length
    ? `<ul class="hist">${hist.items.map(i => `
        <li>
          <a href="${esc(i.url)}" dir="auto"><b>${esc(i.title)}</b></a>
          <div dir="auto">${esc(i.summary)}</div>
          <div class="meta">${esc(i.source)} · ${esc(i.date)} · found ${esc((i.foundAt || "").slice(0, 10))}</div>
        </li>`).join("")}</ul>`
    : `<div class="empty">No news history recorded yet — it fills in as the weekly brief runs.</div>`;

  return page(client.name, `
    ${backLink}
    <h1>${esc(client.name)}</h1>
    <div class="sub">${esc(client.domain || "")}</div>
    ${profileBlock}
    <h3>News history (${hist.count})</h3>
    ${histItems}
  `);
}
