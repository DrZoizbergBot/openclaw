/**
 * sentiment_rank.mjs
 * Lightweight sentiment pre-screener.
 * Takes a list of tickers as arguments, fetches sentiment for each in parallel,
 * and outputs them ranked by sentiment score (highest first).
 *
 * Usage: node sentiment_rank.mjs TICKER1 TICKER2 TICKER3 ...
 *
 * Output (one line per ticker, tab-separated):
 *   SCORE\tLABEL\tTICKER
 *
 * Example:
 *   0.74  BULLISH  HIMS
 *   0.55  NEUTRAL  AAOI
 *   0.40  BEARISH  AGCC
 */

import https from "https";
import http from "http";

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; openclaw/1.0)",
        ...headers,
      },
    };
    https
      .get(url, opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, data }));
      })
      .on("error", reject);
  });
}

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ─── Reddit ───────────────────────────────────────────────────────────────────

const SUBREDDITS = ["wallstreetbets", "stocks", "investing", "StockMarket"];
const BULLISH_WORDS = /\b(buy|long|calls|moon|breakout|bullish|squeeze|rocket|surge|pump)\b/i;
const BEARISH_WORDS = /\b(sell|short|puts|dump|crash|bearish|overvalued|avoid|drop|collapse)\b/i;

async function fetchReddit(ticker) {
  let mentions = 0;
  let bullish = 0;
  let bearish = 0;

  await Promise.all(SUBREDDITS.map(async (sub) => {
    try {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(ticker)}&sort=new&limit=25&t=day&restrict_sr=1`;
      const { status, data } = await get(url, {
        "User-Agent": "openclaw-sentiment/1.0 (by /u/openclaw_bot)",
      });
      if (status !== 200) return;
      const json = safeJSON(data);
      if (!json?.data?.children) return;
      for (const post of json.data.children) {
        const text = `${post?.data?.title || ""} ${post?.data?.selftext || ""}`;
        if (!new RegExp(`\\b${ticker}\\b`, "i").test(text)) continue;
        mentions++;
        if (BULLISH_WORDS.test(text)) bullish++;
        if (BEARISH_WORDS.test(text)) bearish++;
      }
    } catch { /* skip */ }
  }));

  const total = bullish + bearish;
  const bullRatio = total > 0 ? bullish / total : 0.5;
  const mentionScore = Math.min(mentions / 30, 1.0);
  return { mentions, bullRatio, mentionScore };
}

// ─── StockTwits via Webshare proxy ───────────────────────────────────────────


const PROXIES = [
  { host: "23.95.150.145",  port: 6114 },
  { host: "198.23.239.134", port: 6540 },
  { host: "107.172.163.27", port: 6543 },
  { host: "216.10.27.159",  port: 6837 },
  { host: "191.96.254.138", port: 6185 },
];
const PROXY_USER = "oydqkmio";
const PROXY_PASS = "gxoouwy65xd7";

function fetchViaProxy(path, proxy) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString("base64");
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: "api.stocktwits.com:443",
      headers: { "Proxy-Authorization": `Basic ${auth}` },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      const agent = new https.Agent({ socket });
      https.get(
        { host: "api.stocktwits.com", path, agent,
          headers: { "User-Agent": "Mozilla/5.0" } },
        (r) => {
          let d = "";
          r.on("data", c => d += c);
          r.on("end", () => resolve({ status: r.statusCode, data: d }));
        }
      ).on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function fetchStockTwits(ticker) {
  const path = `/api/2/streams/symbol/${ticker}.json`;
  for (const proxy of PROXIES) {
    try {
      const { status, data } = await fetchViaProxy(path, proxy);
      if (status !== 200) continue;
      const json = safeJSON(data);
      if (!json?.messages) continue;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = json.messages.filter(m => new Date(m.created_at).getTime() >= cutoff);

      let bull = 0, bear = 0;
      for (const msg of recent) {
        const s = msg?.entities?.sentiment?.basic;
        if (s === "Bullish") bull++;
        else if (s === "Bearish") bear++;
      }
      const total = bull + bear;
      const bullPercent = total > 0 ? Math.round((bull / total) * 100) : 50;
      const uniqueUsers = new Set(recent.map(m => m?.user?.username).filter(Boolean)).size;
      const participationRatio = recent.length > 0 ? uniqueUsers / recent.length : 0;
      return { bullPercent, messageCount: recent.length, labeledCount: total, participationRatio };
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Score ────────────────────────────────────────────────────────────────────

function computeScore(reddit, stocktwits) {
  const stRatio = stocktwits ? stocktwits.bullPercent / 100 : 0.5;
  return parseFloat((stRatio * 0.6 + reddit.bullRatio * 0.2 + reddit.mentionScore * 0.2).toFixed(3));
}

function scoreToLabel(score) {
  if (score >= 0.55) return "BULLISH";
  if (score <= 0.42) return "BEARISH";
  return "NEUTRAL";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const tickers = process.argv.slice(2).map(t => t.toUpperCase()).filter(Boolean);

if (tickers.length === 0) {
  console.error("Usage: node sentiment_rank.mjs TICKER1 TICKER2 ...");
  process.exit(2);
}

// Fetch all in parallel
const results = await Promise.all(tickers.map(async (ticker) => {
  const [reddit, stocktwits] = await Promise.all([
    fetchReddit(ticker),
    fetchStockTwits(ticker),
  ]);
  // Step 3 cutoff — minimum 10 labeled messages and 75% participation ratio
  if (!stocktwits) {
    process.stderr.write(`[SKIP] ${ticker} — StockTwits unavailable\n`);
    return null;
  }
  if (stocktwits.labeledCount < 10) {
    process.stderr.write(`[SKIP] ${ticker} — StockTwits labeled messages: ${stocktwits.labeledCount} (min 10)\n`);
    return null;
  }
  if (stocktwits.participationRatio < 0.75) {
    process.stderr.write(`[SKIP] ${ticker} — StockTwits participation: ${(stocktwits.participationRatio * 100).toFixed(0)}% (min 75%)\n`);
    return null;
  }

  const score = stocktwits.bullPercent / 100;
  const label = scoreToLabel(score);
  const stVolume = stocktwits.messageCount || 0;
  return { ticker, score, label, stVolume };
}));

// Sort by score descending, tie-break by StockTwits message volume
const filtered = results.filter(r => r !== null && r.label !== "BEARISH");
filtered.sort((a, b) => {
  if (b.score !== a.score) return b.score - a.score;
  return (b.stVolume || 0) - (a.stVolume || 0);
});

// Output tab-separated
for (const r of filtered) {
  process.stdout.write(`${r.score}\t${r.label}\t${r.ticker}\n`);
}
