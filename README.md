# Claude-works — Skylit Heatseeker Terminal

A dealer-positioning trading terminal: a dependency-free **C++23 backend** (exposure / Greek /
projection engine + HTTP API) serving a static **browser frontend** (Atlas chart with Orbs,
Projections and Expiry Data windows, live heatmaps, Quadrinity multi-heatmap view).

> Market data is **synthetic** (a seeded generator stands in for a vendor feed) until a real
> feed is connected — see `docs/CHANGES.md`.

## Layout

```
backend/
  src/main.cpp                  entry point, argument parsing, API route table
  include/skylit/
    http_server.hpp             HTTP transport (thread-per-connection, timeouts, limits)
    exposure_engine.hpp         exposure / node / King-Node / confluence engine
    projection_engine.hpp       Atlas Projections engine
    live_feed.hpp               background price + exposure refresh, snapshots
    candles.hpp                 tick history -> candles, dark pool, flow
    json_serialize.hpp          JSON output
frontend/                       static web root (index.html + js/*.js)
tests/
  backend/                      engine unit tests, API smoke test, stress / sanitizer scripts
  e2e/                          Playwright browser suites + test stubs
scripts/                        setup.sh, run.sh
docs/                           ARCHITECTURE.md, TESTING.md, CHANGES.md, screenshots/
.vscode/                        tasks, launch (gdb), IntelliSense config
.devcontainer/                  Codespaces / dev container
Makefile                        g++ build driver
```

## Build and run

Requirements: **g++ >= 13** (C++23) and `make`. No other dependencies.

```bash
make            # release build -> build/skylit_server
make run        # build + start on http://127.0.0.1:8080
# or:  bash scripts/run.sh      (SKYLIT_PORT / SKYLIT_HOST override port / bind address)
```

Open <http://localhost:8080>. The port is fixed at **8080** (change with `SKYLIT_PORT=9000` or
`--port 9000`). The server binds `127.0.0.1` by default; use `SKYLIT_HOST=0.0.0.0` only inside a
container that needs it.

Other targets: `make debug`, `make asan`, `make tsan`, `make test`, `make test-e2e`,
`make test-sanitize`, `make clean` (see the Makefile header).

## Share with a friend (VS Code Live Share)

See [docs/LIVE_SHARE.md](docs/LIVE_SHARE.md).
