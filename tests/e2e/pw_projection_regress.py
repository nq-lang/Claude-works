#!/usr/bin/env python3
"""Regression: Projections must coexist with multi-pane layouts, Orbs, drawing
tools and the Quadrinity tab (each pane owns its own projection layer)."""
import os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shots"
PORT = 18112
res = []
def check(n, c, d=""):
    res.append(bool(c)); print(("  PASS  " if c else "  FAIL  ") + n + (f"   [{d}]" if d else ""))
srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        page = b.new_context(viewport={"width": 1700, "height": 950}).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        page.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        page.goto(f"http://127.0.0.1:{PORT}/")
        page.wait_for_selector(".atlas-projection-toggle")
        page.check(".atlas-projection-toggle"); page.keyboard.press("Escape"); page.wait_for_timeout(800)
        expect = {"single": 1, "2up": 2, "2stack": 2, "3up": 3, "3stack": 3, "4up": 4}
        for lid, n in expect.items():
            page.click(".atlas-layout-btn"); page.click(f".atlas-layout-option[data-layout='{lid}']")
            page.wait_for_timeout(1300)
            panes = page.locator(".atlas-multi-pane").count()
            orbs = page.evaluate("""() => [...document.querySelectorAll('.atlas-orb-canvas')].filter(c => {
                const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true; return false; }).length""")
            proj = page.evaluate("""() => [...document.querySelectorAll('.atlas-projection-canvas')].filter(c => {
                const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true; return false; }).length""")
            check(f"{lid}: {n} pane(s), each with a painted corridor and painted Orbs, no on-chart label",
                  panes == n and proj == n and orbs == n, f"panes={panes} corridors={proj} orbs={orbs}")
            if lid == "4up": page.screenshot(path=f"{OUT}/07_4up_projections.png")
        drawing = page.locator(".atlas-drawing-strip, .atlas-drawing-toolbar, [class*='drawing']").count()
        check("drawing layers still present per pane", drawing >= 4, f"{drawing} drawing elements")
        page.click(".atlas-projection-toggle"); page.keyboard.press("Escape"); page.wait_for_timeout(600)
        check("no atlas-projection-badge element exists anywhere in the DOM", page.locator(".atlas-projection-badge").count() == 0)
        check("toggling off leaves Orbs intact", page.locator(".atlas-orb-canvas").count() == 4)
        page.click("#tab-quadrinity"); page.wait_for_timeout(1500)
        check("Quadrinity tab still renders panes", page.locator("#quadrinity-grid > *").count() >= 2)
        check("zero JS errors", not errs, "; ".join(errs[:3]))
        b.close()
finally:
    srv.terminate()
print(f"\n{sum(res)} passed, {len(res) - sum(res)} failed"); sys.exit(0 if all(res) else 1)
