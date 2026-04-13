import { UNIVERSE } from './universe.mjs';
import { getNews, getFloat } from './finnhub_client.mjs';
import { readFileSync, existsSync } from 'fs';

const TOKEN = process.env.TOKEN;
const CHAT = process.env.CHAT;
const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;

const MIN_RVOL = 1.5;
const MIN_PROXIMITY = -3.0;
const MIN_CHANGE = 3.0;
const MIN_PRICE = 5.0;
const POLL_INTERVAL_MS = 60 * 1000;
const ATR_PERIOD = 14;
const RVOL_WINDOW = 5;
const OBV_WINDOW = 5;
const SQUEEZE_PERIOD = 20;

const alertedToday = new Set();
const pullbackWatch = {};  // symbols in pullback watch mode
const state = {};
const avgVolumes = {};
const floatShares = {};
let gapSymbols = new Set();

function loadGapWatchlist() {
  try {
    const path = '/home/davide/openclaw-scripts/gap_watchlist.json';
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.date !== today) return;
    gapSymbols = new Set(data.candidates.map(c => c.symbol));
    console.log(`Gap watchlist loaded: ${gapSymbols.size} symbols — ${[...gapSymbols].join(', ')}`);
  } catch {
    console.log('No gap watchlist found.');
  }
}

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const totalMinutes = hours * 60 + minutes;
  return totalMinutes >= 570 && totalMinutes < 960;
}

function resetDailyState() {
  for (const symbol of Object.keys(state)) {
    const atr = state[symbol].atr;
    const dailySqueeze = state[symbol].dailySqueeze;
    state[symbol] = {
      atr,
      dailySqueeze,
      rvolHistory: [],
      intradayBars: [],
      sessionHigh: null,
      vwap: null,
      obvDivergence: false,
      intradaySqueeze: false,
    };
  }
  alertedToday.clear();
  Object.keys(pullbackWatch).forEach(k => delete pullbackWatch[k]);
  gapSymbols.clear();
  console.log('Daily state reset.');
}

function computeEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeVWAP(bars) {
  let cumTPV = 0;
  let cumVol = 0;
  for (const bar of bars) {
    const typicalPrice = (bar.h + bar.l + bar.c) / 3;
    cumTPV += typicalPrice * bar.v;
    cumVol += bar.v;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function computeATR(bars) {
  if (bars.length < 2) return null;
  const trueRanges = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trueRanges.push(tr);
  }
  const period = Math.min(ATR_PERIOD, trueRanges.length);
  const recent = trueRanges.slice(-period);
  return recent.reduce((sum, tr) => sum + tr, 0) / recent.length;
}

function computeOBV(bars) {
  let obv = 0;
  const obvSeries = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].c > bars[i - 1].c) obv += bars[i].v;
    else if (bars[i].c < bars[i - 1].c) obv -= bars[i].v;
    obvSeries.push(obv);
  }
  return obvSeries;
}

function detectOBVDivergence(bars) {
  if (bars.length < OBV_WINDOW + 1) return false;
  const recent = bars.slice(-OBV_WINDOW - 1);
  const obvSeries = computeOBV(recent);
  if (obvSeries.length < OBV_WINDOW) return false;
  const obvRising = obvSeries[obvSeries.length - 1] > obvSeries[0];
  const priceChangePct = Math.abs((recent[recent.length - 1].c - recent[0].c) / recent[0].c * 100);
  return obvRising && priceChangePct < 0.5;
}

function isRvolAccelerating(rvolHistory) {
  if (rvolHistory.length < 3) return false;
  const recent = rvolHistory.slice(-RVOL_WINDOW);
  const latest = recent[recent.length - 1];
  const avg = recent.slice(0, -1).reduce((s, v) => s + v, 0) / (recent.length - 1);
  return latest > avg * 1.1;
}

function getFloatRotationStage(rotation) {
  if (rotation === null) return null;
  if (rotation < 0.3) return null;
  if (rotation < 0.5) return 'early';
  if (rotation < 1.0) return 'building';
  if (rotation < 2.0) return 'full';
  return 'exhaustion';
}

