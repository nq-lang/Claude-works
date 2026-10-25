#!/usr/bin/env bash
# Repeatable Codespaces-equivalent smoke test (Part A.7 / TESTING.md).
# Builds, starts the server on a scratch port, hits the routes a real
# browser/Ports-tab session would hit, and tears down. Exit code is
# non-zero on any failure so this can gate future changes.

set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=18080
BIN="./build/skylit_server"

echo "[smoke] Building..."
make clean build

echo "[smoke] Starting server on port ${PORT}..."
"${BIN}" --port "${PORT}" --web-root "./frontend" > /tmp/skylit_smoke.log 2>&1 &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" 2>/dev/null || true' EXIT

# Wait for the socket to come up rather than a fixed sleep.
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/health"; then
    break
  fi
  sleep 0.2
  if [[ "$i" -eq 30 ]]; then
    echo "[smoke] FATAL: server never came up. Log:" >&2
    cat /tmp/skylit_smoke.log >&2
    exit 1
  fi
done

echo "[smoke] Checking GET /api/health..."
HEALTH_BODY="$(curl -sf "http://127.0.0.1:${PORT}/api/health")"
echo "  -> ${HEALTH_BODY}"
if [[ "${HEALTH_BODY}" != *'"status":"ok"'* ]]; then
  echo "[smoke] FATAL: /api/health did not report ok" >&2
  exit 1
fi

echo "[smoke] Checking GET / (index.html served, Lightweight Charts referenced)..."
INDEX_BODY="$(curl -sf "http://127.0.0.1:${PORT}/")"
if [[ "${INDEX_BODY}" != *"lightweight-charts"* ]]; then
  echo "[smoke] FATAL: index.html did not reference lightweight-charts" >&2
  exit 1
fi
if [[ "${INDEX_BODY}" != *"Charting System"* ]]; then
  echo "[smoke] FATAL: index.html did not render expected terminal shell" >&2
  exit 1
fi

echo "[smoke] Checking path-traversal guard (GET /../Makefile must NOT succeed)..."
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/../Makefile")"
if [[ "${STATUS}" == "200" ]]; then
  echo "[smoke] FATAL: path traversal served a file outside web root" >&2
  exit 1
fi

echo "[smoke] Checking 404 on unknown route..."
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/definitely-not-a-real-path")"
if [[ "${STATUS}" != "404" ]]; then
  echo "[smoke] FATAL: expected 404, got ${STATUS}" >&2
  exit 1
fi

echo "[smoke] Checking GET /api/heatmap?ticker=SPY (King Node present)..."
HEATMAP_BODY="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&exposure=GEX")"
if [[ "${HEATMAP_BODY}" != *'"king_strike"'* ]]; then
  echo "[smoke] FATAL: /api/heatmap missing king_strike" >&2
  exit 1
fi

echo "[smoke] Checking GET /api/quadrinity rejects <2 or >4 tickers..."
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/quadrinity?tickers=SPY")"
if [[ "${STATUS}" != "400" ]]; then
  echo "[smoke] FATAL: expected 400 for 1-ticker quadrinity request, got ${STATUS}" >&2
  exit 1
fi

echo "[smoke] Checking GET /api/quadrinity with 4 tickers returns confluence..."
QUAD_BODY="$(curl -sf "http://127.0.0.1:${PORT}/api/quadrinity?tickers=SPXW,SPY,QQQ,NVDA")"
if [[ "${QUAD_BODY}" != *'"confluence"'* ]]; then
  echo "[smoke] FATAL: /api/quadrinity missing confluence block" >&2
  exit 1
fi

echo "[smoke] Checking URL-decoding of query params (GEX+VEX / %2B, comma / %2C)..."
GEX_BODY="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&exposure=GEX")"
GEXVEX_BODY="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&exposure=GEX%2BVEX")"
if [[ "${GEX_BODY}" == "${GEXVEX_BODY}" ]]; then
  echo "[smoke] FATAL: GEX and GEX+VEX (URL-encoded as %2B) returned identical bodies — query string is not being URL-decoded" >&2
  exit 1
