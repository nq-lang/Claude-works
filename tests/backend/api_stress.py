#!/usr/bin/env python3
"""Robustness / concurrency probe for the Skylit server.

Usage: python3 tests/backend/api_stress.py [port] [--quick]

Checks that the server
  * survives malformed / hostile requests (no crash, always answers afterwards),
  * is not blocked by an idle client (slow-loris) -- two Live Share viewers
    must be able to use the terminal at the same time,
  * survives clients that disconnect before the response is written (SIGPIPE),
  * serves many concurrent clients with consistent JSON.
Exit status is non-zero on any failure.
"""
import json
import socket
import sys
import threading
import time
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 18090
QUICK = "--quick" in sys.argv
HOST = "127.0.0.1"
failures = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


def get(path, timeout=5):
    with urllib.request.urlopen(f"http://{HOST}:{PORT}{path}", timeout=timeout) as r:
        return r.status, r.read()


def raw(payload: bytes, timeout=5, read=True):
    s = socket.create_connection((HOST, PORT), timeout=timeout)
    try:
        s.sendall(payload)
        if not read:
            return b""
        buf = b""
        while True:
            try:
                d = s.recv(65536)
            except socket.timeout:
                break
            if not d:
                break
            buf += d
        return buf
    finally:
        s.close()


def alive(label):
    try:
        st, body = get("/api/health", timeout=3)
        check(st == 200 and b'"ok"' in body, f"server alive after: {label}")
    except Exception as e:  # noqa: BLE001
        check(False, f"server alive after: {label} ({e})")


print("== valid routes")
routes = [
    "/api/health", "/api/tickers", "/api/heatmap?ticker=SPY&exposure=GEX&expiration=0dte",
    "/api/heatmap?ticker=SPXW&exposure=GEX,VEX,CHEX&expiration=dte:0,1,3&velocity=1&velocity_baseline=15m&velocity_scope=all",
    "/api/quadrinity?tickers=SPXW,SPY,QQQ,NVDA&specs=GEX~0dte,VEX~dte:1,GEX,VEX~current%2B3",
    "/api/projection/config", "/api/projection?ticker=SPY&exposure=GEX&interval=5m&dte=2",
    "/api/candles?ticker=SPY&interval=1m", "/api/candles/latest?ticker=QQQ&interval=15m",
    "/api/darkpool?ticker=NVDA", "/api/flow?ticker=SPY&interval=5m", "/", "/index.html", "/js/atlas.js",
]
for r in routes:
    try:
        st, body = get(r)
        ok = st == 200 and len(body) > 0
        if r.startswith("/api/"):
            json.loads(body)
        check(ok, f"GET {r[:70]} -> {st}")
    except Exception as e:  # noqa: BLE001
        check(False, f"GET {r[:70]} raised {e}")

print("== hostile / malformed input")
bad = {
    "garbage": b"\x00\x01\x02garbage\r\n\r\n",
    "no-version": b"GET /api/health\r\n\r\n",
    "empty": b"",
    "bad-content-length": b"POST /api/health HTTP/1.1\r\nContent-Length: abc\r\n\r\n",
    "huge-content-length": b"POST /api/health HTTP/1.1\r\nContent-Length: 99999999999999999999\r\n\r\n",
    "big-content-length": b"POST /api/health HTTP/1.1\r\nContent-Length: 4000000000\r\n\r\n",
    "long-url": b"GET /" + b"a" * 200000 + b" HTTP/1.1\r\n\r\n",
    "traversal": b"GET /../Makefile HTTP/1.1\r\n\r\n",
    "traversal-encoded": b"GET /%2e%2e/Makefile HTTP/1.1\r\n\r\n",
    "traversal-prefix": b"GET /../web-secret/x HTTP/1.1\r\n\r\n",
    "bad-percent": b"GET /api/heatmap?ticker=%zz%4 HTTP/1.1\r\n\r\n",
    "dangling-percent": b"GET /api/heatmap?ticker=SPY% HTTP/1.1\r\n\r\n",
}
for name, payload in bad.items():
    try:
        resp = raw(payload, timeout=3)
        print(f"       {name}: {resp[:40]!r}")
    except Exception as e:  # noqa: BLE001
        print(f"       {name}: connection error {e}")
    alive(name)

