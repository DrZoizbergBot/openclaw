/**
 * enrich_watchlist.mjs
 * Enriches OpenClaw trade ideas with:
 *   - Google News RSS headline
 *   - Reddit + StockTwits sentiment score
 *   - Sentiment-adjusted rank (boosts bullish, drops bearish)
 *
 * Expects stdin in the format produced by the OpenClaw scanner:
 *   Ticker: HIMS
 *   Entry: 25.00 | Stop: 22.67 | Target: 29.67
 *   Allocation: 600.00 USD
 *   Rationale: ...
 *
 * Outputs the same format with two new lines injected after Rationale:
 *   Sentiment: 🟢 BULLISH | Score: 0.74 | Reddit: 12 mentions | StockTwits: 78% bull
 *   Rank: #1
 */

import { spawnSync } from "child_process";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function runScript(scriptPath, args = [], timeoutMs = 8000) {
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

// ─── Parse stdin into trade blocks ───────────────────────────────────────────

const input = await new Promise((resolve) => {
  let d = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => resolve(d));
});

const rawLines = input.split(/\r?\n/);

// Split into blocks separated by blank lines
// Each block is a trade idea or a watchlist entry
const blocks = [];
let current = [];

for (const line of rawLines) {
  if (line.trim() === "") {
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  } else {
    current.push(line);
  }
}
if (current.length > 0) blocks.push(current);

// ─── Identify trade idea blocks (have a Ticker: line) ────────────────────────

function extractTicker(block) {
  for (const line of block) {
    const m = line.match(/^Ticker:\s*([A-Z0-9.\-]+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

// ─── Enrich each block ────────────────────────────────────────────────────────

const enriched = [];

for (const block of blocks) {
  const ticker = extractTicker(block);

  if (!ticker) {
    // Not a trade block — pass through unchanged
    enriched.push({ ticker: null, sentimentScore: null, lines: block });
    continue;
  }

  // Fetch headline
  const headlineRaw = runScript("/data/state/scripts/rss_headline.mjs", [ticker]);
  const headline = oneLine(headlineRaw) || "No recent headline found. (Google News RSS)";

  // Fetch sentiment
  const sentimentRaw = runScript("/data/state/scripts/sentiment.mjs", [ticker], 10000);
  const sentiment = safeJSON(sentimentRaw);

  // Build enriched lines
  const newLines = [];
  let rationaleReplaced = false;

  for (const line of block) {
    if (line.startsWith("Rationale:")) {
      // Replace rationale with live headline
      newLines.push(`Rationale: ${headline}`);
      rationaleReplaced = true;

      // Inject sentiment line
      if (sentiment) {
        const st = sentiment.stocktwits;
        const rd = sentiment.reddit;
        const stStr = st
          ? `StockTwits: ${st.bullPercent}% bull`
          : "StockTwits: n/a";
        const rdStr = rd
          ? `Reddit: ${rd.mentions} mention${rd.mentions !== 1 ? "s" : ""}`
          : "Reddit: n/a";
        newLines.push(
          `Sentiment: ${sentiment.sentimentTag} | Score: ${sentiment.sentimentScore} | ${rdStr} | ${stStr}`
        );
      } else {
        newLines.push(`Sentiment: ⚪ UNAVAILABLE`);
      }

      continue;
    }

    newLines.push(line);
  }

  // If no Rationale line existed, append sentiment at end
  if (!rationaleReplaced && sentiment) {
    const st = sentiment.stocktwits;
    const rd = sentiment.reddit;
    const stStr = st ? `StockTwits: ${st.bullPercent}% bull` : "StockTwits: n/a";
    const rdStr = rd ? `Reddit: ${rd.mentions} mention${rd.mentions !== 1 ? "s" : ""}` : "Reddit: n/a";
    newLines.push(
      `Sentiment: ${sentiment.sentimentTag} | Score: ${sentiment.sentimentScore} | ${rdStr} | ${stStr}`
    );
  }

  enriched.push({
    ticker,
    sentimentScore: sentiment?.sentimentScore ?? 0.5,
    sentimentLabel: sentiment?.sentimentLabel ?? "NEUTRAL",
    lines: newLines,
  });
}

// ─── Rank trade blocks by sentiment score ────────────────────────────────────
// Only rank blocks that are trade ideas (have a ticker)
// Non-trade blocks (headers, watchlist, etc.) are passed through at their position

// Separate trade blocks from pass-through blocks preserving order
const tradeBlocks = enriched.filter((b) => b.ticker !== null);
const passThrough = enriched.filter((b) => b.ticker === null);

// Sort trade blocks: highest sentiment score first
tradeBlocks.sort((a, b) => (b.sentimentScore || 0) - (a.sentimentScore || 0));

// Assign rank labels
tradeBlocks.forEach((b, i) => {
  const rankLine = `Rank: #${i + 1}`;
  // Inject rank as the last line of the block
  b.lines.push(rankLine);
});

// ─── Reconstruct output ───────────────────────────────────────────────────────
// Output: pass-through blocks first, then ranked trade blocks
// (preserves any header lines, then outputs trades ranked 1→N)

const outputBlocks = [...passThrough, ...tradeBlocks];

const outputLines = outputBlocks.map((b) => b.lines.join("\n")).join("\n\n");
process.stdout.write(outputLines + "\n");
