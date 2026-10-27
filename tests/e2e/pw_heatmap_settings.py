#!/usr/bin/env python3
"""Fixes S7 — heatmap settings Apply / Reset: draft vs applied, persistence, defaults."""
import os, subprocess, sys, time, urllib.request
from urllib.parse import unquote
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18436"))
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"]); ctx = b.new_context(viewport={"width": 1700, "height": 950}); pg = ctx.new_page()
        reqs = []; pg.on("request", lambda r: reqs.append(unquote(r.url)))
        pg.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        def boot():
            pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector("#sidecar .hm-settings-gear"); pg.wait_for_timeout(1800)
        boot()
        pop = ".hm-settings-popover"
        line = lambda: pg.inner_text("#sidecar .hm-selection-line")
        heat = lambda since: [u for u in reqs[since:] if "/api/heatmap?ticker=SPY" in u and "dte:" in u]
        def opened(): pg.click("#sidecar .hm-settings-gear"); pg.wait_for_selector(pop, state="visible")
        print("[1] draft vs applied")
        check("starts at defaults (0DTE · GEX), Apply disabled", "0DTE" in line() and "GEX" in line())
        opened()
        check("Apply disabled with no pending changes", pg.locator(f"{pop} .hm-settings-apply").is_disabled())
        m = len(reqs)
        pg.click(f"{pop} [data-dte='3']"); pg.click(f"{pop} [data-greek='VEX']"); pg.check(f"{pop} .hm-badges-checkbox"); pg.select_option(f"{pop} .hm-extremes-count", "7")
        pg.wait_for_timeout(2500)
        check("Apply becomes enabled", pg.locator(f"{pop} .hm-settings-apply").is_enabled())
        check("heatmap unchanged and no new-selection request before Apply", "0DTE" in line() and not any("dte:3" in u for u in heat(m)))
        pg.click(f"{pop} .hm-settings-apply"); pg.wait_for_timeout(2300)
        check("Apply updates the heatmap (3DTE · VEX) and requests it", "3DTE" in line() and "VEX" in line() and any("exposure=VEX&expiration=dte:3" in u for u in heat(m)), line())
        check("Apply disabled again after applying", pg.locator(f"{pop} .hm-settings-apply").is_disabled())
        pg.click("body", position={"x": 5, "y": 5})
        print("[2] closing with unapplied edits discards them")
        opened(); pg.click(f"{pop} [data-dte='5']"); pg.click("body", position={"x": 5, "y": 5}); opened()
        check("reopened panel shows the applied value, not the discarded draft",
              "active" in pg.eval_on_selector(f"{pop} [data-dte='3']", "e => e.className") and "active" not in pg.eval_on_selector(f"{pop} [data-dte='5']", "e => e.className") and "3DTE" in line())
        pg.click("body", position={"x": 5, "y": 5})
        print("[3] persistence across restart")
        boot()
        check("applied settings survive a reload", "3DTE" in line() and "VEX" in line(), line())
        opened()
        check("panel shows persisted values (badges on, 7 strikes)", pg.is_checked(f"{pop} .hm-badges-checkbox") and pg.input_value(f"{pop} .hm-extremes-count") == "7")
        print("[4] Reset restores defaults and applies immediately")
        m = len(reqs)
        pg.click(f"{pop} .hm-settings-reset"); pg.wait_for_timeout(2300)
        check("heatmap back to default selection immediately (no Apply needed)", "0DTE" in line() and "GEX" in line() and any("exposure=GEX&expiration=dte:0" in u for u in heat(m)), line())
        check("every field returns to its default", not pg.is_checked(f"{pop} .hm-badges-checkbox") and pg.input_value(f"{pop} .hm-extremes-count") == "5"
              and pg.input_value(f"{pop} .hm-vel-baseline") == "session" and pg.input_value(f"{pop} .hm-vel-scope") == "match")
        pg.click("body", position={"x": 5, "y": 5})
        boot()
        check("reset persists after restart", "0DTE" in line() and "GEX" in line())
        b.close()
finally:
    srv.terminate()
print(f"\n{sum(results)}/{len(results)} checks passed"); sys.exit(0 if all(results) else 1)
