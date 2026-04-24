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
    url: n.url,
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

export async function getFloat(symbol) {
  const data = await get(`/stock/profile2?symbol=${symbol}`);
  return data?.shareOutstanding ? data.shareOutstanding * 1e6 : null;
}

export async function getSocialSentiment(symbol) {
  const today = new Date().toISOString().split('T')[0];
  const data = await get(`/stock/social-sentiment?symbol=${symbol}&from=${today}`);
  if (!data || (!data.reddit?.length && !data.twitter?.length)) return null;

  const aggregate = (entries) => {
    if (!entries?.length) return null;
    const total = entries.reduce((acc, e) => {
      acc.mention += e.mention || 0;
      acc.positiveScore += e.positiveScore || 0;
      acc.negativeScore += e.negativeScore || 0;
      acc.count++;
      return acc;
    }, { mention: 0, positiveScore: 0, negativeScore: 0, count: 0 });
    return {
      mention: total.mention,
      positiveScore: total.count ? total.positiveScore / total.count : 0,
      negativeScore: total.count ? total.negativeScore / total.count : 0,
      score: total.count ? (total.positiveScore - total.negativeScore) / total.count : 0,
    };
  };

  const reddit = aggregate(data.reddit);
  const twitter = aggregate(data.twitter);

  // Combined score weighted: reddit 60%, twitter 40%
  const combined = reddit && twitter
    ? reddit.score * 0.6 + twitter.score * 0.4
    : (reddit?.score ?? twitter?.score ?? 0);

  const totalMentions = (reddit?.mention || 0) + (twitter?.mention || 0);

  return {
    reddit,
    twitter,
    combinedScore: Math.round(combined * 100) / 100,  // -1 to +1
    totalMentions,
  };
}
