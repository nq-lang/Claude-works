> **Note (repository layout):** the code now lives in `backend/` (C++), `frontend/` (static
> web root), `tests/`, `scripts/` and `docs/`; paths below were updated accordingly. Where this
> historical design log describes planned modules that were never created as separate files
> (e.g. `expiration_store.hpp`), the implementation lives in `backend/include/skylit/`.
> See the top-level README for the authoritative layout.

# ARCHITECTURE

Status: **Part A complete**, Part E.1 (shared exposure engine) in progress.
Heatmaps (Part B), Atlas features (Part C), and Quadrinity (Part D,
renamed/expanded — see §0) are not yet implemented; this document will grow
with each milestone.

## 0. Spec amendments (post-original-task-doc)

The following were given directly by the product owner after the original
`Skylit-Heatseeker-Rebuild-Task.md` was written, and supersede/extend it:

1. **Trinity Mode → "Quadrinity."** Renamed throughout. Now supports a
   **4th instrument, NVDA**, alongside SPXW/SPY/QQQ. The pane-count control
   changes from a fixed 3 to a **selectable range of 2–4** panes, with
   selectable ticker-per-pane (not hardcoded to the SPX/SPY/QQQ trio).
   Confluence logic (Part D.2/D.3) must generalize from "3/3 aligned" to
   "N/N aligned" for whatever N panes are currently active.
2. **Live data cadence:** candlestick/price data must update **tick-by-tick**;
   options/exposure data (GEX/VEX, nodes) must refresh **at least once per
   minute**, continuously — not on-demand/on-load only. This is the concrete
   requirement behind Part E.3's "high-frequency live updates" and pushes us
   toward WebSocket streaming sooner rather than later (see §2 dependency
   policy amendment below).
3. **Flow/tape print color hierarchy** (large-print / unusual-activity
   highlighting, distinct from the Pika/Barney node color system in Part
   B.3): this governs individual trade prints in Flow Bucket / tape views,
   not the heatmap nodes themselves.
   - **Size > Open Interest** (large block relative to existing OI): highest
     visual weight — bright yellow / orange / saturated red.
   - **Volume > Open Interest** (elevated activity, below block-size
     threshold): medium weight — purple / magenta / saturated blue.
   - **Routine/default prints**: intentionally dim — white / off-white /
     dark gray, so they don't compete for attention.
   - This is a second, independent color system from Pika/Barney (which
     encodes gamma sign + magnitude on the heatmap). Implementation must
     keep them visually and logically distinct — a purple flow print
     (volume > OI) is not the same signal as a purple Barney node
     (negative gamma), and both existing side-by-side (flow overlay on
     Atlas + heatmap sidecar) must not be visually confusable.

These are captured here so later contributors don't need to reconcile the
original task doc against verbal/chat instructions by hand.

3. **Reference visual target.** A reference HTML mockup + screenshots were
   provided showing the intended color scaling and panel layout precisely.
   Key takeaways encoded into `frontend/js/colorscale.js` and `frontend/js/heatmap.js`:
   - The Pika/Barney color system (Part B.3) is implemented as **one
     continuous diverging gradient** — deep purple (heaviest negative) →
     blue → teal (near zero) → green → bright yellow (heaviest positive) —
     rather than two independently-toggled palettes. This still satisfies
     Part B.3's core invariant (absolute magnitude drives intensity, sign
     only picks which half of the gradient), it's just expressed as a
     single interpolated scale instead of a hard split.
   - Each board is normalized against **its own** max |exposure| — never a
     shared/global constant across tickers, since SPXW/SPY/QQQ/NVDA have
     very different notional scales.
   - King Node gets a gold marker + full-row highlight; current spot gets a
     white "pill" overlay on its row; panel footer shows session min/max
     exposure plus a gradient-bar legend.
   - This color-scale function is shared (`SkylitColorScale` global) so
     Heatmaps, Quadrinity, and the Atlas sidecar render identically —
     mirrors the Part E.1 "one engine" rule at the render layer.
4. **IBKR data note:** a live IBKR API connection was mentioned as a near-
   future addition, once "a large majority of important optimizations" are
   done first. Nothing IBKR-specific has been built. The engine's
   `SyntheticExposureSource` (see `exposure_engine.hpp`) remains the only
   data source; wiring a real feed later means implementing a new source
   behind the same `LiveFeedManager` seams — see §2/§5 below.

## 1. Why a C++23 backend + browser frontend split

The spec (Part A.6) mandates Lightweight Charts™ (a JS/TS browser library)
for all price rendering, and C++23 for the terminal itself. Those two
requirements only fit together one way:

```
┌─────────────────────────────┐        HTTP (static assets, JSON API)
│  C++23 backend               │◄──────────────────────────────┐
│  (backend/)                  │                                │
│                               │        WebSocket (future:      │
│  - HTTP server (transport)   │         live ticks, node        │
│  - exposure/node engine      │         reshuffles — Part E.3)  │
│    (future, Part E.1)        │───────────────────────────────►│
│  - JSON API routes           │                          ┌──────┴──────┐
└───────────────────────────────┘                         │  Browser     │
                                                            │  (frontend/)│
                                                            │  - HTML/CSS │
                                                            │  - Lightweight
                                                            │    Charts   │
                                                            │  - Heatmap/ │
                                                            │    Trinity  │
                                                            │    canvas   │
                                                            │    rendering│
                                                            └─────────────┘
```

**Backend (C++23) owns:** exposure/node computation (Part E.1's single
shared engine), King Node / Gatekeeper / air-pocket / freshness-decay /
rate-of-change logic, per-expiration data storage (Part E.2), layout
persistence, and everything that must be correct and shared across
Heatmaps, Atlas's sidecar, and Trinity Mode. This is where "one engine, three
UI surfaces" (Part E.1) is enforced — it's a backend module boundary, not a
UI convention, precisely so it can't drift into three divergent
implementations.