fi
QUAD_ENCODED_BODY="$(curl -sf "http://127.0.0.1:${PORT}/api/quadrinity?tickers=SPXW%2CSPY%2CQQQ")"
if [[ "${QUAD_ENCODED_BODY}" != *'"SPXW"'* || "${QUAD_ENCODED_BODY}" != *'"QQQ"'* ]]; then
  echo "[smoke] FATAL: quadrinity with URL-encoded commas (%2C) did not parse all 3 tickers" >&2
  exit 1
fi

echo "[smoke] Checking expiration scope is a genuine data-scope change (not a cosmetic filter)..."
DTE0_BODY="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&expiration=0dte")"
DTE_PLUS5_BODY="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&expiration=current%2B5")"
if [[ "${DTE0_BODY}" == "${DTE_PLUS5_BODY}" ]]; then
  echo "[smoke] FATAL: 0dte and current+5 returned identical bodies — expiration scope is not affecting data" >&2
  exit 1
fi
if [[ "${DTE0_BODY}" != *'"expiration_bucket":"0dte"'* ]]; then
  echo "[smoke] FATAL: 0dte response did not label its bucket as 0dte" >&2
  exit 1
fi
if [[ "${DTE_PLUS5_BODY}" != *'"expiration_bucket":"0dte+5"'* ]]; then
  echo "[smoke] FATAL: current+5 response did not label its bucket as 0dte+5" >&2
  exit 1
fi

echo "[smoke] Atlas Projections: config table is served and non-empty..."
PCFG="$(curl -sf "http://127.0.0.1:${PORT}/api/projection/config")"
if [[ "${PCFG}" != *'"profiles"'* || "${PCFG}" != *'"max_dte":6'* ]]; then
  echo "[smoke] FATAL: /api/projection/config missing the bar-geometry table or max_dte" >&2
  exit 1
fi

echo "[smoke] Atlas Projections: dte selects an exact bucket (0-6)..."
for D in 0 1 2 3 4 5 6; do
  PD="$(curl -sf "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=1D&dte=${D}")"
  EXPECT_BUCKET="0dte"; [[ "${D}" != "0" ]] && EXPECT_BUCKET="next${D}"
  if [[ "${PD}" != *"\"dte\":${D}"* || "${PD}" != *"\"bucket\":\"${EXPECT_BUCKET}\""* ]]; then
    echo "[smoke] FATAL: dte=${D} did not echo dte/bucket correctly" >&2
    exit 1
  fi
done

echo "[smoke] Atlas Projections: bad dte is rejected, not silently clamped by the route..."
S400="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=1D&dte=99")"
if [[ "${S400}" != "400" ]]; then
  echo "[smoke] FATAL: expected 400 for out-of-range dte, got ${S400}" >&2
  exit 1
fi

echo "[smoke] Atlas Projections: forward bars are clamped server-side per timeframe (Part III)..."
P1M="$(curl -sf "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=1m&dte=5")"
P1D0="$(curl -sf "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=1D&dte=0")"
if [[ "${P1M}" != *'"clamped":true'* ]]; then
  echo "[smoke] FATAL: 1m + 5DTE horizon was not clamped" >&2
  exit 1
fi
if [[ "${P1D0}" != *'"effective_bars":1'* || "${P1D0}" != *'"clamped":false'* ]]; then
  echo "[smoke] FATAL: 1D + 0DTE should need exactly 1 unclamped bar" >&2
  exit 1
fi
if [[ "${P1M}" != *'"beta":true'* ]]; then
  echo "[smoke] FATAL: projection payload is not labelled beta" >&2
  exit 1
fi

echo "[smoke] Atlas Projections: exposure type changes the build (URL-encoded GEX+VEX too)..."
PG="$(curl -sf "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=1D&dte=2&exposure=GEX")"
PV="$(curl -sf "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=1D&dte=2&exposure=VEX")"
PM="$(curl -sf "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=1D&dte=2&exposure=GEX%2BVEX")"
if [[ "${PM}" != *'"exposure":"GEX+VEX"'* || "${PV}" != *'"exposure":"VEX"'* || "${PG}" != *'"exposure":"GEX"'* ]]; then
  echo "[smoke] FATAL: projection did not honour the selected exposure type" >&2
  exit 1
fi

