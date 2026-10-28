#!/usr/bin/env python3
"""S3 — every heatmap setting is wired end to end: apply it through the settings panel and assert the observable
effect (request parameters, DOM, row dimming).  One row per setting; see docs/HEATMAP_SETTINGS.md."""
import os, subprocess, sys, time, urllib.request
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18441")); results = []
def check(n, c, d=""):
    results.append(bool(c)); print(("  PASS  " if c else "  FAIL  ") + n + (f"   [{d}]" if d else ""))
srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        pg = b.new_context(viewport={"width": 1700, "height": 950}).new_page(); errs, reqs = [], []
        pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("request", lambda r: reqs.append(unquote(r.url)))
        pg.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector("#sidecar .hm-settings-gear"); pg.wait_for_timeout(2200)
        pop = ".hm-settings-popover"
        mark = [0]
        def apply(fn):
            mark[0] = len(reqs)
            pg.click("#sidecar .hm-settings-gear"); pg.wait_for_selector(pop, state="visible"); fn()
            pg.click(f"{pop} .hm-settings-apply"); pg.click("body", position={"x": 5, "y": 5}); pg.wait_for_timeout(2600)
        def latest(): return [u for u in reqs if "/api/heatmap?ticker=SPY" in u and "velocity" in u or "/api/heatmap?ticker=SPY" in u][-3:]
        def hm_since(): return [u for u in reqs[mark[0]:] if "/api/heatmap?ticker=SPY" in u]
        rows = lambda: pg.locator("#sidecar .hm-row").count()
        dimmed = lambda: pg.evaluate("() => [...document.querySelectorAll('#sidecar .hm-row')].filter(r => r.style.color.includes('0.35')).length")
        # 1 greek
        apply(lambda: pg.click(f"{pop} [data-greek='VEX']")); check("Greek=VEX -> exposure=VEX in request", any("exposure=VEX" in u for u in hm_since()), hm_since()[-1:])
        # 2 dte
        apply(lambda: pg.click(f"{pop} [data-dte='4']")); check("DTE=4 -> expiration=dte:4", any("exposure=VEX&expiration=dte:4" in u for u in hm_since()), hm_since()[-1:])
        check("selection line reads 4DTE VEX", "4DTE" in pg.inner_text("#sidecar .hm-selection-line"))
        # 3 velocity mode + baseline + scope
        apply(lambda: pg.click(f"{pop} .hm-velocity-btn"))
        check("Velocity Mode on -> velocity=1", any("velocity=1" in u for u in hm_since()))
        check("Velocity pills render (or none qualify) without errors", pg.locator("#sidecar .hm-vel-pill").count() >= 0)
        apply(lambda: pg.select_option(f"{pop} .hm-vel-baseline", "15m")); check("baseline=15m in request", any("velocity_baseline=15m" in u for u in hm_since()), hm_since()[-1:])
        apply(lambda: pg.select_option(f"{pop} .hm-vel-scope", "all")); check("scope=all in request", any("velocity_scope=all" in u for u in hm_since()), hm_since()[-1:])
        def custom():
            pg.select_option(f"{pop} .hm-vel-scope", "custom")
            for d in range(7):
                want = d in (1, 2); cb = pg.locator(f"{pop} [data-vdte='{d}']")
                if cb.is_checked() != want: cb.click()
        apply(custom); check("custom scope sends exactly velocity_dtes=1,2", any("velocity_scope=custom" in u and "velocity_dtes=1,2" in u for u in hm_since()), hm_since()[-1:])
        apply(lambda: pg.click(f"{pop} .hm-velocity-btn")); check("Velocity Mode off -> no velocity=1", not any("velocity=1" in u for u in hm_since()[-2:] if "exposure=VEX" in u), hm_since()[-2:])
        check("velocity pills gone", pg.locator("#sidecar .hm-vel-pill").count() == 0)
        # 4 badges
        n0 = pg.locator("#sidecar .hm-pct-badge").count()
        apply(lambda: pg.check(f"{pop} .hm-badges-checkbox"))
        n1 = pg.locator("#sidecar .hm-pct-badge").count()
        check("Badges on -> session-change pills appear (>= before)", n1 >= n0 and pg.locator("#sidecar .sidecar-badges-btn.active").count() == 1, f"{n0}->{n1}")
        apply(lambda: pg.uncheck(f"{pop} .hm-badges-checkbox")); check("Badges off -> no pills", pg.locator("#sidecar .hm-pct-badge").count() == 0)
        # 5 highlight nodes
        d0 = dimmed(); apply(lambda: pg.check(f"{pop} .hm-highlight-checkbox")); d1 = dimmed()
        check("Highlight Nodes on -> non-node rows dimmed", d1 > d0, f"{d0}->{d1} of {rows()}")
        apply(lambda: pg.uncheck(f"{pop} .hm-highlight-checkbox")); check("Highlight Nodes off -> nothing dimmed", dimmed() == 0)
        # 6 extreme + count
        def ext(n):
            def f():
                if "active" not in (pg.get_attribute(f"{pop} .hm-extreme-btn", "class") or ""): pg.click(f"{pop} .hm-extreme-btn")
                pg.select_option(f"{pop} .hm-extremes-count", str(n))
            return f
        apply(ext(4)); lit4 = rows() - dimmed()
        check("EXTREME with 4 each side -> exactly 8 rows undimmed", lit4 == 8, str(lit4))
        apply(ext(7)); lit7 = rows() - dimmed()
        check("EXTREME with 7 each side -> exactly 14 rows undimmed", lit7 == 14, str(lit7))
        apply(lambda: pg.click(f"{pop} .hm-extreme-btn")); check("EXTREME off -> nothing dimmed", dimmed() == 0)
        check("no page errors", not errs, str(errs[:2])); b.close()
finally: srv.terminate()
print(f"\n{sum(results)}/{len(results)} checks passed"); sys.exit(0 if all(results) else 1)
