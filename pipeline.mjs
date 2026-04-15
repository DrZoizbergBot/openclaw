import { UNIVERSE } from './universe.mjs';
import { getNews, getFloat, getSocialSentiment } from './finnhub_client.mjs';
import { readFileSync, existsSync } from 'fs';

const TOKEN = process.env.TOKEN;
const CHAT = process.env.CHAT;
const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;

const MIN_RVOL = 1.5;
const MIN_PROXIMITY = -3.0;
const MIN_CHANGE = 3.0;
const MIN_PRICE = 5.0;
const MIN_CONFIDENCE = 60;
const POLL_INTERVAL_MS = 60 * 1000;
const ATR_PERIOD = 14;
const RVOL_WINDOW = 5;
const OBV_WINDOW = 5;
const SQUEEZE_PERIOD = 20;
const ORB_MINUTES = 15;

const alertedToday = new Set();
const orbAlertedToday = new Set();
const pullbackWatch = {};
const orbState = {};
const state = {};
const avgVolumes = {};
const floatShares = {};
const shortVolRatio = {};
let gapSymbols = new Set();

function computeConfidenceScore({
  proximityPct, changePct, rvol, rvolAccelerating,
  aboveVWAP, obvDivergence, intradaySqueeze, dailySqueeze,
  hasNews, rotationStage, isGapStock, socialSentiment
}) {
  let proximityScore = 0;
  if (proximityPct >= 0) proximityScore = 100;
  else if (proximityPct >= -1) proximityScore = 90;
  else if (proximityPct >= -2) proximityScore = 70;
  else if (proximityPct >= -3) proximityScore = 40;

  let changeScore = 0;
  const absChange = Math.abs(changePct);
  if (absChange < 2) changeScore = 20;
  else if (absChange < 5) changeScore = 50;
  else if (absChange < 10) changeScore = 100;
  else if (absChange < 20) changeScore = 85;
  else changeScore = 20;

  let rvolScore = 0;
  if (rvol) {
    if (rvol < 1.5) rvolScore = 0;
    else if (rvol < 2) rvolScore = 60;
    else if (rvol < 3) rvolScore = 85;
    else rvolScore = 100;
  }

  const rotationScore =
    rotationStage === 'full' ? 100 :
    rotationStage === 'building' ? 75 :
    rotationStage === 'early' ? 50 : 0;

  // Social sentiment: combinedScore is -1 to +1, normalize to 0–100
  const sentimentScore = socialSentiment
    ? Math.round(((socialSentiment.combinedScore + 1) / 2) * 100)
    : 0;

  return Math.round((
    proximityScore * 0.20 +
    changeScore * 0.15 +
    rvolScore * 0.15 +
    (rvolAccelerating ? 100 : 0) * 0.10 +
    (aboveVWAP ? 100 : 0) * 0.10 +
    (obvDivergence ? 100 : 0) * 0.08 +
    (intradaySqueeze ? 100 : dailySqueeze ? 70 : 0) * 0.07 +
    (hasNews ? 100 : 0) * 0.07 +
    rotationScore * 0.05 +
    sentimentScore * 0.05 +
    (isGapStock ? 100 : 0) * 0.03 // 103% total — gap stock is a bonus on top
  ) * 10) / 10;
}

