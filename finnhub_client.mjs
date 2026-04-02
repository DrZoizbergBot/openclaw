const BASE = 'https://finnhub.io/api/v1';
const KEY = process.env.FINNHUB_KEY;

async function get(path) {
  const url = `${BASE}${path}&token=${KEY}`;
  const res = await fetch(url);
  return res.json();
}

export async function getNews(symbol) {
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const data = await get(`/company-news?symbol=${symbol}&from=${weekAgo}&to=${today}`);
  return (data || []).slice(0, 5).map(n => ({
    headline: n.headline,
    source: n.source,
    datetime: new Date(n.datetime * 1000).toISOString(),
  }));
}

export async function getInsiders(symbol) {
  const data = await get(`/stock/insider-transactions?symbol=${symbol}`);
  return (data?.data || []).slice(0, 5).map(t => ({
    name: t.name,
    transactionType: t.transactionType,
    share: t.share,
    transactionPrice: t.transactionPrice,
    transactionDate: t.transactionDate,
  }));
}

export async function getEarnings(symbol) {
  const data = await get(`/stock/earnings?symbol=${symbol}&limit=1`);
  const last = data?.[0] || null;
  return last ? {
    period: last.period,
    actual: last.actual,
    estimate: last.estimate,
    surprise: last.surprise,
    surprisePercent: last.surprisePercent,
  } : null;
}
