#!/usr/bin/env node
/**
 * telegram_listener.mjs
 * Polls Telegram for incoming messages.
 * Accepts text commands to manage portfolio.
 * Commands: BUY TICKER PRICE SHARES | SELL TICKER PRICE SHARES | PORTFOLIO
 */

import fs from "fs";
import https from "https";

// ─── Config ───────────────────────────────────────────────────────────────────

const config = fs.readFileSync("/home/davide/openclaw-scripts/config.env", "utf8");
const env = Object.fromEntries(config.trim().split("\n").map(l => l.split("=")));
const TOKEN = env.TOKEN;
const CHAT  = env.CHAT;
const PORTFOLIO_FILE = "/home/davide/openclaw-scripts/portfolio.json";
const OFFSET_FILE    = "/home/davide/openclaw-scripts/.tg_offset";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

async function sendTelegram(msg) {
  const body = JSON.stringify({ chat_id: CHAT, text: msg });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Portfolio helpers ────────────────────────────────────────────────────────

function loadPortfolio() {
  try { return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf8")); }
  catch { return { positions: [] }; }
}

function savePortfolio(p) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(p, null, 2));
}

function loadOffset() {
  try { return parseInt(fs.readFileSync(OFFSET_FILE, "utf8")); }
  catch { return 0; }
}

function saveOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, String(offset));
}

// ─── Process incoming message ─────────────────────────────────────────────────

async function processMessage(msg) {
  if (String(msg.chat?.id) !== String(CHAT)) return;
  if (!msg.text) return;

  const text  = msg.text.trim().toUpperCase();
  const parts = text.split(/\s+/);

  // ── BUY / SELL ──────────────────────────────────────────────────────────────
  if ((parts[0] === "BUY" || parts[0] === "SELL") && parts.length === 4) {
    const action = parts[0];
    const ticker = parts[1];
    const price  = parseFloat(parts[2]);
    const shares = parseInt(parts[3]);

    if (isNaN(price) || isNaN(shares)) {
      await sendTelegram("Invalid format. Use: BUY TICKER PRICE SHARES");
      return;
    }

    const portfolio = loadPortfolio();

    if (action === "BUY") {
      if (portfolio.positions.length >= 3) {
        await sendTelegram("Max 3 positions reached. Close a position before adding " + ticker + ".");
        return;
      }
      if (portfolio.positions.find(p => p.ticker === ticker)) {
        await sendTelegram(ticker + " already in portfolio.");
        return;
      }

      const hardStop   = parseFloat((price * 0.955).toFixed(2));
      const allocation = parseFloat((price * shares).toFixed(2));

      portfolio.positions.push({
        ticker,
        entry:       price,
        shares:      shares,
        hardStop:    hardStop,
        sessionHigh: price,
        allocation:  allocation,
        openedAt:    new Date().toISOString()
      });

      savePortfolio(portfolio);

      await sendTelegram(
        "Position opened\n" +
        "Ticker: " + ticker + "\n" +
        "Shares: " + shares + " @ $" + price + "\n" +
        "Allocation: $" + allocation + "\n" +
        "Hard stop: $" + hardStop + " (-4.5%)\n" +
        "Trailing stop: 5% below session high"
      );

    } else if (action === "SELL") {
      const pos = portfolio.positions.find(p => p.ticker === ticker);
      if (!pos) {
        await sendTelegram(ticker + " not found in portfolio.");
        return;
      }

      const pnlPct = ((price - pos.entry) / pos.entry * 100).toFixed(2);
      const pnlUsd = ((price - pos.entry) * pos.shares).toFixed(2);

      portfolio.positions = portfolio.positions.filter(p => p.ticker !== ticker);
      savePortfolio(portfolio);

      await sendTelegram(
        "Position closed\n" +
        "Ticker: " + ticker + "\n" +
        "Entry: $" + pos.entry + " -> Exit: $" + price + "\n" +
        "Shares: " + pos.shares + "\n" +
        "P&L: " + pnlPct + "% ($" + pnlUsd + ")"
      );
    }

  // ── PORTFOLIO ───────────────────────────────────────────────────────────────
  } else if (text === 'SCAN' || text === '/SCAN') {
    await sendTelegram('Scan started...');
    const { execFile } = await import('child_process');
    execFile('bash', ['/home/davide/openclaw-scripts/run_research.sh'], { env: { ...process.env, TOKEN, CHAT } }, () => {});

  } else if (text === "PORTFOLIO" || text === "/PORTFOLIO") {
    const portfolio = loadPortfolio();
    if (portfolio.positions.length === 0) {
      await sendTelegram("No open positions.");
      return;
    }
    const lines = portfolio.positions.map(p =>
      p.ticker + " | " + p.shares + " shares @ $" + p.entry +
      " | Stop: $" + p.hardStop + " | Alloc: $" + p.allocation
    );
    await sendTelegram("Portfolio:\n" + lines.join("\n"));

  // ── UNKNOWN ─────────────────────────────────────────────────────────────────
  } else {
    await sendTelegram(
      "Unknown command.\n" +
      "BUY TICKER PRICE SHARES\n" +
      "SELL TICKER PRICE SHARES\n" +
      "PORTFOLIO"
    );
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

async function poll() {
  let offset = loadOffset();
  console.log("[" + new Date().toISOString() + "] Telegram listener started. Polling...");

  while (true) {
    try {
      const url = "https://api.telegram.org/bot" + TOKEN + "/getUpdates?timeout=30&offset=" + offset;
      const raw  = await httpsGet(url);
      const data = JSON.parse(raw);

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          saveOffset(offset);
          if (update.message) {
            await processMessage(update.message);
          }
        }
      }
    } catch (e) {
      console.error("[ERROR] Poll failed:", e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

poll();
