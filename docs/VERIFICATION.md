# Verification record

What was checked, what was found, and how each finding was confirmed. Every defect listed under
"Demonstrated" was reproduced on the **pristine original sources** (not inferred from reading code)
and re-tested on the fixed tree.

## Issues found and fixed

### Demonstrated on the original, fixed

| # | Defect (original behaviour) | Evidence | Fix |
|---|---|---|---|
| 1 | **Remote crash from one malformed request.** `Content-Length: abc` throws an uncaught `std::invalid_argument` from `stoul` → `std::terminate`. A declared 99 999 999 999-byte body also aborts the process. | Original: `terminate called … stoul`, exit 134 / -6. Fixed server answers `400` / `413` and stays up. | Validated `from_chars` parse, body cap 1 MB, 64 KB header cap. |
| 2 | **One idle client freezes everyone.** Single-threaded `accept()` → `handle_connection()` inline, no read timeout. Two Live Share viewers cannot coexist with a single stalled connection. | Original: with one idle TCP connection open, `/api/health` timed out after 6 s. Fixed: answered in 0.00 s with 3 idle + 1 half-sent request open. | Thread-per-connection with I/O timeouts, 256-connection cap (503 beyond), `poll`-based accept loop. |
| 3 | **`--port abc` aborts** (`stoi` exception, no message). `--port 99999` silently accepted. | Original: `terminate called … stoi`. Fixed: `invalid --port 'abc' (expected 1-65535)`. | `from_chars` validation, `--help`, env `SKYLIT_PORT`. |
| 4 | **Binds `0.0.0.0` unconditionally**, exposing the terminal to the whole LAN. | Code + test: fixed default is `127.0.0.1` (unreachable via the machine's LAN IP, HTTP 200 only on loopback); `SKYLIT_HOST=0.0.0.0` is opt-in. | `--host` / `SKYLIT_HOST`, validated with `inet_pton`. |
| 5 | **Frontend: request pile-up, stale-ticker flash, listener leak.** | Same browser suite on both frontends: original **6 pass / 4 fail** (2 and 3 concurrent polls on a 1.6 s link; SPY's price flashed in 9 of 89 samples after switching to SPXW; document click listeners 5 → 129 after 24 panel rebuilds). Current: **10/10**. | In-flight guards, latest-wins sequence tokens, `AbortSignal.timeout`, hidden-tab skip, `AbortController`-owned listeners. |

### Found by code inspection / static analysis, fixed (not independently demonstrated)

| # | Finding | Fix |
|---|---|---|
| 6 | `dark_pool()` / `flow()` mutate a shared RNG (`market_source_`) without a lock; two viewers' requests can race. | `market_mutex_`. ThreadSanitizer run is clean. |
| 7 | Unknown-ticker error echoed the raw query value into JSON (breaks JSON / injection). | `json::escape()`. |
| 8 | `json::escape` did not handle `\r`, `\t` or other control characters → invalid JSON. | Escapes all C0 controls (`\u00xx`). Property-tested (400 k cases). |
| 9 | No signal handling: Ctrl+C / SIGTERM killed the process with no orderly stop or exit-time leak check; no `SIGPIPE` / `MSG_NOSIGNAL` protection on writes. | Handlers + `MSG_NOSIGNAL`; graceful stop (~8 ms). **Hardening:** a connection-reset probe did not kill the original, so this is defence in depth, not a demonstrated bug. |
| 10 | Static path confinement relied on string checks. | `lexically_relative` check. **Hardening:** the original already refused `/../` and `%2e%2e` traversal in my probe, so this was not exploitable there. |
| 11 | Compiler diagnostics under `-Wall -Wextra -Wpedantic` plus an extra-strict set (`-Wlogical-op`, `-Wconversion`/sign-conversion in numeric code, missing-field-initializers). | All fixed at the root cause; no warnings are suppressed. Build is warning-free. |

### Tooling that was missing or wrong

`Makefile` made g++-only with a `check-compiler` guard (C++23 needs GCC ≥ 13) and debug / ASan /
TSan flavours with header dependency tracking; `.vscode/{tasks,launch,c_cpp_properties,settings,
extensions}.json` created and validated; `scripts/run.sh` / `setup.sh`; devcontainer wired to the
fixed port; `.gitignore`; README.

## Checks run (all on the final tree unless noted)

| Check | Command | Result |
|---|---|---|
| Release build, `-Wall -Wextra -Wpedantic`, g++ 13.3 | `make` | 0 errors, **0 warnings** |
| Extra-strict warnings (`-Wconversion -Wsign-conversion -Wshadow -Wlogical-op -Wnull-dereference …`) | ad-hoc g++ | 0 warnings |
| Engine unit tests | `make test-unit` | 224 passed |
| Candle-tail property test | (in `test-unit`) | 1 890 000 cases, 0 failures |
| JSON escape property test | (in `test-unit`) | 400 009 cases, 0 failures |
| API smoke test | `make test-smoke` | all checks pass |
| Hostile-input / concurrency / keep-alive probe | `tests/backend/api_stress.py` | all pass |
| ASan + UBSan stress | `make test-sanitize` | clean, clean exit on SIGTERM |
| TSan stress (incl. 10 s exposure thread) | `make test-sanitize` | clean |
| Math regression | `make golden` | **identical**, 3 514 lines, digest `25283397df590ab6` |
| Browser suites (7 + two-viewer) | `make test-e2e` | all pass (61 + 9 + 32 + 5 + 11 + 2 + 10 + 24 checks) |
| Soak 30 s (4 panes + 4 heatmaps + 2 API clients) + backend restart | `make test-e2e` | RSS +0.16 MB, threads 9→9, fds 10→10, DOM flat; outage reported, auto-recovery |
| Two simultaneous viewers through a latency forwarder | `tests/e2e/pw_two_viewers.py` | 24 / 24 |

## Limitations of this verification (read these)

- **No real chart pixels.** The environment has no route to `unpkg.com` and `registry.npmjs.org`
  (403 by policy; not circumvented). Browser tests therefore run against a **stub of
  lightweight-charts** that checks our own calls, not the library's rendering. The first run in a
  networked browser should confirm candles actually draw (see TESTING.md).
- **No real Live Share session.** Reproduced with a local forwarder (different port, Host header,
  added latency). The steps in `LIVE_SHARE.md` follow the documented workflow but were not driven
  through the VS Code extension.
- **VS Code verified headlessly.** The JSON configs parse, every task's command was executed from a
  shell with the same `cwd`, and the gdb launch flow was exercised with gdb in batch mode. The
  VS Code UI itself (IntelliSense squiggles, the debug toolbar) was not driven.
- **Codespaces/devcontainer** was not built (no Docker / GitHub Codespaces access here).
- **Data is synthetic** (seeded generator), so the math is verified for self-consistency and
  bit-for-bit non-regression, not against a market data vendor.
- **Linux/x86-64 only** was executed. macOS/Windows paths are configured but unbuilt here.
