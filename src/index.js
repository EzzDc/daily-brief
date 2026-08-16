import clients from "../clients.json";

export default {
  async fetch(request) {
    // ?days=7 while testing, so you actually see results
    const days = new URL(request.url).searchParams.get("days") || "1";
    const results = await getAllNews(days);
    return new Response(JSON.stringify(results, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
};

// --- build one Google News feed URL ---
function feedUrl(feed, days) {
  const q = encodeURIComponent(`${feed.q} when:${days}d`);
  return `https://news.google.com/rss/search?q=${q}`
       + `&hl=${feed.hl}&gl=${feed.gl}&ceid=${encodeURIComponent(feed.ceid)}`;
}

// --- turn &amp; and &#39; back into real characters ---
function decode(s = "") {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// --- pull <item> blocks out of the XML ---
function parseItems(xml) {
  return [...xml.matchAll(/<item>(.*?)<\/item>/gs)].map(m => {
    const block = m[1];
    const grab = tag => {
      const hit = block.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "s"));
      return hit ? decode(hit[1].trim()) : "";
    };
    return {
      title: grab("title"),
      link: grab("link"),
      date: grab("pubDate"),
      source: grab("source")
    };
  });
}

async function fetchFeed(feed, days) {
  const res = await fetch(feedUrl(feed, days), {
    headers: { "user-agent": "Mozilla/5.0 (compatible; daily-brief/1.0)" }
  });
  if (!res.ok) return [];
  return parseItems(await res.text());
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAllNews(days) {
  const out = [];

  for (const client of clients) {
    let items = [];

    for (const feed of client.feeds) {
      items.push(...await fetchFeed(feed, days));
      await sleep(200); // be polite to Google
    }

    // same story can appear in two feeds — keep one
    const seen = new Set();
    items = items.filter(i => !seen.has(i.title) && seen.add(i.title));

    // drop coupon/jobs noise
    const bad = (client.exclude || []).map(w => w.toLowerCase());
    const kept = items.filter(i =>
      !bad.some(w => i.title.toLowerCase().includes(w))
    );

    out.push({
      client: client.name,
      fetched: items.length,
      kept: kept.length,
      items: kept
    });
  }

  return out;
}
