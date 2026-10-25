#!/usr/bin/env python3
"""Playwright end-to-end check for Atlas Projections (DTE picker revision).

Starts the real C++ server, opens the real page in real Chromium, and
drives the real toolbar. Lightweight Charts (unpkg) is unreachable in a
sandbox with no egress, so the CDN request is answered with
tests/e2e/lwc_render_stub.js (a canvas renderer with the same coordinate
conventions) — see that file's header for exactly what that does/doesn't
prove. Everything else (C++ engine, HTTP, DOM, our overlay code) is real.

Usage: python3 tests/e2e/pw_projection.py [outdir]
"""
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shots"
PORT = 18111
CHROME = os.environ.get("SKYLIT_CHROMIUM") or None
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))

def api(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=5) as r:
        return json.loads(r.read())


def set_proj_dte(page, d):
    """Projections now picks its DTE inside its own window."""
    page.click(".atlas-projection-open")
    page.click(f".atlas-proj-dte .atlas-chip[data-key='{d}']")
    page.keyboard.press("Escape")

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: api("/api/health"); break
        except Exception: time.sleep(0.1)

    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    cfg = api("/api/projection/config")
    prof = {p["interval"]: p for p in cfg["profiles"]}
    check("config reports max_dte == 6", cfg["max_dte"] == 6, str(cfg["max_dte"]))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1600, "height": 900})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        page.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        page.goto(f"http://127.0.0.1:{PORT}/")
        page.wait_for_selector(".atlas-projection-toggle")
        page.wait_for_timeout(600)

        print("[A] initial state")
        check("projection is OFF by default", not page.is_checked(".atlas-projection-toggle"))
        check("rail shows Projections Off while disabled", "off" in page.inner_text(".atlas-projection-status").lower())
        page.screenshot(path=f"{OUT}/01_projections_off.png")

        print("[B] toggle on -> DTE row appears, 0DTE selected by default, corridor renders")
        page.check(".atlas-projection-toggle"); page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        page.wait_for_timeout(900)
        check("rail status reads \"0DTE GEX ... LIVE\" when on", "0DTE GEX" in page.inner_text(".atlas-projection-status") and "live" in page.inner_text(".atlas-projection-status").lower(), page.inner_text(".atlas-projection-status"))
        page.click(".atlas-projection-open")
        check("0DTE active by default in the Projections window", "active" in page.eval_on_selector(".atlas-proj-dte .atlas-chip[data-key='0']", "e => e.className"))
        check("seven DTE options present (0-6)", page.locator(".atlas-proj-dte .atlas-chip").count() == 7)
        page.keyboard.press("Escape")
        check("no visible \"projections beta\" label rendered on the chart", page.locator(".atlas-projection-badge").count() == 0)

        def overlay_stats():
            return page.evaluate("""() => {
              const c = document.querySelector('.atlas-projection-canvas');
              const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
              let painted = 0, minX = c.width, maxX = 0;
              for (let i = 3, p = 0; i < d.length; i += 4, p++) if (d[i] > 8) {
                painted++; const x = p % c.width; if (x < minX) minX = x; if (x > maxX) maxX = x;
              }
              return { painted, minX, maxX, w: c.width };
            }""")
        st = overlay_stats()
        check("overlay canvas has painted pixels", st["painted"] > 500, f"{st['painted']} px")
        page.screenshot(path=f"{OUT}/02_projections_on_5m_0dte.png")

        d0 = api("/api/projection?ticker=SPY&exposure=GEX&interval=5m&dte=0")
        check("server default dte=0 applied", d0["dte"] == 0 and d0["bucket"] == "0dte", str(d0["dte"]))

        print("[C] switching DTE buttons re-fetches and changes the corridor")
        set_proj_dte(page, 5)
        page.wait_for_timeout(900)
        check("status line follows the chosen DTE (5DTE)", "5DTE GEX" in page.inner_text(".atlas-projection-status"), page.inner_text(".atlas-projection-status"))
        check("status no longer names 0DTE", "0DTE" not in page.inner_text(".atlas-projection-status"))
        d5 = api("/api/projection?ticker=SPY&interval=5m&dte=5")
        check("switching to 5DTE queries the correct bucket (next5)", d5["dte"] == 5 and d5["bucket"] == "next5", str(d5["bucket"]))
        page.screenshot(path=f"{OUT}/03_projections_5dte.png")

        print("[D] forward bars are clamped per timeframe (Part III) and it is reported")
        maxes = {}
        for iv in ["1m", "5m", "15m", "1h", "1D"]:
            page.click(f".atlas-interval-btn[data-interval='{iv}']")
            page.wait_for_timeout(500)
            maxes[iv] = prof[iv]["max_window_bars"]
        d = api(f"/api/projection?ticker=SPY&interval=1m&dte=5")
        check("1m + 5DTE horizon is clamped server-side", d["horizon"]["clamped"] and d["horizon"]["effective_bars"] == maxes["1m"], str(d["horizon"]))
        d2 = api(f"/api/projection?ticker=SPY&interval=1D&dte=0")
        check("1D + 0DTE needs exactly 1 bar, unclamped", d2["horizon"]["effective_bars"] == 1 and not d2["horizon"]["clamped"], str(d2["horizon"]))

        print("[E] server rejects an out-of-range dte outright")
        import urllib.error
        try:
            api("/api/projection?ticker=SPY&interval=1D&dte=99")
            bad_status = 200
        except urllib.error.HTTPError as e:
            bad_status = e.code
        check("dte=99 rejected with 400", bad_status == 400, str(bad_status))

        print("[F] four required outputs, now wall-driven not vol-driven")
        page.click(".atlas-interval-btn[data-interval='1h']"); page.wait_for_timeout(500)
        dd = api("/api/projection?ticker=SPY&exposure=GEX&interval=1h&dte=3")
        b0, b1 = dd["bars"][0], dd["bars"][-1]
        check("forward range: per-bar upper/lower around spot", all(b["upper"] > dd["spot"] > b["lower"] for b in dd["bars"]))
        check("gravity zones: zone thickness provided", dd["zone_half_thickness"] > 0)
        check("percent levels: signed % from spot", b1["upper_pct"] > 0 > b1["lower_pct"])
        check("developing path: corridor is FLAT across bars (not a widening forecast)", abs(b0["upper"] - b1["upper"]) < 1e-6 and abs(b0["lower"] - b1["lower"]) < 1e-6)
        check("response carries real wall info instead of a vol placeholder", "up_wall" in dd and "down_wall" in dd and "daily_vol_pct" not in dd)

        print("[G] exposure selection still changes the gamma/vanna mix per dte")
        g = api("/api/projection?ticker=SPY&exposure=GEX&interval=1D&dte=5")
        v = api("/api/projection?ticker=SPY&exposure=VEX&interval=1D&dte=5")
        m = api("/api/projection?ticker=SPY&exposure=GEX%2BVEX&interval=1D&dte=5")
        check("GEX-only uses gamma share 1.0", g["gex_share"] == 1.0)
        check("VEX-only uses gamma share 0.0", v["gex_share"] == 0.0)
        check("GEX+VEX blends (0 < share < 1)", 0 < m["gex_share"] < 1)
        check("payload echoes the selected exposure", (g["exposure"], v["exposure"], m["exposure"]) == ("GEX", "VEX", "GEX+VEX"))

        print("[H] persistence in named Chart Layouts (Part IV.6)")
        set_proj_dte(page, 2); page.wait_for_timeout(1000)
        saved = page.evaluate("() => JSON.parse(localStorage.getItem('skylit:chart-layouts'))[0].snapshot")
        check("layout snapshot stores projection enabled + dte", saved.get("showProjection") is True and saved.get("projectionDte") == 2, f"{saved.get('showProjection')}, {saved.get('projectionDte')}")
        page.reload()
        page.wait_for_selector(".atlas-projection-toggle")
        page.wait_for_timeout(1200)
        check("after reload: toggle restored ON", page.is_checked(".atlas-projection-toggle"))
        check("after reload: 2DTE restored", "2DTE" in page.inner_text(".atlas-projection-status"), page.inner_text(".atlas-projection-status"))
        check("after reload: still no on-chart projections-beta label", page.locator(".atlas-projection-badge").count() == 0)
        page.screenshot(path=f"{OUT}/06_after_reload_restored.png")

        print("[I] Orbs render at real strike prices even beyond the visible candle range")
        page.click(".atlas-projection-toggle"); page.keyboard.press("Escape"); page.wait_for_timeout(400)  # turn projections off to isolate Orbs
        board = api("/api/heatmap?ticker=SPY&exposure=GEX&expiration=0dte")
        strikes = [n["strike"] for n in board["nodes"]]
        check("heatmap board has nodes spanning a real strike range", max(strikes) - min(strikes) > 5, f"{min(strikes)}-{max(strikes)}")
        chart_range = page.evaluate("() => { const c = window.LightweightCharts.__lastChart; return c ? c.__range : null; }")
        check("chart's autoscaled price range covers the full orb strike range (not clipped)",
              chart_range and chart_range["lo"] <= min(strikes) + 0.5 and chart_range["hi"] >= max(strikes) - 0.5,
              f"chart {chart_range}, strikes {min(strikes)}-{max(strikes)}")
        orb_painted = page.evaluate("""() => {
          const c = document.querySelector('.atlas-orb-canvas');
          const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true; return false;
        }""")
        check("orb canvas actually painted (not silently dropped)", orb_painted)
        page.screenshot(path=f"{OUT}/07_orbs_full_strike_range.png")

        print("[J] no page errors")
        check("zero JS errors across the whole session", not errors, "; ".join(errors[:3]))
        browser.close()
finally:
    srv.terminate()

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
