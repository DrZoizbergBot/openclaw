import { UNIVERSE } from './universe.mjs';

const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
const TOKEN = process.env.TOKEN;
const CHAT = process.env.CHAT;
const BASE = 'https://data.alpaca.markets';

const MIN_GAP_PCT = 4.0;
const MIN_PREMARKET_RVOL = 2.0;

async function alpacaGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'APCA-API-KEY-ID': KEY,
      'APCA-API-SECRET-KEY': SECRET,
    }
  });
  return res.json();
}

async function sendTelegram(message) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: message, parse_mode: 'Markdown' }),
  });
}

async function getAvgDailyVolume(symbol) {
  try {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const data = await alpacaGet(`/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&end=${end}&feed=iex&limit=30`);
    const bars = data.bars || [];
    if (bars.length === 0) return null;
    return bars.reduce((sum, b) => sum + b.v, 0) / bars.length;
  } catch {
    return null;
  }
}

async function scan() {
  console.log(`\nPre-market scan started at ${new Date().toISOString()}`);

  const snapshots = {};
  const batchSize = 20;
  for (let i = 0; i < UNIVERSE.length; i += batchSize) {
    const batch = UNIVERSE.slice(i, i + batchSize);
    const data = await alpacaGet(`/v2/stocks/snapshots?symbols=${batch.join(',')}&feed=iex`);
    Object.assign(snapshots, data);
  }

  const candidates = [];

  for (const [symbol, snap] of Object.entries(snapshots)) {
    try {
      const prevClose = snap.prevDailyBar?.c;
      const preMarketPrice = snap.minuteBar?.c;
      const preMarketVolume = snap.minuteBar?.v;

      if (!prevClose || !preMarketPrice || !preMarketVolume) continue;

      const gapPct = ((preMarketPrice - prevClose) / prevClose) * 100;
      if (gapPct < MIN_GAP_PCT) continue;

      const avgDailyVol = await getAvgDailyVolume(symbol);
      if (!avgDailyVol) continue;

      const expectedPreMarketVol = avgDailyVol * 0.1;
      const rvol = preMarketVolume / expectedPreMarketVol;
      if (rvol < MIN_PREMARKET_RVOL) continue;

      candidates.push({
        symbol,
        prevClose: prevClose.toFixed(2),
        preMarketPrice: preMarketPrice.toFixed(2),
        gapPct: gapPct.toFixed(2),
        preMarketVolume,
        avgDailyVol: Math.round(avgDailyVol),
        rvol: rvol.toFixed(2),
      });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => parseFloat(b.gapPct) - parseFloat(a.gapPct));

  if (candidates.length === 0) {
    const msg = `🔍 *Pre-market scan complete*\nNo gap candidates found above ${MIN_GAP_PCT}% threshold.`;
    await sendTelegram(msg);
    console.log('No candidates found.');
    return [];
  }

  // Build Telegram message
  let msg = `🌅 *Pre-market Watchlist — ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET*\n`;
  msg += `${candidates.length} candidate(s) found:\n\n`;

  candidates.forEach((c, i) => {
    msg += `*#${i + 1} ${c.symbol}*\n`;
    msg += `Gap: +${c.gapPct}% | Price: $${c.preMarketPrice}\n`;
    msg += `Pre-mkt Vol: ${c.preMarketVolume.toLocaleString()} | RVOL: ${c.rvol}x\n\n`;
  });

  await sendTelegram(msg);
  console.log(`Sent ${candidates.length} candidates to Telegram.`);

  return candidates;
}

scan().catch(console.error);
