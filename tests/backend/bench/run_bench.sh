#!/usr/bin/env bash
# Builds and runs the micro-benchmarks against the current tree (or against another checkout via
# SKYLIT_TREE=/path/to/checkout, which must have the same backend/ layout).
set -euo pipefail
cd "$(dirname "$0")/../../.."
TREE="${SKYLIT_TREE:-$PWD}"
OUT="${TMPDIR:-/tmp}/skylit_bench_$$"
mkdir -p "$OUT"
trap 'rm -rf "$OUT"' EXIT
g++ -std=c++23 -O2 -Wall -Wextra -I"$TREE/backend/include" -DSKYLIT_MAIN_CPP="\"$TREE/backend/src/main.cpp\"" \
    -I"$PWD/tests/backend/bench" tests/backend/bench/bench.cpp -o "$OUT/bench" -pthread
"$OUT/bench"
