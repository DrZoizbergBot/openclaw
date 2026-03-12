#!/usr/bin/env node
// fetch_quote.mjs — Yahoo Finance primary, Stooq fallback
// Output: TICKER|PRICE|HIGH|LOW|OPEN|VOLUME|SOURCE|TIMESTAMP

async function fetchYahoo(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price  = meta.regularMarketPrice;
    const high   = meta.regularMarketDayHigh;
    const low    = meta.regularMarketDayLow;
    const open   = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const volume = meta.regularMarketVolume;
    const ts     = meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          timeZone: "America/New_York", hour12: false
        }) + " ET"
      : "N/A";
    if (!price || price <= 0) return null;
    return { price, high, low, open, volume, source: "yahoo", ts };
  } catch {
    return null;
  }
}

async function fetchStooq(ticker) {
  try {
    const url = `https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const cols = lines[1].split(",");
    const open   = parseFloat(cols[3]);
    const high   = parseFloat(cols[4]);
    const low    = parseFloat(cols[5]);
    const price  = parseFloat(cols[6]);
    const volume = parseInt(cols[7]);
    if (!price || price <= 0 || isNaN(price)) return null;
    return { price, high, low, open, volume, source: "stooq", ts: "~15-20 min delayed" };
  } catch {
    return null;
  }
}

async function getQuote(ticker) {
  let result = await fetchYahoo(ticker);
  if (!result) {
    process.stderr.write(`[WARN] Yahoo failed for ${ticker} — trying Stooq\n`);
    result = await fetchStooq(ticker);
  }
  if (!result) {
    process.stderr.write(`[ERROR] Both sources failed for ${ticker}\n`);
    return `${ticker}|N/D|N/D|N/D|N/D|N/D|none|N/A`;
  }
  const { price, high, low, open, volume, source, ts } = result;
  return `${ticker}|${price}|${high}|${low}|${open ?? "N/A"}|${volume}|${source}|${ts}`;
}

const tickers = process.argv.slice(2).map(t => t.toUpperCase());
if (tickers.length === 0) {
  process.stderr.write("Usage: node fetch_quote.mjs TICKER [TICKER ...]\n");
  process.exit(1);
}

for (const ticker of tickers) {
  const line = await getQuote(ticker);
  console.log(line);
}
