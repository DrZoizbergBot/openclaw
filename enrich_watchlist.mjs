/**
 * enrich_watchlist.mjs
 * Enriches trade ideas with news headline, StockTwits sentiment, and AI rationale.
 */

import { spawnSync } from "child_process";

function oneLine(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

function runScript(scriptPath, args = [], timeoutMs = 10000) {
  const result = spawnSync("node", [scriptPath, ...args], { encoding: "utf8", timeout: timeoutMs });
  return result.stdout || "";
}

function safeJSON(str) { try { return JSON.parse(str); } catch { return null; } }

async function buildRationale({ ticker, entry, stop, headline, sentiment }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "Rationale unavailable (no API key).";
  const st = sentiment?.stocktwits;
  const prompt = `You are a concise US equity trading analyst. Write a single 2-sentence trade rationale for ${ticker}.

Available data:
- Entry: ${entry || "n/a"} | Stop: ${stop || "n/a"}
- Latest news: ${headline || "No recent news"}
- Sentiment: ${sentiment?.sentimentLabel || "NEUTRAL"} (score ${sentiment?.sentimentScore || "n/a"})
- StockTwits: ${st ? `${st.bullPercent}% bullish, ${st.messageCount} messages` : "unavailable"}

Rules:
- Combine news catalyst, sentiment signal, and price setup into one coherent thesis
- Be direct and specific — no generic filler
- Do not mention stop loss or entry price explicitly
- Max 2 sentences`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 120, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    return oneLine(data?.choices?.[0]?.message?.content) || "Rationale unavailable.";
  } catch { return "Rationale unavailable (API error)."; }
}

const input = await new Promise((resolve) => {
  let d = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => resolve(d));
});

const rawLines = input.split(/\r?\n/);
const blocks = [];
let current = [];
for (const line of rawLines) {
  if (line.trim() === "") { if (current.length > 0) { blocks.push(current); current = []; } }
  else { current.push(line); }
}
if (current.length > 0) blocks.push(current);

function extractField(block, prefix) {
  for (const line of block) { if (line.startsWith(prefix)) return line.slice(prefix.length).trim(); }
  return null;
}
function extractTicker(block) {
  const v = extractField(block, "Ticker:");
  return v ? v.match(/^([A-Z0-9.\-]+)/)?.[1] || null : null;
}
function extractPrice(str, label) {
  if (!str) return null;
  const m = str.match(new RegExp(`${label}[:\\s]+([\\d.]+)`, "i"));
  return m ? m[1] : null;
}

const enriched = [];

for (const block of blocks) {
  const ticker = extractTicker(block);
  if (!ticker) { enriched.push({ ticker: null, sentimentScore: null, lines: block }); continue; }

  const fullText = block.join(" ");
  const entry = extractPrice(fullText, "Entry");
  const stop  = extractPrice(fullText, "Stop");
  const allocMatch = fullText.match(/Allocation:\s*([\d.]+ USD(?:\s*\|\s*Shares:\s*\d+)?)/i);
  const allocation = allocMatch ? allocMatch[1] : "";

  const headlineRaw = runScript("/home/davide/openclaw-scripts/rss_headline.mjs", [ticker]);
  const headline = oneLine(headlineRaw).replace(" (Google News RSS)", "") || "No recent headline found";

  const sentimentRaw = runScript("/home/davide/openclaw-scripts/sentiment.mjs", [ticker], 12000);
  const sentiment = safeJSON(sentimentRaw);

  const rationale = await buildRationale({ ticker, entry, stop, headline, sentiment });

  const st = sentiment?.stocktwits;
  const stStr = st ? `StockTwits: ${st.bullPercent}% bull (${st.messageCount} msgs)` : "StockTwits: n/a";
  const sentimentLine = sentiment
    ? `Sentiment: ${sentiment.sentimentLabel} | ${stStr}`
    : `Sentiment: UNAVAILABLE`;

  const priceLine = [
    entry      ? `Entry: ${entry}`           : null,
    stop       ? `Stop: ${stop}`             : null,
    allocation ? `Allocation: ${allocation}` : null,
  ].filter(Boolean).join(" | ");

  const marketCapLine = extractField(block, "Market Cap:");
  const priceTsLine   = extractField(block, "Price:");

  const newLines = [
    `Ticker: ${ticker}`,
    priceLine,
    marketCapLine ? `Market Cap: ${marketCapLine}` : null,
    priceTsLine   ? `Price: ${priceTsLine}`         : null,
    `News: ${headline}`,
    sentimentLine,
    `Rationale: ${rationale}`,
  ].filter(Boolean);

  enriched.push({
    ticker,
    sentimentScore: sentiment?.sentimentScore ?? 0.5,
    sentimentLabel: sentiment?.sentimentLabel ?? "NEUTRAL",
    lines: newLines,
  });
}

const tradeBlocks = enriched.filter(b => b.ticker !== null);
tradeBlocks.sort((a, b) => (b.sentimentScore || 0) - (a.sentimentScore || 0));
const filteredBlocks = tradeBlocks.filter(b => b.sentimentLabel !== "BEARISH");
filteredBlocks.forEach((b, i) => b.lines.push(`Rank: #${i + 1}`));

const passThrough = enriched.filter(b => b.ticker === null);
const outputBlocks = [...passThrough, ...filteredBlocks];
process.stdout.write(outputBlocks.map(b => b.lines.join("\n")).join("\n\n") + "\n");