queries = [
    "/api/heatmap?ticker=NOPE", "/api/heatmap?ticker=", "/api/heatmap?exposure=&expiration=",
    "/api/heatmap?expiration=dte:", "/api/heatmap?expiration=dte:-5,999999999999,abc",
    "/api/heatmap?expiration=current%2B", "/api/heatmap?expiration=current%2B99999999999999",
    "/api/heatmap?expiration=current%2B-3", "/api/heatmap?exposure=%00%00",
    "/api/heatmap?velocity=1&velocity_scope=custom&velocity_dtes=x,y,-1,99999",
    "/api/heatmap?velocity=1&velocity_baseline=zzz",
    "/api/quadrinity?tickers=,,,", "/api/quadrinity?tickers=A,B", "/api/quadrinity?tickers=SPY,SPY",
    "/api/quadrinity?tickers=SPY,QQQ&specs=~,~~,x~", "/api/quadrinity?tickers=SPY,QQQ&specs=GEX~dte:abc",
    "/api/quadrinity?tickers=SPY,QQQ,NVDA,SPXW,SPY",
    "/api/projection?ticker=SPY&dte=abc", "/api/projection?ticker=SPY&dte=-1", "/api/projection?ticker=SPY&dte=99",
    "/api/projection?ticker=SPY&dte=99999999999999999999", "/api/projection?ticker=SPY&interval=7s",
    "/api/projection?ticker=SPY&interval=", "/api/projection?ticker=SPY&exposure=ZZZ",
    "/api/candles?ticker=SPY&interval=0", "/api/candles?ticker=SPY&interval=-1m", "/api/candles?ticker=SPY&interval=abc",
    "/api/candles?ticker=SPY&interval=99999999999d", "/api/candles?ticker=NOPE", "/api/candles/latest?ticker=NOPE",
    "/api/flow?ticker=NOPE", "/api/flow?ticker=SPY&interval=0", "/api/darkpool?ticker=NOPE",
]
for q in queries:
    try:
        st, body = (None, b"")
        try:
            st, body = get(q)
        except urllib.error.HTTPError as he:
            st, body = he.code, he.read()
        check(st is not None and st < 600, f"{q[:80]} -> {st}")
    except Exception as e:  # noqa: BLE001
        check(False, f"{q[:80]} raised {e}")
    # any hostile query must leave the server alive
    try:
        get("/api/health", timeout=3)
    except Exception as e:  # noqa: BLE001
        check(False, f"server died after {q[:80]}: {e}")
        break
alive("hostile queries")

print("== client disconnects before response (SIGPIPE)")
for _ in range(40):
    try:
        s = socket.create_connection((HOST, PORT), timeout=2)
        s.sendall(b"GET /api/candles?ticker=SPY&interval=1m HTTP/1.1\r\n\r\n")
        s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b"\x01\x00\x00\x00\x00\x00\x00\x00")  # RST on close
        s.close()
    except Exception:  # noqa: BLE001
        pass
time.sleep(0.5)
alive("40 aborted clients")

print("== idle client must not block other clients")
idle = [socket.create_connection((HOST, PORT)) for _ in range(3)]  # connect, send nothing
t0 = time.time()
try:
    st, _ = get("/api/health", timeout=4)
    check(st == 200, f"health answered while 3 idle connections open ({time.time() - t0:.2f}s)")
except Exception as e:  # noqa: BLE001
    check(False, f"server blocked by idle connections: {e}")
half = socket.create_connection((HOST, PORT))
half.sendall(b"GET /api/health HTTP/1.1\r\nHost: x\r\n")  # headers never finished
t0 = time.time()
try:
    st, _ = get("/api/health", timeout=4)
    check(st == 200, f"health answered while a half-sent request is open ({time.time() - t0:.2f}s)")
except Exception as e:  # noqa: BLE001
    check(False, f"server blocked by half-sent request: {e}")
for s in idle + [half]:
    s.close()

print("== concurrent clients")
N_THREADS = 8 if QUICK else 24
N_REQ = 15 if QUICK else 60
errs = []
lock = threading.Lock()
seen = {"proj": set()}


def worker(i):
    paths = [
        "/api/heatmap?ticker=SPXW&exposure=GEX&expiration=0dte&velocity=1",
        "/api/quadrinity?tickers=SPXW,SPY,QQQ,NVDA",
        "/api/candles/latest?ticker=SPY&interval=1m",
        "/api/candles?ticker=QQQ&interval=5m",
        "/api/flow?ticker=SPY&interval=5m",
        "/api/darkpool?ticker=SPY",
        "/api/projection?ticker=SPY&exposure=GEX%2BVEX&interval=5m&dte=1",
        "/",
    ]
    for j in range(N_REQ):
        p = paths[(i + j) % len(paths)]
        try:
            st, body = get(p, timeout=10)
            if st != 200:
                raise RuntimeError(f"status {st}")
            if p.startswith("/api/"):
                json.loads(body)
        except Exception as e:  # noqa: BLE001
            with lock:
                errs.append(f"{p}: {e}")


t0 = time.time()
ths = [threading.Thread(target=worker, args=(i,)) for i in range(N_THREADS)]
[t.start() for t in ths]
[t.join() for t in ths]
dt = time.time() - t0
total = N_THREADS * N_REQ
check(not errs, f"{total} concurrent requests, {len(errs)} errors ({total / dt:.0f} req/s)")
for e in errs[:5]:
    print("       ", e)
alive("concurrent load")

print()
if failures:
    print(f"FAILED: {len(failures)} check(s)")
    sys.exit(1)
print("api_stress: all checks passed")