**Frontend (browser) owns:** rendering only — Lightweight Charts for
candles/overlays, custom canvas/SVG for the heatmap "orb" nodes and Trinity's
three-panel layout, and UI state (toolbar selections, layout switching).
It talks to the backend exclusively over HTTP (initial load, layout
CRUD, filter changes) and, starting when live-update work begins, a
WebSocket stream for push updates (Part E.3) rather than polling.

This split is also why "Part A skeleton" is meaningful as an intermediate
milestone on its own: it proves the transport (HTTP serving + a JSON route)
and the render path (Lightweight Charts drawing inside the served page)
independently of any real trading logic, so later milestones can be judged
against a known-good baseline instead of debugging both layers at once.

## 2. Dependency policy — zero external C++ dependencies (for now)

Part A.4 requires every dependency to be identified, pinned, and
auto-installed with no manual Codespace step. The current backend
(`backend/include/skylit/http_server.hpp`) is deliberately written against **POSIX
sockets and the C++23 standard library only** — no Boost.Asio, no
cpp-httplib, no vcpkg/Conan manifest.

Why:

- **Nothing to fetch.** A fresh Codespace build failing because a package
  mirror had a bad day (this happened during this build's own network
  sandboxing — see below) is exactly the class of environment-specific
  breakage Part A.7 asks us to guard against. Zero dependencies means zero
  surface area for that failure mode.
- **Nothing to pin/drift.** No lockfile, no "works on my machine because I
  had a newer Boost."
- **The surface area we need right now is small.** Part A only requires
  serving one static page and proving a JSON round-trip. A hand-rolled
  ~300-line HTTP server handles that, with a basic path-traversal guard,
  cleanly under `-std=c++23 -Wall -Wextra -Wpedantic` with zero warnings.

This is explicitly **not** a permanent stance. It will be revisited when:

- **WebSocket streaming** (Part E.3) is implemented — hand-rolling a
  spec-compliant WebSocket server (framing, ping/pong, close handshake) is a
  much larger undertaking than HTTP, so a header-only WS library is likely
  at that point. Candidate: a single-header WebSocket implementation vendored
  directly into `backend/include/skylit/` (checked into the repo, not fetched at
  build time) so the "no network fetch during build" property survives.
- **JSON payloads grow past hand-written string formatting** — the
  `/api/health` route returns a hand-written JSON literal, which is fine for
  one field. Once Part B's node/King-Node payloads exist, a real JSON
  library becomes worth the dependency cost. Candidate: nlohmann/json,
  vendored as a single header for the same reason as above.

Any dependency added later will be recorded here with: what it's for, why
it was chosen over alternatives, and how it's pinned (vendored header vs.
package manager, with an exact version/commit).

**Current dependency table:**

| Dependency | Version | Why |
|---|---|---|
| g++-13 | 13.3.0 (Ubuntu 24.04 default) | Pinned compiler per Part A.3 |
| POSIX sockets (libc) | system | HTTP transport, always present, no install step |
| Lightweight Charts™ | 4.1.3, loaded from unpkg CDN in `frontend/index.html` | Mandated by Part A.6; a *browser*-side dependency, not a build-time C++ one — loaded by the client at runtime, so it does not affect Codespace build reliability. Pinned to an exact version (not `@latest`) so the rendered chart doesn't silently change behavior on a cache miss. |

No `package.json`/npm build step exists yet because the frontend is currently
a single static HTML file. If/when the frontend grows into multiple
JS/TS modules (state management for layouts, the heatmap canvas renderer,
etc.), this section will document the build step added for that and how it
plugs into `scripts/setup.sh`.

## 3. Repository layout

```
.devcontainer/devcontainer.json   Codespaces image, port forwarding, onCreate/postStart hooks
Makefile                          Build driver (no cmake — see §2 for why)
scripts/setup.sh                  Verifies g++ >= 13 + -std=c++23, builds (onCreateCommand)
scripts/run.sh                    Starts the server, foreground or background (postStartCommand)
backend/src/main.cpp                      Backend entry point, route registration
backend/include/skylit/http_server.hpp    Transport layer: HTTP parsing, static serving, routing
frontend/index.html                    Frontend shell: terminal chrome + blank Atlas chart
tests/backend/smoke_test.sh               Repeatable build+run+curl smoke test (Part A.7)
ARCHITECTURE.md                   This file
TESTING.md                        Codespaces-equivalent test procedure
```

As Parts B/C/D land, expect:

- `backend/include/skylit/exposure_engine.hpp` (+ `.cpp`) — the shared node/King-Node/
  Gatekeeper/decay/rate-of-change engine (Part E.1), consumed by all three UI
  surfaces' route handlers.
- `backend/include/skylit/expiration_store.hpp` — per-expiration-bucket data model
  (Part E.2 / C.5), backing near-DTE vs. further-DTE separation.
- `frontend/js/heatmap.js`, `frontend/js/quadrinity.js`, `frontend/js/atlas.js` — frontend
  rendering modules, added once there's real data to render instead of
  placeholders.

## 4. Port forwarding (Codespaces "Ports" tab)

`.devcontainer/devcontainer.json` declares `forwardPorts: [8080]` and labels
it "Skylit Terminal" via `portsAttributes`, and `postStartCommand` launches
`scripts/run.sh --background`, which binds `SKYLIT_HOST:8080` and detaches so the
lifecycle hook can return. The binary's own default bind address is `127.0.0.1`
(nothing else on the machine/LAN can reach it, and VS Code Live Share and
Codespaces both forward localhost ports); the devcontainer sets
`SKYLIT_HOST=0.0.0.0` via `containerEnv` because inside the container the
forwarder connects over the container network. This means a fresh Codespace should show port 8080
already forwarded and labeled in the Ports tab with no manual "Forward a
Port" step, per Part A.5.

