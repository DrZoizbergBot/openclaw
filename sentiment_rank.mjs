/**
 * sentiment_rank.mjs
 * Ranks tickers by confidence score.
 * Usage: node sentiment_rank.mjs TICKER,PROXIMITY,CHANGE TICKER,PROXIMITY,CHANGE ...
 * Example: node sentiment_rank.mjs FLY,-3.20,18.28 CF,-1.30,12.91
 *
 * Output (tab-separated):
 *   SCORE\tLABEL\tTICKER\tCONFIDENCE\tCONFIDENCE_LABEL
 */

import https from "https";
import http from "http";

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

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
      host: proxy.host, port: proxy.port, method: "CONNECT",
      path: "api.stocktwits.com:443",
      headers: { "Proxy-Authorization": `Basic ${auth}` },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      const agent = new https.Agent({ socket });
      https.get(
        { host: "api.stocktwits.com", path, agent, headers: { "User-Agent": "Mozilla/5.0" } },
        (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => resolve({ status: r.statusCode, data: d })); }
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
      const bullPercent = total > 0 ? Math.round((bull / total) * 100) : 0;
      return { bullPercent, labeledCount: total };
    } catch { continue; }
  }
  return null;
}

// ─── Confidence Score ─────────────────────────────────────────────────────────

function proximityScore(proximity) {
  // proximity is negative (e.g. -1.30)
  // 0% = 100, -5% = 50, -10% = 0
  const score = 100 + (proximity * 10);
  return Math.max(0, Math.min(100, score));
}

function changeScore(change) {
  if (change < 5)  return 20;
  if (change < 8)  return 40;
  if (change < 15) return 100;
  if (change < 25) return 85;
  return 25;
}

function sentimentScore(bullPercent, labeledCount) {
  // Only applies if labeled >= 8
  if (labeledCount < 8) return 0;
  return bullPercent;
}

function computeConfidence(proximity, change, bullPercent, labeledCount) {
  const pScore = proximityScore(proximity);
  const cScore = changeScore(change);
  const sScore = sentimentScore(bullPercent, labeledCount);

  const total = (pScore * 0.50) + (cScore * 0.42) + (sScore * 0.08);
  return parseFloat(total.toFixed(1));
}

function confidenceLabel(score) {
  if (score >= 75) return "HIGH";
  if (score >= 50) return "MEDIUM";
  return "LOW";
}

function sentimentLabel(bullPercent, labeledCount) {
  if (labeledCount < 8) return "NEUTRAL";
  if (bullPercent >= 60) return "BULLISH";
  if (bullPercent <= 40) return "BEARISH";
  return "NEUTRAL";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Input format: TICKER,PROXIMITY,CHANGE
const inputs = process.argv.slice(2).map(arg => {
  const [ticker, proximity, change] = arg.split(",");
  return {
    ticker: ticker.toUpperCase(),
    proximity: parseFloat(proximity),
    change: parseFloat(change),
  };
}).filter(i => i.ticker && !isNaN(i.proximity) && !isNaN(i.change));

if (inputs.length === 0) {
  console.error("Usage: node sentiment_rank.mjs TICKER,PROXIMITY,CHANGE ...");
  process.exit(2);
}

const results = await Promise.all(inputs.map(async ({ ticker, proximity, change }) => {
  const st = await fetchStockTwits(ticker);
  const bullPercent = st?.bullPercent ?? 0;
  const labeledCount = st?.labeledCount ?? 0;

  const confidence = computeConfidence(proximity, change, bullPercent, labeledCount);
  const label = confidenceLabel(confidence);
  const sentiment = sentimentLabel(bullPercent, labeledCount);

  process.stderr.write(
    `[RANK] ${ticker} | proximity: ${proximity}% | change: ${change}% | ` +
    `labeled: ${labeledCount} | bull: ${bullPercent}% | confidence: ${confidence} ${label}\n`
  );

  return { ticker, confidence, label, sentiment, bullPercent, labeledCount };
}));

// Filter BEARISH sentiment, sort by confidence descending
const filtered = results
  .filter(r => r.sentiment !== "BEARISH")
  .sort((a, b) => b.confidence - a.confidence);

for (const r of filtered) {
  process.stdout.write(`${r.confidence}\t${r.label}\t${r.ticker}\t${r.bullPercent}\t${r.labeledCount}\n`);
}
