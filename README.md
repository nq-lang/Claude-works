Skylit Heatseeker Terminal

dealer-positioning trading terminal: a dependency-free **C++23 backend**.

projection engine + HTTP API) serving a static **browser frontend** (Atlas chart with Orbs,

Projections and Expiry Data windows, live heatmaps, Quadrinity multi-heatmap view).

> Market data is **synthetic** (a seeded generator stands in for a vendor feed) until a real > feed is connected — see `docs/CHANGES.md`.

##
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
`make test-sanitize`, `make golden` (backend-math regression check), `make bench`, `make clean`
(see the Makefile header). `make test-e2e` needs `pip install playwright` and a Chromium.

VS Code: **Ctrl/Cmd+Shift+B** builds; *Terminal → Run Task…* has run/test tasks; *Run and Debug*
has gdb launch configs (`.vscode/`).

## Share with a friend (VS Code Live Share)

1. `make run` (serves on fixed port **8080**, bound to `127.0.0.1` — what Live Share forwards).
2. Click **Live Share** in the status bar; the invite link is copied — send it to your friend.
3. Live Share view → **Shared Servers → Share Server…** → enter `8080`.
4. Your friend joins via the link and opens `http://localhost:8080` in their browser.

Full guide, troubleshooting and security notes: [docs/LIVE_SHARE.md](docs/LIVE_SHARE.md).

## Documentation

| Doc | Contents |
|---|---|
| [docs/LIVE_SHARE.md](d