## 5. Known simplifications in this milestone (to be resolved in later parts)

- ~~The HTTP server handled one request per connection on a single thread.~~
  **Superseded (verification pass):** each connection now gets its own short-lived
  thread (bounded at 256), with per-socket I/O timeouts and a 10 s request
  deadline, so an idle or slow client can no longer stall everyone else — required
  once two Live Share viewers use the terminal together. The frontend still polls
  over HTTP (no WebSocket yet).
- `/api/health` returns a hand-written JSON string. No real JSON
  (de)serialization exists yet — see dependency policy above.
- The Atlas chart shows deterministic placeholder candle data generated in
  the browser, not real price data. There is no market-data ingestion of any
  kind yet.
- `backend/include/skylit/exposure_engine.hpp`, `json_serialize.hpp`, and
  `live_feed.hpp` now implement Part E.1's shared engine (King Node /
  Gatekeeper / Hedge Node role assignment, air pockets, OPEX-week, N-way
  confluence) and back two live routes: `GET /api/heatmap` (Part B) and
  `GET /api/quadrinity` (Part D, renamed — see §0). `frontend/js/heatmap.js`
  renders the Heatmap sidecar against `/api/heatmap`; the same factory
  function is intended to be reused for Quadrinity's 2-4 panes next.
- Hedge Node classification is distance-from-spot relative to the board's
  own strike span, with a minimum-magnitude floor — an earlier version
  compared distance against the (often tiny) King-to-spot gap and
  misclassified nearly every node as a Hedge Node; fixed and re-verified
  visually via a Playwright screenshot before considering this correct.
- VEX and GEX+VEX views are currently a placeholder damped-fraction
  derivative of the single synthetic exposure series (`main.cpp`,
  `apply_exposure_type`), not independently modeled vanna. Flagged in code;
  will need real per-Greek data once a live feed exists.
- Quadrinity (Part D, renamed — ARCHITECTURE.md §0) is now built:
  `frontend/js/quadrinity.js` reuses `createHeatmapPanel` unmodified per pane
  (with a new `hideControls`/`onBoard`/`setExposureType`/`setNodeLimit`
  extension to `heatmap.js` so panes can be driven externally by one shared
  toolbar instead of each pane's own controls) — 2/3/4-pane switching,
  add/remove pane, per-pane ticker swap, and a confluence banner
  (N/N-aligned state, majority read, outlier tickers) all confirmed working
  via Playwright screenshots at 2, 3, and 4 panes with SPXW/SPY/QQQ/NVDA.
- **Real bug found and fixed this milestone**: `HttpServer` never
  URL-decoded query strings. This silently broke two things that had
  earlier been reported as "verified working": the Atlas `GEX+VEX` toggle
  (browser sends `GEX%2BVEX`; the backend's literal string compare against
  `"GEX+VEX"` always failed, so it silently fell back to plain GEX every
  time) and — caught before ever shipping — Quadrinity's comma-joined
  ticker list (`tickers=SPXW%2CSPY%2CQQQ`) would have failed to parse past
  the first ticker. Fixed with a `url_decode` helper in
  `http_server.hpp`, applied once to the query string during request
  parsing so every route benefits automatically. Verified via direct curl
  (GEX vs GEX+VEX now return genuinely different exposure series;
  3-ticker encoded Quadrinity request now returns all 3 tickers) and
  added as permanent regression checks in `tests/backend/smoke_test.sh`. This is
  a good example of why "no console errors" alone isn't sufficient
  verification — the bug produced a *plausible-looking wrong answer*
  (silently defaulting to GEX) rather than a crash, which is why it went
  undetected in the Atlas milestone's stub-based JS testing (the stub
  never exercised the real backend's string parsing).
- Still not built: Atlas's Projections, pane-layout persistence (2-4 grid
  switching with saved configs), drawing tools, and Replay mode; Quadrinity
  currently drives all panes off one shared exposure/node-filter setting
  (by design, so confluence and the panes can't silently disagree — see
  the file header comment in `quadrinity.js`) rather than per-pane
  independent settings.
- Fixed a scroll-reset bug in `heatmap.js` (used by both the Heatmap
  sidecar and every Quadrinity pane): the row list was fully rebuilt on
  every ~2s poll, which reset `scrollTop` to 0 each time — meaning a user
  could never actually scroll through the strike list, it would snap back
  within 2 seconds. Fixed by preserving `scrollTop` across re-renders and
  only auto-centering on the current spot on a panel's first render (and
  again after a ticker switch, since re-centering on the new symbol's spot
  is the right behavior there). Verified with Playwright: scrollTop holds
  exactly across a full poll cycle when given an in-range target, and a
  panel auto-centers on load rather than defaulting to the top of the list.- Atlas "don't yank the view" (this feature): `atlas.js` now tracks whether
  the user has manually interacted with the chart (mousedown/wheel/
  touchstart on the chart container). Once they have, `pollLatestCandles`
  snapshots the visible logical range before calling `series.update()` and
  restores it after, so tick-by-tick candle/orb updates never move the
  user's view. A "● Live" / "⏸ Jump to Live" toolbar button shows tracking
  state and lets the user explicitly resume (`scrollToRealTime()`). A
  ticker/timeframe switch (`loadCandles`) intentionally resets tracking —
  the old scroll position has no meaning on a different series, so
  snapping to the new series' latest data on a full reload is correct.
  Verified with the Lightweight Charts stub (extended with a working
  `getVisibleLogicalRange`/`setVisibleLogicalRange`/`scrollToRealTime`):
  simulated a user pan, confirmed the visible range survives 2+ full
  candle-poll cycles unchanged, then confirmed "Jump to Live" calls
  `scrollToRealTime()` exactly once and resets the button state.
