"""Tiny threaded HTTP reverse proxy used by the browser tests.

It stands in for a VS Code Live Share forwarded port: the guest's browser talks
to a *different* port (and Host header) than the one the C++ server listens on,
optionally with network latency, so we can prove that the frontend works
through a forwarder and survives slow responses.

    proxy = LatencyProxy(listen_port, upstream_port, delay=lambda path_qs: seconds)
    proxy.start(); ...; proxy.stop()
"""
import http.client
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class LatencyProxy:
    def __init__(self, listen_port, upstream_port, delay=None, host="127.0.0.1"):
        self.listen_port = listen_port
        self.upstream_port = upstream_port
        self.delay = delay or (lambda target: 0.0)
        self.host = host
        self.requests = 0
        self.active = 0
        self.active_by_path = {}
        self.peak_by_path = {}
        self.upstream_status = []  # (path, status) of every upstream reply, in order
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # keep test output quiet
                pass

            def do_GET(self):
                outer.requests += 1
                outer.active += 1
                path = self.path.split("?", 1)[0]
                cur = outer.active_by_path[path] = outer.active_by_path.get(path, 0) + 1
                outer.peak_by_path[path] = max(outer.peak_by_path.get(path, 0), cur)
                try:
                    self._serve()
                finally:
                    outer.active -= 1
                    outer.active_by_path[path] -= 1


            def _serve(self):
                d = outer.delay(self.path)
                if d:
                    time.sleep(d)
                try:
                    conn = http.client.HTTPConnection("127.0.0.1", outer.upstream_port, timeout=20)
                    # Preserve the guest-facing Host header, as Live Share's forwarder would.
                    fwd = {"Host": self.headers.get("Host", "")}
                    if self.headers.get("If-None-Match"):  # a real forwarder passes validators through
                        fwd["If-None-Match"] = self.headers["If-None-Match"]
                    conn.request("GET", self.path, headers=fwd)
                    resp = conn.getresponse()
                    body = resp.read()
                    outer.upstream_status.append((self.path.split("?", 1)[0], resp.status))
                    self.send_response(resp.status)
                    for k, v in resp.getheaders():
                        if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                            self.send_header(k, v)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                    conn.close()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception:  # noqa: BLE001
                    try:
                        self.send_error(502)
                    except Exception:  # noqa: BLE001
                        pass

        self._srv = ThreadingHTTPServer((host, listen_port), Handler)
        self._srv.daemon_threads = True
        self._thread = threading.Thread(target=self._srv.serve_forever, daemon=True)

    def reset_peaks(self):
        """Forget past peaks; restart from what is in flight right now."""
        self.peak_by_path = {k: v for k, v in self.active_by_path.items() if v}

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._srv.shutdown()
        self._srv.server_close()