function computePenalties({
  price, high, low, open,
  atrExtension, hasNews,
  intradayBars, rvol, float,
  proximityPct, shortVolRatio
}) {
  let penalty = 0;
  const reasons = [];

  // Topping tail: upper wick > 60% of candle range near session high
  const range = high - low;
  if (range > 0) {
    const upperWick = high - price;
    const wickRatio = upperWick / range;
    if (wickRatio > 0.6 && proximityPct >= -2) {
      penalty += 20;
      reasons.push('topping tail');
    }
  }

  // Declining volume on rising price — last 3 bars
  if (intradayBars && intradayBars.length >= 3) {
    const last3 = intradayBars.slice(-3);
    const risingPrice = last3[2].c > last3[0].c;
    const decliningVol = last3[2].v < last3[1].v && last3[1].v < last3[0].v;
    if (risingPrice && decliningVol) {
      penalty += 15;
      reasons.push('declining volume on rising price');
    }
  }

  // No catalyst
  if (!hasNews) {
    penalty += 10;
    reasons.push('no news catalyst');
  }

  // Overextension >2.0x ATR
  if (atrExtension && atrExtension > 2.0) {
    penalty += 15;
    reasons.push(`overextended ${atrExtension.toFixed(1)}x ATR`);
  }

  // Low float trap: float <5M shares with RVOL >3x
  if (float && float < 5_000_000 && rvol && rvol > 3) {
    penalty += 12;
    reasons.push('low float trap');
  }

  // Fading gap: current price below open
  if (open && price < open) {
    penalty += 20;
    reasons.push('gap fading');
  }

  // High short volume ratio (>50%) without squeeze — institutional resistance
  if (shortVolRatio !== null && shortVolRatio > 0.50) {
    penalty += 10;
    reasons.push(`high short vol ${(shortVolRatio * 100).toFixed(0)}%`);
  }

  return { penalty, reasons };
}

function confidenceLabel(score) {
  if (score >= 75) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  return 'LOW';
}

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
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const total = et.getHours() * 60 + et.getMinutes();
  return total >= 570 && total < 960;
}

function getETMinutes() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getHours() * 60 + et.getMinutes();
}

function resetDailyState() {
  for (const symbol of Object.keys(state)) {
    const atr = state[symbol].atr;
    const dailySqueeze = state[symbol].dailySqueeze;
    state[symbol] = { atr, dailySqueeze, rvolHistory: [], intradayBars: [], sessionHigh: null, vwap: null, obvDivergence: false, intradaySqueeze: false };
  }
  alertedToday.clear();
  orbAlertedToday.clear();
  Object.keys(pullbackWatch).forEach(k => delete pullbackWatch[k]);
  Object.keys(orbState).forEach(k => delete orbState[k]);
  gapSymbols.clear();
  console.log('Daily state reset.');
}

function computeEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

function computeRSI(closes, period = 2) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function computeVWAP(bars) {
  let cumTPV = 0, cumVol = 0;
  for (const bar of bars) {
    cumTPV += ((bar.h + bar.l + bar.c) / 3) * bar.v;
    cumVol += bar.v;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function computeATR(bars) {
  if (bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c)));
  }
  const period = Math.min(ATR_PERIOD, trs.length);
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function computeOBV(bars) {
  let obv = 0;
  const series = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].c > bars[i-1].c) obv += bars[i].v;
    else if (bars[i].c < bars[i-1].c) obv -= bars[i].v;
    series.push(obv);
  }
  return series;
}

function detectOBVDivergence(bars) {
  if (bars.length < OBV_WINDOW + 1) return false;
  const recent = bars.slice(-OBV_WINDOW - 1);
  const obv = computeOBV(recent);
  if (obv.length < OBV_WINDOW) return false;
  return obv[obv.length-1] > obv[0] && Math.abs((recent[recent.length-1].c - recent[0].c) / recent[0].c * 100) < 0.5;
}

function isRvolAccelerating(rvolHistory) {
  if (rvolHistory.length < 3) return false;
  const recent = rvolHistory.slice(-RVOL_WINDOW);
  const latest = recent[recent.length-1];
  const avg = recent.slice(0,-1).reduce((s,v) => s+v, 0) / (recent.length-1);
  return latest > avg * 1.1;
}

function getFloatRotationStage(rotation) {
  if (!rotation || rotation < 0.3) return null;
  if (rotation < 0.5) return 'early';
  if (rotation < 1.0) return 'building';
  if (rotation < 2.0) return 'full';
  return 'exhaustion';
}

function detectSqueeze(bars) {
  if (bars.length < SQUEEZE_PERIOD) return { squeeze: false, bullish: false };
  const recent = bars.slice(-SQUEEZE_PERIOD);
  const closes = recent.map(b => b.c);
  const sma = closes.reduce((s,c) => s+c, 0) / closes.length;
  const stdDev = Math.sqrt(closes.reduce((s,c) => s+Math.pow(c-sma,2), 0) / closes.length);
  let ema = closes[0];
  const k = 2 / (SQUEEZE_PERIOD + 1);
  for (const c of closes) ema = c * k + ema * (1-k);
  const atr = computeATR(recent);
  if (!atr) return { squeeze: false, bullish: false };
  const squeeze = (sma + 2*stdDev) < (ema + 1.5*atr) && (sma - 2*stdDev) > (ema - 1.5*atr);
  const highs = recent.map(b => b.h), lows = recent.map(b => b.l);
  return { squeeze, bullish: closes[closes.length-1] > (Math.max(...highs) + Math.min(...lows)) / 2 };
}

