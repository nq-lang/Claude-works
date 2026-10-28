# Heatmap settings — wiring table (S3/S7)

Defaults are defined once (`DEFAULTS` in `frontend/js/heatmap.js`); edits go to a draft and take effect only on
**Apply**; **Reset** restores defaults and applies immediately. Applied settings persist per panel
(`skylit:heatmap-settings:<panel>`). Each row is verified by `tests/e2e/pw_heatmap_wiring.py`.

| Setting | Default | Observable effect (tested) |
|---|---|---|
| Greek (GEX / VEX / GEX+VEX) | GEX | `exposure=` in the request; selection line |
| Expiration (0–6 DTE) | 0 | `expiration=dte:N`; selection line |
| Velocity Mode | off | `velocity=1` in request; velocity pills |
| Velocity baseline | session | `velocity_baseline=` |
| Velocity expirations | match | `velocity_scope=` (+ `velocity_dtes=1,2` for custom) |
| Badges | off | session-change pills; header Badges button mirrors it |
| Highlight Nodes | off | non-node rows dimmed |
| EXTREME + strikes per side | off / 5 | exactly 2×N rows undimmed |

Data states: LIVE/STALE age chip in the footer (STALE after 6 s without a successful refresh), explicit
"Unable to load …" error with retry note, explicit empty state when a selection has no strikes.
King = most positive strike, Barney = most negative, per Greek + DTE (2% hysteresis).

Expiry model (S2): selectors are `0dte`, `current+N` (1–50) or `dte:a,b,…` (0–50); anything else is rejected
with HTTP 400. Multi-select = exact per-strike sum of the individual expiries (`tests/backend/expiry_api_test.py`).
**Known limitation:** the synthetic source treats bucket index N as "N-th expiry cycle", which equals N calendar
DTE only for daily-expiry tickers. Weekly-cycle names (VIX, most equities) need a real expiry calendar and
roll-off (AM/PM settlement) from the data source.