function detectSqueeze(bars) {
  if (bars.length < SQUEEZE_PERIOD) return { squeeze: false, bullish: false };
  const recent = bars.slice(-SQUEEZE_PERIOD);
  const closes = recent.map(b => b.c);
  const highs = recent.map(b => b.h);
  const lows = recent.map(b => b.l);
  const sma = closes.reduce((s, c) => s + c, 0) / closes.length;
  const variance = closes.reduce((s, c) => s + Math.pow(c - sma, 2), 0) / closes.length;
  const stdDev = Math.sqrt(variance);
  const bbUpper = sma + 2 * stdDev;
  const bbLower = sma - 2 * stdDev;
  let ema = closes[0];
  const k = 2 / (SQUEEZE_PERIOD + 1);
  for (const c of closes) ema = c * k + ema * (1 - k);
  const atr = computeATR(recent);
  if (!atr) return { squeeze: false, bullish: false };
  const kcUpper = ema + 1.5 * atr;
  const kcLower = ema - 1.5 * atr;
  const squeeze = bbUpper < kcUpper && bbLower > kcLower;
  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const midpoint = (highestHigh + lowestLow) / 2;
  const momentum = closes[closes.length - 1] - midpoint;
  return { squeeze, bullish: momentum > 0 };
}

function checkPullbackEntry(symbol, price, vol) {
  const pw = pullbackWatch[symbol];
  if (!pw) return;
  if (pw.pullbackTaken) return; // only first pullback

  const bars = state[symbol]?.intradayBars;
  if (!bars || bars.length < 20) return;

  const closes = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const ema9 = computeEMA(closes, 9);
  const ema20 = computeEMA(closes, 20);

  if (!ema9 || !ema20) return;

  const prevClose = closes[closes.length - 2];
  const prevVol = volumes[volumes.length - 2];
  const currClose = closes[closes.length - 1];
  const currVol = volumes[volumes.length - 1];

  // Phase 1: detect pullback into Bone Zone (between 9 and 20 EMA)
  if (!pw.inBoneZone) {
    const inZone = currClose <= ema9 && currClose >= ema20;
    if (inZone) {
      pw.inBoneZone = true;
      pw.pullbackLow = currClose;
      pw.pullbackVol = currVol;
      console.log(`${symbol} entered Bone Zone — watching for reclaim`);
    }
    return;
  }

  // Update pullback low
  if (currClose < pw.pullbackLow) {
    pw.pullbackLow = currClose;
    pw.pullbackVol = currVol;
  }

  // Phase 2: detect reclaim of 9 EMA with expanding volume
  const reclaimedEMA9 = prevClose < ema9 && currClose > ema9;
  const expandingVol = currVol > pw.pullbackVol * 1.2;

  if (reclaimedEMA9 && expandingVol) {
    pw.pullbackTaken = true;

    const atr = state[symbol]?.atr;
    const stop = Math.min(pw.pullbackLow, ema20);
    const entry = (price * 1.005).toFixed(2);
    const stopPrice = stop.toFixed(2);
    const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });

    console.log(`PULLBACK ENTRY: ${symbol} | Price: ${price} | Stop: ${stopPrice}`);

    const msg =
      `🎯 *PULLBACK ENTRY — First Pullback*\n` +
      `Ticker: *${symbol}*\n` +
      `Price: $${price.toFixed(2)} as of ${timeET} ET\n` +
      `Entry: $${entry} | Stop: $${stopPrice}\n` +
      `Bone Zone: 9 EMA $${ema9.toFixed(2)} / 20 EMA $${ema20.toFixed(2)}\n` +
      `Signal: Reclaimed 9 EMA with expanding volume`;

    sendTelegram(msg);
  }
}

async function fetchIntradayBars(symbol) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Min&start=${today}T13:30:00Z&feed=iex&limit=390`,
      { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } }
    );
    const data = await res.json();
    return data.bars || [];
  } catch {
    return [];
  }
}

async function fetchDailyBars(symbol) {
  try {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&end=${end}&feed=iex&limit=30`,
      { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } }
    );
    const data = await res.json();
    return data.bars || [];
  } catch {
    return [];
  }
}

