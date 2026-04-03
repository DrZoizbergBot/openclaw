import { UNIVERSE } from './universe.mjs';
import { writeFileSync } from 'fs';

const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
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

      // Filter fading gaps
      if (currentPrice < todayOpen) continue;

      candidates.push({
        symbol,
        prevClose: parseFloat(prevClose.toFixed(2)),
        todayOpen: parseFloat(todayOpen.toFixed(2)),
        currentPrice: parseFloat(currentPrice.toFixed(2)),
        gapPct: parseFloat(gapPct.toFixed(2)),
        vol,
        scannedAt: new Date().toISOString(),
      });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => b.gapPct - a.gapPct);

  // Write to JSON file for pipeline to consume
  const output = {
    date: new Date().toISOString().split('T')[0],
    candidates,
  };

  writeFileSync('/home/davide/openclaw-scripts/gap_watchlist.json', JSON.stringify(output, null, 2));
  console.log(`Gap watchlist written: ${candidates.length} candidates.`);
  candidates.forEach((c, i) => {
    console.log(`#${i + 1} ${c.symbol} | Gap: +${c.gapPct}% | Open: $${c.todayOpen} | Now: $${c.currentPrice}`);
  });

  return candidates;
}

scan().catch(console.error);
