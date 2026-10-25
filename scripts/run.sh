#!/usr/bin/env bash
# Starts the Skylit terminal (C++ backend + static frontend) on one port.
#
#   bash scripts/run.sh                 # foreground, Ctrl+C to stop
#   bash scripts/run.sh --background    # detached, logs to .run/server.log
#     (what the devcontainer's postStartCommand uses: a lifecycle command must return)
#
# Environment:
#   SKYLIT_PORT   port to serve on             (default 8080 — keep it fixed for Live Share)
#   SKYLIT_HOST   IPv4 address to bind         (default 127.0.0.1: reachable only from this
#                 machine, which is exactly what VS Code Live Share / Codespaces forward)
#
# Open http://localhost:${SKYLIT_PORT} in a browser, or share that port via Live Share
# (see docs/LIVE_SHARE.md).

set -euo pipefail
cd "$(dirname "$0")/.."

BIN="./build/skylit_server"
PORT="${SKYLIT_PORT:-8080}"
HOST="${SKYLIT_HOST:-127.0.0.1}"

if [[ ! -x "${BIN}" ]]; then
  echo "[run] Binary not found at ${BIN}; building first..."
  make build
fi

mkdir -p .run

if [[ "${1:-}" == "--background" ]]; then
  echo "[run] Starting ${BIN} on ${HOST}:${PORT} (background)"
  nohup "${BIN}" --host "${HOST}" --port "${PORT}" --web-root "./frontend" \
    > .run/server.log 2>&1 &
  disown
  echo $! > .run/server.pid
  sleep 0.5
  if kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
    echo "[run] Server started (pid $(cat .run/server.pid)). Logs: .run/server.log"
    echo "[run] Open http://localhost:${PORT}  (stop with: kill \$(cat .run/server.pid))"
  else
    echo "[run] FATAL: server exited immediately. Check .run/server.log" >&2
    cat .run/server.log >&2 || true
    exit 1
  fi
else
  echo "[run] Starting ${BIN} on ${HOST}:${PORT} (foreground, Ctrl+C to stop)"
  exec "${BIN}" --host "${HOST}" --port "${PORT}" --web-root "./frontend"
fi
