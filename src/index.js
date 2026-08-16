import clients from "../clients.json";

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "accept": "application/rss+xml, application/xml, text/xml, */*",
  "accept-language": "en-US,en;q=0.9,ar;q=0.8"
};

const json = obj => new Response(JSON.stringify(obj, null, 2), {
  headers: { "content-type": "application/json; charset=utf-8" }
});

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const days = url.searchParams.get("days") || "2";

    // ?debug=1 -> show exactly what Google sends back
    if (url.searchParams.get("debug")) {
      const feed = clients[0].feeds[0];
      const u = feedUrl(feed, days);
      const r = await fetch(u, { headers: HEADERS });
      const body = await r.text();
      return json({
        url: u,
        status: r.status,
        contentType: r.headers.get("content-type"),
        bodyLength: body.length,
        itemCount: (body.match(/<item>/g) || []).length,
        sample: body.slice(0, 800)
      });
    }

    return json(await getAllNews(days));
  }
};

function feedUrl(feed, days) {
  const q = encodeURIComponent(`${feed.q} when:${days}d`);
  return `https://news.google.com/rss/search?q=${q}`
       + `&hl=${feed.hl}&gl=${feed.gl}&ceid=${encodeURIComponent(feed.ceid)}`;
}

function decode(s = "") {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

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

// now reports WHY a feed came back empty instead of hiding it
async function fetchFeed(feed, days) {
  try {
    const res = await fetch(feedUrl(feed, days), { headers: HEADERS });
    const body = await res.text();
    return {
      status: res.status,
      bodyLength: body.length,
      items: res.ok ? parseItems(body) : []
    };
  } catch (err) {
    return { status: "threw", error: String(err), items: [] };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAllNews(days) {
  const out = [];

  for (const client of clients) {
    let items = [];
    const feedLog = [];

    for (const feed of client.feeds) {
      const res = await fetchFeed(feed, days);
      feedLog.push({
        lang: feed.hl,
        status: res.status,
        bodyLength: res.bodyLength,
        found: res.items.length,
        error: res.error
      });
      items.push(...res.items);
      await sleep(200);
    }

    const seen = new Set();
    items = items.filter(i => !seen.has(i.title) && seen.add(i.title));

    const bad = (client.exclude || []).map(w => w.toLowerCase());
    const kept = items.filter(i =>
      !bad.some(w => i.title.toLowerCase().includes(w))
    );

    out.push({
      client: client.name,
      feeds: feedLog,          // <-- the useful part
      fetched: items.length,
      kept: kept.length,
      items: kept
    });
  }

  return out;
}
