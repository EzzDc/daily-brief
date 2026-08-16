import clients from "../clients.json";

const json = obj => new Response(JSON.stringify(obj, null, 2), {
  headers: { "content-type": "application/json; charset=utf-8" }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const days = url.searchParams.get("days") || "2";
    const mark = url.searchParams.get("mark") === "1";

    if (!env.BRIEF) {
      return json({ error: "KV binding BRIEF is missing — check Worker → Bindings" });
    }

    return json(await getAllNews(env, days, mark));
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

Return ONLY a JSON array, no other text, no markdown fences:
[{"title":"","summary":"one sentence","url":"","date":"YYYY-MM-DD","source":""}]
If there is nothing, return []`;

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
  const text = data.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  try {
    const parsed = JSON.parse(text);
    return { items: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { error: "could not parse", raw: text.slice(0, 300), items: [] };
  }
}

// ---------- dedupe ----------

function fingerprints(item) {
  const keys = [];

  if (item.url) {
    const clean = String(item.url)
      .toLowerCase()
      .split("?")[0]
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
    if (clean) keys.push("seen:url:" + clean);
  }

  if (item.title) {
    const clean = String(item.title)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")   // Unicode-aware: keeps Arabic
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
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
    await env.BRIEF.put(key, "1", { expirationTtl: 2592000 }); // 30 days
  }
}

// ---------- main ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAllNews(env, days, mark) {
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

    // TEMPORARY: ?mark=1 simulates a successful send.
    // In Phase 6 this moves to AFTER Resend confirms delivery.
    if (mark) {
      for (const item of fresh) await markSeen(env, item);
    }

    out.push({
      client: client.name,
      found: res.items.length,
      afterExclude: kept.length,
      fresh: fresh.length,
      items: fresh,
      error: res.error,
      raw: res.raw || res.detail
    });

    await sleep(500);
  }

  return out;
}
