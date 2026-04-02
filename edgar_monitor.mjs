import { UNIVERSE } from './universe.mjs';

const EDGAR_BASE = 'https://efts.sec.gov/LATEST/search-index?q=%228-K%22&dateRange=custom&startdt=TODAY&enddt=TODAY&forms=8-K';
const FILING_URL = 'https://efts.sec.gov/LATEST/search-index?forms=8-K&dateRange=custom&startdt=TODAY&enddt=TODAY';
const TOKEN = process.env.TOKEN;
const CHAT = process.env.CHAT;

const MATERIAL_ITEMS = ['1.01', '2.02', '8.01', '7.01'];
const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

const alreadyAlerted = new Set();

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: message, parse_mode: 'Markdown' }),
  });
}

async function getRecentFilings() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://efts.sec.gov/LATEST/search-index?forms=8-K&dateRange=custom&startdt=${today}&enddt=${today}&hits.hits._source=period_of_report,entity_name,file_num,period_of_report,period_of_report&hits.hits.total.value=true`;

  const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%228-K%22&forms=8-K&dateRange=custom&startdt=${today}&enddt=${today}`;

  const res = await fetch(`https://efts.sec.gov/LATEST/search-index?forms=8-K&dateRange=custom&startdt=${today}&enddt=${today}`, {
    headers: { 'User-Agent': 'OpenClaw/1.0 research@openclaw.bot' }
  });

  if (!res.ok) {
    console.error(`EDGAR request failed: ${res.status}`);
    return [];
  }

  const data = await res.json();
  return data.hits?.hits || [];
}

async function getTickerFromCIK(cik) {
  try {
    const paddedCik = String(cik).padStart(10, '0');
    const res = await fetch(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, {
      headers: { 'User-Agent': 'OpenClaw/1.0 research@openclaw.bot' }
    });
    const data = await res.json();
    return data.tickers?.[0] || null;
  } catch {
    return null;
  }
}

async function checkFilings() {
  const filings = await getRecentFilings();

  for (const filing of filings) {
    const source = filing._source || {};
    const id = filing._id;

    if (alreadyAlerted.has(id)) continue;

    const entityName = source.entity_name || source.display_names?.[0] || 'Unknown';
    const cik = source.entity_id || source.file_num;
    const formType = source.form_type || '8-K';
    const filedAt = source.file_date || source.period_of_report || '';
    const description = source.period_of_report || '';

    // Check if this company is in our universe
    const ticker = await getTickerFromCIK(cik);
    if (!ticker || !UNIVERSE.includes(ticker.toUpperCase())) continue;

    // Check for material items
    const items = source.items || '';
    const isMaterial = MATERIAL_ITEMS.some(item => items.includes(item));
    if (!isMaterial) continue;

    alreadyAlerted.add(id);

    const message =
      `🚨 *8-K FILING DETECTED*\n` +
      `Ticker: *${ticker.toUpperCase()}*\n` +
      `Company: ${entityName}\n` +
      `Items: ${items}\n` +
      `Filed: ${filedAt}\n` +
      `[View Filing](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=8-K&dateb=&owner=include&count=5)`;

    await sendTelegram(message);
    console.log(`Alert sent for ${ticker}: ${items}`);
  }
}

async function run() {
  console.log(`EDGAR monitor started at ${new Date().toISOString()}`);
  console.log(`Polling every 60 seconds for 8-K filings...\n`);

  // Run immediately on start
  await checkFilings().catch(console.error);

  // Then poll every 60 seconds
  setInterval(() => checkFilings().catch(console.error), POLL_INTERVAL_MS);
}

run();
