#!/usr/bin/env python3
"""Two simultaneous viewers, as in a VS Code Live Share session.

  * HOST  opens the terminal directly on the server port (http://127.0.0.1:PORT).
  * GUEST opens it through a latency proxy on a *different* port and Host header, which is what a
    Live Share shared-server / forwarded port looks like to the guest's browser.

Checks that both viewers get live, independently-updating data at the same time, that rapid ticker
switching on both does not disturb either (or the server), that the server stays responsive and
leak-free, that foreign Origin/Host headers are not rejected (no origin blocking), and that a guest
cannot read anything outside the frontend directory.

    python3 tests/e2e/pw_two_viewers.py
"""
import http.client
import os
import statistics
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from latency_proxy import LatencyProxy  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER_PORT, PROXY_PORT = 18520, 18521
GUEST_LATENCY_S = 0.12  # one-way-ish relay delay added to every guest API call
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))


def proc_stats(pid):
    rss = threads = 0
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                rss = int(line.split()[1])
            elif line.startswith("Threads:"):
                threads = int(line.split()[1])
    return rss, threads, len(os.listdir(f"/proc/{pid}/fd"))


srv = subprocess.Popen([f"{ROOT}/build/skylit_server", "--port", str(SERVER_PORT), "--web-root", f"{ROOT}/frontend"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
proxy = None
try:
    for _ in range(80):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{SERVER_PORT}/api/health", timeout=1)
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    proxy = LatencyProxy(PROXY_PORT, SERVER_PORT,
                         lambda t: GUEST_LATENCY_S if t.startswith("/api/") and not t.startswith("/api/health") else 0.0).start()
    base_rss, base_thr, base_fd = proc_stats(srv.pid)
    stub = open(f"{ROOT}/tests/e2e/lwc_render_stub.js").read()

    # health probe running for the whole session: the server must stay responsive for everyone
    health_lat, health_err, stop_probe = [], [], threading.Event()

    def probe():
        while not stop_probe.is_set():
            t0 = time.perf_counter()
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{SERVER_PORT}/api/health", timeout=3).read()
                health_lat.append((time.perf_counter() - t0) * 1000)
            except Exception as e:  # noqa: BLE001
                health_err.append(str(e))
            time.sleep(0.2)

    threading.Thread(target=probe, daemon=True).start()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None, args=["--no-sandbox"])

        def viewer(port):
            ctx = browser.new_context(viewport={"width": 1700, "height": 950})
            page = ctx.new_page()
            errors, failed = [], []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
            page.on("response", lambda r: failed.append(f"{r.status} {r.url}") if r.status >= 400 else None)
            page.route("**/unpkg.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
            page.goto(f"http://127.0.0.1:{port}/")
            page.wait_for_selector(".atlas-pane-price")
            return ctx, page, errors, failed

        print("[1] both viewers load the terminal")
        host_ctx, host, host_err, host_fail = viewer(SERVER_PORT)
        guest_ctx, guest, guest_err, guest_fail = viewer(PROXY_PORT)
        host.wait_for_timeout(1500)
        check("host sees a live price", host.inner_text(".atlas-pane-price").startswith("$"), host.inner_text(".atlas-pane-price"))
        check("guest (via forwarded port) sees a live price", guest.inner_text(".atlas-pane-price").startswith("$"),
              guest.inner_text(".atlas-pane-price"))
        check("guest page talks to the forwarded origin, not a hard-coded host",
              guest.evaluate("location.port") == str(PROXY_PORT))

        print("[2] real-time data reaches both viewers")
        seen_h, seen_g = set(), set()
        for _ in range(24):
            seen_h.add(host.inner_text(".atlas-pane-price"))
            seen_g.add(guest.inner_text(".atlas-pane-price"))
            host.wait_for_timeout(500)
        check("host price keeps ticking", len(seen_h) >= 3, f"{len(seen_h)} distinct values in 12s")
        check("guest price keeps ticking", len(seen_g) >= 3, f"{len(seen_g)} distinct values in 12s")

        print("[3] viewers are independent (ticker selection is per page)")
        host.select_option(".atlas-pane-ticker-select", "SPXW")
        host.wait_for_timeout(3500)
        guest.wait_for_timeout(500)

        def val(t):
            try:
                return float(t.replace("$", "").replace(",", ""))
            except ValueError:
                return None
        hv, gv = val(host.inner_text(".atlas-pane-price")), val(guest.inner_text(".atlas-pane-price"))
        check("host switched to SPXW (~$57xx)", hv and hv > 1000, str(hv))
        check("guest still on SPY (~$5xx), unaffected by host", gv and gv < 1000, str(gv))

        print("[4] busy configuration + rapid ticker switching on both viewers at once")
        for pg in (host, guest):
            pg.click(".sidecar-quad-toggle-btn")
            pg.click(".sidecar-quad-count-btn[data-count='4']")
        tickers = ["SPY", "QQQ", "NVDA", "SPXW"]
        for i in range(24):
            host.select_option(".atlas-pane-ticker-select", tickers[i % 4])
            guest.select_option(".atlas-pane-ticker-select", tickers[(i + 2) % 4])
            host.wait_for_timeout(120)
        host.wait_for_timeout(3500)
        guest.wait_for_timeout(1000)
        check("host still renders a price after the switching storm", host.inner_text(".atlas-pane-price").startswith("$"))
        check("guest still renders a price after the switching storm", guest.inner_text(".atlas-pane-price").startswith("$"))
        check("neither viewer has a heatmap panel stuck on an error",
              host.locator(".hm-error").count() == 0 and guest.locator(".hm-error").count() == 0)

        print("[5] guest reload revalidates static assets (ETag -> 304) instead of re-downloading")
        # Measured at the proxy (the real upstream status). This uses its own browser WITHOUT
        # page.route(): Playwright switches Chromium's HTTP cache off while request interception is
        # active, so the stubbed pages above can never revalidate. unpkg.com is blackholed so the
        # chart CDN fails fast (charts are irrelevant to this check).
        cache_browser = pw.chromium.launch(executable_path=os.environ.get("SKYLIT_CHROMIUM") or None,
                                           args=["--no-sandbox", "--host-resolver-rules=MAP unpkg.com 127.0.0.1:9"])
        cpage = cache_browser.new_context().new_page()
        cpage.goto(f"http://127.0.0.1:{PROXY_PORT}/", wait_until="domcontentloaded")
        cpage.wait_for_timeout(1500)
        proxy.upstream_status.clear()
        cpage.reload(wait_until="domcontentloaded")
        cpage.wait_for_timeout(1500)
        static = [(p, st) for p, st in proxy.upstream_status if not p.startswith("/api/")]
        n304 = sum(1 for _, st in static if st == 304)
        n200 = sum(1 for _, st in static if st == 200)
        print(f"       static requests on guest reload: {n304} x 304, {n200} x 200")
        check("guest reload revalidates the page's static files with 304s", n304 >= 5 and n200 == 0,
              f"{n304} x 304, {n200} x 200")
        cache_browser.close()

        check("no console/page errors - host", not host_err, "; ".join(host_err[:3]))
        check("no console/page errors - guest", not guest_err, "; ".join(guest_err[:3]))
        check("no HTTP >=400 responses seen by host", not host_fail, "; ".join(host_fail[:3]))
        check("no HTTP >=400 responses seen by guest", not guest_fail, "; ".join(guest_fail[:3]))

        host_ctx.close()
        guest_ctx.close()
        browser.close()

    stop_probe.set()
    time.sleep(0.3)
    p50 = statistics.median(health_lat) if health_lat else 0
    p99 = sorted(health_lat)[int(len(health_lat) * 0.99) - 1] if len(health_lat) > 5 else 0
    check("server answered every health probe during the two-viewer session", not health_err and len(health_lat) > 50,
          f"{len(health_lat)} probes, errors={health_err[:2]}")
    check("health latency stayed low with two busy viewers", p99 < 250, f"p50={p50:.1f}ms p99={p99:.1f}ms")

    time.sleep(3)  # let the browsers' kept-alive sockets close and the server's per-connection threads exit
    rss, thr, fd = proc_stats(srv.pid)
    print(f"       server before/after: RSS {base_rss}->{rss} KB, threads {base_thr}->{thr}, fds {base_fd}->{fd}")
    check("server RSS growth < 10 MB", rss - base_rss < 10 * 1024, f"{(rss - base_rss) / 1024:.1f} MB")
    check("server threads returned to baseline after viewers left", thr <= base_thr + 2, f"{base_thr}->{thr}")
    check("server fds returned to baseline after viewers left", fd <= base_fd + 3, f"{base_fd}->{fd}")

    print("[6] no origin blocking; a guest cannot read outside the frontend directory")
    c = http.client.HTTPConnection("127.0.0.1", PROXY_PORT, timeout=5)
    c.request("GET", "/api/health", headers={"Host": "abcd1234-8080.euw.devtunnels.ms",
                                              "Origin": "https://abcd1234-8080.euw.devtunnels.ms"})
    r = c.getresponse(); r.read()
    check("request with a tunnel Host/Origin is served (no origin/host checks)", r.status == 200, str(r.status))
    check("page is served for a tunnel Host header too",
          http.client.HTTPConnection("127.0.0.1", PROXY_PORT, timeout=5).request("GET", "/", headers={"Host": "x.devtunnels.ms"}) is None)
    leaks = []
    for path in ["/Makefile", "/README.md", "/backend/src/main.cpp", "/backend/include/skylit/http_server.hpp",
                 "/.git/HEAD", "/.git/config", "/.env", "/.vscode/launch.json", "/.vscode/settings.json",
                 "/docs/LIVE_SHARE.md", "/tests/e2e/pw_two_viewers.py", "/scripts/run.sh", "/.gitignore",
                 "/build/skylit_server", "/../Makefile", "/%2e%2e/Makefile", "/js/../../Makefile"]:
        try:
            cc = http.client.HTTPConnection("127.0.0.1", PROXY_PORT, timeout=5)
            cc.request("GET", path)
            rr = cc.getresponse(); body = rr.read()
            if rr.status == 200 and path != "/":
                leaks.append(f"{path} -> 200 ({len(body)}B)")
        except Exception as e:  # noqa: BLE001
            leaks.append(f"{path} -> error {e}")
    check("no repo/config/source/secret file is reachable through the shared port", not leaks, "; ".join(leaks[:4]))
finally:
    if proxy:
        proxy.stop()
    srv.terminate()
    try:
        srv.wait(timeout=5)
    except Exception:  # noqa: BLE001
        srv.kill()

out = srv.stdout.read() if srv.stdout else ""
check("backend logged no errors/warnings", not any(w in out.lower() for w in ("error", "warn", "fail")), out.strip()[-200:])
print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
