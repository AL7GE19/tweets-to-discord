const fs = require("fs");
const path = require("path");

const dir = __dirname;
const readLines = (f) =>
  fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const WEBHOOK = process.env.WEBHOOK_URL || readLines("webhook.txt")[0];
const FEEDS = process.env.FEEDS ? process.env.FEEDS.split(/\s+/).filter(Boolean) : readLines("feeds.txt");
const SEEN_FILE = path.join(dir, "seen.json");
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || 5);
const ONCE = process.argv.includes("--once");

let seen = fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const get = (tag) => {
      const r = m[0].match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return r ? r[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : "";
    };
    const link = get("link").replace(/^https?:\/\/(mobile\.)?twitter\.com/, "https://x.com");
    const id = get("guid") || link;
    if (id) items.push({ id, link, date: Date.parse(get("pubDate")) || 0 });
  }
  return items.sort((a, b) => a.date - b.date);
}

async function send(link) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: link }),
    });
    if (res.ok) return true;
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await sleep((body.retry_after || 2) * 1000);
      continue;
    }
    console.error("send failed:", res.status, await res.text());
    return false;
  }
  return false;
}

async function checkAll() {
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) { console.error("feed error", feed, res.status); continue; }
      const items = parseItems(await res.text());
      const firstTime = !seen[feed];
      const known = new Set(seen[feed] || []);
      for (const it of items) {
        if (known.has(it.id)) continue;
        if (!firstTime) {
          if (!(await send(it.link))) continue;
          console.log("sent:", it.link);
          await sleep(1000);
        }
        known.add(it.id);
      }
      seen[feed] = [...known].slice(-200);
      if (firstTime) console.log("first run", feed, "saved", items.length, "without sending");
    } catch (e) {
      console.error("error", feed, e.message);
    }
  }
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
}

(async () => {
  if (!WEBHOOK || !FEEDS.length) { console.error("missing WEBHOOK_URL or feeds.txt"); process.exit(1); }
  do {
    await checkAll();
    if (!ONCE) await sleep(INTERVAL_MIN * 60 * 1000);
  } while (!ONCE);
})();
