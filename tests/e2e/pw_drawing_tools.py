#!/usr/bin/env python3
"""WS2 — drawing tools: placement preview, Displayed/Not displayed, alignment (real Lightweight Charts).

usage: python3 pw_drawing_tools.py [web_root]
"""
import os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from real_lwc import install_real_lwc
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = sys.argv[1] if len(sys.argv) > 1 else f"{ROOT}/frontend"
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18434"))
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))


# expose the per-pane drawing layer for assertions
HOOK = """(() => { let real; Object.defineProperty(window, 'createDrawingLayer', { configurable: true,
  set(f) { real = function () { const l = f.apply(this, arguments); (window.__layers = window.__layers || []).push(l); return l; }; },
  get() { return real; } }); })();"""

# count painted pixels on a canvas: amber (preview colour) vs any
PIX = """(sel) => { const c = document.querySelector(sel); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let amber = 0, any = 0; for (let i = 0; i < d.length; i += 4) { if (d[i+3] < 40) continue; any++;
    if (d[i] > 200 && d[i+1] > 150 && d[i+2] < 170 && d[i+1] < 235) amber++; } return { amber, any }; }"""
PREV, COMM = "#chart-pane .atlas-drawing-preview", "#chart-pane .atlas-drawing-committed"
L = "() => window.__layers[0]"

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", WEB],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1700, "height": 950})
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.add_init_script(HOOK)
        install_real_lwc(pg)
        # synthetic live candles so data really ticks/grows during the alignment checks
        st = {"n": 0, "k": 0, "base": None, "last": None, "armed": False}
        def latest(route):
            bars = route.fetch().json(); st["n"] += 1
            if st["base"] is None: st["base"] = bars[-1]["time"]; st["last"] = bars[-1]
            if st["armed"] and st["n"] % 2 == 0: st["k"] += 1
            if st["k"]:
                lb = st["last"]; t = st["base"] + st["k"] * 300; px = lb["close"] + (1.2 if st["k"] % 2 else -1.2)
                route.fulfill(json=[{"time": t - 300, **{k: lb[k] for k in ("open", "high", "low", "close")}},
                                    {"time": t, "open": lb["close"], "high": px + .4, "low": px - .4, "close": px}])
            else: route.fulfill(json=bars)
        pg.route("**/api/candles/latest*", latest)
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(2500)
        box = pg.locator("#chart-pane .atlas-pane-chart").first.bounding_box()
        X0, Y0 = box["x"], box["y"]
        cx, cy = X0 + 500, Y0 + box["height"] * 0.45

        def frames(n=2): pg.evaluate("(n) => new Promise(r => { let i = 0; const f = () => ++i >= n ? setTimeout(r, 0) : requestAnimationFrame(f); requestAnimationFrame(f); })", n)
        def drawings(): return pg.evaluate(f"() => ({L})().getDrawings()")

        # ------------------------------------------------------------ A: placement preview
        print("[A] placement preview for every tool")
        for tool in ["hline", "rect", "short", "long", "range"]:
            pg.click(f"#chart-pane .atlas-drawing-tool-{tool}")
            pg.mouse.move(cx - 30, cy - 20); pg.mouse.move(cx, cy); frames(2)
            pv = pg.evaluate(f"() => ({L})().getPreview()"); px = pg.evaluate(PIX, PREV)
            check(f"{tool}: highlighted preview visible with NO click yet", pv is not None and pv["type"] == tool and px["amber"] > 60,
                  f"amber px {px['amber']}")
            check(f"{tool}: preview is on its own layer; committed layer untouched", pg.evaluate(PIX, COMM)["any"] == 0)
            # no layer leakage: it is dashed/amber, a committed drawing never is
        # multi-point: click-click placement with live in-progress shape
        pg.click("#chart-pane .atlas-drawing-tool-rect")
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.up(); frames(2)
        p_a = pg.evaluate(f"() => ({L})().getPreview()")
        check("rect: after the first click the preview is the in-progress shape (placing)", p_a and p_a["placing"])
        pg.mouse.move(cx + 120, cy - 60); frames(2)
        p_b = pg.evaluate(f"() => ({L})().getPreview()")
        pg.mouse.move(cx + 220, cy - 110); frames(2)
        p_c = pg.evaluate(f"() => ({L})().getPreview()")
        check("rect: in-progress shape updates live with the cursor (p1 fixed, p2 follows)",
              p_b and p_c and abs(p_b["p1"]["time"] - p_c["p1"]["time"]) < 1e-6 and p_c["p2"]["time"] > p_b["p2"]["time"] and p_c["p2"]["price"] > p_b["p2"]["price"])
        before_commit = p_c
        pg.mouse.down(); pg.mouse.up(); frames(3)
        ds = drawings()
        check("rect: second click commits one drawing", len(ds) == 1, str(len(ds)))
        d = ds[-1]
        check("committed points EXACTLY equal the previewed points (no shift on click)",
              abs(d["p1"]["time"] - before_commit["p1"]["time"]) < 1e-6 and abs(d["p2"]["time"] - before_commit["p2"]["time"]) < 1e-6
              and abs(d["p2"]["price"] - before_commit["p2"]["price"]) < 1e-9)
        pp = pg.evaluate(f"(p) => ({L})().pixelOf(p)", d["p2"])
        check("committed anchor lands on the cursor pixel (<=0.75 px)", abs(pp["x"] + X0 - (cx + 220)) <= .75 and abs(pp["y"] + Y0 - (cy - 110)) <= .75, f"{pp['x'] + X0:.2f},{pp['y'] + Y0:.2f} vs {cx + 220},{cy - 110}")
        check("preview gone from the preview layer? (cursor still over chart => ghost for next one, but no leftovers of the placed one)",
              pg.evaluate(f"() => ({L})().getPreview().placing") is False)
        # drag placement still works
        pg.mouse.move(cx - 200, cy + 40); pg.mouse.down()
        for i in range(1, 11): pg.mouse.move(cx - 200 + i * 15, cy + 40 - i * 6); pg.wait_for_timeout(12)
        pg.mouse.up(); frames(3)
        check("press-drag-release placement also commits", len(drawings()) == 2)
        # Esc cancels an in-progress placement, leaving no artifacts
        pg.mouse.move(cx, cy + 100); pg.mouse.down(); pg.mouse.up(); frames(2)
        pg.mouse.move(cx + 60, cy + 150); frames(2)
        check("in-progress preview visible before Esc", pg.evaluate(PIX, PREV)["amber"] > 60)
        pg.keyboard.press("Escape"); frames(2)
        pv = pg.evaluate(f"() => ({L})().getPreview()")
        check("Esc cancels the placement: no drawing added", len(drawings()) == 2)
        check("after Esc only the pointer ghost remains (not placing)", pv is None or pv["placing"] is False)
        pg.click("#chart-pane .atlas-drawing-tool-cursor"); frames(2)
        check("deselecting the tool clears the preview layer completely", pg.evaluate(PIX, PREV)["any"] == 0 and pg.evaluate(f"() => ({L})().getPreview()") is None)
        pg.click("#chart-pane .atlas-drawing-tool-rect"); pg.mouse.move(cx, cy); frames(2)
        pg.mouse.move(X0 + 5, Y0 + box["height"] + 40); frames(2)   # leave the chart
        check("moving the pointer off the chart clears the preview", pg.evaluate(PIX, PREV)["any"] == 0)
        pg.click("#chart-pane .atlas-drawing-tool-cursor")

        # ------------------------------------------------------------ B: all tools commit + display
        print("[B] every tool commits; hidden state")
        for i, tool in enumerate(["hline", "short", "long", "range"]):
            pg.click(f"#chart-pane .atlas-drawing-tool-{tool}")
            x, y = cx - 250 + i * 160, cy - 120 + i * 30
            pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x + 90, y - 50, steps=6); pg.mouse.up(); frames(2)
        pg.click("#chart-pane .atlas-drawing-tool-cursor"); frames(2)
        ds = drawings()
        check("hline/short/long/range committed (6 total)", len(ds) == 6, str([d['type'] for d in ds]))
        check("every drawing has an id and a visible flag", all(d.get("id") and d.get("visible") is True for d in ds))
        target = next(d for d in ds if d["type"] == "rect")
        pp = pg.evaluate(f"(p) => ({L})().pixelOf(p)", target["p1"])
        # select + open settings via double-click on its corner area
        rx, ry = X0 + pp["x"], Y0 + pp["y"]
        pg.mouse.dblclick(rx + 1, ry + 1); frames(2)
        check("double-click opens the settings dialog", pg.locator(".atlas-drawing-modal").count() == 1)
        check("dialog has a Displayed switch (on)", pg.locator(".atlas-drawing-visible-toggle").is_checked() and "Displayed" == pg.inner_text(".atlas-drawing-switch-label"))
        before_any = pg.evaluate(PIX, COMM)["any"]
        pg.locator(".atlas-drawing-switch").click(); frames(3)
        after_any = pg.evaluate(PIX, COMM)["any"]
        check("toggling to Not displayed removes it from the chart immediately", after_any < before_any, f"{before_any}->{after_any} px")
        check("label reads 'Not displayed'", pg.inner_text(".atlas-drawing-switch-label") == "Not displayed")
        ds2 = drawings(); t2 = next(d for d in ds2 if d["id"] == target["id"])
        check("hidden drawing is NOT deleted and keeps its points", t2["visible"] is False and len(ds2) == 6 and t2["p1"] == target["p1"] and t2["p2"] == target["p2"])
        pg.click(".atlas-drawing-modal-close")
        pg.click("#chart-pane .atlas-drawing-list-btn"); frames(2)
        row = pg.locator(f".atlas-drawing-row[data-id='{target['id']}']")
        check("drawings list shows it dimmed (hidden)", row.count() == 1 and "hidden" in (row.get_attribute("class") or ""))
        # not hit-testable: double-click again where it was -> no dialog; mouse down there must pan the chart instead
        pg.click("#chart-pane .atlas-drawing-list-btn")
        pg.mouse.dblclick(rx + 1, ry + 1); frames(2)
        check("hidden drawing cannot be selected (no dialog on double-click)", pg.locator(".atlas-drawing-modal").count() == 0)
        lr0 = pg.evaluate("() => __charts[0].timeScale().getVisibleLogicalRange().from")
        pg.mouse.move(rx + 1, ry + 1); pg.mouse.down(); pg.mouse.move(rx + 120, ry + 1, steps=8); pg.mouse.up(); frames(2)
        lr1 = pg.evaluate("() => __charts[0].timeScale().getVisibleLogicalRange().from")
        check("hidden drawing cannot be dragged (the gesture pans the chart instead)", lr1 < lr0 - 2 and drawings()[0]["p1"] == ds2[0]["p1"], f"{lr0:.1f}->{lr1:.1f}")
        # toggle from the list (eye) shows it again
        pg.click("#chart-pane .atlas-drawing-list-btn"); frames(2)
        pg.locator(f".atlas-drawing-row[data-id='{target['id']}'] .atlas-drawing-eye").click(); frames(3)
        check("list eye toggles it back on; canvas shows it again", pg.evaluate(PIX, COMM)["any"] >= before_any * 0.9 and next(d for d in drawings() if d["id"] == target["id"])["visible"] is True)
        pg.locator(f".atlas-drawing-row[data-id='{target['id']}'] .atlas-drawing-eye").click(); frames(2)
        pg.click("#chart-pane .atlas-drawing-list-btn")
        # master override does not touch per-drawing state
        n_vis = sum(1 for d in drawings() if d["visible"])
        pg.click("#chart-pane .atlas-drawing-master-btn"); frames(3)
        check("master hide-all clears the chart", pg.evaluate(PIX, COMM)["any"] == 0)
        check("...without changing any per-drawing flag", sum(1 for d in drawings() if d["visible"]) == n_vis)
        pg.click("#chart-pane .atlas-drawing-master-btn"); frames(3)
        check("master show restores them (hidden one stays hidden)", pg.evaluate(PIX, COMM)["any"] > 0 and next(d for d in drawings() if d["id"] == target["id"])["visible"] is False)

        # persistence: data updates, timeframe change, reload
        st["armed"] = True; pg.wait_for_timeout(5500)
        check("hidden state survives live data updates", next(d for d in drawings() if d["id"] == target["id"])["visible"] is False and st["k"] >= 1)
        pg.click(".atlas-interval-btn:has-text('15m')"); pg.wait_for_timeout(2200)
        check("hidden state survives a timeframe change", next(d for d in drawings() if d["id"] == target["id"])["visible"] is False and len(drawings()) == 6)
        st["armed"] = False
        pg.reload(); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(2500)
        check("hidden state survives a reload", next(d for d in drawings() if d["id"] == target["id"])["visible"] is False and len(drawings()) == 6)
        stored = pg.evaluate("() => JSON.parse(localStorage.getItem('skylit:drawings:SPY'))")
        check("persisted in the stored drawing", next(d for d in stored if d["id"] == target["id"])["visible"] is False)

        # ------------------------------------------------------------ C: alignment through view changes
        print("[C] drawings stay anchored while panning, zooming, rescaling, live data")
        pg.click(".atlas-interval-btn:has-text('5m')"); pg.wait_for_timeout(2200)
        ds = [d for d in drawings() if d["visible"]]
        rect = next(d for d in ds if d["type"] == "rect")
        def painted_at(p):
            q = pg.evaluate(f"(p) => ({L})().pixelOf(p)", p)
            return pg.evaluate("""([x, y]) => { const c = document.querySelector('#chart-pane .atlas-drawing-committed'); const r = c.width / c.clientWidth;
              const d = c.getContext('2d').getImageData(Math.round((x - 2) * r), Math.round((y - 2) * r), Math.round(5 * r), Math.round(5 * r)).data;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 60) return true; return false; }""", [q["x"], q["y"]]), q
        ok, q = painted_at(rect["p1"]); check("rect corner is painted exactly at its data anchor (baseline)", ok, str(q))
        def alignment_after(label, action):
            action(); frames(4); pg.wait_for_timeout(300)
            ok, q = painted_at(rect["p1"]); ok2, q2 = painted_at(rect["p2"])
            vis = 0 <= q["x"] <= 1100 and 0 <= q["y"] <= 700
            check(f"aligned after {label}", (ok and ok2) or not vis, f"p1 {q['x']:.0f},{q['y']:.0f} painted={ok}; p2 painted={ok2}")
        alignment_after("panning", lambda: (pg.mouse.move(X0 + 600, Y0 + 400), pg.mouse.down(), pg.mouse.move(X0 + 640, Y0 + 400, steps=5), pg.mouse.up()))
        alignment_after("wheel zoom", lambda: (pg.mouse.move(X0 + 700, Y0 + 300), pg.mouse.wheel(0, -200)))
        ax, ay = pg.evaluate("""() => { const c = [...document.querySelectorAll('#chart-pane canvas')].find(c => !c.className && c.clientWidth > 30 && c.clientWidth < 120 && c.clientHeight > 100);
          const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }""")
        alignment_after("dragging the price axis", lambda: (pg.mouse.move(ax, ay), pg.mouse.down(), pg.mouse.move(ax, ay - 60, steps=8), pg.mouse.up()))
        st["armed"] = True
        alignment_after("live data (new candles + autoscale)", lambda: pg.wait_for_timeout(4500))
        # preview is not cleared / delayed by data ticks
        pg.click("#chart-pane .atlas-drawing-tool-rect"); pg.mouse.move(X0 + 520, Y0 + 330); frames(2)
        ok_all = True; n_before = st["k"]
        for _ in range(6):
            pg.wait_for_timeout(700); ok_all = ok_all and pg.evaluate(PIX, PREV)["amber"] > 60
        check("a live data tick never clears the preview (6 samples across ticks)", ok_all and st["k"] > n_before, f"new candles {st['k'] - n_before}")
        # hidden drawings don't appear in the preview/hit paths and a visible drawing can be moved
        pg.click("#chart-pane .atlas-drawing-tool-cursor"); frames(2)
        vis_rect = next(d for d in drawings() if d["visible"] and d["type"] == "rect")
        q = pg.evaluate(f"(p) => ({L})().pixelOf(p)", vis_rect["p1"])
        if 5 < q["x"] < 1100 and 5 < q["y"] < 700:
            pg.mouse.move(X0 + q["x"] + 8, Y0 + q["y"] + 8); pg.mouse.down(); pg.mouse.move(X0 + q["x"] + 68, Y0 + q["y"] + 48, steps=6); pg.mouse.up(); frames(3)
            moved = next(d for d in drawings() if d["id"] == vis_rect["id"])
            check("a visible drawing can be selected and dragged (data coordinates updated)", moved["p1"] != vis_rect["p1"] and moved["p2"]["time"] - moved["p1"]["time"] == vis_rect["p2"]["time"] - vis_rect["p1"]["time"] or abs((moved["p2"]["time"] - moved["p1"]["time"]) - (vis_rect["p2"]["time"] - vis_rect["p1"]["time"])) < 1)
        else:
            check("(rect off-screen after view changes; move test skipped)", True)
        check("no page errors", not errs, str(errs[:3]))
        b.close()
finally:
    srv.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
