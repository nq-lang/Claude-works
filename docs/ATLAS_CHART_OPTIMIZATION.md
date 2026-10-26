# ATLAS chart optimization — summary, decisions, measurements, manual test script

Work order: `atlas_chart_optimization_prompt.md` (3 workstreams). All changes are in `frontend/`; no backend or data-logic changes.

## 1. Workstream 1 — view persistence

**Root cause (it matches the description, but the exact location matters).** `frontend/js/atlas.js` re-applied
`chart.priceScale('right').applyOptions({ autoScale: true })` from `loadOrbs()` and `loadProjection()` on **every 1-second poll** (and
on every toggle). Lightweight Charts flips `autoScale` to `false` the moment the user drags or zooms the price axis, so the very next poll turned
it back on: the manual price scale was lost within ~1 s. Reproduced on the real library (manual scale gone within 250 ms of the next poll).
The time axis was *not* reset by the same mechanism: it was patched per poll with `setVisibleLogicalRange()` behind a sticky "user panned"
flag (which also froze a live-edge view after any zoom), and `fitContent()` ran on every history load. A second, related bug: the chart
only resized on `window.resize`, so showing/hiding the sidecar left stale-size canvases.

**Fix.**
- `refreshPriceAutoscale()` only re-triggers autoscale while the axis is **already** automatic. Manual mode is never rescaled by data.
- View state (price scale, visible window, bar spacing) is separated from data state. Only a **context change** (new ticker/timeframe/pane)
  or an explicit reset (Reset view button, axis double-click) may write it. `loadCandles()` is context-aware: same context (history re-fetch /
  reconnect / same-ticker reselect) captures the visible window **in times**, swaps data, restores in the same task; new context fits + auto price.
- The per-poll range restore was removed: `series.update()` is incremental and Lightweight Charts itself keeps a scrolled-back window fixed and follows only when the newest bar is visible (keeping bar spacing).
- A pointer gesture wins: while a drag/pan/axis-scale is in progress incoming bars are **held** (keyed by time, none lost) and applied right
  after release. Without this a new candle re-bases the drag anchor and the content hops by a bar.
- Projection room (`rightOffset`) is applied change-only and never drags a scrolled-back view forward.
- `ResizeObserver` sizing (bar spacing and right-edge anchor are kept by the library on resize).
- New toolbar **Reset view** button; native double-click on either axis also resets.
- New shared `frontend/js/chart-coords.js` (time <-> logical index, exact to the right of the newest bar).

## 2. Workstream 2 — drawing tools (`frontend/js/atlas-drawing.js`, rewritten)

- **Overlay layer:** two dedicated canvases (committed + preview), DPR-aware, clipped to the plot area. Events are captured on the container,
  so the canvases never block the chart's crosshair, pan or axes.
- **A. Preview:** every tool shows an amber dashed ghost of the real shape at the cursor with an anchor handle and a price/time readout; two-point
  tools show a default-size ghost before the first click and the live in-progress shape after it. Click-click and press-drag-release both work.
  Esc cancels (then deselects the tool), leaving the pointer clears it.
- **B. Displayed / Not displayed:** `visible` flag per drawing, switch in the settings dialog (double-click a drawing or the gear in the list), eye
  icon in the new drawings list (dimmed row when hidden). Persisted with the drawing. Hidden drawings are not drawn, hit-tested, selected, dragged, or considered by snapping. A toolbar master eye hides all temporarily and never touches per-drawing flags.
- **C. Performance approach:** pointer handlers only record the cursor and schedule one `requestAnimationFrame`; all geometry happens in the frame.
  Pixel<->data conversion is cached in a view snapshot keyed by (visible logical range, plot size, price-axis probe, bar count) and rebuilt only when it changes. Preview and commit share `snapPoint()` + `paintShape()`, so they cannot drift. Drawings are anchored to (time, price); live ticks only dirty the committed layer and never clear or delay the preview.
- Also fixed on the way: price-axis changes (axis drag, autoscale) previously did not redraw drawings; times beyond the newest bar returned `null` (drawings could not be placed in the projection area); no DPR scaling.

### Projection performance (before / after), `tests/e2e/perf_drawing.py`
40 drawings on the chart, real library, drag of a new Rectangle with 4 pointer events per frame, 300 frames, headless Chromium (software rendering — compare builds on one machine, not absolute numbers):