function setOpeningRange(symbol, bars) {
  if (orbState[symbol]?.set) return;
  if (getETMinutes() < 570 + ORB_MINUTES) return;
  const orbBars = bars.filter(b => {
    const barET = new Date(new Date(b.t).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const barMinutes = barET.getHours() * 60 + barET.getMinutes();
    return barMinutes >= 570 && barMinutes < 570 + ORB_MINUTES;
  });
  if (orbBars.length === 0) return;
  const orbHigh = Math.max(...orbBars.map(b => b.h));
  const orbLow = Math.min(...orbBars.map(b => b.l));
  orbState[symbol] = { set: true, high: orbHigh, low: orbLow, range: orbHigh - orbLow };
}

function checkORBEntry(symbol, price, high, low, vol, vwap) {
  if (orbAlertedToday.has(symbol)) return;
  if (getETMinutes() > 720) return; // no ORB alerts after 12:00 PM ET
  const orb = orbState[symbol];
  if (!orb?.set) return;
  const avgVol = avgVolumes[symbol];
  const rvol = avgVol ? vol / avgVol : null;
  const barRange = high - low;
  if (
    price > orb.high &&
    (vwap ? price > vwap : true) &&
    (rvol ? rvol >= 1.5 : true) &&
    (barRange > 0 ? (price - low) / barRange >= 0.7 : true)
  ) {
    orbAlertedToday.add(symbol);
    const target = (orb.high + orb.range).toFixed(2);
    const stop = orb.low.toFixed(2);
    const entry = (price * 1.005).toFixed(2);
    const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
    console.log(`ORB ENTRY: ${symbol} | Price: ${price} | Stop: ${stop} | Target: ${target}`);
    sendTelegram(
      `📊 *OPENING RANGE BREAKOUT*\n` +
      `Ticker: *${symbol}*\n` +
      `Price: $${price.toFixed(2)} as of ${timeET} ET\n` +
      `Entry: $${entry} | Stop: $${stop} | Target: $${target}\n` +
      `ORB High: $${orb.high.toFixed(2)} | ORB Low: $${orb.low.toFixed(2)}\n` +
      `RVOL: ${rvol ? rvol.toFixed(2) + 'x' : 'n/a'} | VWAP: ${vwap ? '$' + vwap.toFixed(2) : 'n/a'}`
    );
  }
}

function checkEntryPatterns(symbol, price, high, low, vol) {
  const pw = pullbackWatch[symbol];
  const vwap = state[symbol]?.vwap;
  const atr = state[symbol]?.atr;
  const bars = state[symbol]?.intradayBars;

  checkORBEntry(symbol, price, high, low, vol, vwap);

  if (!pw || !bars || bars.length < 20) return;

  const closes = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const ema9 = computeEMA(closes, 9);
  const ema20 = computeEMA(closes, 20);

  if (!pw.boneZoneTaken && ema9 && ema20) {
    const currClose = closes[closes.length-1];
    const currVol = volumes[volumes.length-1];
    if (!pw.inBoneZone) {
      if (currClose <= ema9 && currClose >= ema20) {
        pw.inBoneZone = true; pw.pullbackLow = currClose; pw.pullbackVol = currVol;
        console.log(`${symbol} entered Bone Zone`);
      }
    } else {
      if (currClose < pw.pullbackLow) { pw.pullbackLow = currClose; pw.pullbackVol = currVol; }
      const prevClose = closes[closes.length-2];
      if (prevClose < ema9 && currClose > ema9 && currVol > pw.pullbackVol * 1.2) {
        pw.boneZoneTaken = true;
        const stop = Math.min(pw.pullbackLow, ema20).toFixed(2);
        const entry = (price * 1.005).toFixed(2);
        const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
        console.log(`BONE ZONE ENTRY: ${symbol} | Price: ${price} | Stop: ${stop}`);
        sendTelegram(`🎯 *PULLBACK ENTRY — Bone Zone*\nTicker: *${symbol}*\nPrice: $${price.toFixed(2)} as of ${timeET} ET\nEntry: $${entry} | Stop: $${stop}\n9 EMA: $${ema9.toFixed(2)} | 20 EMA: $${ema20.toFixed(2)}\nSignal: Reclaimed 9 EMA with expanding volume`);
      }
    }
  }

  if (!pw.vwapReclaimTaken && vwap) {
    const currClose = closes[closes.length-1];
    const currVol = volumes[volumes.length-1];
    const prevClose = closes[closes.length-2];
    const rsi = computeRSI(closes);
    if (!pw.atVWAP) {
      if (Math.abs((currClose - vwap) / vwap * 100) < 0.5 && currVol < volumes[volumes.length-2] && currClose <= vwap) {
        pw.atVWAP = true; pw.vwapPullbackVol = currVol; pw.vwapPullbackRSI = rsi;
        console.log(`${symbol} pulling back to VWAP`);
      }
    } else {
      if (prevClose <= vwap && currClose > vwap && currVol > (pw.vwapPullbackVol || volumes[volumes.length-2]) * 1.5) {
        pw.vwapReclaimTaken = true;
        const stop = atr ? (vwap - atr).toFixed(2) : (vwap * 0.99).toFixed(2);
        const entry = (price * 1.005).toFixed(2);
        const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
        const rsiTag = (pw.vwapPullbackRSI !== null && pw.vwapPullbackRSI < 10 && rsi > 10) ? ' | RSI(2) confirmed' : '';
        console.log(`VWAP RECLAIM ENTRY: ${symbol} | Price: ${price}`);
        sendTelegram(`🎯 *VWAP RECLAIM ENTRY*${rsiTag}\nTicker: *${symbol}*\nPrice: $${price.toFixed(2)} as of ${timeET} ET\nEntry: $${entry} | Stop: $${stop}\nVWAP: $${vwap.toFixed(2)} | ATR: ${atr ? '$'+atr.toFixed(2) : 'n/a'}\nSignal: Reclaimed VWAP with volume surge`);
      }
      if (currClose < vwap * 0.98) { pw.atVWAP = false; pw.vwapPullbackVol = null; }
    }
  }
}

async function fetchIntradayBars(symbol) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Min&start=${today}T13:30:00Z&feed=iex&limit=390`,
      { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } }
    );
    return (await res.json()).bars || [];
  } catch { return []; }
}

async function fetchDailyBars(symbol) {
  try {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 30*24*60*60*1000).toISOString();
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&end=${end}&feed=iex&limit=30`,
      { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } }
    );
    return (await res.json()).bars || [];
  } catch { return []; }
}

