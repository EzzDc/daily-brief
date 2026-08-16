import clients from "../clients.json";

const json = obj => new Response(JSON.stringify(obj, null, 2), {
  headers: { "content-type": "application/json; charset=utf-8" }
});

export default {
  async fetch(request, env) {
    const days = new URL(request.url).searchParams.get("days") || "2";
    return json(await getAllNews(env, days));
  }
};

async function searchClient(env, client, days) {
  const prompt = `Search the web for news about this company from the last ${days} days:

Company: ${client.name}
Also known as: ${client.feeds.map(f => f.q).join(" / ")}
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
    return { items: JSON.parse(text) };
  } catch {
    return { error: "could not parse", raw: text.slice(0, 300), items: [] };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAllNews(env, days) {
  const out = [];

  for (const client of clients) {
    const res = await searchClient(env, client, days);

    const bad = (client.exclude || []).map(w => w.toLowerCase());
    const kept = res.items.filter(i =>
      !bad.some(w => (i.title || "").toLowerCase().includes(w))
    );

    out.push({
      client: client.name,
      found: res.items.length,
      kept: kept.length,
      items: kept,
      error: res.error,
      raw: res.raw || res.detail
    });

    await sleep(500);
  }

  return out;
}
