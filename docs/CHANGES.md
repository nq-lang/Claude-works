# Change log — Atlas remodel + final optimizations

Build: `make build` (C++23). Tests: `make test-unit`, `bash tests/backend/smoke_test.sh`, and the Playwright
suites `tests/e2e/pw_*.py` (see TESTING.md). At this archive: 224 engine unit checks, backend smoke and
120 Playwright checks all pass; every `frontend/js/*.js` passes `node --check`.

## Latest round (final optimizations)
- **GEX+VEX is back** as ONE combined option (not two): Atlas heatmap Greeks are GEX / VEX / GEX+VEX;
  Quadrinity is GEX / VEX / GEX+VEX / CHEX. The Expiry Data and Projections windows also have a one-click
  "GEX+VEX" quick-pick.
- **Atlas heatmaps**: expiration, Greek, Velocity Mode and EXTREME live in each heatmap's own settings
  (gear), so every heatmap carries its own. The header keeps the ticker plus a one-line readout
  (e.g. "1DTE . GEX+VEX . Velocity"). Quadrinity heatmaps are unchanged apart from GEX+VEX.
- **Header**: "Charting System" with a dot that is amber until the terminal is pulling data and green while
  it is; the Atlas / Quadrinity tabs sit in the header; Layout / Windows / Default / Live take the tabs'
  old row, still horizontal.
- **Orbs window**: new switch for the strike / $ / % text beside each orb band.
- **Drawing tools**: horizontal toolbar box with a drag grip at the far left (drag it anywhere on the chart;
  position is remembered), new icons, and a **Price Range** tool measuring from where you start to where you
  extend (price distance, % move, bar count; green up / red down). Fixed: the toolbar could not be clicked
  once a drawing tool was active (the drawing canvas sat above it).

## Previous round (Atlas remodel)
- Left rail: Chart Timeframe (horizontal, labelled), Orbs, Expiry Data, Projections stacked vertically.
- Orbs window: node count, positive/negative colors, size, opacity. Expiry Data window: 0DTE-6DTE and
  gamma / vanna / charm / color / speed, with a live status line. Projections window: one DTE + Greeks.
- Heatmaps: Velocity Mode (|E_cur| - |E_ref|) / |E_ref| x 100 with session-open / rolling 5m 15m 1h /
  previous-close baselines and 0DTE / all / custom expiration scope; EXTREME (5 + 5 strikes);
  Neg strike marker; Badges icon across from "Show Heatmap"; per-pane DTE/Greek on the Quadrinity page.
- Backend: multi-Greek bitmask, `expiration=dte:0,1,3`, per-bucket exposure history, `annotate_velocity()`,
  `/api/quadrinity?specs=`, projection DTE 0-6 with custom Greeks.

## Simulated data — replace when your feed is connected
Vanna / charm / color / speed are deterministic placeholder series derived from the single synthetic
exposure feed (`greek_series_value()` in exposure_engine.hpp), and the velocity history is a synthetic
backward walk (`seed_velocity_history()` in live_feed.hpp). Nothing else in the pipeline needs to change.
