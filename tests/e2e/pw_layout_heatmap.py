#!/usr/bin/env python3
"""WS3 — "Show Heatmap" OFF: the chart takes over the freed width (real Lightweight Charts).

usage: python3 pw_layout_heatmap.py [web_root]
"""
import os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from real_lwc import install_real_lwc
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = sys.argv[1] if len(sys.argv) > 1 else f"{ROOT}/frontend"
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18432"))
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))


GEOM = """() => {
  const q = s => document.querySelector(s); const r = e => e ? e.getBoundingClientRect() : null;
  const pane = r(q('#chart-pane')), chart = q('#chart-pane .atlas-pane-chart'), side = q('#sidecar');
  const cv = [...chart.querySelectorAll('canvas')].filter(c => !c.className).map(c => c.clientWidth);
  const s = __series[0], ts = __charts[0].timeScale(), H = chart.clientHeight - ts.height();
  return { paneW: pane.width, chartW: chart.clientWidth, lwcW: Math.max(...cv) + 66 /* plot canvas + price axis */,
           sideDisplay: getComputedStyle(side).display, sideW: side.getBoundingClientRect().width,
           resizerDisplay: getComputedStyle(q('#atlas-resizer')).display, vw: innerWidth,
           bodyScrollW: document.documentElement.scrollWidth, auto: s.priceScale().options().autoScale,
           pTop: s.coordinateToPrice(0), pBot: s.coordinateToPrice(H), spacing: ts.options().barSpacing,
           lr: ts.getVisibleLogicalRange(), n: s.data().length }; }"""

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", WEB],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        pg = b.new_context(viewport={"width": 1700, "height": 950}).new_page()
        errs, reqs = [], []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("request", lambda r: reqs.append(r.url))
        install_real_lwc(pg)
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(2500)

        on0 = pg.evaluate(GEOM)
        check("ON: heatmap panel present beside the chart", on0["sideDisplay"] != "none" and on0["sideW"] > 100, f"sidecar {on0['sideW']:.0f}px")
        check("ON: chart canvas fills its pane", abs(on0["lwcW"] - on0["chartW"]) < 90, f"{on0['lwcW']} vs {on0['chartW']}")

        # user customises the view first
        ax, ay = pg.evaluate("""() => { const c = [...document.querySelectorAll('#chart-pane canvas')]
          .find(c => !c.className && c.clientWidth > 30 && c.clientWidth < 120 && c.clientHeight > 100);
          const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }""")
        pg.mouse.move(ax, ay); pg.wait_for_timeout(60); pg.mouse.down(); pg.wait_for_timeout(60)
        for i in range(1, 21): pg.mouse.move(ax, ay - i * 4); pg.wait_for_timeout(15)
        pg.mouse.up(); pg.wait_for_timeout(200)
        before = pg.evaluate(GEOM)
        check("setup: manual price scale", before["auto"] is False)

        pg.evaluate("() => { const o = document.querySelector('.atlas-orbs-toggle'); if (o && o.checked) o.click(); }")  # so /api/heatmap = panel only
        pg.wait_for_timeout(500)
        pg.uncheck(".sidecar-show-checkbox"); pg.wait_for_timeout(700)
        off = pg.evaluate(GEOM)
        check("OFF: sidecar not rendered", off["sideDisplay"] == "none")
        check("OFF: divider hidden", off["resizerDisplay"] == "none")
        check("OFF: chart pane now spans the full width", off["paneW"] > on0["paneW"] + 100, f"{on0['paneW']:.0f}->{off['paneW']:.0f}")
        check("OFF: chart canvas resized to fill (no dead strip)", abs(off["lwcW"] - off["chartW"]) < 90 and off["chartW"] > on0["chartW"] + 100,
              f"chart {on0['chartW']}->{off['chartW']}, canvases {off['lwcW']}")
        check("OFF: no horizontal scrollbar / overflow", off["bodyScrollW"] <= off["vw"], f"{off['bodyScrollW']} vs {off['vw']}")
        check("OFF: manual price scale kept", off["auto"] is False and abs(off["pTop"] - before["pTop"]) < 1e-3 and abs(off["pBot"] - before["pBot"]) < 1e-3)
        check("OFF: bar spacing kept", abs(off["spacing"] - before["spacing"]) < 1e-6)
        check("OFF: restore control offered", pg.locator(".atlas-heatmap-restore-btn").is_visible())
        mark = len(reqs); pg.wait_for_timeout(4500)
        heat = [u for u in reqs[mark:] if "/api/heatmap" in u]
        check("OFF: heatmap polling paused (0 requests in 4.5 s)", not heat, f"{len(heat)} requests")

        pg.click(".atlas-heatmap-restore-btn"); pg.wait_for_timeout(900)
        on1 = pg.evaluate(GEOM)
        check("ON again: layout identical to the original", abs(on1["paneW"] - on0["paneW"]) < 1 and abs(on1["sideW"] - on0["sideW"]) < 1 and on1["resizerDisplay"] != "none",
              f"pane {on0['paneW']:.0f}/{on1['paneW']:.0f} side {on0['sideW']:.0f}/{on1['sideW']:.0f}")
        check("ON again: restore button gone, checkbox checked", not pg.locator(".atlas-heatmap-restore-btn").is_visible() and pg.is_checked(".sidecar-show-checkbox"))
        check("ON again: view still untouched (price + spacing)", on1["auto"] is False and abs(on1["pTop"] - before["pTop"]) < 1e-3 and abs(on1["spacing"] - before["spacing"]) < 1e-6)
        mark = len(reqs); pg.wait_for_timeout(3000)
        check("ON again: heatmap polling resumed", any("/api/heatmap" in u for u in reqs[mark:]))
        check("no page errors", not errs, str(errs[:2]))
        b.close()
finally:
    srv.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
