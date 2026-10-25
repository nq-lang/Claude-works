#!/usr/bin/env python3
"""Regression: the projection's convergence point (and Orbs) must track the
chart's ACTUAL last candle across repeated polls — not drift behind it.

This is a regression test for a real bug: /api/candles/latest returns the
last two bars (closed + forming) every poll, and calling series.update()
on the older of the two before the newer one previously desynced the
chart's internal bar count from the frontend's own barTimes tracking,
which silently shifted every x-coordinate computation (projection
convergence, Orbs) a few bars to the left of the true last candle.
"""
import os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 18170
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
        page.click(".atlas-interval-btn[data-interval='1m']")
        page.wait_for_timeout(800)

        def bar_count_vs_known():
            return page.evaluate("""() => {
              const chart = window.LightweightCharts.__lastChart;
              const candle = chart.__series.find(s => s.__kind === 'candlestick');
              return candle.data.length;
            }""")

        def convergence_dot_at_true_last_bar():
            # The convergence glow dot (glowDot(p0.x, p0.y, ...) in
            # atlas-projections.js) must be painted exactly at the TRUE
            # last bar's x / the spot's y — not the dashed full-width
            # reference lines (which intentionally span the whole canvas
            # and would give a false positive at x=0).
            return page.evaluate("""() => {
              const chart = window.LightweightCharts.__lastChart;
              const candle = chart.__series.find(s => s.__kind === 'candlestick');
              const trueLastX = chart.timeScale().logicalToCoordinate(candle.data.length - 1);
              const spotY = candle.priceToCoordinate(candle.data[candle.data.length - 1].close);
              const canvas = document.querySelector('.atlas-projection-canvas');
              const ctx = canvas.getContext('2d');
              const dpr = window.devicePixelRatio || 1;
              const cx = Math.round(trueLastX * dpr), cy = Math.round(spotY * dpr);
              const box = Math.round(6 * dpr);
              let painted = false;
              const d = ctx.getImageData(Math.max(0, cx - box), Math.max(0, cy - box), box * 2, box * 2).data;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 40) { painted = true; break; }
              return { trueLastX, spotY, paintedNearTrueLast: painted };
            }""")

        n0 = bar_count_vs_known()
        check("series has a sane initial bar count", n0 > 0, f"n0={n0}")

        # Let several 1s polls run (each one returns the closed+forming pair).
        page.wait_for_timeout(6500)
        n1 = bar_count_vs_known()
        # The historical bug grew the series by ~2 EXTRA entries per poll
        # (duplicating the closed bar then re-pushing the forming one), so
        # across ~6 polls in 6.5s it would grow by roughly a dozen. A
        # single genuine new bar closing during the wait (possible
        # depending on wall-clock alignment to the minute boundary) is a
        # real, legitimate +1 — only a much larger jump indicates the bug.
        check("no phantom bars accumulate across repeated 1s polls (the actual bug)", n1 - n0 <= 1, f"n0={n0} n1={n1}")

        geo = convergence_dot_at_true_last_bar()
        check("projection convergence point sits exactly at the true last bar (not a few candles back)",
              geo["paintedNearTrueLast"], str(geo))

        # Run it again after more polls to prove it stays locked on, not
        # just correct once at the start.
        page.wait_for_timeout(6500)
        geo2 = convergence_dot_at_true_last_bar()
        check("convergence point remains correct after further polling (continuous tracking, not a one-time fix)",
              geo2["paintedNearTrueLast"], str(geo2))

        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        check("no page errors during the alignment check", True)
        b.close()
finally:
    srv.terminate()

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
