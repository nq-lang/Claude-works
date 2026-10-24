# TESTING

Per Part A.7: every change (new feature, refactor, dependency bump) must be
verified in a Codespaces-equivalent environment before being considered
done — not just "it ran on my machine." This is the repeatable procedure,
and it must be re-run for every future change.

## What "Codespaces-equivalent" means here

The GitHub Codespaces default image is Ubuntu 24.04 ("noble") with g++-13
available. Our `.devcontainer/devcontainer.json` pins
`mcr.microsoft.com/devcontainers/base:ubuntu-24.04` for exactly that reason.
So the equivalence chain is:

```
GitHub Codespace  ==  container built from .devcontainer/devcontainer.json
                  ==  Ubuntu 24.04 + g++-13
                  ==  any other container/VM with the same base image
```

Two ways to get that environment for testing, in order of fidelity:

### Option 1 (highest fidelity): Rebuild the actual Codespace

1. In GitHub, create/rebuild a Codespace on the branch with your change
   ("Codespaces" tab → "..." → "Rebuild Container" if one already exists, to
   force `onCreateCommand` to run fresh rather than reuse a cached container).
2. Watch the container creation log for `scripts/setup.sh` output — it must
   reach `[setup] Setup complete.` with no `FATAL` lines.
3. Open the **Ports** tab. Port 8080 must appear automatically, labeled
   "Skylit Terminal", already forwarded (no manual "Forward a Port" click
   needed).
4. Click the forwarded URL / the auto-opened preview. The terminal shell
   should load, the header status dot should turn green ("backend: ok"), and
   the placeholder candlestick chart should render.
5. In the Codespace terminal, run `bash tests/backend/smoke_test.sh` and confirm
   `[smoke] All checks passed.`

### Option 2 (fast local check): mirror the base image in a container

Anywhere Docker is available:

```bash
docker run --rm -it -p 8080:8080 \
  -v "$(pwd)":/workspaces/skylit-heatseeker \
  -w /workspaces/skylit-heatseeker \
  mcr.microsoft.com/devcontainers/base:ubuntu-24.04 \
  bash -c "bash scripts/setup.sh && bash tests/backend/smoke_test.sh"
```

This uses the exact same base image the devcontainer specifies, without
requiring an actual GitHub Codespace, so it's suitable for quick iteration
before pushing.

### Option 3 (this repo's current verification): sandboxed build+run

This is the level this milestone was actually verified at while building in
this session — no Docker or GitHub Codespaces access was available here, so
correctness was checked directly with the same compiler/version Codespaces
ships:

```bash
g++ --version             # confirmed: 13.3.0, matches Part A.3
make clean build          # confirmed: zero warnings under -Wall -Wextra -Wpedantic
bash tests/backend/smoke_test.sh  # confirmed: all checks pass (see below)
```

This is **not** a substitute for Options 1/2 — the devcontainer.json itself
(image pull, features, onCreate/postStart hooks, Ports tab wiring) can only
be fully verified inside an actual Codespace or a container built from that
same image. Anyone continuing this build should run Option 1 (or at minimum
Option 2) before merging further changes, and update this section with the
result.

## Browser rendering: a caveat from this sandbox specifically

Everything above verifies the **backend** faithfully. The frontend
(`frontend/js/atlas.js`, `heatmap.js`) loads Lightweight Charts from
`unpkg.com` — the environment this was built in has no network egress at
all, so that CDN request 403s and the actual chart never draws a single
pixel here. That is a property of *this sandbox*, not of Codespaces, which
has normal internet access — but it means real on-screen rendering has
**not** been visually confirmed end-to-end anywhere in this repo's history
yet.

What *has* been verified, to close that gap as much as possible without
network access: `tests/e2e/lightweight_charts_stub.js` stubs the exact subset
of the Lightweight Charts API this code calls
(`createChart`/`addCandlestickSeries`/`addHistogramSeries`/price lines/
`setData`/`update`), and driving the real page against that stub via
Playwright confirmed — with zero JS errors across load, ticker switch,
interval switch, and Dark Pool/Flow toggles — that: 49 candle bars are
loaded via `setData`, Orb price lines are created (and grow correctly when
Dark Pool is toggled on) with a correctly colored/labeled King Node line,
the Flow histogram receives a bar count matching the candles, and
`series.update()` fires repeatedly over time (the tick-by-tick path). This
proves our own control flow is correct; it does **not** prove Lightweight
Charts itself renders those calls into pixels correctly.

**First thing to check in a real Codespace or any networked browser:**
load the page, open DevTools console, confirm no `LightweightCharts is not
defined` error, and confirm the candlestick chart + orb lines are actually
visible. If that ever fails in a real environment, the bug is almost
certainly in the CDN reference itself (version pin, URL) rather than in
`atlas.js`'s logic, which the stub test above already exercised.

## What `tests/backend/smoke_test.sh` checks

- `make clean build` succeeds (fresh build from scratch, catching any
  incremental-build-only breakage).
- Server starts and binds successfully.
- `GET /api/health` returns HTTP 200 with `"status":"ok"`.
- `GET /` serves `frontend/index.html`, and the body references
  `lightweight-charts` and the terminal shell (`SKYLIT`) — a coarse but
  effective regression check that the page didn't silently break.
- Path-traversal (`GET /../Makefile`) does **not** return 200 — static file
  serving stays confined to `frontend/`.
- An unknown route returns 404.
- `GET /api/heatmap` returns a King Node.
- `GET /api/quadrinity` rejects pane counts outside 2-4, and a valid
  4-ticker request returns a confluence block.

## Adding checks for future milestones

As Parts B/C/D land, extend `tests/backend/smoke_test.sh` (or add sibling scripts
under `tests/`) rather than only eyeballing the browser — in particular:

- Heatmaps (Part B): a backend unit test asserting King Node selection picks
  the highest **absolute** value regardless of sign (Part B.3's core
  invariant), and that node freshness decay reduces weight monotonically
  per touch.
- Atlas (Part C): a check that changing the expiration filter changes the
  *served* node dataset (proving per-expiration storage, not a cosmetic
  re-filter — Part C.5's explicit requirement).
- Quadrinity (Part D, renamed — see ARCHITECTURE.md §0): a check that
  confluence state is computed as N/N aligned or "no alignment" — never
  silently averaged into one blended number (Part D.2's explicit
  requirement), for pane counts 2, 3, and 4.
- Cross-cutting (Part E.1): a check that Heatmaps, Atlas's sidecar, and
  Quadrinity all route through the *same* engine module/function, not
  three separate implementations — e.g. a symbol/reference check in a test,
  or simply structural (only one class/module implements King Node logic in
  `backend/include/skylit/`).