echo "[smoke] Atlas Projections: unknown ticker / interval are rejected..."
S404="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/projection?ticker=NOPE")"
S400B="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=7m")"
if [[ "${S404}" != "404" || "${S400B}" != "400" ]]; then
  echo "[smoke] FATAL: expected 404 (unknown ticker) / 400 (unknown interval), got ${S404}/${S400B}" >&2
  exit 1
fi

echo "[smoke] Atlas Projections: bar-geometry table is tunable via CSV without rebuilding..."
CSV="$(mktemp)"
printf '# tuned\n1D,80\n' > "${CSV}"
"${BIN}" --port "$((PORT + 1))" --web-root "./frontend" --projection-config "${CSV}" > /tmp/skylit_smoke2.log 2>&1 &
SERVER2_PID=$!
trap 'kill "${SERVER_PID}" "${SERVER2_PID}" 2>/dev/null || true; rm -f "${CSV}"' EXIT
for i in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$((PORT + 1))/api/health" && break
  sleep 0.2
done
PT="$(curl -sf "http://127.0.0.1:$((PORT + 1))/api/projection?ticker=SPY&interval=1D&dte=5")"
if [[ "${PT}" != *'"max_bars":80'* ]]; then
  echo "[smoke] FATAL: CSV-tuned 1D max (80) not honoured" >&2
  exit 1
fi
kill "${SERVER2_PID}" 2>/dev/null || true

echo "[smoke] Multi-DTE / multi-Greek / Velocity Mode API..."
H1="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&exposure=GEX&expiration=dte:1")"
H3="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&exposure=GEX&expiration=dte:3")"
H13="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&exposure=GEX&expiration=dte:1,3")"
python3 - "$H1" "$H3" "$H13" <<'PYEOF'
import json, sys
a, b, c = (json.loads(x) for x in sys.argv[1:4])
for i in (3, 7, 20):
    want = a["nodes"][i]["exposure"] + b["nodes"][i]["exposure"]
    got = c["nodes"][i]["exposure"]
    if abs(want - got) > 1.0:
        sys.exit(f"dte:1,3 is not the sum of dte:1 and dte:3 at node {i}: {got} vs {want}")
PYEOF
[[ $? -eq 0 ]] || { echo "[smoke] FATAL: multi-DTE aggregation wrong (comma in a query value dropped?)" >&2; exit 1; }
HX="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&exposure=GEX,CHEX&expiration=dte:0")"
if [[ "${HX}" != *'"velocity_pct"'* ]]; then echo "[smoke] FATAL: nodes carry no velocity fields" >&2; exit 1; fi
for BASE in session 5m 15m 1h prev_close; do
  HV="$(curl -sf "http://127.0.0.1:${PORT}/api/heatmap?ticker=SPY&exposure=GEX&expiration=dte:0&velocity=1&velocity_baseline=${BASE}")"
  python3 - "$HV" "$BASE" <<'PYEOF'
import json, sys
d = json.loads(sys.argv[1])
moving = [n for n in d["nodes"] if abs(n["velocity_pct"]) >= 1.0 or n["velocity_new"]]
if len(moving) < 3:
    sys.exit(f"baseline {sys.argv[2]}: velocity pills would be empty ({len(moving)} moving strikes)")
PYEOF
  [[ $? -eq 0 ]] || { echo "[smoke] FATAL: velocity baseline ${BASE} produced no movement" >&2; exit 1; }
done
PV="$(curl -sf "http://127.0.0.1:${PORT}/api/projection?ticker=SPY&interval=1h&dte=6&exposure=GEX,CHEX,SPEED")"
if [[ "${PV}" != *'"exposure":"GEX+CHEX+SPEED"'* || "${PV}" != *'"bucket":"next6"'* ]]; then
  echo "[smoke] FATAL: custom-Greek 6DTE projection not honoured" >&2; exit 1
fi
QS="$(curl -sf "http://127.0.0.1:${PORT}/api/quadrinity?tickers=SPY,QQQ&specs=GEX~dte:0,CHEX~dte:2")"
if [[ "${QS}" != *'"panes"'* ]]; then echo "[smoke] FATAL: per-pane Quadrinity specs rejected" >&2; exit 1; fi

echo "[smoke] All checks passed."
