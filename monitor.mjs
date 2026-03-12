#!/usr/bin/env node
/**
 * monitor.mjs
 * Runs every 15 minutes during market hours.
 * Checks open positions against trailing stop, hard stop, and 3:30 PM ET forced exit.
 * Sends Telegram alert when exit condition is triggered.
 */

import fs from "fs";
import https from "https";

const PORTFOLIO_FILE = "/home/davide/openclaw-scripts/portfolio.json";
const TOKEN = process.env.TOKEN || "";
const CHAT  = process.env.CHAT  || "";

const HARD_STOP_PCT    = 0.045; // 4.5% below entry
const TRAILING_STOP_PCT = 0.05; // 5% below session high
const FORCE_EXIT_HOUR  = 15;    // 3:30 PM ET
const FORCE_EXIT_MIN   = 30;

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(msg) {
  if (!TOKEN || !CHAT) { console.log("[TELEGRAM]", msg); return; }
  const body = JSON.stringify({ chat_id: CHAT, text: msg });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(); });
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

// ─── Yahoo quote ──────────────────────────────────────────────────────────────

async function getPrice(ticker) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const meta = JSON.parse(d).chart.result[0].meta;
          resolve({
            price: meta.regularMarketPrice,
            high:  meta.regularMarketDayHigh,
          });
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// ─── Portfolio helpers ────────────────────────────────────────────────────────

function loadPortfolio() {
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf8"));
  } catch {
    return { positions: [] };
  }
}

function savePortfolio(portfolio) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2));
}

// ─── Market hours check ───────────────────────────────────────────────────────

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour = et.getHours();
  const min  = et.getMinutes();
  const day  = et.getDay();
  if (day === 0 || day === 6) return false;
  const afterOpen  = hour > 9  || (hour === 9  && min >= 30);
  const beforeClose = hour < 16;
  return afterOpen && beforeClose;
}

function isForceExitTime() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() === FORCE_EXIT_HOUR && et.getMinutes() >= FORCE_EXIT_MIN;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`[${new Date().toISOString()}] Monitor running...`);

if (!isMarketHours()) {
  console.log("[INFO] Market closed — skipping monitor run");
  process.exit(0);
}

const portfolio = loadPortfolio();

if (portfolio.positions.length === 0) {
  console.log("[INFO] No open positions to monitor");
  process.exit(0);
}

for (const pos of portfolio.positions) {
  const quote = await getPrice(pos.ticker);
  if (!quote) {
    console.log(`[WARN] Could not fetch price for ${pos.ticker}`);
    continue;
  }

  const { price, high } = quote;

  // Update session high
  if (!pos.sessionHigh || high > pos.sessionHigh) {
    pos.sessionHigh = high;
  }

  const hardStop     = parseFloat((pos.entry * (1 - HARD_STOP_PCT)).toFixed(2));
  const trailingStop = parseFloat((pos.sessionHigh * (1 - TRAILING_STOP_PCT)).toFixed(2));
  const effectiveStop = Math.max(hardStop, trailingStop);
  const pnl = ((price - pos.entry) / pos.entry * 100).toFixed(2);
  const pnlUsd = ((price - pos.entry) * pos.shares).toFixed(2);

  console.log(`[INFO] ${pos.ticker} | Price: $${price} | High: $${pos.sessionHigh} | Stop: $${effectiveStop} | P&L: ${pnl}% ($${pnlUsd})`);

  // ─── Force exit at 3:30 PM ET ───────────────────────────────────────────
  if (isForceExitTime()) {
    await sendTelegram(
`🔔 CLOSE ${pos.ticker} — 3:30 PM ET
Current price: $${price}
Entry: $${pos.entry} | Shares: ${pos.shares}
P&L: ${pnl}% ($${pnlUsd})
→ Close position before market close.`
    );
    continue;
  }

  // ─── Hard stop ──────────────────────────────────────────────────────────
  if (price <= hardStop) {
    await sendTelegram(
`🔴 SELL ${pos.ticker} — hard stop triggered
Entry: $${pos.entry} → Current: $${price}
Stop: $${hardStop} | Loss: ${pnl}% ($${pnlUsd})
→ Exit immediately.`
    );
    continue;
  }

  // ─── Trailing stop ──────────────────────────────────────────────────────
  if (price <= trailingStop) {
    await sendTelegram(
`🔴 SELL ${pos.ticker} — trailing stop hit
Session high: $${pos.sessionHigh} → Trail stop: $${trailingStop}
Current: $${price} | P&L: ${pnl}% ($${pnlUsd})
→ Exit immediately.`
    );
    continue;
  }
}

savePortfolio(portfolio);
console.log(`[${new Date().toISOString()}] Monitor complete.`);
