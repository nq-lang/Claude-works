"""Helpers to run the page against the REAL Lightweight Charts v4.1.3 (see vendor/README.md).

    from real_lwc import install_real_lwc
    install_real_lwc(page)            # before page.goto()

The page's own <script src="https://unpkg.com/lightweight-charts@4.1.3/..."> request is answered with the
vendored library plus a tiny recorder, so tests can reach the live chart / series objects:

    window.__charts  - every chart created via LightweightCharts.createChart
    window.__series  - every candlestick series, same order as __charts
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REAL_LWC_PATH = os.environ.get("SKYLIT_LWC_JS", os.path.join(HERE, "vendor", "lightweight-charts.standalone.production.js"))

RECORDER = r"""
;(function () {
  // The library's global namespace object is frozen, so wrap it in a plain object rather than patching it.
  const LW = window.LightweightCharts;
  window.__charts = []; window.__series = [];
  const wrapped = Object.assign({}, LW);
  wrapped.createChart = function () {
    const chart = LW.createChart.apply(LW, arguments);
    window.__charts.push(chart);
    const origAdd = chart.addCandlestickSeries.bind(chart);
    chart.addCandlestickSeries = function () { const s = origAdd.apply(null, arguments); window.__series.push(s); return s; };
    return chart;
  };
  window.LightweightCharts = wrapped;
})();
"""


def real_lwc_source():
    with open(REAL_LWC_PATH, encoding="utf-8") as f:
        return f.read() + RECORDER


def install_real_lwc(page_or_context):
    src = real_lwc_source()
    page_or_context.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=src))