- Session-change badges (this feature): green/red % badges on each
  strike showing how much dealer position SIZE at that strike has grown
  or shrunk since the start of the current trading-session window ("day"
  09:30-16:00, "overnight" 18:00-09:30 — the 16:00-18:00 gap folds into
  "overnight"). Backend: `LiveFeedManager` now tracks a per-ticker
  exposure baseline (`session_baseline_`), re-seeded whenever
  `session_label_for()` detects the session has rolled over (checked once
  per exposure-refresh tick, so up to ~60s of lag on a rollover — same
  cadence as exposure refresh generally). New `Node::session_change_pct`
  field, populated in `apply_session_change_pct()` and serialized in
  `json_serialize.hpp`.
  **Sign semantics, and a bug caught before shipping**: this is a
  MAGNITUDE change (did the position at this strike grow or shrink),
  not a signed-value change. A Barney (negative-exposure) node moving
  from -466K toward -445K has SHRUNK (dealers covered some short gamma) —
  that must read as a red/decreasing badge, even though the raw signed
  value went up. An initial implementation used
  `(current - baseline)/|baseline|` (a signed-value delta), which gets
  exactly this case backwards. Caught with a standalone before/after
  check against `SyntheticExposureSource` output prior to wiring the
  frontend, and fixed to
  `(|current| - |baseline|)/|baseline|` (magnitude-of-magnitude). Known
  remaining edge case, not specially handled: a strike flipping sides
  entirely (Pika -> Barney) still reports as a magnitude-shrink rather
  than a distinct "flipped" state — the spec frames badges around
  size growing/shrinking, not a separate flip indicator.
  Frontend: an opt-in "Badges" toggle (default off) in both the Heatmap
  sidecar's own controls and Quadrinity's shared toolbar (driving all
  panes via a new `setShowBadges` handle method, same pattern as
  `setExposureType`/`setNodeLimit`); badges only render above a 1%
  threshold to match the reference's sparse look rather than showing a
  ±0.3% badge on every row. Verified by mocking the `/api/heatmap`
  response with known percentages (since the real 60s exposure-refresh
  cadence made waiting for organic values impractical to verify quickly)
  and confirming +12.5%/-8.2%/-45.0% rendered as `+13%` (green) /
  `-8%` (red) / `-45%` (red) respectively, with the sub-threshold 0.3%
  node correctly showing no badge.
- Spot-price highlighting: reviewed and confirmed already correct — the
  white-pill "current" row marker (`nearestStrikeIndex` against live
  `board.spot`) recomputes on every poll and was unaffected by the scroll
  or badge changes above; no code change was needed there.
