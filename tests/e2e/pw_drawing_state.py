#!/usr/bin/env python3
"""Fixes S1 — drawing tool state machine: no lingering projection after placement, every cancel path
returns to idle, no listener growth over 50 place/cancel cycles (real Lightweight Charts)."""
import os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from real_lwc import install_real_lwc
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = sys.argv[1] if len(sys.argv) > 1 else f"{ROOT}/frontend"
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18435"))
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))


INIT = """
(() => { let real; Object.defineProperty(window, 'createDrawingLayer', { configurable: true,
  set(f) { real = function () { const l = f.apply(this, arguments); (window.__layers = window.__layers || []).push(l); return l; }; }, get() { return real; } }); })();
// net listener bookkeeping on the elements/targets that drawing uses
window.__lc = 0;
const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
const seen = new WeakMap();
EventTarget.prototype.addEventListener = function (t, f, o) { if (f) { const k = t + '|' + (o && o.capture || o === true); let m = seen.get(this); if (!m) seen.set(this, m = new Map()); if (!m.has(f)) m.set(f, new Set()); if (!m.get(f).has(k)) { m.get(f).add(k); window.__lc++; } } return add.call(this, t, f, o); };
EventTarget.prototype.removeEventListener = function (t, f, o) { const m = seen.get(this); const k = t + '|' + (o && o.capture || o === true); if (m && m.has(f) && m.get(f).delete(k)) window.__lc--; return rem.call(this, t, f, o); };
"""
PREVPIX = """() => { const c = document.querySelector('#chart-pane .atlas-drawing-preview'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 20) return true; return false; }"""

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", WEB], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        pg = b.new_context(viewport={"width": 1700, "height": 950}).new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        pg.add_init_script(INIT); install_real_lwc(pg)
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(2500)
        box = pg.locator("#chart-pane .atlas-pane-chart").first.bounding_box()
        X0, Y0 = box["x"], box["y"]; cx, cy = X0 + 500, Y0 + box["height"] * 0.45
        def frames(n=2): pg.evaluate("(n) => new Promise(r => { let i = 0; const f = () => ++i >= n ? setTimeout(r, 0) : requestAnimationFrame(f); requestAnimationFrame(f); })", n)
        mode = lambda: pg.evaluate("() => window.__layers[0].getMode()")
        tool = lambda: pg.evaluate("() => window.__layers[0].getTool()")
        def sweep():
            for i in range(0, 12):
                pg.mouse.move(X0 + 60 + i * 80, Y0 + 80 + (i % 4) * 90); pg.wait_for_timeout(25)
            frames(3)
        def place(t, two=True):
            pg.click(f"#chart-pane .atlas-drawing-tool-{t}")
            pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 90, cy - 40, steps=4); pg.mouse.up(); frames(3)

        print("[1] one drawing per activation; no lingering preview")
        for t in ["hline", "rect", "short", "long", "range"]:
            place(t); sweep()
            check(f"{t}: committed, tool back to idle/cursor, no preview anywhere after sweeping the chart",
                  mode() == "idle" and tool() == "cursor" and not pg.evaluate(PREVPIX))
        n = pg.evaluate("() => window.__layers[0].getDrawingCount()")
        check("five drawings stored", n == 5, str(n))
        pg.click("#chart-pane .atlas-drawing-tool-cursor")
        # normal behaviour back: dragging the chart pans it
        lr0 = pg.evaluate("() => __charts[0].timeScale().getVisibleLogicalRange().from")
        pg.mouse.move(X0 + 600, Y0 + 500); pg.mouse.down(); pg.mouse.move(X0 + 760, Y0 + 500, steps=6); pg.mouse.up(); frames(2)
        check("chart pans normally afterwards", pg.evaluate("() => __charts[0].timeScale().getVisibleLogicalRange().from") < lr0 - 2)
        # other interactions never re-trigger a preview
        pg.mouse.wheel(0, -200); frames(2); pg.click(".atlas-interval-btn:has-text('15m')"); pg.wait_for_timeout(1500)
        pg.click(".atlas-interval-btn:has-text('5m')"); pg.wait_for_timeout(1500)
        sweep()
        check("scroll/zoom/timeframe change: still no preview", mode() == "idle" and not pg.evaluate(PREVPIX))

        print("[2] every cancel path returns to idle")
        def armed(t="rect", placing=False):
            pg.click(f"#chart-pane .atlas-drawing-tool-{t}"); pg.mouse.move(cx, cy); frames(2)
            if placing: pg.mouse.down(); pg.mouse.up(); pg.mouse.move(cx + 80, cy - 40); frames(2)
        armed(placing=True); check("setup: placing", mode() == "placing")
        pg.keyboard.press("Escape"); frames(2); check("Esc during placing cancels the placement (tool stays armed)", mode() == "armed" and not pg.evaluate("() => !!window.__layers[0].getPreview() && window.__layers[0].getPreview().placing"))
        pg.keyboard.press("Escape"); frames(2); check("second Esc: idle", mode() == "idle" and not pg.evaluate(PREVPIX))
        armed(); pg.mouse.click(cx, cy, button="right"); frames(2)
        check("right-click while armed: idle, no preview", mode() == "idle" and not pg.evaluate(PREVPIX))
        armed(placing=True); pg.mouse.click(cx + 10, cy + 10, button="right"); frames(2); pg.mouse.click(cx + 10, cy + 10, button="right"); frames(2)
        check("right-click while placing then again: idle", mode() == "idle" and not pg.evaluate(PREVPIX))
        armed(); pg.click("#chart-pane .atlas-drawing-tool-rect"); frames(2)
        check("clicking the active tool button again: idle", mode() == "idle" and not pg.evaluate(PREVPIX))
        armed("rect", placing=True); pg.click("#chart-pane .atlas-drawing-tool-hline"); frames(2)
        check("selecting a different tool resets placement (armed with the new tool, not placing)", tool() == "hline" and mode() == "armed")
        pg.click("#chart-pane .atlas-drawing-tool-cursor")
        armed("rect", placing=True); pg.click(".atlas-interval-btn:has-text('15m')"); pg.wait_for_timeout(1500)
        check("timeframe change mid-placement: idle", mode() == "idle" and not pg.evaluate(PREVPIX))
        pg.click(".atlas-interval-btn:has-text('5m')"); pg.wait_for_timeout(1200)
        armed("rect", placing=True)
        pg.select_option(".atlas-pane-ticker-select", index=1); pg.wait_for_timeout(1500)
        check("ticker change mid-placement: idle, no preview", mode() == "idle" and not pg.evaluate(PREVPIX))
        pg.select_option(".atlas-pane-ticker-select", index=0); pg.wait_for_timeout(1500)
        pg.mouse.move(X0 + 100, Y0 + 100); frames(2)
        check("switching back: still idle", mode() == "idle")

        print("[3] sticky mode is an explicit opt-in (off by default)")
        check("sticky off by default", "active" not in (pg.get_attribute("#chart-pane .atlas-drawing-sticky-btn", "class") or ""))
        pg.click("#chart-pane .atlas-drawing-sticky-btn"); place("rect")
        check("with 'keep drawing' ON the tool stays armed after placing", mode() == "armed")
        pg.click("#chart-pane .atlas-drawing-sticky-btn"); pg.click("#chart-pane .atlas-drawing-tool-cursor"); frames(2)

        print("[4] 50 place/cancel cycles: no listener growth")
        # warm up once, then compare
        place("rect"); frames(2)
        base = pg.evaluate("() => window.__lc")
        for i in range(50):
            pg.click("#chart-pane .atlas-drawing-tool-rect"); pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.up(); pg.mouse.move(cx + 40, cy - 20)
            if i % 2 == 0: pg.keyboard.press("Escape"); pg.keyboard.press("Escape")
            else: pg.mouse.down(); pg.mouse.up()
        frames(3)
        after = pg.evaluate("() => window.__lc")
        check("listener count unchanged after 50 cycles", after == base, f"{base} -> {after}")
        check("no console/page errors", not errs, str(errs[:3]))
        b.close()
finally:
    srv.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
