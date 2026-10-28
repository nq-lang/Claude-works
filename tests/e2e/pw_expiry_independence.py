#!/usr/bin/env python3
"""S4 — the heatmap panel and Orbs & Nodes keep fully independent expiry/Greek state: separate selections,
separate request streams (no cross-keyed or mixed requests), independent persistence across reload,
and each shows what it is displaying."""
import os, subprocess, sys, time, urllib.request
from urllib.parse import unquote, urlparse, parse_qs
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18440")); results = []
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
        ctx = b.new_context(viewport={"width": 1700, "height": 950}); pg = ctx.new_page(); errs, reqs = [], []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: reqs.append(unquote(r.url)))
        pg.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        def boot():
            pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector("#sidecar .hm-settings-gear"); pg.wait_for_timeout(2200)
        def pairs(since):
            out = set()
            for u in reqs[since:]:
                if "/api/heatmap?" in u and "ticker=SPY" in u:
                    q = parse_qs(urlparse(u).query); out.add((q["exposure"][0], q["expiration"][0]))
            return out
        boot()
        pop = ".hm-settings-popover"; line = lambda: pg.inner_text("#sidecar .hm-selection-line")
        # heatmap -> 3DTE VEX
        pg.click("#sidecar .hm-settings-gear"); pg.wait_for_selector(pop, state="visible")
        pg.click(f"{pop} [data-dte='3']"); pg.click(f"{pop} [data-greek='VEX']"); pg.click(f"{pop} .hm-settings-apply"); pg.click("body", position={"x": 5, "y": 5})
        # Orbs & Nodes -> 2DTE GEX only
        pg.click(".atlas-expiry-open")
        pg.click(".atlas-expiry-dte .atlas-chip[data-key='2']"); pg.click(".atlas-expiry-dte .atlas-chip[data-key='0']")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
        m = len(reqs); pg.wait_for_timeout(4500)
        ps = pairs(m)
        check("heatmap panel still on 3DTE VEX", "3DTE" in line() and "VEX" in line(), line())
        status = pg.inner_text(".atlas-expiry-open >> xpath=..")
        check("Orbs & Nodes rail status shows its own selection (2DTE GEX)", "2DTE" in status and "3DTE" not in status, status.replace("\n", " "))
        check("heatmap requests only (VEX, dte:3)", ("VEX", "dte:3") in ps, str(ps))
        check("orb requests only (GEX, dte:2)", ("GEX", "dte:2") in ps, str(ps))
        check("no cross-keyed request (GEX@3DTE or VEX@2DTE never issued)", ("GEX", "dte:3") not in ps and ("VEX", "dte:2") not in ps, str(ps))
        # reload: each restores its own
        boot()
        status2 = pg.inner_text(".atlas-expiry-open >> xpath=..")
        check("after reload heatmap restores 3DTE VEX", "3DTE" in line() and "VEX" in line(), line())
        check("after reload Orbs & Nodes restores 2DTE GEX (independently)", "2DTE" in status2 and "3DTE" not in status2, status2.replace("\n", " "))
        # change heatmap again; orbs untouched
        pg.click("#sidecar .hm-settings-gear"); pg.wait_for_selector(pop, state="visible")
        pg.click(f"{pop} [data-dte='1']"); pg.click(f"{pop} .hm-settings-apply"); pg.click("body", position={"x": 5, "y": 5}); pg.wait_for_timeout(600)
        check("changing the heatmap leaves Orbs & Nodes selection untouched", "2DTE" in pg.inner_text(".atlas-expiry-open >> xpath=.."))
        check("no page errors", not errs, str(errs[:2])); b.close()
finally: srv.terminate()
print(f"\n{sum(results)}/{len(results)} checks passed"); sys.exit(0 if all(results) else 1)
