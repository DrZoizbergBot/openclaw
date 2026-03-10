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

// ─── StockTwits ───────────────────────────────────────────────────────────────

async function fetchStockTwits(ticker) {
  try {
    const { status, data } = await get(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
    if (status !== 200) return null;
    const json = safeJSON(data);
    if (!json?.messages) return null;
    let bull = 0, bear = 0;
    for (const msg of json.messages) {
      const s = msg?.entities?.sentiment?.basic;
      if (s === "Bullish") bull++;
      else if (s === "Bearish") bear++;
    }
    const total = bull + bear;
    const bullPercent = total > 0 ? Math.round((bull / total) * 100) : 50;
    return { bullPercent };
  } catch { return null; }
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
  const score = computeScore(reddit, stocktwits);
  const label = scoreToLabel(score);
  return { ticker, score, label };
}));

// Sort by score descending
results.sort((a, b) => b.score - a.score);

// Output tab-separated
for (const r of results) {
  process.stdout.write(`${r.score}\t${r.label}\t${r.ticker}\n`);
}
