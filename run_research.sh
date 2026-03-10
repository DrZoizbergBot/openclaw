#!/usr/bin/env bash
# run_research.sh
# OpenClaw market scan — runs at 08:30, 10:30, 12:30 NY time on US market days.
# Fetches top movers, builds trade ideas, enriches with sentiment, sends to Telegram.

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────

SCRIPTS_DIR="/data/state/scripts"
TOKEN="${TOKEN:-}"
CHAT="${CHAT:-}"
TIMESTAMP="$(TZ='America/New_York' date '+%Y-%m-%d %H:%M EDT')"
MAX_POSITIONS=3
CAPITAL=1000
MAX_PER_TRADE=600   # 60% max concentration
MIN_PRICE=5
MIN_RR=2            # minimum reward:risk ratio

# ─── Telegram sender ──────────────────────────────────────────────────────────

send_telegram() {
  local msg="$1"
  if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
    echo "[WARN] TOKEN or CHAT not set — skipping Telegram send"
    echo "$msg"
    return
  fi
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"${CHAT}\",\"text\":$(echo "$msg" | node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8')))")}" \
    > /dev/null
}

# ─── Fetch top movers from Finviz ─────────────────────────────────────────────

fetch_movers() {
  curl -fsSL --max-time 15 \
    -H "User-Agent: Mozilla/5.0" \
    "https://finviz.com/screener.ashx?v=111&s=ta_topgainers&f=sh_avgvol_o500,sh_price_o5&o=-change&c=1,2,3,4,5,6,65" \
    2>/dev/null || echo ""
}

parse_tickers() {
  echo "$1" | grep -oP '(?<=quote\.ashx\?t=)[A-Z]+' | head -10 | sort -u
}

# ─── Fetch quote from Stooq ───────────────────────────────────────────────────

fetch_quote() {
  local ticker="$1"
  curl -fsSL --max-time 10 \
    "https://stooq.com/q/l/?s=${ticker}.us&f=sd2t2ohlcv&h&e=csv" \
    2>/dev/null | tail -1
}

# ─── Calculate trade parameters ───────────────────────────────────────────────

calculate_trade() {
  local ticker="$1"
  local price="$2"

  node -e "
    const price = parseFloat('$price');
    const capital = $CAPITAL;
    const maxTrade = $MAX_PER_TRADE;
    const stopPct = 0.045;
    const targetPct = 0.09;

    const entry = parseFloat((price * 1.005).toFixed(2));
    const stop = parseFloat((entry * (1 - stopPct)).toFixed(2));
    const target = parseFloat((entry * (1 + targetPct)).toFixed(2));

    const riskAmount = capital * 0.10;
    const riskPerShare = entry - stop;
    let shares = Math.floor(riskAmount / riskPerShare);
    let allocation = parseFloat((shares * entry).toFixed(2));

    if (allocation > maxTrade) {
      allocation = maxTrade;
      shares = Math.floor(maxTrade / entry);
    }

    console.log(entry+'|'+stop+'|'+target+'|'+allocation+'|'+shares);
  "
}

# ─── Main scan ────────────────────────────────────────────────────────────────

echo "[$(date -u)] Starting OpenClaw scan..."

# Fetch movers
RAW_HTML=$(fetch_movers)
ALL_TICKERS=$(parse_tickers "$RAW_HTML")

if [ -z "$ALL_TICKERS" ]; then
  echo "[WARN] No tickers fetched from Finviz — using fallback watchlist"
  ALL_TICKERS="NVDA AMD TSLA MSTR PLTR"
fi

echo "[INFO] Tickers to pre-screen: $ALL_TICKERS"

# ─── Stage 1: Validate prices ─────────────────────────────────────────────────

VALID_TICKERS=""

for TICKER in $ALL_TICKERS; do
  QUOTE=$(fetch_quote "$TICKER")
  PRICE=$(echo "$QUOTE" | cut -d',' -f7 2>/dev/null || echo "")

  if [ -z "$PRICE" ] || [ "$PRICE" = "N/D" ]; then
    echo "[SKIP] $TICKER — no price data"
    continue
  fi

  if node -e "process.exit(parseFloat('$PRICE') < $MIN_PRICE ? 0 : 1)" 2>/dev/null; then
    echo "[SKIP] $TICKER — price $PRICE below minimum $MIN_PRICE"
    continue
  fi

  VALID_TICKERS="$VALID_TICKERS $TICKER"
