# Vendored test fixture: TradingView Lightweight Charts v4.1.3 (standalone build)

`lightweight-charts.standalone.production.js` is the **real** charting library (the same major/minor/patch
version `frontend/index.html` loads from unpkg.com: `lightweight-charts@4.1.3`). It is used **only by the
browser tests** (`tests/e2e/real_lwc.py` serves it in place of the CDN request) so that view-state,
coordinate-conversion and drawing behaviour is tested against the actual library instead of the call-recording
stub (`lwc_render_stub.js`).

- License: Apache License 2.0 (header retained inside the file) - (c) 2024 TradingView, Inc.
- Provenance: copied from `lightweight_charts/js/lightweight-charts.js` in
  <https://github.com/louisnw01/lightweight-charts-python> (commit 052d778), because the build environment
  could not reach unpkg.com / the npm registry. The embedded version string is `4.1.3`. It was **not**
  byte-compared with the unpkg artifact (unreachable here).
- It is not shipped to users and not referenced by `frontend/`.
