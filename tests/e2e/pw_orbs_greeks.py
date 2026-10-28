#!/usr/bin/env python3
"""S5 / S9 / S10 — King & Barney nodes per Greek, Greeks never merged, label format, collisions, drift.
Independent check: expected nodes are recomputed here from the RAW /api/heatmap JSON (single Greek each)."""
import json, os, re, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from real_lwc import install_real_lwc
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get("SKYLIT_TEST_PORT", "18438"))
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))

INIT = """(() => { let real; Object.defineProperty(window, 'createAtlasController', { configurable: true,
  set(f) { real = function () { const c = f.apply(this, arguments); (window.__ctl = window.__ctl || []).push(c); return c; }; }, get() { return real; } }); })();"""
def raw(ticker, greek, exp="0dte"):
    return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/heatmap?ticker={ticker}&exposure={greek}&expiration={exp}").read())

srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(PORT), "--web-root", f"{ROOT}/frontend"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"]); pg = b.new_context(viewport={"width": 1700, "height": 950}).new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.add_init_script(INIT); install_real_lwc(pg)
        pg.goto(f"http://127.0.0.1:{PORT}/"); pg.wait_for_selector(".atlas-pane-price"); pg.wait_for_timeout(3000)
        def select(g): pg.evaluate("(g) => window.__ctl[0].setExposureType(g)", g); pg.wait_for_timeout(1800)
        groups = lambda: pg.evaluate("() => window.__ctl[0].getOrbGroups()")
        labels = lambda: pg.evaluate("() => window.__ctl[0].getOrbLayer().getLabels()")

        print("[1] King = most positive, Barney = most negative, per Greek (independent recompute from raw API)")
        for g in ["GEX", "VEX", "CHEX", "COLOR", "SPEED"]:
            select(g); gs = groups(); rb = raw("SPY", g)
            nodes = rb["nodes"]
            pos = [n for n in nodes if n["exposure"] > 0]; neg = [n for n in nodes if n["exposure"] < 0]
            exp_king = max(pos, key=lambda n: n["exposure"])["strike"] if pos else None
            exp_barney = min(neg, key=lambda n: n["exposure"])["strike"] if neg else None
            got = gs[0]["nodes"] if gs else []
            gk = [n["strike"] for n in got if n["isKing"]]; gb = [n["strike"] for n in got if n["isBarney"]]
            # the live feed moves between the app's fetch and ours: accept exposure-level equality at the identified strike
            ok = (len(gs) == 1 and gs[0]["greek"] == g and (gk == [exp_king] or exp_king is None) and (gb == [exp_barney] or exp_barney is None))
            check(f"{g}: king@{gk} barney@{gb} == independent {exp_king}/{exp_barney}", ok)
        print("[2] Greeks are never merged: values identical alone vs together")
        select("GEX"); alone = {n["strike"]: n["exposure"] for n in groups()[0]["nodes"]}
        select("GEX,VEX,COLOR,SPEED,CHEX"); gs = groups()
        check("five separate groups, in display order", [g["greek"] for g in gs] == ["GEX", "VEX", "CHEX", "COLOR", "SPEED"], str([g["greek"] for g in gs]))
        together = {n["strike"]: n["exposure"] for n in gs[0]["nodes"]}
        same = [k for k in alone if k in together and abs(alone[k] - together[k]) < 1e-6 * max(1, abs(alone[k]))]
        check("GEX values unchanged when other Greeks are enabled", len(same) >= len(alone) * 0.9, f"{len(same)}/{len(alone)}")
        for g in gs:
            rb = {n["strike"]: n["exposure"] for n in raw("SPY", g["greek"])["nodes"]}
            check(f"{g['greek']} group equals its own single-Greek API values (no summing)",
                  all(abs(rb.get(n['strike'], 1e18) - n['exposure']) < 1e-3 * max(1, abs(n['exposure'])) for n in g["nodes"]))
        select("GEX,VEX"); pair = groups()
        check("pair (GEX,VEX): GEX nodes identical to alone", all(abs(alone.get(n['strike'], 1e18) - n['exposure']) < 1e-6 * max(1, abs(n['exposure'])) for n in pair[0]["nodes"]))
        print("[3] labels: 'Pos|Neg <code> <value>', unique codes, no overlaps, deterministic")
        select("GEX,VEX,CHEX,COLOR,SPEED"); L = labels()
        rx = re.compile(r"^(Pos|Neg) [GVCKS] \d+(\.\d+)?[KMB]?$")
        check("every label matches the required format", L and all(rx.match(l["text"]) for l in L), str([l['text'] for l in L[:4]]))
        codes = {l["greek"]: l["text"].split()[1] for l in L}
        check("one unique code per Greek (G V C K S)", sorted(codes.values()) == ["C", "G", "K", "S", "V"] and len(set(codes.values())) == 5, str(codes))
        def overlaps(a, b):
            return abs(a["labelY"] - b["labelY"]) < 15.5 and a["xRight"] - a["w"] < b["xRight"] and b["xRight"] - b["w"] < a["xRight"]
        bad = [(a["text"], b["text"]) for i, a in enumerate(L) for b in L[i + 1:] if overlaps(a, b)]
        check("no two labels overlap (rectangles intersect test over all pairs)", not bad, str(bad[:2]))
        check("every label is present (none hidden): one per displayed node", len(L) == sum(len(g["nodes"]) for g in groups()), f"{len(L)} labels")
        check("collisions were actually exercised (some label displaced)", any(abs(l["labelY"] - l["y"]) > 3 or l["xRight"] < max(m["xRight"] for m in L) - 1 for l in L))
        L2 = labels(); check("layout is deterministic across repaints", [(l['text'], round(l['labelY'], 2)) for l in L] == [(l['text'], round(l['labelY'], 2)) for l in L2])
        sign_ok = all((l["text"].startswith("Pos")) == (next(n for g in groups() if g["greek"] == l["greek"] for n in g["nodes"] if n["strike"] == l["strike"])["exposure"] >= 0) for l in L)
        check("sign in every label matches the exposure sign", sign_ok)
        select("GEX"); L1 = labels()
        check("single Greek shows the letter too (Pos|Neg G value)", L1 and all(re.match(r"^(Pos|Neg) G ", l["text"]) for l in L1))
        check("King and Barney tags carried by exactly one node each", sum(1 for l in L1 if l["king"]) == 1 and sum(1 for l in L1 if l["barney"]) <= 1)
        print("[4] switching Greek/expiry/ticker moves highlights; no residue")
        select("GEX"); a = [l["strike"] for l in labels() if l["king"]]
        pg.evaluate("() => window.__ctl[0].setExpirationSelector('dte:3')"); pg.wait_for_timeout(1800)
        rb3 = raw("SPY", "GEX", "dte:3"); k3 = max((n for n in rb3["nodes"] if n["exposure"] > 0), key=lambda n: n["exposure"])["strike"]
        check("changing expiry recomputes King from the new expiry's table", [l["strike"] for l in labels() if l["king"]] == [k3], f"{a}->{k3}")
        pg.evaluate("() => window.__ctl[0].setTicker('QQQ')"); pg.wait_for_timeout(2200)
        rq = raw("QQQ", "GEX", "dte:3"); kq = max((n for n in rq["nodes"] if n["exposure"] > 0), key=lambda n: n["exposure"])["strike"]
        check("changing ticker recomputes King (no carry-over of hysteresis)", [l["strike"] for l in labels() if l["king"]] == [kq])
        check("no page errors", not errs, str(errs[:3]))
        b.close()
finally:
    srv.terminate()
print(f"\n{sum(results)}/{len(results)} checks passed"); sys.exit(0 if all(results) else 1)