| metric | before | after |
|---|---|---|
| hover → first preview paint | never (no pre-click preview existed) | 11.4 ms |
| pointer-handler main-thread time per frame (mean / p95) | 2.62 / 4.90 ms | 0.06 / 0.10 ms (~44x less) |
| input → painted (mean / p95) | 16.65 / 17.10 ms | 16.62 / 19.90 ms |
| frame spacing p50 / p95 / max; frames > 33 ms | 16.7 / 16.8 / 21.7 ms; 0 | 16.7 / 17.1 / 28.0 ms; 0 |

Honest reading: in this harness input→paint is bound by the 60 Hz frame cadence in both builds, so the win is main-thread headroom (the old handler redrew every drawing synchronously on every pointer event; the new one does no drawing work in the handler) and, above all, that a preview now exists at all. The saved time grows with the number of drawings.

## 3. Workstream 3 — layout reflow

With "Show Heatmap" OFF the whole `#sidecar` is `display:none` (flex layout gives the chart pane the width; the chart's `ResizeObserver` resizes the canvas, and orbs/projection/drawing overlays have their own observers), the divider is hidden, and every heatmap panel's polling is **paused** (`pause()/resume()` added to `heatmap.js`; resume refreshes immediately). Because the sidecar header (with the checkbox) is hidden too, a **Show heatmap** restore button appears in the toolbar. ON is byte-for-byte the previous layout (same width restored). Previously OFF left a 150 px empty column and polling continued (and the page overflowed horizontally by ~90 px).

## 4. Decisions not covered by the brief
1. Resize keeps bar spacing and the right-edge anchor (library behaviour; TradingView-like) instead of rescaling bars to preserve the exact visible range — so showing the heatmap again returns to the identical view.
2. A context change (ticker / timeframe / pane rebuilt) refits and returns the price axis to auto — that is a "context change", per section 1.3.
3. View state is not persisted across a full browser reload (the brief only requires drawing visibility to persist across reloads).
4. The chart had no snapping, so none was added; `snapPoint()` is the single hook where it would go (hidden drawings excluded).
5. Placement supports click-click in addition to press-drag-release; drag-threshold 4 px.
6. The settings dialog, drawings list and selection/move/resize did not exist; added minimally so Displayed/Not displayed has somewhere to live.
7. Held-during-gesture candle updates (see WS1) trade at most the duration of one drag of data freshness for a jump-free gesture.
8. Real-library tests use a vendored copy of Lightweight Charts v4.1.3 (`tests/e2e/vendor/`, provenance in its README; not byte-compared with the unpkg build). The older suites still use the stub.

## 5. Tests
`tests/e2e/pw_chart_view.py` (30 checks; 11 fail on the old frontend), `pw_layout_heatmap.py` (17; 6 fail on the old one), `pw_drawing_tools.py` (48), `perf_drawing.py` (benchmark). All other suites unchanged and passing (`make test-e2e`).

## 6. Manual test script
Open the terminal (default layout, SPY 5m). Wait ~5 s for data.

**WS1 — view**
1. Drag the price axis (right edge) up/down to stretch it. Watch ≥ 1 minute (50+ ticks, a candle close if on 1m): range does not change. A candle far outside the range does not rescale; it just sits off-screen.
2. Scroll back into history and zoom with the wheel; wait for new candles: window and zoom do not move. At the live edge after zooming, the chart follows new candles but keeps the zoom.
3. Re-select the same ticker in the pane's ticker box: view unchanged. Switch timeframe: refit + auto price (expected).
4. Click **Reset view** (or double-click an axis): only now does it auto-fit.
5. Start dragging the chart and keep holding while a candle arrives: no hop; the candle appears when you release.

**WS2 — drawings**
6. Pick each tool and just move over the chart (no click): amber dashed ghost + handle + price/time readout. Click once, move: in-progress shape follows. Click again: placed exactly where the ghost was. Also try press-drag-release. Esc cancels; picking Cursor clears the ghost.
7. Double-click a drawing: settings dialog with **Displayed / Not displayed**. Switch it off: it vanishes, stays in the list (☰ button) dimmed with a closed eye; toggle it from the list; you cannot click or drag it. Reload the page and change timeframe: still hidden.
8. Toolbar eye (hide all): everything disappears; per-drawing states are unchanged; click again to restore.
9. Pan, zoom, drag the price axis and let candles arrive: drawings stay on their price/time.

**WS3 — layout**
10. Uncheck **Show Heatmap**: heatmap disappears, chart fills the full width, no gap/scrollbar, no divider; a **Show heatmap** button appears in the toolbar. Your zoom/price scale and drawings are unchanged. (Network tab: no heatmap requests while hidden.)
11. Click **Show heatmap**: the original split returns and updates resume.
