#!/usr/bin/env python3
"""WS1 — chart VIEW persistence, against the REAL Lightweight Charts build (tests/e2e/vendor).

The stub-based suites cannot see this class of bug (a stub has no user-adjustable price scale), so
this suite loads the genuine library and drives the genuine mouse gestures:

  * price axis (Y) set manually survives polls, new candles, same-ticker re-fetch, a candle far
    outside the visible price range, bursts of updates, and a resize;
  * time axis (X) scrolled back is not pulled forward by new candles; zoom at the live edge keeps
    its bar spacing while following; a drag in progress while data arrives is not fought;
  * context changes (timeframe) and the explicit Reset view DO restore the automatic view.

New candles are synthesised by rewriting /api/candles/latest in the browser (the synthetic backend
is otherwise stationary within a run), so the data genuinely grows.

usage: python3 pw_chart_view.py [web_root]     (default: ../../frontend)
"""
import os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from real_lwc import install_real_lwc
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = sys.argv[1] if len(sys.argv) > 1 else f"{ROOT}/frontend"
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18430"))
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))


VIEW = """() => { const c = __charts[0], s = __series[0], ts = c.timeScale();
  const el = document.querySelector('#chart-pane .atlas-pane-chart'); const H = el.clientHeight - ts.height();
  return { pTop: s.coordinateToPrice(0), pBot: s.coordinateToPrice(H), auto: s.priceScale().options().autoScale,
           lr: ts.getVisibleLogicalRange(), spacing: ts.options().barSpacing, n: s.data().length,
           lastTime: s.data()[s.data().length - 1].time }; }"""

AXIS_POINT = """() => { const c = [...document.querySelectorAll('#chart-pane canvas')]
  .find(c => !c.className && c.clientWidth > 30 && c.clientWidth < 120 && c.clientHeight > 100);
  const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"""


def close(a, b, tol):
    return abs(a - b) <= tol


def price_same(v0, v1, rel=1e-4):
    span = v0["pTop"] - v0["pBot"]
    return close(v0["pTop"], v1["pTop"], span * rel) and close(v0["pBot"], v1["pBot"], span * rel)


def range_same(v0, v1, tol=1e-6):
    return close(v0["lr"]["from"], v1["lr"]["from"], tol) and close(v0["lr"]["to"], v1["lr"]["to"], tol)


def drag(pg, x, y, dx, dy, steps=20, wait=15):
    pg.mouse.move(x, y); pg.wait_for_timeout(60)
    pg.mouse.down(); pg.wait_for_timeout(60)
    for i in range(1, steps + 1):
        pg.mouse.move(x + dx * i / steps, y + dy * i / steps); pg.wait_for_timeout(wait)
    pg.mouse.up(); pg.wait_for_timeout(150)


class Feed:
    """Rewrites /api/candles/latest so that every 2nd poll after arm() carries a NEW candle."""
    def __init__(self):
        self.k = 0; self.n = 0; self.base = None; self.last = None; self.armed = False; self.spike = 0.0
        self.every = 2

    def handler(self, route):
        resp = route.fetch(); bars = resp.json(); self.n += 1
        if self.base is None:
            self.base = bars[-1]["time"]; self.last = bars[-1]
        if self.armed and self.n % self.every == 0:
            self.k += 1
        if self.k > 0:
            lb = self.last; t = self.base + self.k * 300
            px = lb["close"] + (1.5 if self.k % 2 else -1.5) + self.spike
            route.fulfill(json=[{"time": t - 300, "open": lb["open"], "high": lb["high"], "low": lb["low"], "close": lb["close"]},
                                {"time": t, "open": lb["close"], "high": px + 0.4, "low": px - 0.4, "close": px}])
        else:
            route.fulfill(json=bars)


srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", WEB],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)

    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])

        def fresh(viewport=None):
            ctx = b.new_context(viewport=viewport or {"width": 1700, "height": 950})
            pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            install_real_lwc(pg)
            feed = Feed(); pg.route("**/api/candles/latest*", feed.handler)
            pg.goto(f"http://127.0.0.1:{PORT}/")
            pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(2500)
            return ctx, pg, feed, errs

        # ---------------------------------------------------------------- price axis
        print("[A] price axis: manual scale survives data updates")
        ctx, pg, feed, errs = fresh()
        ax, ay = pg.evaluate(AXIS_POINT)
        v_auto = pg.evaluate(VIEW)
        check("starts in automatic price scale", v_auto["auto"] is True)
        drag(pg, ax, ay, 0, -90)                                   # user stretches the price axis
        v0 = pg.evaluate(VIEW)
        check("dragging the price axis switches to manual scale and changes the range",
              v0["auto"] is False and not price_same(v_auto, v0), f"{v_auto['pTop']:.2f}->{v0['pTop']:.2f}")
        pg.wait_for_timeout(4200)                                  # >= 4 orb/projection/candle polls (no new bars yet)
        v1 = pg.evaluate(VIEW)
        check("price range unchanged across 4+ polls (orbs/projection/candles)", v1["auto"] is False and price_same(v0, v1),
              f"{v0['pTop']:.3f}/{v0['pBot']:.3f} vs {v1['pTop']:.3f}/{v1['pBot']:.3f}")
        feed.armed = True
        pg.wait_for_timeout(9000)                                  # ~4 NEW candles + ~9 ticks
        v2 = pg.evaluate(VIEW)
        check("new candles arrived during the test", v2["n"] >= v0["n"] + 3, f"{v0['n']}->{v2['n']}")
        check("price range unchanged across new candles", v2["auto"] is False and price_same(v0, v2),
              f"{v0['pTop']:.3f}/{v0['pBot']:.3f} vs {v2['pTop']:.3f}/{v2['pBot']:.3f}")
        feed.spike = 60.0                                          # next candles print far outside the visible range
        pg.wait_for_timeout(6500)
        v3 = pg.evaluate(VIEW)
        check("candle far outside the visible price range does NOT rescale the axis",
              v3["auto"] is False and price_same(v0, v3), f"{v3['pTop']:.2f}/{v3['pBot']:.2f}")
        feed.spike = 0.0
        # same-ticker re-fetch (history reload) = data refresh, not a context change
        pg.evaluate("() => { const s = document.querySelector('.atlas-pane-ticker-select'); s.dispatchEvent(new Event('change')); }")
        pg.wait_for_timeout(1500)
        v4 = pg.evaluate(VIEW)
        check("same-ticker history re-fetch keeps the manual price scale", v4["auto"] is False and price_same(v0, v4))
        # burst: 300 rapid updates straight into the series
        pg.evaluate("""() => { const s = __series[0]; const d = s.data(); let l = d[d.length-1];
          for (let i = 0; i < 300; i++) { l = { ...l, close: l.close + (i % 2 ? 0.3 : -0.3), high: Math.max(l.high, l.close + 0.5), low: Math.min(l.low, l.close - 0.5) }; s.update(l); } }""")
        pg.wait_for_timeout(300)
        v5 = pg.evaluate(VIEW)
        check("burst of 300 updates keeps the manual price scale", v5["auto"] is False and price_same(v0, v5))
        check("no page errors", not errs, str(errs[:2]))
        ctx.close()

        # ---------------------------------------------------------------- time axis
        print("[B] time axis: scrolled-back / zoomed view is not pulled forward")
        ctx, pg, feed, errs = fresh()
        box = pg.locator("#chart-pane .atlas-pane-chart").first.bounding_box()
        drag(pg, box["x"] + 300, box["y"] + box["height"] / 2, 600, 0, steps=24)   # pan back into history
        v0 = pg.evaluate(VIEW)
        check("panned back: newest bar is off-screen", v0["lr"]["to"] < v0["n"] - 1, f"to={v0['lr']['to']:.1f} n={v0['n']}")
        feed.armed = True
        pg.wait_for_timeout(9000)
        v1 = pg.evaluate(VIEW)
        check("new candles arrived", v1["n"] >= v0["n"] + 3, f"{v0['n']}->{v1['n']}")
        check("scrolled-back window (logical range) unchanged across new candles", range_same(v0, v1),
              f"[{v0['lr']['from']:.2f},{v0['lr']['to']:.2f}] vs [{v1['lr']['from']:.2f},{v1['lr']['to']:.2f}]")
        check("bar spacing unchanged", close(v0["spacing"], v1["spacing"], 1e-6))
        # same-ticker re-fetch while scrolled back: same TIMES stay on screen
        t_from = pg.evaluate("() => __series[0].data()[Math.max(0, Math.ceil(__charts[0].timeScale().getVisibleLogicalRange().from))].time")
        pg.evaluate("() => document.querySelector('.atlas-pane-ticker-select').dispatchEvent(new Event('change'))")
        pg.wait_for_timeout(1500)
        t_from2 = pg.evaluate("() => __series[0].data()[Math.max(0, Math.ceil(__charts[0].timeScale().getVisibleLogicalRange().from))].time")
        check("history re-fetch while scrolled back keeps the same bars on screen", abs(t_from - t_from2) <= 300, f"{t_from} vs {t_from2}")
        check("no page errors", not errs, str(errs[:2]))
        ctx.close()

        print("[C] time axis: zoom at the live edge keeps bar spacing while following")
        ctx, pg, feed, errs = fresh()
        box = pg.locator("#chart-pane .atlas-pane-chart").first.bounding_box()
        pg.mouse.move(box["x"] + box["width"] - 66 - 6, box["y"] + box["height"] / 2)   # right edge of the plot, left of the price axis
        for _ in range(4):
            pg.mouse.wheel(0, -240); pg.wait_for_timeout(40)
        pg.wait_for_timeout(250)
        v0 = pg.evaluate(VIEW)
        feed.armed = True
        pg.wait_for_timeout(9000)
        v1 = pg.evaluate(VIEW)
        check("zoomed bar spacing preserved across new candles", close(v0["spacing"], v1["spacing"], 1e-6),
              f"{v0['spacing']:.3f} vs {v1['spacing']:.3f}")
        check("live edge still followed (newest bar on screen)", v1["lr"]["to"] >= v1["n"] - 1.5,
              f"v0 to={v0['lr']['to']:.2f} n={v0['n']}; v1 to={v1['lr']['to']:.2f} n={v1['n']}")
        span0 = v0["lr"]["to"] - v0["lr"]["from"]; span1 = v1["lr"]["to"] - v1["lr"]["from"]
        check("visible bar count unchanged (no auto-fit)", close(span0, span1, 1e-6))
        ctx.close()

        print("[D] gesture wins: dragging while data arrives is not fought")

        def timed_drag(armed):
            ctx, pg, feed, errs = fresh()
            box = pg.locator("#chart-pane .atlas-pane-chart").first.bounding_box()
            feed.armed = armed
            x, y = box["x"] + 300, box["y"] + box["height"] / 2
            pg.mouse.move(x, y); pg.wait_for_timeout(60); pg.mouse.down(); pg.wait_for_timeout(60)
            prev = pg.evaluate(VIEW)["lr"]["from"]; monotonic = True
            for i in range(1, 81):                                  # ~2.4 s drag spanning >= 2 polls
                pg.mouse.move(x + i * 8, y); pg.wait_for_timeout(30)
                cur = pg.evaluate(VIEW)["lr"]["from"]
                if cur > prev + 1e-9: monotonic = False             # dragging right => `from` must keep decreasing
                prev = cur
            pg.mouse.up(); pg.wait_for_timeout(300)
            v = pg.evaluate(VIEW); k = feed.k; ctx.close()
            return v, monotonic, k

        ctrl, _, _ = timed_drag(False)       # control: identical gesture, no data arriving
        live, monotonic, k = timed_drag(True)
        check("candles arrived during the drag", k >= 1, f"k={k}")
        check("view followed the pointer monotonically while candles arrived (no hop)", monotonic)
        check("final position identical to the same drag with no data arriving",
              abs(live["lr"]["from"] - ctrl["lr"]["from"]) < 1e-6, f"{live['lr']['from']:.3f} vs {ctrl['lr']['from']:.3f}")
        check("held candles were applied after release", live["n"] > ctrl["n"], f"n={live['n']} vs {ctrl['n']}")

        # ---------------------------------------------------------------- resize
        print("[E] resize keeps the manual view")
        ctx, pg, feed, errs = fresh()
        ax, ay = pg.evaluate(AXIS_POINT)
        drag(pg, ax, ay, 0, -80)
        v0 = pg.evaluate(VIEW)
        pg.set_viewport_size({"width": 1400, "height": 800}); pg.wait_for_timeout(700)
        v1 = pg.evaluate(VIEW)
        cw = pg.evaluate("() => [document.querySelector('#chart-pane .atlas-pane-chart').clientWidth, document.querySelector('#chart-pane .atlas-pane-chart canvas').clientWidth]")
        check("chart canvas tracks the container after a resize", abs(cw[0] - cw[1] - 66) < 80, str(cw))
        check("manual price scale kept after resize", v1["auto"] is False)
        check("bar spacing kept after resize", close(v0["spacing"], v1["spacing"], 1e-6))
        ctx.close()

        # ---------------------------------------------------------------- context change + reset
        print("[F] context change and explicit reset restore the automatic view")
        ctx, pg, feed, errs = fresh()
        ax, ay = pg.evaluate(AXIS_POINT)
        drag(pg, ax, ay, 0, -80)
        check("manual before reset", pg.evaluate(VIEW)["auto"] is False)
        if pg.locator(".atlas-reset-view-btn").count():
            pg.click(".atlas-reset-view-btn"); pg.wait_for_timeout(400)
            vr = pg.evaluate(VIEW)
            check("Reset view button returns to automatic price scale", vr["auto"] is True)
        else:
            check("Reset view button present", False)
        drag(pg, ax, ay, 0, -80)
        check("manual again", pg.evaluate(VIEW)["auto"] is False)
        pg.mouse.dblclick(ax, ay); pg.wait_for_timeout(300)
        check("double-click on the price axis resets to automatic", pg.evaluate(VIEW)["auto"] is True)
        drag(pg, ax, ay, 0, -80)
        pg.click(".atlas-interval-btn:has-text('15m')"); pg.wait_for_timeout(2500)
        vc = pg.evaluate(VIEW)
        check("changing timeframe (context change) refits with automatic price scale", vc["auto"] is True)
        ctx.close()
        b.close()
finally:
    srv.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
