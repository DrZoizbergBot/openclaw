/**
 * sentiment.mjs
 * Fetches StockTwits sentiment for a given ticker.
 * Usage: node sentiment.mjs TICKER
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
      const bullPercent = total > 0 ? Math.round((bull / total) * 100) : 50;
      const uniqueUsers = new Set(recent.map(m => m?.user?.username).filter(Boolean)).size;
      const participationRatio = recent.length > 0 ? uniqueUsers / recent.length : 0;
      return {
        bullPercent,
        bearPercent: 100 - bullPercent,
        messageCount: recent.length,
        labeledCount: total,
        participationRatio: parseFloat(participationRatio.toFixed(2)),
      };
    } catch { continue; }
  }
  return null;
}

function scoreToLabel(score) {
  if (score >= 0.55) return "BULLISH";
  if (score <= 0.42) return "BEARISH";
  return "NEUTRAL";
}

const ticker = (process.argv[2] || "").toUpperCase();
if (!ticker) { console.error("Usage: node sentiment.mjs TICKER"); process.exit(2); }

const stocktwits = await fetchStockTwits(ticker);
const sentimentScore = stocktwits ? parseFloat((stocktwits.bullPercent / 100).toFixed(3)) : 0.5;
const sentimentLabel = scoreToLabel(sentimentScore);

const result = {
  ticker,
  stocktwits,
  sentimentScore,
  sentimentLabel,
  sentimentTag: sentimentLabel,
};

process.stdout.write(JSON.stringify(result) + "\n");
