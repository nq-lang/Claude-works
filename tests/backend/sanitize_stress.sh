#!/usr/bin/env bash
# Runs the hostile/concurrent API probe (tests/backend/api_stress.py) against the
# AddressSanitizer+UBSan build and the ThreadSanitizer build of the server, then fails if
# either sanitizer reported anything, the server died, or it did not exit cleanly on SIGTERM.
# Requires: `make asan tsan` (the `make test-sanitize` target does that first), python3.
set -euo pipefail
cd "$(dirname "$0")/../.."

LOGDIR="$(mktemp -d)"
trap 'rm -rf "${LOGDIR}"' EXIT
status=0

run_one() {  # name binary port mode
  local name="$1" bin="$2" port="$3" mode="$4"
  echo "[sanitize] === ${name}"
  "${bin}" --port "${port}" --web-root ./frontend > "${LOGDIR}/${name}.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:${port}/api/health" && break; sleep 0.2; done
  python3 -I tests/backend/api_stress.py "${port}" ${mode} | grep -v '^  ok' || status=1
  [[ "${name}" == tsan ]] && sleep 11   # let the 10s exposure-refresh thread run under TSan too
  kill -0 "${pid}" 2>/dev/null || { echo "[sanitize] ${name}: server died"; status=1; }
  kill -TERM "${pid}" 2>/dev/null || true
  wait "${pid}" || { echo "[sanitize] ${name}: non-zero exit after SIGTERM"; status=1; }
  if grep -qE "ERROR: (Address|Leak)Sanitizer|runtime error:|WARNING: ThreadSanitizer" "${LOGDIR}/${name}.log"; then
    echo "[sanitize] ${name}: SANITIZER REPORT"; cat "${LOGDIR}/${name}.log"; status=1
  else
    echo "[sanitize] ${name}: clean"
  fi
}

run_one asan build/asan/skylit_server 18690 ""
run_one tsan build/tsan/skylit_server 18691 "--quick"
[[ ${status} -eq 0 ]] && echo "[sanitize] all clean" || { echo "[sanitize] FAILED"; exit 1; }
