# Tickers (S11)

Single source of truth: the `tickers` vector in `backend/src/main.cpp`. `/api/tickers` serves the list plus
per-ticker `details`; the ATLAS toolbar/heatmap/pane pickers and Quadrinity read it — no frontend copy to drift.

| Ticker | Kind | Style | Multiplier |
|---|---|---|---|
| SPXW | index | European | 100 |
| SPY, QQQ | ETF | American | 100 |
| NVDA, TSLA, MSFT, AMZN | equity | American | 100 |
| VIX | vol index | European | 100 |

**Limits (honest):** the data source is synthetic. Style/multiplier/kind are metadata only; the synthetic
generator does not price off them. A real-data source must: VIX options priced off the *matching
VIX-futures forward* (not spot VIX) with the special opening quotation (SOQ) settlement; equities need
American-exercise handling and dividend inputs. Seed spot levels are illustrative, not market levels.
Verified: every ticker serves heatmap/candles, pickers match the backend list, switching shows that
ticker's own spot (`tests/e2e/pw_tickers.py`).
