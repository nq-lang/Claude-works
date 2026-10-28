#!/usr/bin/env python3
"""S8 — frontend profile (real Lightweight Charts, headless/software-rendered Chromium, so absolute numbers are
pessimistic): frame pacing during pan/zoom, ticker-switch latency, JS heap + DOM/listener growth over a soak."""
import os, subprocess, sys, time, urllib.request, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from real_lwc import install_real_lwc
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = sys.argv[1] if len(sys.argv) > 1 else f"{ROOT}/frontend"
SOAK = float(os.environ.get("SOAK_SECONDS", "60")); PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18439"))
srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", WEB], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
FRAMES = """() => { window.__ft = []; let last = performance.now(); window.__ftOn = true;
  const f = (t) => { if (!window.__ftOn) return; window.__ft.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); }"""
def stats(ft):
    ft = ft[3:] or [0]; s = sorted(ft)
    return f"frames={len(ft)} mean={statistics.mean(ft):.1f}ms p95={s[int(len(s)*.95)-1]:.1f}ms max={max(ft):.0f}ms >33ms={sum(1 for x in ft if x>33.4)}"
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox", "--enable-precise-memory-info"])
        pg = b.new_context(viewport={"width": 1700, "height": 950}).new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        install_real_lwc(pg); pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(3000)
        box = pg.locator("#chart-pane .atlas-pane-chart").first.bounding_box(); X0, Y0 = box["x"], box["y"]
        def phase(name, fn):
            pg.evaluate(FRAMES); fn(); pg.evaluate("() => { window.__ftOn = false; }"); pg.wait_for_timeout(50)
            print(f"  {name:28s} {stats(pg.evaluate('() => window.__ft'))}")
        def pan():
            pg.mouse.move(X0 + 600, Y0 + 400); pg.mouse.down()
            for i in range(120): pg.mouse.move(X0 + 600 + (i % 60) * 4, Y0 + 400)
            pg.mouse.up()
        def zoom():
            pg.mouse.move(X0 + 600, Y0 + 400)
            for i in range(60): pg.mouse.wheel(0, -120 if i % 2 == 0 else 120); pg.wait_for_timeout(8)
        def idle(): pg.wait_for_timeout(3000)
        phase("idle (live ticks)", idle); phase("pan drag", pan); phase("wheel zoom", zoom)
        t = []
        for tk in ["QQQ", "TSLA", "VIX", "SPY"]:
            t0 = time.perf_counter(); pg.select_option(".atlas-pane-ticker-select", tk)
            pg.wait_for_function("(t) => document.querySelector('.atlas-pane-ticker-select').value === t", arg=tk)
            pg.wait_for_timeout(50); pg.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
            t.append((time.perf_counter() - t0) * 1000)
        print(f"  ticker switch latency ms    {[round(x) for x in t]}")
        cdp = pg.context.new_cdp_session(pg)
        def snap():
            cdp.send("HeapProfiler.collectGarbage")
            m = {x["name"]: x["value"] for x in cdp.send("Performance.getMetrics")["metrics"]}
            return m["JSHeapUsedSize"] / 1e6, m["Nodes"], m["JSEventListeners"]
        cdp.send("Performance.enable"); h0 = snap(); t0 = time.time(); hs = [h0]
        while time.time() - t0 < SOAK:
            pg.wait_for_timeout(5000); pan(); hs.append(snap())
        print(f"  soak {SOAK:.0f}s heap MB {hs[0][0]:.1f} -> {hs[-1][0]:.1f}; DOM nodes {hs[0][1]} -> {hs[-1][1]}; listeners {hs[0][2]} -> {hs[-1][2]}")
        print(f"  errors: {errs[:3]}"); b.close()
finally: srv.terminate()