async function initAvgVolumes() {
  console.log('Fetching average volumes and ATR...');
  for (const symbol of UNIVERSE) {
    const bars = await fetchDailyBars(symbol);
    if (bars.length > 0) {
      avgVolumes[symbol] = bars.reduce((sum, b) => sum + b.v, 0) / bars.length;
      const atr = computeATR(bars);
      if (!state[symbol]) state[symbol] = {};
      state[symbol].atr = atr;
      state[symbol].rvolHistory = state[symbol].rvolHistory || [];
      state[symbol].intradayBars = state[symbol].intradayBars || [];
      const { squeeze, bullish } = detectSqueeze(bars);
      state[symbol].dailySqueeze = squeeze && bullish;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Initialised ${Object.keys(avgVolumes).length} symbols.`);
}

async function initFloats() {
  console.log('Fetching float data from Finnhub...');
  let loaded = 0;
  for (const symbol of UNIVERSE) {
    try {
      const float = await getFloat(symbol);
      if (float) { floatShares[symbol] = float; loaded++; }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`Float data loaded for ${loaded} symbols.`);
}

async function initVWAP() {
  if (!isMarketHours()) return;
  console.log('Seeding VWAP and OBV from intraday bars...');
  let seeded = 0;
  for (const symbol of UNIVERSE) {
    const bars = await fetchIntradayBars(symbol);
    if (bars.length > 0) {
      if (!state[symbol]) state[symbol] = {};
      state[symbol].vwap = computeVWAP(bars);
      state[symbol].intradayBars = bars;
      state[symbol].sessionHigh = Math.max(...bars.map(b => b.h));
      state[symbol].obvDivergence = detectOBVDivergence(bars);
      const { squeeze, bullish } = detectSqueeze(bars);
      state[symbol].intradaySqueeze = squeeze && bullish;
      seeded++;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`VWAP and OBV seeded for ${seeded} symbols.`);
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

async function evaluate(symbol, snap) {
  if (alertedToday.has(symbol)) {
    // Still check for pullback entry even after breakout alert
    const price = snap.dailyBar?.c || snap.minuteBar?.c;
    const vol = snap.dailyBar?.v || 0;
    if (price) checkPullbackEntry(symbol, price, vol);
    return;
  }

  const prevClose = snap.prevDailyBar?.c;
  const price = snap.dailyBar?.c || snap.minuteBar?.c;
  const high = snap.dailyBar?.h || price;
  const low = snap.dailyBar?.l || price;
  const vol = snap.dailyBar?.v || 0;

  if (!prevClose || !price) return;
  if (price < MIN_PRICE) return;

  const barDate = snap.dailyBar?.t;
  if (barDate) {
    const barDay = new Date(barDate).toDateString();
    const today = new Date().toDateString();
    if (barDay !== today) return;
  }

  if (!state[symbol]) state[symbol] = {};
  if (!state[symbol].rvolHistory) state[symbol].rvolHistory = [];
  if (!state[symbol].intradayBars) state[symbol].intradayBars = [];

  if (!state[symbol].sessionHigh || high > state[symbol].sessionHigh) {
    state[symbol].sessionHigh = high;
  }

  state[symbol].intradayBars.push({ h: high, l: low, c: price, v: vol });
  state[symbol].vwap = computeVWAP(state[symbol].intradayBars);
  state[symbol].obvDivergence = detectOBVDivergence(state[symbol].intradayBars);

  const { squeeze, bullish } = detectSqueeze(state[symbol].intradayBars);
  state[symbol].intradaySqueeze = squeeze && bullish;

  const avgVol = avgVolumes[symbol];
  const rvol = avgVol ? vol / avgVol : null;
  if (rvol) {
    state[symbol].rvolHistory.push(rvol);
    if (state[symbol].rvolHistory.length > RVOL_WINDOW) state[symbol].rvolHistory.shift();
  }

  const float = floatShares[symbol];
  const cumVol = state[symbol].intradayBars.reduce((sum, b) => sum + b.v, 0);
  const rotation = float ? cumVol / float : null;
  const rotationStage = getFloatRotationStage(rotation);

  const atr = state[symbol].atr;
  const vwap = state[symbol].vwap;
  const rvolAccelerating = isRvolAccelerating(state[symbol].rvolHistory);
  const obvDivergence = state[symbol].obvDivergence || false;
  const dailySqueeze = state[symbol].dailySqueeze || false;
  const intradaySqueeze = state[symbol].intradaySqueeze || false;

  const changePct = ((price - prevClose) / prevClose) * 100;
  const proximityPct = ((price - state[symbol].sessionHigh) / state[symbol].sessionHigh) * 100;
  const aboveVWAP = vwap ? price > vwap : null;
  const atrExtension = atr ? (price - prevClose) / atr : null;

  const isGapStock = gapSymbols.has(symbol);
  const minChange = isGapStock ? 2.0 : MIN_CHANGE;
  const minRvol = isGapStock ? 1.2 : MIN_RVOL;

  const passChange = changePct >= minChange;
  const passProximity = proximityPct >= MIN_PROXIMITY;
  const passRvol = rvol ? rvol >= minRvol : true;
  const passVWAP = aboveVWAP !== false;
  const overExtended = atrExtension ? atrExtension > 2.5 : false;
  const isExhausted = rotationStage === 'exhaustion' && !rvolAccelerating;

  if (!passChange || !passProximity || !passRvol || !passVWAP || overExtended || isExhausted) return;

  alertedToday.add(symbol);

  // Start watching for pullback entry
  pullbackWatch[symbol] = {
    alertPrice: price,
    inBoneZone: false,
    pullbackLow: null,
    pullbackVol: null,
    pullbackTaken: false,
  };

  const tags = [];
  if (isGapStock) tags.push('🌅 Gap & Go');
  if (rvolAccelerating) tags.push('⚡ RVOL Accelerating');
  if (obvDivergence) tags.push('📈 OBV Divergence');
  if (rotationStage === 'building') tags.push('🔄 Float Rotating');
  if (rotationStage === 'full') tags.push('🔥 Full Float Rotation');
  if (intradaySqueeze) tags.push('💥 Intraday Squeeze');
  else if (dailySqueeze) tags.push('💥 Daily Squeeze');
  const tagLine = tags.join(' | ');

  const vwapStr = vwap ? `$${vwap.toFixed(2)}` : 'n/a';
  const atrStr = atr ? `$${atr.toFixed(2)}` : 'n/a';
  const rvolStr = rvol ? `${rvol.toFixed(2)}x${rvolAccelerating ? ' ↑' : ''}` : 'n/a';
  const rotationStr = rotation ? `${rotation.toFixed(2)}x` : 'n/a';

  console.log(`ALERT: ${symbol} | Change: ${changePct.toFixed(2)}% | RVOL: ${rvolStr} | ATR: ${atrStr}`);

  let newsLine = 'No recent news';
  try {
    const news = await getNews(symbol);
    if (news.length > 0) newsLine = news[0].headline;
  } catch {}

  const entry = (price * 1.005).toFixed(2);
  const stopPrice = atr
    ? (price - atr * 1.5).toFixed(2)
    : (price * 0.955).toFixed(2);

  const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });

  const msg =
    `🚀 *BREAKOUT ALERT*\n` +
    (tagLine ? `${tagLine}\n` : '') +
    `Ticker: *${symbol}*\n` +
    `Price: $${price.toFixed(2)} as of ${timeET} ET\n` +
    `Change: +${changePct.toFixed(2)}% | Proximity: ${proximityPct.toFixed(2)}%\n` +
    `RVOL: ${rvolStr} | VWAP: ${vwapStr} | ATR: ${atrStr}\n` +
    `Float Rotation: ${rotationStr}${rotationStage ? ' — ' + rotationStage : ''}\n` +
    `Entry: $${entry} | Stop: $${stopPrice}\n` +
    `News: ${newsLine}`;

  await sendTelegram(msg);
}

async function poll() {
  loadGapWatchlist();

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
  await initFloats();
  await initVWAP();
  loadGapWatchlist();

  setInterval(() => {
    const et = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = new Date(et);
    if (etDate.getHours() === 0 && etDate.getMinutes() === 0) resetDailyState();
  }, 60 * 1000);

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

run().catch(console.error);
