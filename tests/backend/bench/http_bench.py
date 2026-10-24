#!/usr/bin/env python3
"""HTTP-level transport benchmark against a running server.

    python3 tests/backend/bench/http_bench.py [port]

Measures, on localhost, the cost of polling the way the browser does:
  * new TCP connection per request  (what every poll cost before keep-alive)
  * one persistent connection       (HTTP/1.1 keep-alive; falls back to reconnecting if the server closes)
  * 8 parallel persistent clients   (two viewers x a few panes)
and the bytes / time of re-loading the page's static assets with and without conditional requests.
"""
import http.client
import statistics
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
PATHS = ["/api/candles/latest?ticker=SPY&interval=1m", "/api/heatmap?ticker=SPY&exposure=GEX&expiration=dte%3A0",
         "/api/health", "/api/quadrinity?tickers=SPXW,SPY,QQQ,NVDA"]
N = 1500


def one_conn_per_request(n):
    t0 = time.perf_counter()
    for i in range(n):
        c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
        c.request("GET", PATHS[i % len(PATHS)])
        c.getresponse().read()
        c.close()
    return (time.perf_counter() - t0) / n * 1e6


def persistent(n, reconnects=None):
    t0 = time.perf_counter()
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    reconnect = 0
    for i in range(n):
        try:
            c.request("GET", PATHS[i % len(PATHS)])
            r = c.getresponse()
            r.read()
            if r.getheader("Connection", "").lower() == "close":
                c.close()
                c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
                reconnect += 1
        except (http.client.HTTPException, ConnectionError):
            c.close()
            c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
            reconnect += 1
    if reconnects is not None:
        reconnects.append(reconnect)
    return (time.perf_counter() - t0) / n * 1e6


def best(fn, *a):
    return min(fn(*a) for _ in range(5))


print(f"{'scenario':46s} {'us/request':>12s}")
print(f"{'new connection per request':46s} {best(one_conn_per_request, N):12.1f}")
rc = []
print(f"{'persistent connection':46s} {best(persistent, N, rc):12.1f}   (client reconnects: {rc[-1]})")

res = []
def par():
    res.append(persistent(N // 2))
t0 = time.perf_counter()
ths = [threading.Thread(target=par) for _ in range(8)]
[t.start() for t in ths]
[t.join() for t in ths]
wall = time.perf_counter() - t0
print(f"{'8 parallel persistent clients (aggregate)':46s} {wall / (8 * (N // 2)) * 1e6:12.1f}   ({8 * (N // 2) / wall:.0f} req/s)")

# static assets: a page reload
assets = ["/", "/js/nodeutils.js", "/js/colorscale.js", "/js/heatmap.js", "/js/quadrinity.js", "/js/atlas-sidecar.js",
          "/js/atlas.js", "/js/atlas-orbs.js", "/js/atlas-projections.js", "/js/atlas-drawing.js", "/js/atlas-layout.js"]
c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
total = 0
etags = {}
def load(cond):
    global c
    nbytes = 0
    for a in assets:
        h = {"If-None-Match": etags[a]} if cond and a in etags else {}
        try:
            c.request("GET", a, headers=h)
            r = c.getresponse()
        except (http.client.HTTPException, ConnectionError):
            c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
            c.request("GET", a, headers=h)
            r = c.getresponse()
        body = r.read()
        nbytes += len(body)
        if r.getheader("ETag"):
            etags[a] = r.getheader("ETag")
    return nbytes
t0 = time.perf_counter(); first = load(False); t_first = time.perf_counter() - t0
t0 = time.perf_counter(); again = load(True); t_again = time.perf_counter() - t0
print(f"\npage load, cold:                 {first / 1024:7.1f} KB body, {t_first * 1e3:6.1f} ms")
print(f"page reload, conditional (ETag): {again / 1024:7.1f} KB body, {t_again * 1e3:6.1f} ms")
