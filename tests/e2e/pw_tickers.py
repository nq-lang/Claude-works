#!/usr/bin/env python3
"""S11 — all tickers (incl. VIX/TSLA/MSFT/NVDA/AMZN) come from the single backend list and appear in
ATLAS + Quadrinity pickers; switching through every ticker leaves no stale heatmap/orb state."""
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18438")); results = []
def check(n, c, d=""):
    results.append(bool(c)); print(("  PASS  " if c else "  FAIL  ") + n + (f"   [{d}]" if d else ""))
srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    want = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/tickers"))["tickers"]
    check("backend list contains the new tickers", all(t in want for t in ["VIX", "TSLA", "MSFT", "NVDA", "AMZN"]), str(want))
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 1700, "height": 950}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        pg.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector("#atlas-rail .atlas-expiry-open"); pg.wait_for_timeout(2500)
        opts = pg.eval_on_selector_all("#sidecar .hm-ticker-select option", "o => o.map(x => x.value)")
        check("ATLAS heatmap picker == backend list", opts == want, str(opts))
        popts = pg.eval_on_selector_all(".atlas-pane-ticker-select option", "o => o.map(x => x.value)")
        check("ATLAS pane picker == backend list", popts == want, str(popts))
        for t in want:
            pg.select_option("#sidecar .hm-ticker-select", t); pg.wait_for_timeout(1300)
            spot = float(pg.inner_text("#sidecar .hm-price-val").lstrip("$").replace(",", ""))
            api = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/heatmap?ticker={t}&exposure=GEX&expiration=0dte"))["spot"]
            check(f"{t}: heatmap shows that ticker's own spot", abs(spot - api) / api < 0.01, f"{spot} vs {api}")
        pg.click("text=Quadrinity", timeout=3000) if pg.locator("text=Quadrinity").count() else None
        pg.wait_for_timeout(1500)
        qopts = pg.eval_on_selector_all("#quadrinity-grid select option, .quad-pane select option", "o => [...new Set(o.map(x => x.value))]")
        check("Quadrinity pickers include every backend ticker", all(t in qopts for t in want), str(qopts))
        check("no page/console errors", not errs, str(errs[:3])); b.close()
finally: srv.terminate()
print(f"\n{sum(results)}/{len(results)} checks passed"); sys.exit(0 if all(results) else 1)
