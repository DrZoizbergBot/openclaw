import { UNIVERSE } from './universe.mjs';

const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
const TOKEN = process.env.TOKEN;
const CHAT = process.env.CHAT;
const BASE = 'https://data.alpaca.markets';

const MIN_GAP_PCT = 3.0;

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

async function scan() {
  console.log(`\nScanner started at ${new Date().toISOString()}`);

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
      const todayOpen = snap.dailyBar?.o;
      const currentPrice = snap.dailyBar?.c || snap.minuteBar?.c;
      const vol = snap.dailyBar?.v || 0;

      if (!prevClose || !todayOpen || !currentPrice) continue;

      const gapPct = ((todayOpen - prevClose) / prevClose) * 100;
      if (gapPct < MIN_GAP_PCT) continue;

      // Filter fading gaps — current price must be above open
      if (currentPrice < todayOpen) continue;

      candidates.push({
        symbol,
        prevClose: prevClose.toFixed(2),
        todayOpen: todayOpen.toFixed(2),
        currentPrice: currentPrice.toFixed(2),
        gapPct: gapPct.toFixed(2),
        vol,
      });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => parseFloat(b.gapPct) - parseFloat(a.gapPct));

  if (candidates.length === 0) {
    const msg = `🔍 *Opening gap scan complete*\nNo gap candidates found above ${MIN_GAP_PCT}% with follow-through.`;
    await sendTelegram(msg);
    console.log('No candidates found.');
    return [];
  }

  let msg = `🌅 *Opening Gap Watchlist — ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET*\n`;
  msg += `${candidates.length} candidate(s) found:\n\n`;

  candidates.forEach((c, i) => {
    msg += `*#${i + 1} ${c.symbol}*\n`;
    msg += `Gap: +${c.gapPct}% | Open: $${c.todayOpen} | Now: $${c.currentPrice}\n`;
    msg += `PrevClose: $${c.prevClose} | Vol: ${c.vol.toLocaleString()}\n\n`;
  });

  await sendTelegram(msg);
  console.log(`Sent ${candidates.length} candidates to Telegram.`);
  return candidates;
}

scan().catch(console.error);
