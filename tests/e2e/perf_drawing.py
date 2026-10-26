#!/usr/bin/env python3
"""Drawing-overlay projection performance (real Lightweight Charts, headless Chromium).

Scenario: 40 finished drawings on the chart, live candles arriving, the user drags out a new
Rectangle with a high-rate pointer (4 pointer events per animation frame, ~240 Hz at 60 fps).
Metrics, measured in the page:
  * handler ms/frame   — main-thread time spent INSIDE the pointer handlers per frame
  * input->paint ms    — time from the first pointer event of a frame until the frame is painted
  * frame delta ms     — rAF-to-rAF spacing (p50 / p95 / max): smoothness / dropped frames
  * hover preview      — time from one pointer move over the chart (tool armed, nothing pressed) to the
                         first painted preview pixel; 'never' if the build shows no pre-click preview.

usage: python3 perf_drawing.py [web_root] [frames]      (default: ../../frontend, 300)
Headless software rendering, so absolute numbers are machine-dependent: compare builds on one machine.
"""
import json, os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from real_lwc import install_real_lwc
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = sys.argv[1] if len(sys.argv) > 1 else f"{ROOT}/frontend"
FRAMES = int(sys.argv[2]) if len(sys.argv) > 2 else 300
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18433"))

PAGE_JS = r"""
async (frames) => {
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  const el = document.querySelector('#chart-pane .atlas-drawing-canvas');       // first drawing canvas (events bubble from it)
  const box = el.getBoundingClientRect();
  const ev = (type, x, y, buttons) => new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, buttons, button: 0, view: window });
  const cx = box.left + box.width * 0.45, cy = box.top + box.height * 0.5;
  const out = { hover: null };

  // arm the Rectangle tool
  document.querySelector('#chart-pane .atlas-drawing-tool-rect').click();
  await settle();

  // --- hover preview latency (nothing pressed) ---
  const px = () => { let n = 0; for (const c of document.querySelectorAll('#chart-pane .atlas-drawing-canvas')) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i-3] > 200 && d[i-2] > 150 && d[i-1] < 150) n++; }   // amber preview pixels
    return n; };
  const before = px();
  const t0 = performance.now();
  el.dispatchEvent(ev('mousemove', cx, cy, 0));
  let seen = null;
  for (let i = 0; i < 12 && seen === null; i++) { await settle(); if (px() > before) seen = performance.now() - t0; }
  out.hover = seen;

  // --- drag with 4 pointer events per frame ---
  el.dispatchEvent(ev('mousedown', cx, cy, 1));
  const handler = [], latency = [], deltas = [];
  let last = performance.now();
  for (let f = 0; f < frames; f++) {
    const base = f * 3.1;
    let h = 0; const first = performance.now();
    for (let k = 0; k < 4; k++) {
      const a = (f * 4 + k) / (frames * 4);
      const t = performance.now();
      el.dispatchEvent(ev('mousemove', cx + a * 420, cy - Math.sin(a * 9) * 90 - a * 60, 1));
      h += performance.now() - t;
    }
    await new Promise(r => requestAnimationFrame(r));
    const now = performance.now();
    await new Promise(r => setTimeout(r, 0));
    handler.push(h); latency.push(performance.now() - first); deltas.push(now - last); last = now;
  }
  el.dispatchEvent(ev('mouseup', cx + 420, cy - 60, 0));
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  out.handler = { mean: mean(handler), p95: q(handler, .95), max: Math.max(...handler) };
  out.latency = { mean: mean(latency), p95: q(latency, .95), max: Math.max(...latency) };
  out.frame = { p50: q(deltas, .5), p95: q(deltas, .95), max: Math.max(...deltas), over33: deltas.filter(d => d > 33.4).length, n: deltas.length };
  return out;
}
"""

SEED = """() => {
  const mk = (i) => { const types = ['rect', 'hline', 'long', 'short', 'range'];
    const t0 = %d, px = 590 + (i %% 9) * 3;
    return { type: types[i %% 5], p1: { time: t0 + i * 300, price: px }, p2: { time: t0 + (i + 6) * 300, price: px + 4 + (i %% 4) } }; };
  localStorage.setItem('skylit:drawings:SPY', JSON.stringify(Array.from({ length: 40 }, (_, i) => mk(i))));
}"""

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", WEB],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    base = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/candles?ticker=SPY&interval=5m").read())
    t0 = base[-30]["time"]
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1700, "height": 950})
        pg = ctx.new_page(); install_real_lwc(pg)
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(2000)
        pg.evaluate(SEED % t0)
        pg.reload(); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(2500)
        res = pg.evaluate(PAGE_JS, FRAMES)
        b.close()
    h = res["hover"]
    print(f"web root: {WEB}")
    print(f"  hover -> first preview paint : {'never (no pre-click preview)' if h is None else f'{h:.1f} ms'}")
    print(f"  pointer-handler time / frame : mean {res['handler']['mean']:.2f} ms   p95 {res['handler']['p95']:.2f}   max {res['handler']['max']:.2f}")
    print(f"  input -> painted             : mean {res['latency']['mean']:.2f} ms   p95 {res['latency']['p95']:.2f}   max {res['latency']['max']:.2f}")
    print(f"  frame spacing                : p50 {res['frame']['p50']:.1f} ms   p95 {res['frame']['p95']:.1f}   max {res['frame']['max']:.1f}   frames>33ms: {res['frame']['over33']}/{res['frame']['n']}")
    print("RESULT_JSON " + json.dumps(res))
finally:
    srv.terminate()
