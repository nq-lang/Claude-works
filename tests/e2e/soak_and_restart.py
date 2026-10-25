#!/usr/bin/env python3
"""Sustained-run and backend-restart checks.

  1. SOAK: a real browser (multi-pane Atlas + 4-heatmap sidecar) plus two extra API
     clients run for SOAK_SECONDS (default 60). Server RSS / threads / open fds and the
     page's JS heap / DOM nodes must stay flat (no leak, no unbounded buffers), the page
     must log no errors, and the UI must keep updating.
  2. RESTART: the backend is killed while the page is open, then started again. The page
     must report the outage without throwing, and recover on its own.

    python3 tests/e2e/soak_and_restart.py [SOAK_SECONDS]
"""
import os
import subprocess
import sys
import threading
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 18530
SOAK = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 60
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))


def start_server():
    p = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(80):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1)
            return p
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def proc_stats(pid):
    rss = threads = 0
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                rss = int(line.split()[1])
            elif line.startswith("Threads:"):
                threads = int(line.split()[1])
    return rss, threads, len(os.listdir(f"/proc/{pid}/fd"))


def get(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=5) as r:
        return r.read()


srv = start_server()
stop_clients = threading.Event()
client_errors = []


def api_client(paths):
    i = 0
    while not stop_clients.is_set():
        try:
            get(paths[i % len(paths)])
        except Exception as e:  # noqa: BLE001
            client_errors.append(str(e))
        i += 1
        time.sleep(0.05)


try:
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None,
                                     args=["--no-sandbox", "--enable-precise-memory-info"])
        page = browser.new_context(viewport={"width": 1700, "height": 950}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        page.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        page.goto(f"http://127.0.0.1:{PORT}/")
        page.wait_for_selector(".atlas-pane-price")
        # Busy configuration: 4 Atlas panes + 4 sidecar heatmaps.
        page.click(".sidecar-quad-toggle-btn")
        page.click(".sidecar-quad-count-btn[data-count='4']")
        page.wait_for_timeout(500)
        try:
            page.click("#atlas-layout-controls button:has-text('Layout')", timeout=2000)
            page.click(".atlas-layout-option >> nth=3", timeout=2000)
            page.keyboard.press("Escape")
        except Exception:  # noqa: BLE001  (layout picker differences must not fail the soak)
            pass
        page.wait_for_timeout(1500)

        threads = [threading.Thread(target=api_client, daemon=True, args=([
            "/api/quadrinity?tickers=SPXW,SPY,QQQ,NVDA", "/api/heatmap?ticker=SPY&exposure=GEX&expiration=dte:0,1,2",
            "/api/projection?ticker=QQQ&interval=5m&dte=1", "/api/candles?ticker=NVDA&interval=1m"],)),
            threading.Thread(target=api_client, daemon=True, args=([
                "/api/candles/latest?ticker=SPY&interval=1m", "/api/flow?ticker=SPY&interval=5m", "/api/darkpool?ticker=SPY"],))]
        [t.start() for t in threads]

        def browser_stats():
            return page.evaluate("() => ({heap: performance.memory ? performance.memory.usedJSHeapSize : 0,"
                                 " dom: document.getElementsByTagName('*').length})")

        print(f"[1] soak for {SOAK}s (browser: 4 panes + 4 heatmaps; plus 2 API clients)")
        time.sleep(5)  # warm-up (JIT, caches, history deques)
        r0, th0, fd0 = proc_stats(srv.pid)
        b0 = browser_stats()
        price0 = page.inner_text(".atlas-pane-price")
        samples = []
        t_end = time.time() + SOAK
        while time.time() < t_end:
            time.sleep(max(1, SOAK // 6))
            samples.append((proc_stats(srv.pid), browser_stats()))
        (r1, th1, fd1), b1 = samples[-1]
        price1 = page.inner_text(".atlas-pane-price")
        print(f"       server RSS {r0} -> {r1} KB, threads {th0} -> {th1}, fds {fd0} -> {fd1}")
        print(f"       browser JS heap {b0['heap'] / 1e6:.1f} -> {b1['heap'] / 1e6:.1f} MB, DOM nodes {b0['dom']} -> {b1['dom']}")
        check("server RSS growth < 5 MB over the run", r1 - r0 < 5 * 1024, f"{(r1 - r0) / 1024:.2f} MB")
        check("server thread count unchanged (no thread leak)", th1 <= th0 + 1, f"{th0} -> {th1}")
        check("server fd count unchanged (no socket leak)", fd1 <= fd0 + 2, f"{fd0} -> {fd1}")
        check("browser DOM node count stable", b1["dom"] <= b0["dom"] * 1.1 + 50, f"{b0['dom']} -> {b1['dom']}")
        if b0["heap"]:
            check("browser JS heap growth < 40 MB over the run (GC noise allowed)", b1["heap"] - b0["heap"] < 40e6)
        check("live price kept updating", price0 != price1, f"{price0} -> {price1}")
        check("API clients saw no errors", not client_errors, str(client_errors[:2]))
        check("no console/page errors during soak", not errors, "; ".join(errors[:3]))
        stop_clients.set()
        [t.join(timeout=3) for t in threads]

        print("[2] backend restart while the page is open")
        errors.clear()
        srv.terminate()
        srv.wait(timeout=10)
        page.wait_for_timeout(7000)
        label = page.inner_text("#backend-label")
        check("page reports the outage instead of crashing", "unreachable" in label.lower(), label)
        srv = start_server()
        page.wait_for_timeout(9000)
        label = page.inner_text("#backend-label")
        check("page recovers on its own after the backend returns", "ok" in label.lower(), label)
        t_a = page.inner_text(".atlas-pane-price")
        page.wait_for_timeout(3000)
        check("live data resumes (price is a number)", t_a.startswith("$"), t_a)
        hm_err = page.locator(".hm-error").count()
        check("no heatmap panel stuck on an error message", hm_err == 0, str(hm_err))
        check("no uncaught page errors during the outage", not [e for e in errors if "Failed to fetch" not in e and "ERR_CONNECTION" not in e
                                                              and "NetworkError" not in e and "Failed to load resource" not in e],
              "; ".join(errors[:3]))
        browser.close()
finally:
    stop_clients.set()
    srv.terminate()
    try:
        srv.wait(timeout=5)
    except Exception:  # noqa: BLE001
        srv.kill()

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
