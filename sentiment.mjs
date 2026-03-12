/**
 * sentiment.mjs
 * Fetches Reddit + StockTwits sentiment for a given ticker.
 *
 * Usage: node sentiment.mjs TICKER
 *
 * Output (JSON):
 * {
 *   ticker: "HIMS",
 *   reddit: { mentions: 12, score: 0.72, topTitle: "..." },
 *   stocktwits: { bullPercent: 78, bearPercent: 22, messageCount: 45 },
 *   sentimentScore: 0.75,        // 0.0 – 1.0 composite
 *   sentimentLabel: "BULLISH",   // BULLISH | NEUTRAL | BEARISH
 *   sentimentTag: "🟢 BULLISH"   // for Telegram output
 * }
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
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ─── Reddit ──────────────────────────────────────────────────────────────────
// Uses the public Reddit JSON API — no auth required.
// Searches r/wallstreetbets, r/stocks, r/investing for ticker mentions (last 24h).

const SUBREDDITS = ["wallstreetbets", "stocks", "investing", "StockMarket"];

async function fetchReddit(ticker) {
  let totalMentions = 0;
  let topTitle = null;
  let topScore = -1;
  let bullishHits = 0;
  let bearishHits = 0;

  const BULLISH_WORDS = /\b(buy|long|calls|moon|breakout|bullish|squeeze|rocket|surge|pump)\b/i;
  const BEARISH_WORDS = /\b(sell|short|puts|dump|crash|bearish|overvalued|avoid|drop|collapse)\b/i;

  for (const sub of SUBREDDITS) {
    const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(ticker)}&sort=new&limit=25&t=day&restrict_sr=1`;
    try {
      const { status, data } = await get(url, {
        "User-Agent": "openclaw-sentiment/1.0 (by /u/openclaw_bot)",
      });
      if (status !== 200) continue;

      const json = safeJSON(data);
      if (!json?.data?.children) continue;

      for (const post of json.data.children) {
        const d = post?.data;
        if (!d) continue;

        // Count only posts that actually mention the ticker
        const text = `${d.title || ""} ${d.selftext || ""}`;
        const tickerPattern = new RegExp(`\\b${ticker}\\b`, "i");
        if (!tickerPattern.test(text)) continue;

        totalMentions++;

        if (BULLISH_WORDS.test(text)) bullishHits++;
        if (BEARISH_WORDS.test(text)) bearishHits++;

        const score = d.score || 0;
        if (score > topScore) {
          topScore = score;
          topTitle = (d.title || "").replace(/\s+/g, " ").trim();
        }
      }
    } catch {
      // Silently skip failed subreddit
    }
  }

  // Sentiment direction from keyword ratio
  const totalSentimentHits = bullishHits + bearishHits;
  const redditBullRatio =
    totalSentimentHits > 0 ? bullishHits / totalSentimentHits : 0.5;

  // Normalize mentions: cap at 30 for scoring purposes
  const mentionScore = Math.min(totalMentions / 30, 1.0);

  return {
    mentions: totalMentions,
    bullRatio: parseFloat(redditBullRatio.toFixed(3)),
    mentionScore: parseFloat(mentionScore.toFixed(3)),
    topTitle: topTitle || null,
  };
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
      let bull = 0, bear = 0;
      for (const msg of json.messages) {
        const s = msg?.entities?.sentiment?.basic;
        if (s === "Bullish") bull++;
        else if (s === "Bearish") bear++;
      }
      const total = bull + bear;
      const bullPercent = total > 0 ? Math.round((bull / total) * 100) : 50;
      const uniqueUsers = new Set(json.messages.map(m => m?.user?.username).filter(Boolean)).size;
      const participationRatio = json.messages.length > 0 ? uniqueUsers / json.messages.length : 0;
      return {
        bullPercent,
        bearPercent: 100 - bullPercent,
        messageCount: json.messages.length,
        labeledCount: total,
        participationRatio: parseFloat(participationRatio.toFixed(2)),
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Composite Score ──────────────────────────────────────────────────────────
// Weights: StockTwits bull ratio 50%, Reddit bull ratio 30%, Reddit mention score 20%
// Output: 0.0 (max bearish) → 1.0 (max bullish)

function compositeScore(reddit, stocktwits) {
  const stBullRatio = stocktwits ? stocktwits.bullPercent / 100 : 0.5;
  const rdBullRatio = reddit.bullRatio;
  const rdMentions = reddit.mentionScore;

  const score = stBullRatio * 0.6 + rdBullRatio * 0.2 + rdMentions * 0.2;
  return parseFloat(score.toFixed(3));
}

function scoreToLabel(score) {
  if (score >= 0.55) return "BULLISH";
  if (score <= 0.42) return "BEARISH";
  return "NEUTRAL";
}

function scoreToTag(score) {
  return scoreToLabel(score);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const ticker = (process.argv[2] || "").toUpperCase();
if (!ticker) {
  console.error("Usage: node sentiment.mjs TICKER");
  process.exit(2);
}

const [reddit, stocktwits] = await Promise.all([
  fetchReddit(ticker),
  fetchStockTwits(ticker),
]);

const sentimentScore = compositeScore(reddit, stocktwits);
const sentimentLabel = scoreToLabel(sentimentScore);
const sentimentTag = scoreToTag(sentimentScore);

const result = {
  ticker,
  reddit,
  stocktwits,
  sentimentScore,
  sentimentLabel,
  sentimentTag,
};

console.log(JSON.stringify(result, null, 2));
