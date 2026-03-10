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

  # Stop loss: 2x ATR proxy = 3% below entry for simplicity
  local stop_pct=0.045
  local target_pct=0.09   # 2:1 RR minimum

  local entry
  entry=$(echo "$price * 1.005" | bc -l | xargs printf "%.2f")

  local stop
  stop=$(echo "$entry * (1 - $stop_pct)" | bc -l | xargs printf "%.2f")

  local target
  target=$(echo "$entry * (1 + $target_pct)" | bc -l | xargs printf "%.2f")

  # Allocation: risk 10% of capital per trade
  local risk_amount
  risk_amount=$(echo "$CAPITAL * 0.10" | bc -l | xargs printf "%.2f")

  local risk_per_share
  risk_per_share=$(echo "$entry - $stop" | bc -l)

  local shares
  shares=$(echo "$risk_amount / $risk_per_share" | bc 2>/dev/null || echo "0")

  local allocation
  allocation=$(echo "$shares * $entry" | bc -l | xargs printf "%.2f")

  # Cap at max concentration
  if (( $(echo "$allocation > $MAX_PER_TRADE" | bc -l) )); then
    allocation=$MAX_PER_TRADE
    shares=$(echo "$MAX_PER_TRADE / $entry" | bc)
  fi

  echo "${entry}|${stop}|${target}|${allocation}|${shares}"
}

# ─── Main scan ────────────────────────────────────────────────────────────────

echo "[$(date -u)] Starting OpenClaw scan..."

# Fetch movers
RAW_HTML=$(fetch_movers)
TICKERS=$(parse_tickers "$RAW_HTML")

if [ -z "$TICKERS" ]; then
  echo "[WARN] No tickers fetched from Finviz — using fallback watchlist"
  TICKERS="NVDA AMD TSLA MSTR PLTR"
fi

echo "[INFO] Tickers to scan: $TICKERS"

# Build raw trade block for enrichment
RAW_TRADES=""
COUNT=0

for TICKER in $TICKERS; do
  [ $COUNT -ge $MAX_POSITIONS ] && break

  # Fetch quote
  QUOTE=$(fetch_quote "$TICKER")
  PRICE=$(echo "$QUOTE" | cut -d',' -f6 2>/dev/null || echo "")

  # Validate price
  if [ -z "$PRICE" ] || [ "$PRICE" = "N/D" ]; then
    echo "[SKIP] $TICKER — no price data"
    continue
  fi

  # Check minimum price
  if (( $(echo "$PRICE < $MIN_PRICE" | bc -l) )); then
    echo "[SKIP] $TICKER — price $PRICE below minimum $MIN_PRICE"
    continue
  fi

  # Calculate trade params
  PARAMS=$(calculate_trade "$TICKER" "$PRICE")
  ENTRY=$(echo "$PARAMS" | cut -d'|' -f1)
  STOP=$(echo "$PARAMS" | cut -d'|' -f2)
  TARGET=$(echo "$PARAMS" | cut -d'|' -f3)
  ALLOCATION=$(echo "$PARAMS" | cut -d'|' -f4)
  SHARES=$(echo "$PARAMS" | cut -d'|' -f5)

  # Append raw trade block
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
