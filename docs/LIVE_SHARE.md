# Sharing the terminal with a friend (VS Code Live Share)

The terminal is one HTTP server on **one fixed port (8080)**. Live Share's *Shared Servers* feature
forwards that port to your guest, so they open the terminal in **their own browser** while you use it
in yours. Both of you see live data; each browser keeps its own ticker/layout selection.

> **What was and was not verified.** I could not run a real Live Share session from the build
> environment (it needs two signed-in VS Code installs). Instead the guest path was reproduced with a
> forwarder on a different port and Host header with added latency
> (`tests/e2e/pw_two_viewers.py`, 24 checks). The steps below follow Live Share's documented
> workflow; menu wording can differ slightly between VS Code / extension versions.

## Host: start the terminal

```bash
make run                      # or: bash scripts/run.sh
```

Serves on **http://127.0.0.1:8080**. Check it works locally first: open <http://localhost:8080>.

- Different port: `SKYLIT_PORT=9000 make run` (then share 9000 instead). Keep it fixed between runs
  so the guest's saved link/bookmark keeps working.
- Bind address: `127.0.0.1` by default. That is correct for Live Share, which forwards
  *localhost* ports from the host's machine. You do **not** need `0.0.0.0` (it would also expose
  the port to your LAN). Only inside a dev container / Codespace, where forwarding comes from outside
  the container, is `SKYLIT_HOST=0.0.0.0` needed — the devcontainer sets it for you.
- In VS Code: **Ctrl/Cmd+Shift+B** runs the default release build; then *Terminal → Run Task…* →
  **"run terminal (127.0.0.1:8080)"**, or *Run and Debug* → **"Run terminal (release, no debugger)"**.

## Host: start a Live Share session and invite your friend

1. Install the **Live Share** extension (`ms-vsliveshare.vsliveshare`) and sign in (Microsoft or
   GitHub account) if prompted.
2. Click **Live Share** in the status bar (bottom-left) — or run
   *Live Share: Start Collaboration Session (Share)* from the Command Palette.
3. The **invite link is copied to your clipboard**. Send it to your friend (chat, e-mail…). You can
   copy it again any time from the Live Share view → *Session Details*.
4. *(Optional, recommended)* choose **Read-only** when starting the session if your friend only needs
   to view the terminal and not edit your code. This does not affect their ability to open the
   shared port.

## Host: share port 8080

1. Open the **Live Share** view in the activity bar (or *Live Share: Focus on Session Explorer View*).
2. Under **Shared Servers**, click **Share Server(s)…** (the `+` / "Share Server" action).
3. Enter **`8080`** (or the port you chose), give it a name such as `Skylit Terminal`, confirm.
4. The server now appears in the list while the session is running. To stop sharing it, use
   *Stop sharing server* on that entry; ending the session removes all shared servers.

Only what you add here is shared — your guest cannot reach any other port on your machine.

## Guest: connect

1. Open the invite link (it opens VS Code with Live Share, or the browser-based join page).
2. In the Live Share view, expand **Shared Servers**: `Skylit Terminal (8080)` is listed.
3. Open **http://localhost:8080** in your own browser. Live Share maps the host's port to
   *your* `localhost` on the same port number, so this is not the host's address.
   - If port 8080 is already in use on the guest's machine, Live Share offers/uses a different local
     port; the Shared Servers entry shows the one to use.
4. The terminal loads exactly as it does for the host. Charts need internet access for the CDN
   script (see limitations below).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Guest gets "connection refused" on `localhost:8080` | The server is not running on the host, or the port was not added under *Shared Servers*, or the guest's local 8080 is taken by something else (use the port shown in the entry). |
| Page loads but charts are empty | Guest browser cannot reach `unpkg.com` (offline / blocked network). The chart library is loaded from a CDN. |
| Everything works for the host, nothing for the guest | The session ended or the host's laptop slept; restart the session and re-share the port. |
| `bind: Address already in use` on the host | Something else holds 8080: `SKYLIT_PORT=8081 make run`, then share 8081. |
| Header shows *backend unreachable* | The server stopped. The page recovers on its own once it is started again (no reload needed). |

## What a guest can and cannot reach

The server exposes **only**:

- the static files under `frontend/` (the web root), and
- `GET /api/*` — read-only market data. All routes are `GET`; there are no endpoints that write
  state, run commands or read other files.

Verified by `pw_two_viewers.py` through the forwarded port: `Makefile`, `README`, `backend/**`,
`.git/**`, `.env`, `.vscode/**`, `scripts/**`, `tests/**`, `build/**`, `..`-traversal and
percent-encoded traversal all return **404**. `/api/health` and `/api/projection/config` contain no
paths, hostnames or environment values. The repository holds no API keys or credentials (market data
is synthetic), so there is nothing secret to leak; the server also does not read any secrets from
the environment (only `SKYLIT_PORT` / `SKYLIT_HOST`).

No origin, Host or CORS checking is performed, so a guest arriving with a tunnel hostname is never
rejected. There are no WebSockets — the page polls the API (1 s for prices) — so there is no upgrade
handshake that a forwarder could break. Every request in the frontend is a root-relative `/api/...`
path; nothing is hard-coded to `localhost`.

## Capacity and stability

With a host and a high-latency guest running 4 panes + 4 heatmaps each, rapidly switching tickers:
health probes p99 ≈ 5 ms, server RSS +1.7 MB, thread and fd counts back to baseline after both left
(see `tests/e2e/pw_two_viewers.py`). HTTP/1.1 keep-alive means each viewer reuses a connection
rather than paying a TCP handshake per poll, which matters most over a forwarded tunnel. Connections
are capped at 256; idle keep-alive connections are closed after 30 s.