done

VALID_TICKERS=$(echo "$VALID_TICKERS" | xargs)

if [ -z "$VALID_TICKERS" ]; then
  send_telegram "OpenClaw | ${TIMESTAMP}
No trade ideas generated this scan. Market conditions not favorable."
  exit 0
fi

echo "[INFO] Valid tickers: $VALID_TICKERS"

# ─── Stage 2: Rank all valid tickers by sentiment ─────────────────────────────

echo "[INFO] Pre-screening sentiment for all valid tickers..."

RANKED=$(node "${SCRIPTS_DIR}/sentiment_rank.mjs" $VALID_TICKERS 2>/dev/null || echo "")

if [ -z "$RANKED" ]; then
  echo "[WARN] Sentiment pre-screen failed — using Finviz order"
  TOP_TICKERS=$(echo "$VALID_TICKERS" | tr ' ' '\n' | head -$MAX_POSITIONS | tr '\n' ' ')
else
  # Pick top N by sentiment score, exclude BEARISH
  TOP_TICKERS=$(echo "$RANKED" | awk -F'\t' '$2 != "BEARISH" {print $3}' | head -$MAX_POSITIONS | tr '\n' ' ')
  echo "[INFO] Top tickers by sentiment: $TOP_TICKERS"
fi

if [ -z "$TOP_TICKERS" ]; then
  send_telegram "OpenClaw | ${TIMESTAMP}
No bullish trade ideas found this scan. All movers showing bearish sentiment."
  exit 0
fi

# ─── Stage 3: Build trade blocks for top tickers ──────────────────────────────

RAW_TRADES=""
COUNT=0

for TICKER in $TOP_TICKERS; do
  [ $COUNT -ge $MAX_POSITIONS ] && break

  QUOTE=$(fetch_quote "$TICKER")
  PRICE=$(echo "$QUOTE" | cut -d',' -f7 2>/dev/null || echo "")

  if [ -z "$PRICE" ] || [ "$PRICE" = "N/D" ]; then
    echo "[SKIP] $TICKER — no price data"
    continue
  fi

  PARAMS=$(calculate_trade "$TICKER" "$PRICE")
  ENTRY=$(echo "$PARAMS" | cut -d'|' -f1)
  STOP=$(echo "$PARAMS" | cut -d'|' -f2)
  TARGET=$(echo "$PARAMS" | cut -d'|' -f3)
  ALLOCATION=$(echo "$PARAMS" | cut -d'|' -f4)
  SHARES=$(echo "$PARAMS" | cut -d'|' -f5)

  RAW_TRADES="${RAW_TRADES}Ticker: ${TICKER}
Entry: ${ENTRY} | Stop: ${STOP} | Target: ${TARGET}
Allocation: ${ALLOCATION} USD | Shares: ${SHARES}
Rationale: placeholder

"
  COUNT=$((COUNT + 1))
done

if [ -z "$RAW_TRADES" ]; then
  send_telegram "OpenClaw | ${TIMESTAMP}
No trade ideas generated this scan. Market conditions not favorable."
  exit 0
fi

# ─── Enrich with sentiment ────────────────────────────────────────────────────

echo "[INFO] Enriching with sentiment..."

ENRICHED=$(echo "$RAW_TRADES" | node "${SCRIPTS_DIR}/enrich_watchlist.mjs" 2>/dev/null || echo "$RAW_TRADES")

# ─── Build final Telegram message ─────────────────────────────────────────────

MESSAGE="OpenClaw | ${TIMESTAMP}
WARNING: Prices delayed ~15-20 min. Verify before executing.

— BUY IDEAS —

${ENRICHED}"

# ─── Send to Telegram ─────────────────────────────────────────────────────────

send_telegram "$MESSAGE"
echo "[$(date -u)] Scan complete. ${COUNT} idea(s) sent."