async function initAvgVolumes() {
  console.log('Fetching average volumes and ATR...');
  for (const symbol of UNIVERSE) {
    const bars = await fetchDailyBars(symbol);
    if (bars.length > 0) {
      avgVolumes[symbol] = bars.reduce((sum,b) => sum+b.v, 0) / bars.length;
      if (!state[symbol]) state[symbol] = {};
      state[symbol].atr = computeATR(bars);
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
      setOpeningRange(symbol, bars);
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
    Object.assign(snapshots, await res.json());
  }
  return snapshots;
}

async function evaluate(symbol, snap) {
  const price = snap.dailyBar?.c || snap.minuteBar?.c;
  const high = snap.dailyBar?.h || price;
  const low = snap.dailyBar?.l || price;
  const open = snap.dailyBar?.o || price;
  const vol = snap.dailyBar?.v || 0;

  if (!price || price < MIN_PRICE) return;
  if (snap.dailyBar?.t && new Date(snap.dailyBar.t).toDateString() !== new Date().toDateString()) return;

  if (!state[symbol]) state[symbol] = {};
  if (!state[symbol].rvolHistory) state[symbol].rvolHistory = [];
  if (!state[symbol].intradayBars) state[symbol].intradayBars = [];

  if (!state[symbol].sessionHigh || high > state[symbol].sessionHigh) state[symbol].sessionHigh = high;
  state[symbol].intradayBars.push({ h: high, l: low, c: price, v: vol, t: new Date().toISOString() });
  state[symbol].vwap = computeVWAP(state[symbol].intradayBars);
  state[symbol].obvDivergence = detectOBVDivergence(state[symbol].intradayBars);
  const { squeeze, bullish } = detectSqueeze(state[symbol].intradayBars);
  state[symbol].intradaySqueeze = squeeze && bullish;
  setOpeningRange(symbol, state[symbol].intradayBars);

  const avgVol = avgVolumes[symbol];
  const rvol = avgVol ? vol / avgVol : null;
  if (rvol) {
    state[symbol].rvolHistory.push(rvol);
    if (state[symbol].rvolHistory.length > RVOL_WINDOW) state[symbol].rvolHistory.shift();
  }

  const float = floatShares[symbol];
  const cumVol = state[symbol].intradayBars.reduce((sum,b) => sum+b.v, 0);
  const rotation = float ? cumVol / float : null;
  const rotationStage = getFloatRotationStage(rotation);

  const vwap = state[symbol].vwap;
  const atr = state[symbol].atr;
  const rvolAccelerating = isRvolAccelerating(state[symbol].rvolHistory);
  const obvDivergence = state[symbol].obvDivergence || false;
  const dailySqueeze = state[symbol].dailySqueeze || false;
  const intradaySqueeze = state[symbol].intradaySqueeze || false;
  const isGapStock = gapSymbols.has(symbol);

  checkEntryPatterns(symbol, price, high, low, vol);

  if (alertedToday.has(symbol)) return;

  const prevClose = snap.prevDailyBar?.c;
  if (!prevClose) return;

  const changePct = ((price - prevClose) / prevClose) * 100;
  const proximityPct = ((price - state[symbol].sessionHigh) / state[symbol].sessionHigh) * 100;
  const aboveVWAP = vwap ? price > vwap : null;
  const atrExtension = atr ? (price - prevClose) / atr : null;

  const minChange = isGapStock ? 2.0 : MIN_CHANGE;
  const minRvol = isGapStock ? 1.2 : MIN_RVOL;

  if (
    changePct < minChange ||
    proximityPct < MIN_PROXIMITY ||
    (rvol && rvol < minRvol) ||
    aboveVWAP === false ||
    (atrExtension && atrExtension > 2.5) ||
    (rotationStage === 'exhaustion' && !rvolAccelerating)
  ) return;

  let newsLine = 'No recent news';
  let hasNews = false;
  try {
    const news = await getNews(symbol);
    if (news.length > 0) { newsLine = news[0].headline; hasNews = true; }
  } catch {}

  let socialSentiment = null;
  try { socialSentiment = await getSocialSentiment(symbol); } catch {}

  // Base confidence score
  let score = computeConfidenceScore({
    proximityPct, changePct, rvol, rvolAccelerating,
    aboveVWAP: aboveVWAP !== false, obvDivergence,
    intradaySqueeze, dailySqueeze, hasNews, rotationStage, isGapStock,
    socialSentiment
  });

  const svr = shortVolRatio[symbol] ?? null;

  // Apply penalties
  const { penalty, reasons } = computePenalties({
    price, high, low, open,
    atrExtension, hasNews,
    intradayBars: state[symbol].intradayBars,
    rvol, float, proximityPct, shortVolRatio: svr
  });

  const finalScore = Math.max(0, Math.round((score - penalty) * 10) / 10);
  const label = confidenceLabel(finalScore);

  if (finalScore < MIN_CONFIDENCE) {
    console.log(`SUPPRESSED: ${symbol} | Score: ${score} → ${finalScore} | Penalties: ${reasons.join(', ')}`);
    return;
  }

  alertedToday.add(symbol);
  pullbackWatch[symbol] = {
    alertPrice: price,
    inBoneZone: false, pullbackLow: null, pullbackVol: null, boneZoneTaken: false,
    atVWAP: false, vwapPullbackVol: null, vwapPullbackRSI: null, vwapReclaimTaken: false,
  };

  const tags = [];
  if (isGapStock) tags.push('🌅 Gap & Go');
  if (rvolAccelerating) tags.push('⚡ RVOL Accelerating');
  if (obvDivergence) tags.push('📈 OBV Divergence');
  if (rotationStage === 'building') tags.push('🔄 Float Rotating');
  if (rotationStage === 'full') tags.push('🔥 Full Float Rotation');
  if (intradaySqueeze) tags.push('💥 Intraday Squeeze');
  else if (dailySqueeze) tags.push('💥 Daily Squeeze');
  if (svr !== null && svr > 0.60 && (intradaySqueeze || dailySqueeze)) tags.push('🩳 Short Squeeze Setup');
  if (reasons.length > 0) tags.push(`⚠️ ${reasons.join(', ')}`);

  const vwapStr = vwap ? `$${vwap.toFixed(2)}` : 'n/a';
  const atrStr = atr ? `$${atr.toFixed(2)}` : 'n/a';
  const rvolStr = rvol ? `${rvol.toFixed(2)}x${rvolAccelerating ? ' ↑' : ''}` : 'n/a';
  const rotationStr = rotation ? `${rotation.toFixed(2)}x` : 'n/a';
  const tagLine = tags.join(' | ');

  console.log(`ALERT: ${symbol} | Score: ${score} → ${finalScore}/${label} | Penalties: ${reasons.join(', ') || 'none'}`);

  const entry = (price * 1.005).toFixed(2);
  const stopPrice = atr ? (price - atr * 1.5).toFixed(2) : (price * 0.955).toFixed(2);
  const timeET = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });

  const sentimentStr = socialSentiment
    ? `Score: ${socialSentiment.combinedScore > 0 ? '+' : ''}${socialSentiment.combinedScore} | Mentions: ${socialSentiment.totalMentions}`
    : 'n/a';
  const shortVolStr = svr !== null ? `${(svr * 100).toFixed(0)}%` : 'n/a';

  await sendTelegram(
    `🚀 *BREAKOUT ALERT*\n` +
    (tagLine ? `${tagLine}\n` : '') +
    `Ticker: *${symbol}*\n` +
    `Price: $${price.toFixed(2)} as of ${timeET} ET\n` +
    `Change: +${changePct.toFixed(2)}% | Proximity: ${proximityPct.toFixed(2)}%\n` +
    `RVOL: ${rvolStr} | VWAP: ${vwapStr} | ATR: ${atrStr}\n` +
    `Float Rotation: ${rotationStr}${rotationStage ? ' — ' + rotationStage : ''}\n` +
    `Short Vol: ${shortVolStr} | Sentiment: ${sentimentStr}\n` +
    `Confidence: ${finalScore}/100 — ${label}\n` +
    `Entry: $${entry} | Stop: $${stopPrice}\n` +
    `News: ${newsLine}`
  );
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

async function initShortVolume() {
  try {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    // Use previous trading day if before 6 PM ET (FINRA posts by 6 PM)
    const date = new Date(et);
    if (et.getHours() < 18) date.setDate(date.getDate() - 1);
    // Skip weekends
    while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1);
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');

    const url = `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`;
    const res = await fetch(url);
    if (!res.ok) { console.log(`FINRA short volume: file not available for ${dateStr}`); return; }

    const text = await res.text();
    const lines = text.split('\n');
    let loaded = 0;
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 5 || parts[0] === 'Date') continue;
      const symbol = parts[1];
      const shortVol = parseInt(parts[2]);
      const totalVol = parseInt(parts[4]);
      if (!isNaN(shortVol) && !isNaN(totalVol) && totalVol > 0) {
        shortVolRatio[symbol] = shortVol / totalVol;
        loaded++;
      }
    }
    console.log(`FINRA short volume loaded for ${loaded} symbols (${dateStr}).`);
  } catch (e) {
    console.log(`FINRA short volume fetch failed: ${e.message}`);
  }
}

async function run() {
  console.log(`Pipeline started at ${new Date().toISOString()}`);
  await initAvgVolumes();
  await initFloats();
  await initShortVolume();
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
