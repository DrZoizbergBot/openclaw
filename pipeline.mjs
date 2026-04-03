import { UNIVERSE } from './universe.mjs';
import { getNews } from './finnhub_client.mjs';

const TOKEN = process.env.TOKEN;
const CHAT = process.env.CHAT;
const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;

const MIN_RVOL = 1.5;
const MIN_PROXIMITY = -3.0;
const MIN_CHANGE = 3.0;
const POLL_INTERVAL_MS = 60 * 1000;

// One alert per symbol per day
const alertedToday = new Set();

const state = {};
const avgVolumes = {};

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const day = et.getDay();

  // Monday-Friday only
  if (day === 0 || day === 6) return false;

  // 9:30 AM to 4:00 PM ET only
  const totalMinutes = hours * 60 + minutes;
  return totalMinutes >= 570 && totalMinutes < 960; // 9:30 = 570, 16:00 = 960
}

function resetDailyState() {
  alertedToday.clear();
  Object.keys(state).forEach(k => delete state[k]);
  console.log('Daily state reset.');
}

async function sendTelegram(message) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: message, parse_mode: 'Markdown' }),
  });
}

async function fetchSnapshots(symbols) {
  const batchSize = 20;
  const snapshots = {};
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${batch.join(',')}&feed=iex`,
      { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } }
    );
    const data = await res.json();
    Object.assign(snapshots, data);
  }
  return snapshots;
}

async function fetchAvgVolume(symbol) {
  try {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&end=${end}&feed=iex&limit=30`,
      { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } }
    );
    const data = await res.json();
    const bars = data.bars || [];
    if (bars.length === 0) return null;
    return bars.reduce((sum, b) => sum + b.v, 0) / bars.length;
  } catch {
    return null;
  }
}

async function initAvgVolumes() {
  console.log('Fetching average volumes...');
  for (const symbol of UNIVERSE) {
    const avg = await fetchAvgVolume(symbol);
    if (avg) avgVolumes[symbol] = avg;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Average volumes loaded for ${Object.keys(avgVolumes).length} symbols.`);
}

async function evaluate(symbol, snap) {
  // Skip if already alerted today
  if (alertedToday.has(symbol)) return;

  const prevClose = snap.prevDailyBar?.c;
  const price = snap.dailyBar?.c || snap.minuteBar?.c;
  const sessionHigh = snap.dailyBar?.h || price;
  const vol = snap.dailyBar?.v || 0;

  if (!prevClose || !price) return;

  // Verify data is from today
  const barDate = snap.dailyBar?.t;
  if (barDate) {
    const barDay = new Date(barDate).toDateString();
    const today = new Date().toDateString();
    if (barDay !== today) return; // stale data — skip
  }

  if (!state[symbol]) state[symbol] = { sessionHigh };
  if (sessionHigh > state[symbol].sessionHigh) state[symbol].sessionHigh = sessionHigh;

  const changePct = ((price - prevClose) / prevClose) * 100;
  const proximityPct = ((price - state[symbol].sessionHigh) / state[symbol].sessionHigh) * 100;
  const avgVol = avgVolumes[symbol];
  const rvol = avgVol ? vol / avgVol : null;

  const passChange = changePct >= MIN_CHANGE;
  const passProximity = proximityPct >= MIN_PROXIMITY;
  const passRvol = rvol ? rvol >= MIN_RVOL : true;

  if (!passChange || !passProximity || !passRvol) return;

  // Mark as alerted today
  alertedToday.add(symbol);

  console.log(`ALERT: ${symbol} | Change: ${changePct.toFixed(2)}% | Proximity: ${proximityPct.toFixed(2)}% | RVOL: ${rvol?.toFixed(2)}x`);

  let newsLine = 'No recent news';
  try {
    const news = await getNews(symbol);
    if (news.length > 0) newsLine = news[0].headline;
  } catch {}

  const entry = (price * 1.005).toFixed(2);
  const stop = (price * 0.955).toFixed(2);
  const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });

  const msg =
    `🚀 *BREAKOUT ALERT*\n` +
    `Ticker: *${symbol}*\n` +
    `Price: $${price.toFixed(2)} as of ${timeET} ET\n` +
    `Change: +${changePct.toFixed(2)}% | Proximity: ${proximityPct.toFixed(2)}%\n` +
    `RVOL: ${rvol ? rvol.toFixed(2) + 'x' : 'n/a'}\n` +
    `Entry: $${entry} | Stop: $${stop}\n` +
    `News: ${newsLine}`;

  await sendTelegram(msg);
}

async function poll() {
  if (!isMarketHours()) {
    console.log(`Outside market hours — skipping poll at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET`);
    return;
  }

  const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
  console.log(`Polling at ${timeET} ET...`);

  try {
    const snapshots = await fetchSnapshots(UNIVERSE);
    for (const [symbol, snap] of Object.entries(snapshots)) {
      await evaluate(symbol, snap).catch(() => {});
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

async function run() {
  console.log(`Pipeline started at ${new Date().toISOString()}`);
  await initAvgVolumes();

  // Reset state at midnight ET every day
  setInterval(() => {
    const et = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = new Date(et);
    if (etDate.getHours() === 0 && etDate.getMinutes() === 0) resetDailyState();
  }, 60 * 1000);

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

run().catch(console.error);
