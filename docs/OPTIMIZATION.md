# Optimization report (Stage 4)

**Constraint:** the backend math must stay identical. Every change below is a data-structure,
transport or scheduling change; no formula, constant, rounding step or order of floating-point
operations was touched. Proof is in [Backend math: proof of equivalence](#backend-math-proof-of-equivalence).

**Method.** "Before" = the original sources (plus a mechanical, behaviour-preserving extraction of the
two background-loop bodies into callable functions so they can be driven deterministically).
"After" = this tree. Micro-benchmarks (`make bench`) call the real route handlers' code paths in
process; the benchmark binary is compiled from each tree with identical flags, runs are **interleaved
(before, after, before, after…) and the median of 7 is reported**. Machine: 2 vCPU Intel Xeon
2.8 GHz, g++ 13.3.0 (Ubuntu 24.04), `-O2`. Treat differences under about ±5 % as noise — they are
shown as measured, not rounded up.

## 1. Backend — measured results

| Path (µs per call unless stated) | Before | After | Speed-up |
|---|---:|---:|---:|
| **`/api/candles/latest` 1m, 24 h history** (polled every 1 s per chart pane) | 281.4 | **1.5** | **188×** |
| `/api/candles/latest` 15m, 24 h history | 278.2 | **9.3** | **30×** |
| `/api/candles/latest` 1m, 4 h history | 43.1 | **1.5** | **29×** |
| Startup (`LiveFeedManager` construction) | 156.2 ms | **73.5 ms** | **2.1×** |
| Resident memory after start (RSS) | 55.3 MB | **34.7 MB** | **−37 %** |
| Time to first healthy response | ~155 ms | ~115 ms | ~1.3× (noisy, 3 runs each) |
| heatmap 0dte GEX | 26.8 | 25.5 | 1.05× |
| heatmap dte 0,1,2 GEX+VEX | 32.4 | 32.4 | 1.00× |
| heatmap 0dte GEX + velocity(15m) | 35.5 | 33.4 | 1.06× |
| heatmap current+50 (51 buckets) | 49.3 | 46.7 | 1.06× |
| quadrinity (4 panes + confluence) | 116.3 | 111.2 | 1.05× |
| projection 5m dte0 GEX | 44.1 | 44.0 | 1.00× |
| projection 15m dte3 GEX+VEX | 26.6 | 26.0 | 1.02× |
| projection 1h dte6 custom(GEX,VEX,CHEX) | 28.2 | 28.1 | 1.00× |
| candles full 1m (4 h) | 152.0 | 147.2 | 1.03× |
| candles full 5m (24 h) | 415.9 | 391.8 | 1.06× |
| flow 5m (24 h) | 456.5 | 441.8 | 1.03× |
| darkpool | 2.9 | 3.0 | 0.97× (noise) |

The engine routes (heatmap / projection / quadrinity / flow) were already cheap (tens of µs) and are
**essentially unchanged — that is intentional**: they are where the math lives, and they are not the
bottleneck. The wins come from the places that were doing needless work around the math.

### What changed and why

1. **Candle tail aggregation** (`candles.hpp: aggregate_candles_tail`). `/api/candles/latest`
   returns only the last 2 bars but re-aggregated the *entire* 24 h tick history on every 1 s poll of
   every chart pane. It now walks back from the newest tick until `count` bar buckets are found and
   aggregates only that tail. Output is identical to "aggregate everything, slice the last N";
   `tests/backend/candles_tail_test.cpp` checks that on 1.89 M random histories/intervals/counts.
2. **Flat exposure snapshots** (`live_feed.hpp: ExposureSnap`). ~130 historical snapshots × ~200
   strikes were held as `unordered_map<double,double>` (one heap node per strike). They are now a
   sorted `vector<pair<double,double>>` (last write wins per strike, exactly the old map-assignment
   semantics). Every consumer either iterates the whole snapshot and accumulates *per strike*
   (the per-strike sum order across buckets is unchanged) or does a point lookup, so results are
   bit-identical. Effect: −37 % RSS and half the startup time (the history seeding allocates ~4×
   less).
3. **`annotate_velocity`**: `reserve()` for the two accumulation maps and one hash lookup instead of
   `count()` + `operator[]` per node. Same values, fewer rehashes.
4. **`json::escape` fast path**: returns the input unchanged when it contains nothing to escape (the
   common case: tickers, labels). Property-tested against a reference implementation
   (`tests/backend/json_escape_test.cpp`, 400 k cases). It also now escapes `\r`, `\t` and other
   control characters, which previously produced invalid JSON — a correctness fix, see CHANGES.md.
5. **Graceful shutdown** (robustness, not throughput). The original installed no signal handler, so
   SIGTERM/Ctrl+C killed the process abruptly (7 ms, but with no orderly stop, no thread join and no
   leak check at exit). Now SIGINT/SIGTERM stop the accept loop and the background loops, which sleep
   on a condition variable so they wake at once rather than after up to 10 s, and the process exits
   cleanly in ~8 ms (measured). This is what lets the sanitizer runs verify a clean exit.

## 2. Transport — HTTP/1.1 keep-alive and conditional requests

The terminal polls: ~1 request/s per pane per viewer. Over a Live Share tunnel every new TCP
connection costs extra round trips, so connection reuse matters more than raw server speed.

`python3 tests/backend/bench/http_bench.py PORT` (localhost, so it *understates* the real-network
benefit — no latency is being saved here, only per-connection setup cost):

| Scenario | Before | After |
|---|---:|---:|
| One persistent client (per request) | 283.6 µs (server closed every connection; client reconnected 1500×) | **156.0 µs** (1 connection) |
| 8 parallel persistent clients | 3 844 req/s | **5 310 req/s** (+38 %) |
| Page reload, body bytes re-downloaded | 204.5 KB | **0 KB** (11/11 files → `304 Not Modified`) |
| Page reload, wall time | 3.5 ms | 1.2 ms |
| New connection per request | 244.8 µs | 204.0 µs (noise-level) |

Implementation (`http_server.hpp`): keep-alive honouring `Connection: close` and HTTP/1.0, 30 s idle
timeout, 1000 requests/connection, pipelined requests carried over correctly, `ETag` (size+mtime) with
`If-None-Match` → `304` (weak `W/` validators accepted), static files `Cache-Control: no-cache`
(always revalidate, so edits show up immediately), API responses `no-store`. Covered by 12 checks in
`tests/backend/api_stress.py` and, through a forwarder, by `pw_two_viewers.py`.

## 3. Frontend — measured with the identical test suite on old vs new

`tests/e2e/pw_resilience.py` (real browser through a latency proxy — the Live Share guest experience):

| Check | Original frontend | Current |
|---|---|---|
| `/api/candles/latest` requests in flight on a 1.6 s link | **2** (stacking) | 1 |
| `/api/heatmap` requests in flight | **3** | ≤ 2 (one per panel) |
| Stale reply after switching SPY → SPXW | header **flashed SPY's price in 9 of 89 samples** | 0 of 89 |
| Document click listeners after 24 heatmap-panel rebuilds | **5 → 129 (leak)** | 5 → 7 |
| Console / page errors | none | none |
| **Suite result** | **6 passed, 4 failed** | **10 passed, 0 failed** |

Fixes (`atlas.js`, `heatmap.js`, `quadrinity.js`): an in-flight guard per poller so a slow response
cannot stack timers; a sequence token so only the latest request for the current ticker may paint;
`AbortSignal.timeout` on polls; polling skipped while the tab is hidden; document-level listeners
owned by an `AbortController` that is aborted when a panel is rebuilt.

Not measured: frame rate / long-task time in the browser. The stubbed chart library used for
headless testing does no real rendering, so such numbers would be meaningless here.

## 4. Compiler flags

- `-O2` shipped. `-O3` was measured (interleaved, 5 runs): rows moved from 0.83× to 1.09× with no
  consistent direction, and the binary grew 362 → 367 KB. Not a clear win, so not adopted.
- **No `-march=native`, no `-ffast-math`**: the binary stays portable and floating-point results stay
  reproducible.
- **`-ffp-contract=off` added** to every build. It is a no-op on x86-64 (no FMA without
  `-march`), but GCC defaults to fused multiply-add on aarch64/ppc, which would change the last bits
  of the Greek/exposure maths on those machines. It is also what the golden harness is compiled with,
  so the shipped binary now matches the one that was proven.
- Debug (`make debug`: `-O0 -g3`), ASan+UBSan and TSan flavours remain available.

## 5. Things deliberately not done

- **Parallelism inside request handlers.** A request costs 30–450 µs; thread hand-off would cost a
  large fraction of that, and the handlers share one mutex-protected data set. Not beneficial.
- **Caching computed responses.** Would change when values are computed relative to the data (the code
  base deliberately recomputes "fresh each call" — see the candles comment) and is unnecessary at
  these costs.
- **Changing any engine file.** `exposure_engine.hpp` and `projection_engine.hpp` math are untouched
  (one `static_cast<std::size_t>` on an index to remove a sign-conversion warning, which cannot
  change a value).

## Backend math proof of equivalence

`make golden` (`tests/backend/golden/`):

- Builds a dump program against the tree under test with `-ffp-contract=off`, runs it under a
  **fake clock** (`LD_PRELOAD`, fixed epoch inside an OPEX week 15 min before the session rollover) so
  nothing depends on wall time, and drives the real `LiveFeedManager` loops step-by-step.
- Dumps **3 514 lines**: for every ticker × expiration selector × interval × exposure/Greek
  combination × velocity baseline (`session`, `5m`, `15m`, `1h`, `prev_close`) × projection
  parameters, both the **JSON bytes** and the underlying doubles in **hex-float (`%a`) form** — i.e. a
  bit-exact comparison, not a tolerance.
- `golden_baseline.txt` in git was generated from the **original, unoptimized** sources. Current tree:
  `IDENTICAL to baseline: digest 25283397df590ab6`. No tolerance was needed anywhere; there are no
  documented numerical deviations.
- The harness was **mutation-tested**: deliberately altering a constant / an operation order in the
  engine makes it fail, so a pass is meaningful (this was demonstrated during development).

Reproduce: `make golden` (current tree) or
`SKYLIT_TREE=/path/to/other/checkout bash tests/backend/golden/run_golden.sh`.
