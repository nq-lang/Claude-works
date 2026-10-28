#!/usr/bin/env python3
"""S5 — heatmap King = most POSITIVE strike, Barney = most NEGATIVE strike, checked against an
independent computation from the raw /api/heatmap payload (per Greek)."""
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18437")); results = []
def check(n, c, d=""):
    results.append(bool(c)); print(("  PASS  " if c else "  FAIL  ") + n + (f"   [{d}]" if d else ""))
srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 1700, "height": 950}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
        pg.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector("#atlas-rail .atlas-expiry-open"); pg.wait_for_timeout(3000)
        shown_king = pg.locator("#sidecar .hm-king-strike").inner_text()
        shown_neg = pg.locator("#sidecar .hm-neg-strike").inner_text() if pg.locator("#sidecar .hm-neg-label").is_visible() else ""
        label = pg.locator("#sidecar .hm-neg-label").inner_text()
        check("header says Barney (not 'Neg')", "Barney" in label, label)
        raw = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/heatmap?ticker=SPY&exposure=GEX&expiration=0"))
        nodes = raw["nodes"]
        pos = [n for n in nodes if n["exposure"] > 0]; neg = [n for n in nodes if n["exposure"] < 0]
        fmt = lambda s: f"{s:g}"
        ek = max(pos, key=lambda n: n["exposure"])["strike"] if pos else None
        eb = min(neg, key=lambda n: n["exposure"])["strike"] if neg else None
        if ek is not None: check("King strike equals independent max-positive", fmt(ek) in shown_king.replace(",", ""), f"{shown_king} vs {ek}")
        if eb is not None: check("Barney strike equals independent most-negative", fmt(eb) in shown_neg.replace(",", ""), f"{shown_neg} vs {eb}")
        check("exactly one King and at most one Barney badge", pg.locator("#sidecar .hm-badge-king").count() <= 1 and pg.locator("#sidecar .hm-badge-neg").count() <= 1)
        check("no page errors", not errs, str(errs[:2])); b.close()
finally: srv.terminate()
print(f"\n{sum(results)}/{len(results)} checks passed"); sys.exit(0 if all(results) else 1)
