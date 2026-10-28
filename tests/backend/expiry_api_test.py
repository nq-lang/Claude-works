#!/usr/bin/env python3
"""S2 — expiry selection correctness against the live API: multi-select is the exact per-strike sum of the
individual expiries (order/duplicate independent), distinct expiries are distinct data, and invalid selectors
are rejected explicitly (never silently mapped to 0DTE).  usage: expiry_api_test.py [port]"""
import json, sys, urllib.request, urllib.error, urllib.parse
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080; ok = []
def get(q):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/heatmap?{q}") as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
def check(n, c, d=""): ok.append(bool(c)); print(("  PASS  " if c else "  FAIL  ") + n + (f"   [{d}]" if d else ""))
def exp(sel, t="SPY", g="GEX"):
    s, b = get(f"ticker={t}&exposure={g}&expiration={urllib.parse.quote(sel)}"); assert s == 200, (sel, s, b)
    return {n["strike"]: n["exposure"] for n in b["nodes"]}
for t in ["SPY", "VIX", "TSLA"]:
    for g in ["GEX", "VEX"]:
        a, b2, c3 = exp("dte:0", t, g), exp("dte:2", t, g), exp("dte:3", t, g)
        m = exp("dte:0,2,3", t, g)
        strikes = set(a) | set(b2) | set(c3)
        err = max(abs(m.get(k, 0) - (a.get(k, 0) + b2.get(k, 0) + c3.get(k, 0))) for k in strikes)
        # live data ticks between requests, so allow a small relative drift
        scale = max(abs(v) for v in m.values()) or 1
        check(f"{t} {g}: dte:0,2,3 == sum of 0,2,3 per strike", err / scale < 0.02, f"max err {err/scale:.4%}")
    m1, m2 = exp("dte:3,0,2,0"), exp("dte:0,2,3")
    scale = max(abs(v) for v in m2.values()) or 1
    check(f"{t}: order/duplicates don't change the result", max(abs(m1.get(k, 0) - m2.get(k, 0)) for k in set(m1) | set(m2)) / scale < 0.02)
a, c = exp("dte:0"), exp("dte:3")
check("0DTE and 3DTE are different data", any(abs(a.get(k, 0) - c.get(k, 0)) > 1e-6 for k in a))
for bad in ["dte:", "dte:abc", "dte:-1", "dte:99", "dte:1,,2", "current+0", "current+99", "weekly", "0DTE ", "dte:1.5"]:
    s, b = get(f"ticker=SPY&expiration={urllib.parse.quote(bad)}")
    check(f"invalid selector {bad!r} -> 400 with error", s == 400 and b.get("error") == "invalid expiration selector", f"{s} {b.get('detail')}")
for good in ["0dte", "current+1", "current+50", "dte:0", "dte:0,6", "dte:50"]:
    s, _ = get(f"ticker=SPY&expiration={urllib.parse.quote(good)}"); check(f"valid selector {good!r} -> 200", s == 200, str(s))
print(f"\n{sum(ok)}/{len(ok)} checks passed"); sys.exit(0 if all(ok) else 1)
