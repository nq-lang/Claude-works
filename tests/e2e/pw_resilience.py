#!/usr/bin/env python3
"""Frontend resilience under a slow link (what a Live Share guest experiences).

Runs the real page through a latency proxy and checks that
  A. polling does not stack requests when responses are slower than the poll period,
  B. a late response for a previous ticker never overwrites the newly selected one,
  C. rebuilding heatmap panels does not leak document-level listeners,
  D. nothing logs a console / page error throughout.

    python3 tests/e2e/pw_resilience.py            # uses ./build/skylit_server and ./frontend
    SKYLIT_WEB_ROOT=/path/to/other/frontend python3 tests/e2e/pw_resilience.py   # test another frontend copy
"""
import os
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from latency_proxy import LatencyProxy  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = os.environ.get("SKYLIT_WEB_ROOT", f"{ROOT}/frontend")
SERVER_PORT, PROXY_PORT = 18510, 18511
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))


srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(SERVER_PORT), "--web-root", WEB],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mode = {"slow_spy_candles": False, "all_slow": False}


def delay(target):
    u = urlparse(target)
    if not u.path.startswith("/api/") or u.path == "/api/health":
        return 0.0
    if mode["all_slow"]:
        return 1.6
    if mode["slow_spy_candles"] and u.path.startswith("/api/candles") and parse_qs(u.query).get("ticker") == ["SPY"]:
        return 3.0
    return 0.0


proxy = None
try:
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{SERVER_PORT}/api/health", timeout=1)
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    proxy = LatencyProxy(PROXY_PORT, SERVER_PORT, delay).start()
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])

        def new_page():
            ctx = browser.new_context(viewport={"width": 1700, "height": 950})
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
            page.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
            return ctx, page, errors

        # ---------------------------------------------------------- A: no request pile-up
        print("[A] slow link: polling must not stack requests")
        mode["all_slow"] = True
        ctx, page, errors = new_page()
        inflight, peak = defaultdict(int), defaultdict(int)

        def key(url):
            p = urlparse(url).path
            return p if p.startswith("/api/") else None

        def on_req(r):
            k = key(r.url)
            if k:
                inflight[k] += 1
                peak[k] = max(peak[k], inflight[k])

        def on_done(r):
            k = key(r.url)
            if k:
                inflight[k] = max(0, inflight[k] - 1)

        page.on("request", on_req)
        page.on("requestfinished", on_done)
        page.on("requestfailed", on_done)
        page.goto(f"http://127.0.0.1:{PROXY_PORT}/")
        page.wait_for_selector(".atlas-pane-price")
        page.wait_for_timeout(8000)          # let the startup burst of explicit loads settle...
        proxy.reset_peaks()
        page.wait_for_timeout(10000)         # ...then measure steady-state polling only
        # Concurrency is measured at the proxy (what the server actually sees), which is more
        # reliable than browser request events.
        peak = defaultdict(int, proxy.peak_by_path)
        print("       steady-state peak concurrent per endpoint:", dict(peak))
        check("/api/candles/latest never has >1 request in flight", peak["/api/candles/latest"] <= 1, str(peak["/api/candles/latest"]))
        check("/api/heatmap never has >2 requests in flight (orbs + sidecar panel, one each)", peak["/api/heatmap"] <= 2, str(peak["/api/heatmap"]))
        check("/api/quadrinity never has >1 request in flight", peak["/api/quadrinity"] <= 1, str(peak["/api/quadrinity"]))
        check("page rendered data despite 1.6s latency", page.inner_text(".atlas-pane-price").startswith("$"))
        check("no console/page errors on a slow link", not errors, "; ".join(errors[:3]))
        ctx.close()
        mode["all_slow"] = False

        # ---------------------------------------------------------- B: stale ticker response
        print("[B] stale response after a ticker switch")
        mode["slow_spy_candles"] = True
        ctx, page, errors = new_page()
        page.goto(f"http://127.0.0.1:{PROXY_PORT}/")
        page.wait_for_selector(".atlas-pane-price")
        page.select_option(".atlas-pane-ticker-select", "SPXW")   # SPY's slow candle request is still in flight
        # Sample the header every 100ms while the stale SPY reply lands (~3s): the 1s candle poll
        # would heal a wrong price within a second, so a single late read cannot catch the glitch.
        seen = []
        for _ in range(90):
            seen.append(page.inner_text(".atlas-pane-price"))
            page.wait_for_timeout(100)
        def value(t):
            try:
                return float(t.replace("$", "").replace(",", ""))
            except ValueError:
                return None
        vals = [v for v in map(value, seen) if v is not None]
        wrong = [v for v in vals if v < 1000]        # SPY trades ~570, SPXW ~5700
        print(f"       {len(vals)} header samples, range {min(vals):.2f}..{max(vals):.2f}; samples showing SPY's price: {len(wrong)}")
        check("header never flashes the stale SPY reply after switching to SPXW", vals and not wrong, f"{len(wrong)} bad samples")
        check("header ends on SPXW (~$57xx)", vals and vals[-1] > 1000, str(vals[-1] if vals else None))
        check("no console/page errors during ticker race", not errors, "; ".join(errors[:3]))
        ctx.close()
        mode["slow_spy_candles"] = False

        # ---------------------------------------------------------- C: listener leak on rebuild
        print("[C] heatmap panel rebuilds do not leak document listeners")
        ctx, page, errors = new_page()
        page.goto(f"http://127.0.0.1:{PROXY_PORT}/")
        page.wait_for_selector(".sidecar-quad-toggle-btn")
        page.wait_for_timeout(800)
        cdp = ctx.new_cdp_session(page)

        def doc_click_listeners():
            obj = cdp.send("Runtime.evaluate", {"expression": "document"})["result"]["objectId"]
            ls = cdp.send("DOMDebugger.getEventListeners", {"objectId": obj})["listeners"]
            return sum(1 for l in ls if l["type"] == "click")

        base = doc_click_listeners()
        for _ in range(6):
            for n in ("4", "2", "3", "0"):
                page.click(".sidecar-quad-toggle-btn")
                page.click(f".sidecar-quad-count-btn[data-count='{n}']")
        page.click(".sidecar-quad-toggle-btn")
        page.click(".sidecar-quad-count-btn[data-count='2']")
        page.wait_for_timeout(500)
        after = doc_click_listeners()
        print(f"       document click listeners: {base} before, {after} after 24 rebuilds")
        # A fixed few are legitimately live (current panels); a leak would add ~2 per rebuilt panel (~140).
        check("document click listener count stays bounded across rebuilds", after <= base + 6, f"{base} -> {after}")
        check("no console/page errors during rebuilds", not errors, "; ".join(errors[:3]))
        ctx.close()
        browser.close()
finally:
    if proxy:
        proxy.stop()
    srv.terminate()
    try:
        srv.wait(timeout=5)
    except Exception:  # noqa: BLE001
        srv.kill()

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
