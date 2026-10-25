#!/usr/bin/env bash
# Backend math regression check.
#
#   make golden                              compare the current tree against golden_baseline.txt
#   SKYLIT_TREE=/path/to/other/checkout bash tests/backend/golden/run_golden.sh
#   SKYLIT_GOLDEN_UPDATE=1 ... run_golden.sh  rewrite the baseline (ONLY from a tree whose math is
#                                             known good - the baseline in git was generated from the
#                                             original, unoptimized sources)
#
# The dump is produced under a fake clock (fake_time.cpp) so it is reproducible; any difference in
# any output - JSON bytes or the hex-float dump of the underlying doubles - fails the check.
set -euo pipefail
cd "$(dirname "$0")/../../.."
HERE="tests/backend/golden"
TREE="${SKYLIT_TREE:-$PWD}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

g++ -std=c++23 -O2 -shared -fPIC "$HERE/fake_time.cpp" -o "$OUT/fake_time.so" -ldl
g++ -std=c++23 -O2 -ffp-contract=off -Wall -Wextra -Wno-unused-function \
    -I"$TREE/backend/include" -DSKYLIT_MAIN_CPP="\"$TREE/backend/src/main.cpp\"" \
    "$HERE/golden_dump.cpp" -o "$OUT/golden_dump" -pthread -ldl

# 2026-03-18 15:45:00 UTC (a Wednesday in OPEX week; 15 minutes before the 16:00 session rollover)
LD_PRELOAD="$OUT/fake_time.so" TZ=UTC SKYLIT_FAKE_EPOCH=1773848700 "$OUT/golden_dump" > "$OUT/dump.txt"

if [[ "${SKYLIT_GOLDEN_UPDATE:-0}" == "1" ]]; then
  cp "$OUT/dump.txt" "$HERE/golden_baseline.txt"
  echo "[golden] baseline rewritten: $(tail -1 "$OUT/dump.txt")"
  exit 0
fi
if cmp -s "$OUT/dump.txt" "$HERE/golden_baseline.txt"; then
  echo "[golden] IDENTICAL to baseline: $(tail -1 "$OUT/dump.txt")"
else
  echo "[golden] MISMATCH vs $HERE/golden_baseline.txt (first differences):" >&2
  diff "$HERE/golden_baseline.txt" "$OUT/dump.txt" | head -20 >&2
  exit 1
fi