- Atlas core overlays milestone: `backend/include/skylit/candles.hpp` adds tick-
  history aggregation into OHLC bars (`aggregate_candles`), a synthetic
  dark-pool level generator, and a synthetic flow-bar generator, all
  wired into `LiveFeedManager` and four new routes (`/api/candles`,
  `/api/candles/latest`, `/api/darkpool`, `/api/flow`). `frontend/js/atlas.js`
  is the frontend controller: real ticker/timeframe switching, an Orbs
  overlay (candlestick price lines) reusing the exact same
  `SkylitColorScale`/`SkylitNodeUtils` modules as the Heatmap sidecar
  (extracted to `frontend/js/nodeutils.js` for that reason), Dark Pool level
  lines (deliberately distinct styling — dashed gray-blue, no color-scale
  coupling — so they're never confused with exposure nodes), and a Flow
  histogram in its own price scale. Tick-by-tick updates use
  `series.update()` against a cheap `/api/candles/latest` poll (1s
  cadence) rather than re-fetching/redrawing the whole history each tick.
  **Verified**: since this sandbox has no network egress, the real
  `unpkg.com` Lightweight Charts CDN load could not be exercised here — a
  first attempt at screenshotting the live page showed a blank chart pane
  because of exactly that (a real `pageerror: LightweightCharts is not
  defined` from the blocked CDN request, not a bug in this code). To
  verify the code itself, `tests/e2e/lightweight_charts_stub.js` stubs the
  small subset of the Lightweight Charts API this code touches
  (`createChart`/`addCandlestickSeries`/`addHistogramSeries`/price
  lines/`setData`/`update`), and a Playwright run against that stub
  confirmed: 49 candle bars loaded via `setData`, 41+ Orb price lines
  created (growing correctly when Dark Pool is toggled on), a correctly
  colored/labeled King Node price line, the Flow histogram receiving a
  bar count matching the candles, `series.update()` firing repeatedly
  over time (tick-by-tick), and the node-count filter changing the
  price-line set on selection — all with zero JS errors across load,
  ticker switch, interval switch, and toggle interactions. What remains
  unverified in this sandbox specifically is Lightweight Charts' own
  rendering (pixels on screen) — see TESTING.md for what to check first
  in an actual (networked) Codespace.

## 6. Expiration data-scope, Orb settings, node highlighting, multi-window Atlas

This session's milestone, addressing a batch of gaps identified against
real product screenshots (Trinity-style multi-pane layouts, DOM ladder
mockups, the pane-layout picker modal):

**Expiration data-scope (the real bug underlying several complaints).**
`LiveFeedManager` now generates 11 independent expiration buckets per
ticker ("0dte" plus "next1".."next10"), each with its own King strike and
magnitude distribution. `GET /api/heatmap` and `GET /api/quadrinity` both
accept `expiration=0dte` (default) or `expiration=current+N` (N=1-10),
which aggregates real per-bucket data via the existing
`ExpirationStore::aggregate()` — this is a genuine data-scope change, not
a client-side re-filter: verified by curl that switching from 0DTE to
Current+5/Current+10 shifts the King strike (571 -> 568 -> 567) and every
node's exposure value, not just a relabeling. `apply_exposure_type`'s
scalar-multiple property (GEX/VEX/GEX+VEX are linear rescalings of the
same series — see §2) still holds after aggregation since summation
commutes with scalar multiplication, so exposure-type and expiration-scope
compose correctly without special-casing. Regression check added to
`tests/backend/smoke_test.sh`. Spot price and price ticks stay ticker-wide (one
random walk, propagated to every bucket) since the underlying is a single
instrument; only each bucket's *exposure* evolves independently
(`exposure_loop` now iterates every bucket, not just one). **Known
simplification**: session-change badges still track only the "0dte"
bucket's baseline regardless of which scope is being viewed — extending
badges to a per-scope baseline was deferred rather than silently
mismatched; flagged in code (`live_feed.hpp`'s constructor comment).

**Node-count options** changed from the earlier ad hoc 0/3/5/10 ("All"/Top
3/Top 5/Top 10) to the specified discrete 5/10/15/20/25/30, consistently
across the Heatmap sidecar, Atlas's Orbs, and Quadrinity's shared toolbar
(default 10 everywhere, replacing the old "show everything" default).

**"Highlight nodes only" toggle** (`heatmap.js`): dims every row that
isn't King/Gatekeeper/Hedge via a new `dimColor()` helper that scales RGB
toward black by a fixed factor WITHOUT changing hue — a dimmed positive
node still reads unambiguously as "positive, just less prominent," per the
reference screenshot's "strikes that are not nodes should still have their
color, just lower brightness" requirement. Verified via Playwright:
non-node rows render at ~28% of their un-dimmed RGB values while the King
row stays at full color.

**Orb size/opacity sliders** (`atlas.js`): two range inputs next to the
Orbs toggle, wired to `colorscale.js`'s new `exposureToColorWithOpacity()`
(returns an `rgba()` string) and to price-line `lineWidth` scaling.
Verified the resulting price-line color string carries the requested
alpha exactly (`rgba(31,101,143,0.4)` for an 0.4 opacity setting).

**Atlas multi-window layout** (`atlas-layout.js`, new): a pane-layout
picker modal matching the reference screenshot's exact 6 options (Single,
2-Up, 2-Stack, 3-Up, 3-Stack, 4-Up) with the same title/subtitle copy and
per-option icon+description, plus a "Window Settings" gear panel listing
each open window with its own ticker dropdown. Each pane is a full
`createAtlasController` instance — the SAME controller function
instantiated 1-4 times in a CSS grid, not a forked implementation,
mirroring the precedent Quadrinity set for heatmap panels. To avoid four
copies of Atlas's large toolbar cramming into quarter-height panes,
`atlas.js` gained a `minimalToolbar` option (ticker + interval + Live
button only; always renders the FULL toolbar markup and hides the rest via
a `.atlas-toolbar-minimal` CSS class, rather than conditionally omitting
DOM nodes and having to null-guard every event listener) — only the
primary/first pane shows the full Orbs/Dark Pool/Flow/expiration/node-
limit control set. Verified via Playwright: cycling through all 6 layouts
produces the exact expected pane count (1/2/2/3/3/4) with zero JS errors
each time, including the destroy-and-rebuild that happens on every switch;
confirmed the Window Settings panel's per-pane ticker dropdown correctly
drives that specific pane's own `createAtlasController` instance via the
newly-exposed `setTicker`/`setInterval`/`getTicker` handle methods.

**Known simplification, stated rather than silently dropped**: the
reference product screenshots also show ASYMMETRIC multi-pane arrangements
(e.g. "3 windows: two small stacked charts + one larger chart to the
left") produced by manually dragging pane boundaries after picking a
layout. That drag-to-resize interaction is a materially larger, separate
feature from "pick one of N named layouts," and the layout picker's own
descriptions are explicit about equal panes (e.g. "3-Up: three EQUAL
comparison charts") — so equal-split grids is what was built and verified
this round; freeform pane resizing is not implemented.

## 7. Atlas toolbar correction: single global control surface

This session's milestone corrected a real architectural bug and
restructured Atlas's controls per explicit reference-matched feedback.

**The bug**: node count (and every other Atlas setting) was previously
per-pane state on each `createAtlasController` instance, with no
synchronization mechanism — selecting "Top 5" in one pane's toolbar did
nothing to the other panes in a multi-window layout, contradicting "the
main node number picked is what will be displayed on the charts
visually" (singular intent, plural charts). Fixed by making `atlas.js`
fully externally-driven: it renders NO control UI beyond a minimal
on-chart header (ticker selector + live price + intraday %-change,
computed from the loaded candle series' first-bar-open vs latest-close —
exactly the three elements specified, nothing else). Every other setting
— interval, exposure type, expiration scope, node count, Orbs on/off,
Dark Pool, Flow, Live/resume — is driven by ONE global toolbar in
`atlas-layout.js` through setter methods (`setInterval`, `setExposureType`,
`setExpiration`, `setNodeLimit`, `setShowOrbs`, `setOrbSize`,
`setOrbOpacity`, `setShowDarkPool`, `setShowFlow`, `resumeLive`) on each
pane's controller handle. There is now exactly one source of truth per
setting, applied uniformly to every open pane — verified with Playwright:
changing Nodes from the global toolbar produced a fresh `loadOrbs()` call
on all 4 panes of a 4-Up layout simultaneously (confirmed via price-line
creation-call growth on every pane, not just one).

**Expiration labels** renamed from "0DTE" to "Current" (keeping
"Current + Next N" for the aggregated scope) across the Heatmap sidecar,
Quadrinity, and Atlas's global toolbar, matching the reference screenshot
exactly. The backend's internal bucket name (`"0dte"`) is unchanged — this
was a display-label-only rename.

**Orbs settings**: replaced the always-visible inline sliders with a gear
icon next to the Orbs toggle that opens a popover (Size + Opacity sliders,
Save/Reset buttons). Deliberately DRAFT-then-commit semantics, unlike
every other global-toolbar control (which applies immediately): dragging
a slider updates a local draft value and its displayed number only —
panes are untouched until "Save" is clicked, and "Reset" reverts both the
draft and the applied value to defaults (size 1.0x, opacity 85%).
Verified via Playwright: an orb's rendered `rgba()` color was provably
unchanged while dragging without saving, changed only after clicking
Save, and correctly reverted after Reset.

**Quadrinity moved into Atlas's sidecar**, not a separate destination.
`atlas-sidecar.js` (new) toggles the existing sidecar area between a
single full-featured Heatmap panel (default) and a vertically-STACKED 2-4
pane "Quadrinity" mode (a settings gear picks the count), reusing
`createHeatmapPanel` for every panel in both modes — no forked rendering.
This is a deliberately separate, simpler controller from `quadrinity.js`'s
own full-page view rather than reusing that file's grid directly: that
grid lays panes out SIDE BY SIDE for a full-width page, while the sidecar
is a narrow column where multiple heatmap ladders need to stack
vertically to stay legible. The full-page "QUADRINITY" tab (§0/§6) is
unchanged and still exists independently — this adds a second, sidecar-
scoped way to view multiple heatmaps without leaving Atlas. Verified via
Playwright: toggling on produces 2 stacked panels by default, the gear
correctly resizes to 4, and toggling off cleanly restores the single-panel
view — zero errors through the full cycle.

## 8. Atlas sidecar corrected to horizontal, resizable divider, drawing tools

**Correction: Atlas sidecar heatmaps now lay out HORIZONTALLY.** An
earlier revision (§7) stacked Quadrinity-mode sidecar panels vertically,
which was wrong on two counts: it contradicted the reference screenshots/
HTML (which show heatmap panels as full-height columns side by side), and
it gave each panel materially less room to show its data (a short, narrow
box vs. a full-height column). `atlas-sidecar.js`'s `renderMulti()`
(renamed from `renderStacked()`) now uses `flex-direction: row`, matching
Quadrinity's own full-page layout direction. Verified via Playwright by
reading each panel's `getBoundingClientRect().left` and confirming
strictly increasing offsets (side-by-side), not stacked vertically.

**New: resizable divider.** A thin draggable line (`#atlas-resizer`,
brightens to solid white on hover/drag) sits between the chart-pane area
and the sidecar, letting the user reallocate horizontal space between them
by dragging. Verified precisely via Playwright mouse drag: dragging the
divider 150px left grew the sidecar by exactly 150px. The sidecar also
auto-sizes its default width to the current heatmap pane count (scaling
with N so 4 panels aren't crammed into a 300px column the moment they
appear) via a new `onPaneCountChange` callback from `atlas-sidecar.js` —
the divider still lets the user override that at any time afterward.
Verified working identically across every explicitly-requested
combination of chart-pane count (Atlas layout: 1/2/3/4) and heatmap-pane
count (sidecar Quadrinity mode: 1/2/3/4) — 1+1, 2+2, 1+2, 3+3, 4+4 — with
zero errors across the full sequence of transitions between them, since
the resizer only ever touches `#sidecar`'s own width and is otherwise
fully decoupled from both pane-count settings.

**New: drawing tools** (`atlas-drawing.js`). Lightweight Charts (the
library this project uses) ships no drawing-tools API itself, so this is
a small canvas overlay built directly against the coordinate-conversion
methods LWC v4 does expose (`series.priceToCoordinate`/
`coordinateToPrice`, `chart.timeScale().timeToCoordinate`/
`coordinateToTime`) — no external drawing library, per the zero-
dependency policy (§2). Trend Line, Horizontal Line, Rectangle, Cursor
(pass-through), and Clear All, presented as a vertical icon strip docked
to each chart pane's own top-left corner — deliberately NOT in the pane
header (restricted to ticker+price+change, §7) or the global toolbar
(cross-pane settings) since a drawing is an annotation on one specific
chart, so each pane gets independent tool state. The canvas's
`pointer-events` toggles between `none` (Cursor tool — clicks/drags pass
through to the chart underneath for normal pan/zoom) and `auto` (any
drawing tool active). Drawings are stored as `{type, p1:{time,price},
p2:{time,price}}` and re-projected to pixel coordinates on every redraw
(triggered by `ResizeObserver` and
`chart.timeScale().subscribeVisibleTimeRangeChange`), so they stay
anchored to the correct time/price rather than drifting as the chart
pans or zooms. Verified via Playwright: drawing a trend line and a
rectangle both completed with zero errors, the Cursor tool correctly set
`pointer-events: none` on the overlay canvas, and Clear All ran cleanly;
visually confirmed via screenshot that two independently-drawn shapes
(a horizontal line and a trend line) both persist correctly on screen
simultaneously.

**Test-infrastructure note**: `atlas.js` now unconditionally creates a
drawing layer for every pane, which meant `tests/e2e/lightweight_charts_stub.js`
needed new stub methods (`priceToCoordinate`/`coordinateToPrice` on
series, `timeToCoordinate`/`coordinateToTime`/
`subscribeVisibleTimeRangeChange` on the time scale) before ANY existing
Playwright test could pass again — every prior test would have started
throwing the moment this feature landed, without that stub extension.
Caught immediately by re-running the full test suite first rather than
assuming the new feature was isolated from the old ones.

## 9. Drawing tool persistence + Long/Short position tools

Tool set corrected to the explicit, authoritative list: Rectangle,
Horizontal Line, Short Position, Long Position (plus Cursor, the
non-drawing pass-through mode — necessary for normal pan/zoom, not itself
a "drawing tool"). The earlier Trend Line tool was dropped since it wasn't
part of this restated list.

**Persistence** (`atlas-drawing.js`): drawings are now scoped PER TICKER,
not per pane — switching a pane's ticker swaps in that ticker's own
drawing set via a new `setActiveTicker()` method, called from both of
`atlas.js`'s ticker-change paths (the pane's own dropdown, and the
external `setTicker()` used by the Window Settings panel). Switching
TIMEFRAME deliberately does NOT clear drawings, since they're anchored to
real Unix timestamps via LWC's coordinate conversion, not bar indices —
they still project to sensible positions under different bar spacing.
Also persisted to `localStorage` (`skylit:drawings:<TICKER>`, wrapped in
try/catch for private-browsing/quota safety) so drawings survive a page
reload. Verified end-to-end: drew a rectangle on SPY, switched to QQQ
(confirmed QQQ's storage key was empty — no bleed-through), switched back
to SPY (confirmed the rectangle was still there); in a 4-pane layout,
drew a Short position on pane 1 (SPY) only and confirmed the other three
panes' tickers (SPXW/QQQ/NVDA) had no stored drawings at all — proving the
per-ticker scoping is real, not just per-pane-instance memory.

**Long/Short Position tools**: a single drag from entry (mousedown) to a
reward-defining point (mouseup). The drag's price distance sets the
take-profit distance; stop-loss defaults to half that distance (a 2:1
reward:risk default — not hardcoded to a trivial 1:1, since both levels
are independently computed and displayed). Renders a green profit zone
and red loss zone on the correct side of a dashed entry line for the
selected direction, plus a stats label showing exact entry/TP/SP prices,
signed point distances for both, and the computed R:R ratio — this is the
literal "display how many points are set for stop loss / take profit"
ask. Verified the math directly: a controlled drag (entry price 100,
target price 50) produced exactly TP=150, SL=75, R:R=1:2.00, matching the
formula by hand.

**Per-pane independence, re-confirmed**: with 4 simultaneous chart panes,
there are 4 independent drawing strips and 4 independent canvases — a
drawing on one pane's chart cannot appear on or affect any other pane,
verified both by DOM element count and by inspecting each pane's distinct
localStorage key after drawing on only one.

**Note on the test stub**: `tests/e2e/lightweight_charts_stub.js` uses a
deliberately simplified, non-inverted linear price<->pixel mapping (unlike
a real chart, where higher price = smaller/higher-up pixel Y). This means
a Long/Short position's green/red zones can appear visually swapped in a
screenshot taken against the stub specifically — the box-placement code
itself (`Math.min(entryY, tpY)` etc.) is written generically and is
unaffected; it renders correctly under Lightweight Charts' real inverted
axis. The stats math (which operates on price values directly, never on
raw pixel coordinates) is unaffected by this either way, as verified
above.

Full backend + frontend regression suite (including every previously-
verified Atlas layout combination, Quadrinity sidecar mode, and settings
change) re-run after this change with zero errors — confirming this
feature didn't regress anything built in earlier sessions.

## 10. Sidecar/Orbs corrections, discrete expiration list, Chart Layouts, rebrand

**Expiration N-list corrected** to the exact discrete set from the
reference (1/2/3/5/7/10/15/20/30/50, not a dense 1-10 range), shared via
`SkylitNodeUtils.EXPIRATION_N_OPTIONS` across the Heatmap sidecar, Atlas,
and Quadrinity so they can't drift apart. Backend's `kMaxNextExpirations`
raised from 10 to 50 to actually support the new max — verified the
backend builds clean and `current+50` returns correct, distinct data with
no meaningful startup/response time impact.

**Orbs settings expanded to the full 6-control set**: Orb Size, Min
Clamp, Max Clamp, Min Opacity, Max Opacity, King Opacity — replacing the
earlier 2-slider version, same Save/Reset (draft-until-saved) semantics.
**A real bug was caught and fixed during verification**: the first
implementation used minClamp/maxClamp to CLAMP the raw magnitude
fraction, which — given the reference's tiny default values (2%/4%) —
collapsed every node's width to a constant 1px regardless of the Orb Size
slider, making the controls functionally inert. Fixed by switching to
INTERPOLATION between minClamp and maxClamp (matching how King/min/max
opacity already correctly worked), consistent with each slider's
plain-English description ("sets the minimum/maximum size an orb can
be" — a floor/ceiling on the output range, not a clamp on the input).
Verified: before the fix, changing Orb Size from 50% to 100% produced no
change in rendered `lineWidth`; after the fix, it does. This formula is
explicitly documented in `atlas.js` as a transparent approximation, since
the exact proprietary internal math isn't derivable from a screenshot —
what matters is that each control demonstrably does what it says.

**Heatmap sidecar settings consolidated behind a gear popover**
(`heatmap.js`): the previously always-visible exposure/expiration/node-
count/badges/highlight rows now live behind a single settings gear in the
subheader, matching the reference's settings-subtab pattern. The popover
is appended to `document.body` (not nested inside the panel) so it's
never clipped by the sidecar's scroll container; `destroy()` now also
removes the popover to avoid leaking orphaned DOM nodes across repeated
pane create/destroy cycles (Quadrinity pane-count changes, Atlas layout
switches). Verified functioning correctly after the refactor.

**Chart Layouts** (`atlas-layout.js`): named, switchable, renamable,
deletable full-workspace presets, distinct from the pane-arrangement
picker (arrangement is only one field a saved layout captures). A
"Layouts" toolbar button opens a panel (switch by clicking a name, pencil
icon to rename in place, X for a two-step delete confirmation, "+ New
layout from current"). No Save button anywhere — every mutation
(arrangement change, per-pane ticker change via either the Window
Settings panel or a pane's own header dropdown, interval, exposure type,
expiration scope, node count, Orbs toggle/settings, Dark Pool, Flow)
schedules a debounced (800ms) autosave of whichever named layout is
currently active, persisted to `localStorage` under
`skylit:chart-layouts`. On startup: loads the most recently active saved
layout, or bootstraps a "Default" one from initial state if none exist
yet. A `restoringSnapshot` guard prevents the act of restoring a snapshot
from re-triggering its own autosave.
**A real bug was caught and fixed during verification**: renaming the
currently-ACTIVE layout updated its name in storage correctly but left
the toolbar button showing the old name — fixed by updating
`el.layoutsBtnName.textContent` whenever the renamed entry is the active
one. Verified end-to-end: node-limit change auto-persisted into "Default"
after the debounce window; "+ New layout from current" correctly
snapshotted the modified state as a second, independent entry; switching
back to "Default" correctly restored its own separate settings; rename
now correctly updates the toolbar immediately; the two-step delete
confirmation (first click arms "Confirm", second click actually deletes,
count verified unchanged after the first click and decremented after the
second) all behave exactly as specified. Full regression sweep (all 6
pane arrangements, sidecar Quadrinity mode, full-page Quadrinity 1-4
panes, drawing tools) re-run with zero errors after these changes.

**Rebrand**: the terminal's header/title text changed from "SKYLIT" to
"DUOTONIC" (`frontend/index.html`'s `<title>` and header `.brand` text) — a
display-only rename; no internal identifiers, API routes, or backend
service names were changed, since those aren't user-facing.

## 11. Orbs rendering correction: two-tone color, no chart labels, real freshness decay

Three corrections to Atlas's Orbs overlay, driven by closer reference
screenshots of the real product:

**No floating price labels on the chart.** An earlier revision drew each
node's strike as text next to its band (`ctx.fillText` in
`atlas-orbs.js`). Removed — price is read from the Y-axis (Lightweight
Charts' own, not something this app draws), and nothing else should be
labeled on the chart body per the explicit correction.

**Strict two-tone color, not the 5-stop gradient.** The heatmap ladder
(sidecar/Quadrinity) correctly uses the 5-stop diverging gradient
(purple→blue→teal→green→yellow) built earlier for that reference. Orbs
on the candlestick chart are a different visual grammar: exactly two
hues — gold/amber for positive (Pika) exposure, vivid purple for negative
(Barney) exposure — with magnitude and decay expressed ONLY through
opacity, never through a hue blend. New `exposureToOrbColor()` in
`colorscale.js`, kept separate from the existing `exposureToColor()` so
the ladder's gradient is untouched.

**Freshness/retest decay now actually wired in — a real, previously-
undiscovered gap.** `exposure_engine.hpp` has had `Node::touch_count` and
`decay_weight_for_touches()` since the Heatmaps milestone, but nothing
ever incremented `touch_count`, and the frontend never consumed it —
Orb opacity was driven by magnitude alone. Fixed on both ends:
- Backend (`live_feed.hpp`): a new `crossed(old_spot, new_spot, strike)`
  helper detects when a price tick passes through a node's strike level
  (either direction), called from `price_loop()` for every node in every
  expiration bucket on every tick, incrementing `touch_count` on a real
  crossing. Verified live: at server start, the at-the-money strike
  (exactly equal to the seeded spot) showed `touch_count: 1` immediately
  (a boundary case — starting AT a level counts as an initial touch,
  which is reasonable/expected, not a bug).
- Frontend (`atlas.js`): `computeOrbStyle()` now multiplies the
  magnitude-based opacity by a decay weight computed from
  `node.touch_count`, using the exact same constants as the backend's
  `FreshnessConfig` defaults (first-touch weight 1.0, decay-per-touch
  0.30, floor 0.15) — a deliberate mirror so the visual decay matches the
  backend's own definition of freshness rather than inventing a second,
  divergent curve.
- **Verification was done at the pixel level, not just visually**: mocked
  `/api/heatmap` with three nodes of known exposure and touch_count,
  patched the chart's coordinate mapping to a known scale, and read raw
  alpha bytes back from the canvas via `getImageData()` at each band's
  expected row. All three matched hand-calculated predictions exactly:
  a fresh 56%-magnitude node → alpha 125/255 (≈0.49, matching the
  interpolation formula precisely), a fresh King node → alpha 255/255
  (full King Opacity), and a node retested 5 times → alpha 23/255
  (≈0.09, matching `0.60 base × 0.15 decay` exactly). This is
  meaningfully stronger verification than a screenshot, which had
  already once given a false negative in this same session (a decayed
  band was genuinely too faint to see by eye, which pixel inspection
  correctly disambiguated from "didn't render at all").

Full regression sweep (all 6 pane arrangements, sidecar Quadrinity mode,
full-page Quadrinity 1-4 panes, Orb settings save, drawing tools, Chart
Layouts) re-run after these changes — zero errors, backend smoke suite
clean.
