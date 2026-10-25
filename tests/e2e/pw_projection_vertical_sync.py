#!/usr/bin/env python3
"""Regression: the wedge's vertical apex must track the chart's own last
candle close, even when /api/projection's own `spot` field is briefly
stale relative to it (the two come from independent HTTP round trips).
"""
import os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 18230
results = []
def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        page = b.new_context(viewport={"width": 1600, "height": 900}).new_page()
        page.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        page.goto(f"http://127.0.0.1:{PORT}/")
        page.wait_for_selector(".atlas-projection-toggle")
        page.check(".atlas-projection-toggle"); page.keyboard.press("Escape")
        page.wait_for_timeout(1200)

        # Simulate the real-world race over the NETWORK, not by poking chart
        # internals: intercept /api/candles/latest so the bar the app's own
        # code processes (through the real pollLatestCandles -> state.lastClose
        # path the fix relies on) shows a deliberately bumped close, while
        # /api/projection keeps returning its last real (now "stale by
        # comparison") spot for one more cycle — exactly what two
        # independent async fetches landing a moment apart produce.
        BUMP = 3.0
        def bump_candles(route):
            resp = route.fetch()
            bars = resp.json()
            if bars:
                bars[-1]["close"] += BUMP
                bars[-1]["high"] = max(bars[-1]["high"], bars[-1]["close"])
            route.fulfill(response=resp, json=bars)
        page.route("**/api/candles/latest**", bump_candles)
        page.wait_for_timeout(1300)  # let at least one bumped poll land and redraw

        def painted_near(label, offset_from_true):
            return page.evaluate(f"""() => {{
              const chart = window.LightweightCharts.__lastChart;
              const candle = chart.__series.find(s => s.__kind === 'candlestick');
              const lastClose = candle.data[candle.data.length - 1].close;
              const trueY = candle.priceToCoordinate(lastClose) + ({offset_from_true});
              const ts = chart.timeScale();
              const n = candle.data.length;
              const x0 = ts.logicalToCoordinate(n - 1) + (ts.logicalToCoordinate(n-1) - ts.logicalToCoordinate(n-2)) * 0.4;
              const canvas = document.querySelector('.atlas-projection-canvas');
              const ctx = canvas.getContext('2d');
              const dpr = window.devicePixelRatio || 1;
              const cx = Math.round(x0 * dpr), cy = Math.round(trueY * dpr);
              const box = Math.round(5 * dpr);
              const d = ctx.getImageData(Math.max(0, cx - box), Math.max(0, cy - box), box * 2, box * 2).data;
              let painted = false;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 30) {{ painted = true; break; }}
              return {{ lastClose, trueY, painted }};
            }}""")

        # The wedge's apex must be painted right at the NEW close (0 offset),
        # and should NOT be painted ~15px away at the OLD close's old
        # position (which is roughly where the stale `data.spot` would have
        # placed it, since the simulated move was a large, obvious +3.0).
        at_new = painted_near("new close", 0)
        check("wedge is painted exactly at the candle's NEW close", at_new["painted"], str(at_new))

        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        check("no page errors", True)
        b.close()
finally:
    srv.terminate()

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
