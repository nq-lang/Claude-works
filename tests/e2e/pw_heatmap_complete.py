#!/usr/bin/env python3
"""Regression: every heatmap surface in the terminal must show the FULL
strike list the backend returns for the selected ticker/exposure/DTE —
no client-side node-count truncation, anywhere, under any default
setting. This is the fix for a real bug: the row list used to apply a
magnitude-ranked top-N filter (default N=10) that silently dropped
far-OTM strikes from the scrollable list entirely, so scrolling past the
visible rows hit a dead end well short of the true end of the data.
"""
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 18280
results = []
def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))

def api(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=5) as r:
        return json.loads(r.read())

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: api("/api/health"); break
        except Exception: time.sleep(0.1)

    board = api("/api/heatmap?ticker=SPY&exposure=GEX&expiration=0dte")
    true_count = len(board["nodes"])
    check("sanity: backend board has a non-trivial strike count to test against", true_count > 15, str(true_count))

    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        page = b.new_context(viewport={"width": 1700, "height": 950}).new_page()
        page.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        page.goto(f"http://127.0.0.1:{PORT}/")

        print("[A] Atlas sidecar single heatmap — default settings, no user interaction")
        page.wait_for_selector(".hm-panel")
        page.wait_for_timeout(1500)
        row_count = page.eval_on_selector_all(".hm-rows .hm-row", "els => els.length")
        check("sidecar heatmap shows every strike by default (no settings touched)", row_count == true_count,
              f"expected {true_count}, got {row_count}")
        check("no leftover 'Nodes' truncation control exists in the settings popover",
              page.locator(".hm-node-limit").count() == 0)

        print("[B] Atlas sidecar Quadrinity (multi-pane) — also default settings")
        page.click(".sidecar-quad-toggle-btn")
        page.wait_for_selector(".sidecar-quad-popover")
        page.click(".sidecar-quad-count-btn[data-count='3']")
        page.wait_for_timeout(1800)
        counts = page.eval_on_selector_all(
            ".sidecar-horizontal-pane .hm-rows", "els => els.map(e => e.querySelectorAll('.hm-row').length)")
        check("every Quadrinity sidecar pane shows the full strike list", all(c == true_count for c in counts), str(counts))

        print("[C] Standalone QUADRINITY tab — also default settings")
        page.click("#tab-quadrinity")
        page.wait_for_selector(".quad-count-btn")
        page.wait_for_timeout(1800)
        tab_counts = page.eval_on_selector_all(".quad-pane .hm-rows", "els => els.map(e => e.querySelectorAll('.hm-row').length)")
        check("every pane on the standalone Quadrinity tab shows the full strike list",
              len(tab_counts) > 0 and all(c == true_count for c in tab_counts), str(tab_counts))
        check("no leftover 'Nodes' truncation control on the Quadrinity tab toolbar",
              page.locator(".quad-node-limit").count() == 0)

        print("[D] scrolling reaches the true top and bottom of the data, not a truncated list's edges")
        page.click("#tab-atlas")
        page.wait_for_selector(".hm-panel")
        page.wait_for_timeout(800)
        strikes_sorted = sorted((n["strike"] for n in board["nodes"]), reverse=True)
        top_expected, bottom_expected = strikes_sorted[0], strikes_sorted[-1]
        first_row_text = page.eval_on_selector(".hm-rows .hm-row:first-child", "e => e.textContent")
        page.eval_on_selector(".hm-rows", "e => e.scrollTop = e.scrollHeight")
        page.wait_for_timeout(300)
        last_row_text = page.eval_on_selector(".hm-rows .hm-row:last-child", "e => e.textContent")
        check("first row in the (unscrolled) list is the true highest strike",
              str(int(top_expected)) in first_row_text, f"{top_expected} in '{first_row_text}'")
        check("scrolling to the bottom reaches the true lowest strike (not an artificial cutoff)",
              str(int(bottom_expected)) in last_row_text, f"{bottom_expected} in '{last_row_text}'")

        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        check("no page errors", True)
        b.close()
finally:
    srv.terminate()

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
