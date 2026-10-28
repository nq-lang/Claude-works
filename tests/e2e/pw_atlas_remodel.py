#!/usr/bin/env python3
"""End-to-end checks for the Atlas remodel: left rail, Orbs / Expiry Data /
Projections windows, per-heatmap stacked controls (ticker, DTE+Greek,
Velocity Mode, EXTREME), Neg-strike highlight, header Badges icon, and the
same controls (plus CHEX) on the Quadrinity page."""
import json, os, subprocess, sys, time, urllib.request
from urllib.parse import unquote
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 18420
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shots"
results = []
def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])
        page = b.new_context(viewport={"width": 1700, "height": 950}).new_page()
        errors, requests = [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        page.on("request", lambda r: requests.append(unquote(r.url)))
        page.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
        page.goto(f"http://127.0.0.1:{PORT}/")
        page.wait_for_selector("#atlas-rail .atlas-expiry-open")
        page.wait_for_timeout(1200)

        def seen(fragment, since=0):
            return any(fragment in u for u in requests[since:])

        print("[A] left rail: stacked vertically, left of the chart")
        rail = page.locator("#atlas-rail").bounding_box()
        chart = page.locator("#chart-pane").bounding_box()
        check("rail sits to the LEFT of the chart area", rail["x"] + rail["width"] <= chart["x"] + 1, f"{rail} {chart}")
        ys = [page.locator(s).first.bounding_box()["y"] for s in
              [".atlas-interval-group", ".atlas-orbs-toggle", ".atlas-expiry-open", ".atlas-projection-toggle"]]
        check("timeframes, Orbs, Expiry Data, Projections are stacked top to bottom", ys == sorted(ys) and len(set(ys)) == 4, str(ys))
        check("timeframe buttons stay horizontal under a header label",
              "timeframe" in page.inner_text("#atlas-rail .rail-header").lower()
              and len({round(page.locator('.atlas-interval-btn').nth(i).bounding_box()['y']) for i in range(7)}) == 1)
        check("old GEX/VEX/GEX+VEX, Current/Next N and Nodes tabs are gone",
              page.locator(".atlas-exp-btn, .atlas-expscope-btn, .atlas-node-limit, .atlas-expiration-n").count() == 0)
        check("Dark Pool / Flow still removed", page.locator(".atlas-darkpool-toggle, .atlas-flow-toggle").count() == 0)

        print("[B] Expiry Data window")
        page.click(".atlas-expiry-open")
        check("seven DTE options 0DTE-6DTE", page.locator(".atlas-expiry-dte .atlas-chip").count() == 7)
        greek_texts = page.locator(".atlas-expiry-greeks .atlas-chip-main").all_inner_texts()
        check("five Greek options (gamma, vanna, charm, color, speed)", greek_texts == ["GEX", "VEX", "CHEX", "COLOR", "SPEED"], str(greek_texts))
        mark = len(requests)
        page.click(".atlas-expiry-dte .atlas-chip[data-key='1']")
        page.click(".atlas-expiry-dte .atlas-chip[data-key='0']")
        page.click(".atlas-expiry-greeks .atlas-chip[data-key='VEX']")
        page.click(".atlas-expiry-greeks .atlas-chip[data-key='COLOR']")
        page.wait_for_timeout(700)
        status = page.inner_text(".atlas-expiry-status")
        check("status outside the window reads '1DTE GEX, VEX & COLOR ... LIVE'",
              "1DTE GEX, VEX & COLOR" in status and "live" in status.lower(), status)
        page.wait_for_timeout(1500)
        check("chart requests each chosen Greek SEPARATELY (never merged) for the chosen DTE",
              all(seen(f"/api/heatmap?ticker=SPY&exposure={g}&expiration=dte:1", mark) for g in ("GEX", "VEX", "COLOR"))
              and not seen("exposure=GEX,VEX", mark))
        page.click(".atlas-expiry-greeks .atlas-chip[data-key='VEX']")      # back to a single Greek (GEX): user colours apply
        page.click(".atlas-expiry-greeks .atlas-chip[data-key='COLOR']")
        page.wait_for_timeout(900)
        page.keyboard.press("Escape")

        print("[C] Orbs window")
        page.click(".atlas-orbs-toggle"); page.keyboard.press("Escape")       # off
        page.click(".atlas-orbs-toggle")                                       # on -> window opens
        check("enabling Orbs opens its window", page.locator(".atlas-window:visible .atlas-orb-nodes-input").count() == 1)
        page.fill(".atlas-orb-nodes-input", "7")
        page.eval_on_selector('.atlas-orb-color[data-key="orbPosColor"]', "e => { e.value = '#00ff00'; e.dispatchEvent(new Event('input', {bubbles:true})); }")
        page.eval_on_selector('.atlas-orb-color[data-key="orbNegColor"]', "e => { e.value = '#ff00ff'; e.dispatchEvent(new Event('input', {bubbles:true})); }")
        page.click(".atlas-orbs-save-btn")
        page.wait_for_timeout(1600)
        check("rail shows the chosen node count", "7 nodes" in page.inner_text(".atlas-orbs-status"), page.inner_text(".atlas-orbs-status"))
        colors = page.evaluate("""() => {
          const c = document.querySelector('.atlas-orb-canvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let green = 0, magenta = 0;
          for (let i = 0; i < d.length; i += 4) { if (d[i+3] < 40) continue;
            if (d[i+1] > 150 && d[i] < 90 && d[i+2] < 90) green++;
            if (d[i] > 150 && d[i+2] > 150 && d[i+1] < 90) magenta++; }
          return { green, magenta };
        }""")
        check("orbs actually render in the chosen positive / negative colors", colors["green"] > 50 and colors["magenta"] > 50, str(colors))
        page.screenshot(path=f"{OUT}/R1_orbs_colors.png")

        print("[D] Projections window")
        mark = len(requests)
        page.click(".atlas-projection-toggle")
        check("enabling Projections opens its window", page.locator(".atlas-window:visible .atlas-proj-dte").count() == 1)
        check("projection DTE options 0-6", page.locator(".atlas-proj-dte .atlas-chip").count() == 7)
        page.click(".atlas-proj-dte .atlas-chip[data-key='3']")
        page.click(".atlas-proj-greeks .atlas-chip[data-key='CHEX']")
        page.wait_for_timeout(900)
        pstatus = page.inner_text(".atlas-projection-status")
        check("projection status reads '3DTE GEX & CHEX ... LIVE'", "3DTE GEX & CHEX" in pstatus and "live" in pstatus.lower(), pstatus)
        check("projection request uses its own DTE + Greeks", seen("/api/projection", mark) and seen("dte=3", mark) and seen("exposure=GEX,CHEX", mark))
        page.keyboard.press("Escape")

        print("[E] Atlas heatmap: DTE / Greek / Velocity / EXTREME live in the heatmap's settings")
        check("Atlas heatmap header no longer carries the DTE / Velocity / EXTREME buttons",
              not page.locator("#sidecar .hm-ctrl-stack").first.is_visible())
        check("header keeps the ticker and a one-line readout of what is displayed",
              page.locator("#sidecar .hm-ticker-select").is_visible() and "0DTE" in page.inner_text("#sidecar .hm-selection-line"),
              page.inner_text("#sidecar .hm-selection-line"))
        check("header shows King AND the most negative strike", page.locator("#sidecar .hm-king-strike").inner_text().startswith("@")
              and page.locator("#sidecar .hm-neg-label").is_visible())
        check("most negative strike is marked on its row", page.locator("#sidecar .hm-badge-neg").count() == 1)
        check("Badges icon sits in the header across from Show Heatmap", page.locator("#sidecar .sidecar-header-controls .sidecar-badges-btn").count() == 1)
        before = page.locator("#sidecar .hm-pct-badge").count()
        page.click("#sidecar .sidecar-badges-btn"); page.wait_for_timeout(2300)
        check("Badges icon turns the change pills on", page.locator("#sidecar .hm-pct-badge").count() > before, f"{before} -> {page.locator('#sidecar .hm-pct-badge').count()}")
        page.click("#sidecar .sidecar-badges-btn")
        page.click("#sidecar .hm-settings-gear")
        pop = ".hm-popover-compact:visible"
        check("settings holds the expiration chips 0DTE-6DTE", page.locator(f"{pop} [data-dte]").count() == 7)
        greeks = page.locator(f"{pop} [data-greek]").evaluate_all("els => els.map(e => e.dataset.greek)")
        check("Atlas Greek options: GEX, VEX and the combined GEX+VEX (one chip)", greeks == ["GEX", "VEX", "GEX+VEX"], str(greeks))
        check("settings holds Velocity Mode and EXTREME", page.locator(f"{pop} .hm-velocity-btn").is_visible() and page.locator(f"{pop} .hm-extreme-btn").is_visible())
        mark = len(requests)
        page.click(f"{pop} [data-dte='2']")
        page.click(f"{pop} [data-greek='GEX+VEX']")
        page.wait_for_timeout(2300)
        check("draft edits do NOT reach the heatmap before Apply", not seen("expiration=dte:2", mark) and "0DTE" in page.inner_text("#sidecar .hm-selection-line"))
        page.click(f"{pop} .hm-settings-apply"); page.wait_for_timeout(2300)
        check("heatmap fetches the combined GEX+VEX for the chosen DTE", seen("/api/heatmap?ticker=SPY&exposure=GEX+VEX&expiration=dte:2", mark))
        check("the chosen expiration / Greek chips light up in the settings",
              "active" in page.eval_on_selector(f"{pop} [data-dte='2']", "e => e.className")
              and "active" in page.eval_on_selector(f"{pop} [data-greek='GEX+VEX']", "e => e.className")
              and "active" not in page.eval_on_selector(f"{pop} [data-dte='0']", "e => e.className"))
        pb = page.locator(pop).bounding_box()
        check("settings popover stays fully on screen", pb["x"] >= 0 and pb["x"] + pb["width"] <= 1700 and pb["y"] + pb["height"] <= 950, str(pb))
        sb = page.locator("#sidecar .sidecar-quad-toggle-btn").bounding_box()
        check("Quadrinity button in the heatmap header is fully visible", sb["x"] + sb["width"] <= 1700, str(sb))
        check("readout under the ticker follows the choice", "2DTE" in page.inner_text("#sidecar .hm-selection-line") and "GEX+VEX" in page.inner_text("#sidecar .hm-selection-line"),
              page.inner_text("#sidecar .hm-selection-line"))
        page.click(f"{pop} [data-greek='GEX']"); page.click(f"{pop} .hm-settings-apply")
        page.click("body", position={"x": 5, "y": 5})

        print("[F] Velocity Mode")
        mark = len(requests)
        page.click("#sidecar .hm-settings-gear")
        page.click(f"{pop} .hm-velocity-btn"); page.click(f"{pop} .hm-settings-apply")
        page.click("body", position={"x": 5, "y": 5})
        page.wait_for_timeout(2400)
        pills = page.eval_on_selector_all("#sidecar .hm-vel-pill", "els => els.map(e => e.className + '|' + e.textContent)")
        check("velocity pills appear", len(pills) >= 5, str(len(pills)))
        check("green (accumulating) and red (unwinding) pills both present",
              any("hm-vel-pos" in p for p in pills) and any("hm-vel-neg" in p for p in pills))
        check("positive pills read +N%, negative read -N%",
              all(p.split("|")[1].startswith("+") for p in pills if "hm-vel-pos" in p)
              and all(p.split("|")[1].startswith("-") for p in pills if "hm-vel-neg" in p))
        check("velocity request sent with the session baseline", seen("velocity=1", mark) and seen("velocity_baseline=session", mark))
        mark = len(requests)
        page.click("#sidecar .hm-settings-gear")
        page.select_option(f"{pop} .hm-vel-baseline", "5m")
        page.select_option(f"{pop} .hm-vel-scope", "0dte")
        page.click(f"{pop} .hm-settings-apply")
        page.wait_for_timeout(2400)
        check("baseline + expiration scope are configurable", seen("velocity_baseline=5m", mark) and seen("velocity_scope=0dte", mark))
        page.screenshot(path=f"{OUT}/R2_velocity.png")
        page.click("body", position={"x": 5, "y": 5})

        print("[G] EXTREME")
        page.click("#sidecar .hm-settings-gear")
        page.click(f"{pop} .hm-extreme-btn"); page.click(f"{pop} .hm-settings-apply")
        page.click("body", position={"x": 5, "y": 5})
        page.wait_for_timeout(2300)
        bright = page.eval_on_selector_all("#sidecar .hm-row", "els => els.filter(e => e.style.color !== 'rgba(255, 255, 255, 0.35)').length")
        total = page.locator("#sidecar .hm-row").count()
        check("EXTREME highlights the 5 most positive + 5 most negative strikes", bright == 10 and total > 10, f"{bright} of {total}")

        print("[I] header: Charting System + live dot + tabs, toolbar row below")
        page.click("#tab-atlas") if page.locator("#tab-atlas.active").count() == 0 else None
        head = page.inner_text("header")
        check("header reads 'Charting System' (no Duotonic)", "Charting System" in head and "DUOTONIC" not in head.upper(), head.replace("\n", " | "))
        check("Atlas and Quadrinity tabs live in the header", page.locator("header #tab-atlas").count() == 1 and page.locator("header #tab-quadrinity").count() == 1)
        check("dot is green while the terminal is pulling data", page.evaluate("() => document.getElementById('live-dot').classList.contains('live')"))
        hb = page.locator("header").bounding_box(); tb = page.locator("#atlas-layout-controls").bounding_box()
        check("Layout / Windows row sits directly under the header, horizontally stacked",
              tb["y"] >= hb["y"] + hb["height"] - 2 and len({round(page.locator('#atlas-layout-controls button').nth(i).bounding_box()['y']) for i in range(4)}) == 1)

        print("[J] Orbs window: exposure labels on/off")
        def label_pixels():
            return page.evaluate("""() => {
              const c = document.querySelector('.atlas-orb-canvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
              let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i+3] > 200 && d[i] > 190 && d[i+1] > 190 && d[i+2] > 190) n++; return n; }""")
        with_labels = label_pixels()
        page.click(".atlas-orbs-open")
        check("Orbs window has a labels switch, on by default", page.locator(".atlas-orb-labels-toggle").is_checked())
        page.uncheck(".atlas-orb-labels-toggle")
        page.click(".atlas-orbs-save-btn"); page.wait_for_timeout(1600)
        without = label_pixels()
        check("turning labels off removes the exposure text beside the orbs", with_labels > 50 and without < with_labels * 0.1, f"{with_labels} -> {without}")
        page.click(".atlas-orbs-open"); page.check(".atlas-orb-labels-toggle")
        page.click(".atlas-orbs-save-btn"); page.wait_for_timeout(1600)
        check("turning labels back on restores them", label_pixels() > with_labels * 0.5)

        print("[K] Drawing toolbar: horizontal box, draggable, Price Range tool")
        strip = page.locator("#chart-pane .atlas-drawing-strip").first
        bb = strip.bounding_box()
        check("toolbar is a horizontal box (wider than tall)", bb["width"] > bb["height"] * 3, str(bb))
        ys = {round(strip.locator(".atlas-drawing-tool").nth(i).bounding_box()["y"]) for i in range(7)}
        check("all seven icons sit on one row", len(ys) == 1, str(ys))
        names = strip.locator(".atlas-drawing-tool[data-tool]").evaluate_all("els => els.map(e => e.dataset.tool)")
        check("tools: cursor, rectangle, h-line, short, long and the new price range", names == ["cursor", "rect", "hline", "short", "long", "range"], str(names))
        grip = strip.locator(".atlas-drawing-grip").bounding_box()
        check("drag grip is at the far left of the toolbar", grip["x"] <= bb["x"] + 12 and grip["x"] < strip.locator(".atlas-drawing-tool").first.bounding_box()["x"])
        gx, gy = grip["x"] + grip["width"] / 2, grip["y"] + grip["height"] / 2
        page.mouse.move(gx, gy); page.mouse.down(); page.mouse.move(gx + 160, gy + 140, steps=8); page.mouse.up()
        moved = strip.bounding_box()
        check("dragging the grip moves the whole toolbar", abs((moved["x"] - bb["x"]) - 160) < 6 and abs((moved["y"] - bb["y"]) - 140) < 6, f"{bb['x']},{bb['y']} -> {moved['x']},{moved['y']}")
        cp = page.locator("#chart-pane .atlas-multi-pane, #chart-pane").first.bounding_box()
        page.mouse.move(moved["x"] + 10, moved["y"] + 10); page.mouse.down(); page.mouse.move(cp["x"] - 400, cp["y"] - 400, steps=5); page.mouse.up()
        clamped = strip.bounding_box()
        check("toolbar cannot be dragged off the chart", clamped["x"] >= cp["x"] - 1 and clamped["y"] >= cp["y"] - 1, f"{clamped} vs {cp}")
        check("toolbar position is remembered", page.evaluate("() => !!localStorage.getItem('skylit:drawing-toolbar-pos')"))
        page.mouse.move(clamped["x"] + 10, clamped["y"] + 10); page.mouse.down(); page.mouse.move(clamped["x"] + 30, clamped["y"] + 260, steps=5); page.mouse.up()
        page.click("#chart-pane .atlas-drawing-tool-range")
        canvas_box = page.locator("#chart-pane .atlas-drawing-canvas").first.bounding_box()
        x1, y1 = canvas_box["x"] + 420, canvas_box["y"] + 330
        page.mouse.move(x1, y1); page.mouse.down(); page.mouse.move(x1 + 180, y1 - 120, steps=8); page.mouse.up()
        page.wait_for_timeout(300)
        stored = page.evaluate("() => JSON.parse(localStorage.getItem('skylit:drawings:SPY') || '[]')")
        rng = [d for d in stored if d["type"] == "range"]
        check("Price Range tool saved a drawing from start to extension", len(rng) == 1 and rng[0]["p2"]["price"] > rng[0]["p1"]["price"], str(rng))
        painted = page.evaluate("""() => {
          const c = document.querySelector('#chart-pane .atlas-drawing-canvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let green = 0, white = 0; for (let i = 0; i < d.length; i += 4) { if (d[i+3] < 100) continue;
            if (d[i+1] > 150 && d[i] < 90 && d[i+2] < 120) green++; if (d[i] > 230 && d[i+1] > 230 && d[i+2] > 230) white++; }
          return { green, white }; }""")
        check("an upward range is drawn green with its measurement label", painted["green"] > 100 and painted["white"] > 20, str(painted))
        page.click("#chart-pane .atlas-drawing-tool-cursor", timeout=3000)
        check("toolbar stays clickable above the drawing canvas (can switch back to Cursor after a tool is active)",
              "active" in page.eval_on_selector("#chart-pane .atlas-drawing-tool-cursor", "e => e.className"))
        page.screenshot(path=f"{OUT}/R4_drawing.png")

        print("[H] Quadrinity page")
        page.click("#tab-quadrinity")
        page.wait_for_selector(".quad-pane .hm-ctrl-stack")
        page.wait_for_timeout(1800)
        check("every Quadrinity heatmap has the stacked controls",
              page.locator(".quad-pane .hm-ctrl-stack").count() == page.locator(".quad-pane").count() >= 2)
        page.locator(".quad-pane .hm-dte-btn").first.click()
        greeks = page.locator(".hm-dte-menu:visible [data-greek]").all_inner_texts()
        check("Quadrinity offers CHEX (charm) as a selectable Greek", any(g.startswith("CHEX") for g in greeks), str(greeks))
        check("Quadrinity has GEX+VEX back as ONE combined option", sum(1 for g in greeks if g.startswith("GEX+VEX")) == 1 and len(greeks) == 4, str(greeks))
        mark = len(requests)
        page.click(".hm-dte-menu:visible [data-greek='CHEX']")
        page.click(".hm-dte-menu:visible [data-dte='3']")
        page.wait_for_timeout(3500)
        check("Quadrinity pane fetches its own Greek + DTE", seen("exposure=CHEX&expiration=dte:3", mark))
        check("confluence is computed from each pane's own selection", seen("/api/quadrinity", mark) and seen("specs=CHEX~dte:3", mark))
        page.locator(".quad-pane .hm-velocity-btn").first.click()
        page.locator(".quad-pane .hm-extreme-btn").nth(1).click()
        page.wait_for_timeout(2400)
        check("Velocity Mode works on Quadrinity heatmaps", page.locator(".quad-pane .hm-vel-pill").count() >= 3)
        check("EXTREME works on Quadrinity heatmaps",
              page.eval_on_selector_all(".quad-pane:nth-child(2) .hm-row", "els => els.filter(e => e.style.color !== 'rgba(255, 255, 255, 0.35)').length") == 10)
        page.screenshot(path=f"{OUT}/R3_quadrinity.png")

        check("zero JS errors across the whole session", not errors, "; ".join(errors[:3]))
        b.close()
finally:
    srv.terminate()

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
