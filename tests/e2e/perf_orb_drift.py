#!/usr/bin/env python3
"""Orb drift measurement (real Lightweight Charts): per animation frame, compare the Y at which each
orb was LAST painted against the chart's current price->pixel mapping for the same strike.

usage: python3 perf_orb_drift.py [web_root]
The old overlay-canvas build can be measured with a copy whose atlas-orbs.js records window.__orbDrawn.
"""
import json, os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from real_lwc import install_real_lwc
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = sys.argv[1] if len(sys.argv) > 1 else f"{ROOT}/frontend"
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18437"))

INIT = """(() => { let real; Object.defineProperty(window, 'createOrbLayer', { configurable: true,
  set(f) { real = function () { const l = f.apply(this, arguments); (window.__orbs = window.__orbs || []).push(l); return l; }; }, get() { return real; } }); })();"""
MEASURE = """async () => {
  const s = __series[0];
  const drawn = () => { const o = window.__orbs && window.__orbs[0] && window.__orbs[0].getDrawn ? window.__orbs[0].getDrawn() : null;
    if (o) { const r = {}; for (const k in o) r[k.split('@')[1]] = o[k]; return r; } return window.__orbDrawn || {}; };
  const out = [];
  const t0 = performance.now();
  await new Promise(res => { const f = () => { requestAnimationFrame(() => setTimeout(() => {
      const d = drawn(); let worst = 0, n = 0;
      for (const k in d) { const y = s.priceToCoordinate(parseFloat(k)); if (y == null) continue; n++; worst = Math.max(worst, Math.abs(d[k] - y)); }
      out.push([worst, n]);
      if (performance.now() - t0 < window.__dur) f(); else res(); }, 0)); }; f(); });
  return out;
}"""

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", WEB], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"]); pg = b.new_context(viewport={"width": 1700, "height": 950}).new_page()
        pg.add_init_script(INIT); install_real_lwc(pg)
        # live ticks while scrolling
        st = {"n": 0, "k": 0, "base": None, "last": None}
        def latest(route):
            bars = route.fetch().json(); st["n"] += 1
            if st["base"] is None: st["base"] = bars[-1]["time"]; st["last"] = bars[-1]
            if st["n"] > 3 and st["n"] % 2 == 0: st["k"] += 1
            if st["k"]:
                lb = st["last"]; t = st["base"] + st["k"] * 300; px = lb["close"] + (2.5 if st["k"] % 2 else -2.5)
                route.fulfill(json=[{"time": t - 300, **{k: lb[k] for k in ("open", "high", "low", "close")}}, {"time": t, "open": lb["close"], "high": px + .6, "low": px - .6, "close": px}])
            else: route.fulfill(json=bars)
        pg.route("**/api/candles/latest*", latest)
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(3000)
        box = pg.locator("#chart-pane .atlas-pane-chart").first.bounding_box()
        ax, ay = pg.evaluate("""() => { const c = [...document.querySelectorAll('#chart-pane canvas')].find(c => !c.className && c.clientWidth > 30 && c.clientWidth < 120 && c.clientHeight > 100);
          const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }""")
        results = {}
        def scenario(name, gesture, dur=2500):
            pg.evaluate(f"window.__dur = {dur}")
            import threading
            holder = {}
            th = threading.Thread(target=lambda: None)
            fut = pg.evaluate_handle(MEASURE)  # starts measuring (promise resolves after dur)
            return fut
        def run(name, gesture, dur=2600):
            pg.evaluate(f"window.__dur = {dur}")
            pg.evaluate("window.__m = null; (" + MEASURE + ")().then(r => { window.__m = r; })")
            gesture()
            pg.wait_for_function("window.__m !== null", timeout=20000)
            m = pg.evaluate("window.__m")
            worst = [w for w, n in m if n]
            results[name] = {"frames": len(m), "max_px": max(worst) if worst else None, "frames_over_0.5px": sum(1 for w in worst if w > 0.5), "frames_over_2px": sum(1 for w in worst if w > 2)}
        def slow_pan(): 
            pg.mouse.move(box["x"] + 300, box["y"] + 300); pg.mouse.down()
            for i in range(60): pg.mouse.move(box["x"] + 300 + i * 6, box["y"] + 300 + i * 3); pg.wait_for_timeout(25)
            pg.mouse.up()
        def fast_pan():
            pg.mouse.move(box["x"] + 300, box["y"] + 300); pg.mouse.down()
            for i in range(25): pg.mouse.move(box["x"] + 300 + i * 35, box["y"] + 300 - i * 12); pg.wait_for_timeout(8)
            pg.mouse.up()
        def zoom():
            pg.mouse.move(box["x"] + 700, box["y"] + 350)
            for i in range(14): pg.mouse.wheel(0, -120 if i < 7 else 120); pg.wait_for_timeout(60)
        def axis_drag():
            pg.mouse.move(ax, ay); pg.mouse.down()
            for i in range(40): pg.mouse.move(ax, ay - i * 3 if i < 20 else ay - 60 + (i - 20) * 3); pg.wait_for_timeout(25)
            pg.mouse.up()
        run("slow pan (time+price)", slow_pan); run("fast pan", fast_pan); run("wheel zoom", zoom); run("price-axis drag", axis_drag)
        run("idle with live ticks", lambda: pg.wait_for_timeout(2600))
        print(f"web root: {WEB}")
        for k, v in results.items(): print(f"  {k:28s} frames={v['frames']:4d}  worst drift={v['max_px']}px  frames>0.5px={v['frames_over_0.5px']}  frames>2px={v['frames_over_2px']}")
        print("RESULT_JSON " + json.dumps(results))
        b.close()
finally:
    srv.terminate()
