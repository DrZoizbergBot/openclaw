import https from "https";

function fetch(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, data }));
      })
      .on("error", reject);
  });
}

function firstItemTitle(xml) {
  const i = xml.indexOf("<item>");
  if (i < 0) return null;
  const s = xml.slice(i);
  const m = s.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/i);
  const title = (m && (m[1] || m[2])) ? (m[1] || m[2]) : null;
  if (!title) return null;
  return title.replace(/\s+/g, " ").trim();
}

const ticker = process.argv[2];
if (!ticker) process.exit(2);

const url = `https://news.google.com/rss/search?q=${encodeURIComponent(ticker)}+stock&hl=en-US&gl=US&ceid=US:en`;

try {
  const { status, data } = await fetch(url);
  if (status !== 200) {
    console.log("No recent headline found. (Google News RSS)");
    process.exit(0);
  }
  const title = firstItemTitle(data);
  console.log(title ? `${title} (Google News RSS)` : "No recent headline found. (Google News RSS)");
} catch {
  console.log("No recent headline found. (Google News RSS)");
}
