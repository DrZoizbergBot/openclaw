/**
 * enrich_watchlist.mjs
 * Enriches OpenClaw trade ideas with:
 *   - Google News RSS headline
 *   - Reddit + StockTwits sentiment
 *   - AI-synthesized rationale combining news + sentiment + price action
 *   - Sentiment-adjusted rank
 *
 * Output format per trade:
 *   Ticker: HIMS
 *   Entry: 25.00 | Stop: 22.67 | Target: 29.67 | Allocation: 600.00 USD
 *   News: <headline> (<source>)
 *   Sentiment: 🟢 BULLISH | Score: 0.587 | Reddit: 1 mention | StockTwits: 80% bull
 *   Rationale: <AI-synthesized from news + sentiment + price action>
 *   Rank: #1
 */

import { spawnSync } from "child_process";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function runScript(scriptPath, args = [], timeoutMs = 10000) {
  const result = spawnSync("node", [scriptPath, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return result.stdout || "";
}

function safeJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ─── Build rationale via OpenAI ───────────────────────────────────────────────

async function buildRationale({ ticker, entry, stop, target, headline, sentiment }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "Rationale unavailable (no API key).";

  const st = sentiment?.stocktwits;
  const rd = sentiment?.reddit;

  const prompt = `You are a concise US equity trading analyst. Write a single 2-sentence trade rationale for ${ticker}.

Available data:
- Entry: ${entry || "n/a"} | Stop: ${stop || "n/a"} | Target: ${target || "n/a"}
- Latest news: ${headline || "No recent news"}
- Sentiment: ${sentiment?.sentimentLabel || "NEUTRAL"} (score ${sentiment?.sentimentScore || "n/a"})
- StockTwits: ${st ? `${st.bullPercent}% bullish, ${st.messageCount} messages` : "unavailable"}
- Reddit: ${rd ? `${rd.mentions} mention(s), top post: "${rd.topTitle || "none"}"` : "unavailable"}

Rules:
- Combine news catalyst, sentiment signal, and price setup into one coherent thesis
- Be direct and specific — no generic filler
- Do not mention stop loss or entry price explicitly
- Max 2 sentences`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    return oneLine(text) || "Rationale unavailable.";
  } catch {
    return "Rationale unavailable (API error).";
  }
}

// ─── Parse stdin into trade blocks ───────────────────────────────────────────

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
  if (line.trim() === "") {
    if (current.length > 0) { blocks.push(current); current = []; }
  } else {
    current.push(line);
  }
}
if (current.length > 0) blocks.push(current);

// ─── Extract fields from a block ─────────────────────────────────────────────

function extractField(block, prefix) {
  for (const line of block) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
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

// ─── Enrich each block ────────────────────────────────────────────────────────

const enriched = [];

for (const block of blocks) {
  const ticker = extractTicker(block);

  if (!ticker) {
    enriched.push({ ticker: null, sentimentScore: null, lines: block });
    continue;
  }

  // Extract price fields from any line in the block
  const fullText = block.join(" ");
  const entry    = extractPrice(fullText, "Entry");
  const stop     = extractPrice(fullText, "Stop");
  const target   = extractPrice(fullText, "Target");

  // Extract allocation
  const allocMatch = fullText.match(/Allocation:\s*([\d.]+ USD(?:\s*\|\s*Shares:\s*\d+)?)/i);
  const allocation = allocMatch ? allocMatch[1] : "";

  // Fetch headline
  const headlineRaw = runScript("/data/state/scripts/rss_headline.mjs", [ticker]);
  const headline = oneLine(headlineRaw).replace(" (Google News RSS)", "") || "No recent headline found";

  // Fetch sentiment
  const sentimentRaw = runScript("/data/state/scripts/sentiment.mjs", [ticker], 12000);
  const sentiment = safeJSON(sentimentRaw);

  // Build rationale via OpenAI
  const rationale = await buildRationale({ ticker, entry, stop, target, headline, sentiment });

  // Build sentiment line
  const st = sentiment?.stocktwits;
  const rd = sentiment?.reddit;
  const stStr = st ? `StockTwits: ${st.bullPercent}% bull` : "StockTwits: n/a";
  const rdStr = rd ? `Reddit: ${rd.mentions} mention${rd.mentions !== 1 ? "s" : ""}` : "Reddit: n/a";
  const sentimentLine = sentiment
    ? `Sentiment: ${sentiment.sentimentTag} | Score: ${sentiment.sentimentScore} | ${rdStr} | ${stStr}`
    : `Sentiment: ⚪ UNAVAILABLE`;

  // Build price line
  const priceLine = [
    entry      ? `Entry: ${entry}`           : null,
    stop       ? `Stop: ${stop}`             : null,
    target     ? `Target: ${target}`         : null,
    allocation ? `Allocation: ${allocation}` : null,
  ].filter(Boolean).join(" | ");

  // Assemble block in target format
  const newLines = [
    `Ticker: ${ticker}`,
    priceLine,
    `News: ${headline} (Google News RSS)`,
    sentimentLine,
    `Rationale: ${rationale}`,
  ];

  enriched.push({
    ticker,
    sentimentScore: sentiment?.sentimentScore ?? 0.5,
    sentimentLabel: sentiment?.sentimentLabel ?? "NEUTRAL",
    lines: newLines,
  });
}

// ─── Rank by sentiment score ──────────────────────────────────────────────────

const tradeBlocks = enriched.filter((b) => b.ticker !== null);
const passThrough = enriched.filter((b) => b.ticker === null);

tradeBlocks.sort((a, b) => (b.sentimentScore || 0) - (a.sentimentScore || 0));

// Filter out bearish trades
const filteredBlocks = tradeBlocks.filter((b) => b.sentimentLabel !== "BEARISH");

filteredBlocks.forEach((b, i) => b.lines.push(`Rank: #${i + 1}`));

// ─── Output ───────────────────────────────────────────────────────────────────

const outputBlocks = [...passThrough, ...filteredBlocks];
process.stdout.write(outputBlocks.map((b) => b.lines.join("\n")).join("\n\n") + "\n");
