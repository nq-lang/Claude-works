// Skylit Heatseeker Terminal — minimal HTTP server.
//
// Architecture note (see ARCHITECTURE.md for the full picture):
// This is the thin transport layer only. It knows how to accept TCP
// connections, parse a bare-bones HTTP/1.1 request line + headers, serve
// static files out of a web root, and dispatch a small number of JSON API
// routes to handler callbacks. It intentionally does NOT know anything about
// exposure data, nodes, King Nodes, etc. — that logic lives in the core
// exposure engine module and is injected as route handlers, so the transport
// layer stays swappable/testable independent of business logic.
//
// Why hand-rolled sockets instead of a library (Boost.Asio, cpp-httplib, ...)?
// See ARCHITECTURE.md "Dependency Policy": zero external dependencies means a
// fresh Codespace build can never fail because of a missing/incompatible
// package or a network hiccup during dependency install.
//
// Robustness model (this matters once a second viewer connects through VS Code
// Live Share, or a browser opens speculative idle connections):
//   * one short-lived thread per connection (bounded by kMaxConnections), so a
//     slow or idle client can never stall everyone else;
//   * every socket has receive/send timeouts plus an overall request deadline;
//   * the request is read until the header terminator, with hard size caps;
//   * a throwing route handler yields HTTP 500 instead of killing the process;
//   * SIGPIPE is ignored and writes use MSG_NOSIGNAL, so a client that hangs
//     up mid-response is a non-event;
//   * SIGINT / SIGTERM stop the accept loop and let in-flight requests finish.
//
// Bind address: 127.0.0.1 by default (VS Code Live Share forwards localhost
// ports, and nothing else on the machine/LAN gets to reach the terminal).
// Pass --host 0.0.0.0 / SKYLIT_HOST=0.0.0.0 for containers that need it.

#pragma once

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <expected>
#include <filesystem>
#include <format>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

namespace skylit {

namespace fs = std::filesystem;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

struct ServerError {
    std::string message;
};

// ---------------------------------------------------------------------------
// HTTP request/response value types
// ---------------------------------------------------------------------------

struct HttpRequest {
    std::string method;
    std::string path;              // raw request path (not percent-decoded), without query string
    std::string query;             // percent-decoded query string (may be empty)
    std::unordered_map<std::string, std::string> headers;  // lower-cased names
    std::string body;
};

struct HttpResponse {
    int status = 200;
    std::string content_type = "text/plain; charset=utf-8";
    std::string body;

    static HttpResponse json(std::string body_json, int status = 200) {
        return HttpResponse{.status = status,
                             .content_type = "application/json; charset=utf-8",
                             .body = std::move(body_json)};
    }

    static HttpResponse not_found() {
        return HttpResponse{.status = 404,
                             .content_type = "text/plain; charset=utf-8",
                             .body = "404 Not Found"};
    }

    static HttpResponse error(int status, std::string_view text) {
        return HttpResponse{.status = status,
                             .content_type = "text/plain; charset=utf-8",
                             .body = std::string(text)};
    }
};

using RouteHandler = std::function<HttpResponse(const HttpRequest&)>;

// ---------------------------------------------------------------------------
// HttpServer
// ---------------------------------------------------------------------------

class HttpServer {
public:
    // Limits. Generous for this app (largest legitimate request is a GET with a
    // few hundred bytes of query string) but small enough to be harmless.
    static constexpr std::size_t kMaxHeaderBytes = 64 * 1024;
    static constexpr std::size_t kMaxBodyBytes = 1024 * 1024;
    static constexpr int kMaxConnections = 256;
    static constexpr int kIoTimeoutSeconds = 5;        // per recv()/send() call
    static constexpr int kRequestDeadlineSeconds = 10;  // whole request must arrive by then

    HttpServer(uint16_t port, fs::path web_root, std::string bind_host = "127.0.0.1")
        : port_(port), web_root_(std::move(web_root)), bind_host_(std::move(bind_host)) {}

    // Registers a handler for an exact path + method (e.g. GET /api/health).
    // Route handlers take priority over static file serving. Must be called
    // before serve_forever() (the route table is read-only afterwards, which
    // is what makes concurrent dispatch lock-free).
    void route(std::string method, std::string path, RouteHandler handler) {
        routes_[std::make_pair(std::move(method), std::move(path))] = std::move(handler);
    }

    // Asks serve_forever() to return. Async-signal-safe (a single atomic store).
    static void request_stop() noexcept { stop_requested().store(true); }

    // Installs SIGINT/SIGTERM handlers (-> request_stop) and ignores SIGPIPE.
    static void install_signal_handlers() {
        std::signal(SIGPIPE, SIG_IGN);
        struct sigaction sa{};
        sa.sa_handler = [](int) { request_stop(); };
        sigemptyset(&sa.sa_mask);
        sa.sa_flags = 0;  // no SA_RESTART: let accept()/poll() return EINTR so the loop notices
        ::sigaction(SIGINT, &sa, nullptr);
        ::sigaction(SIGTERM, &sa, nullptr);
    }

    // Binds and serves until request_stop() is called. Returns an error instead
    // of throwing so callers (main.cpp) can print a clean diagnostic and exit
    // non-zero on failure, e.g. port already in use.
    [[nodiscard]] std::expected<void, ServerError> serve_forever() {
        std::signal(SIGPIPE, SIG_IGN);

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port_);
        if (::inet_pton(AF_INET, bind_host_.c_str(), &addr.sin_addr) != 1) {
            return std::unexpected(ServerError{
                std::format("invalid bind host '{}' (expected an IPv4 address)", bind_host_)});
        }

        int server_fd = ::socket(AF_INET, SOCK_STREAM, 0);
        if (server_fd < 0) {
            return std::unexpected(ServerError{"socket() failed"});
        }

        int opt = 1;
        ::setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

        if (::bind(server_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
            ::close(server_fd);
            return std::unexpected(ServerError{std::format(
                "bind() failed on {}:{} ({}) — is the port already in use?", bind_host_, port_,
                std::strerror(errno))});
        }

        if (::listen(server_fd, /*backlog=*/128) < 0) {
            ::close(server_fd);
            return std::unexpected(ServerError{"listen() failed"});
        }

        std::cout << std::format("[skylit] listening on http://{}:{}/ (web root: {})\n", bind_host_,
                                  port_, web_root_.string())
                  << std::flush;

        while (!stop_requested().load()) {
            pollfd pfd{server_fd, POLLIN, 0};
            int pr = ::poll(&pfd, 1, /*timeout_ms=*/250);  // wake regularly to notice request_stop()
            if (pr < 0) {
                if (errno == EINTR) continue;
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                continue;
            }
            if (pr == 0) continue;

            int client_fd = ::accept(server_fd, nullptr, nullptr);
            if (client_fd < 0) {
                if (errno != EINTR) std::this_thread::sleep_for(std::chrono::milliseconds(5));
                continue;  // transient accept error (EMFILE, ECONNABORTED, ...); keep serving
            }

            if (active_.fetch_add(1) >= kMaxConnections) {
                active_.fetch_sub(1);
                static constexpr std::string_view k503 =
                    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                write_all(client_fd, k503.data(), k503.size());
                ::close(client_fd);
                continue;
            }

            try {
                std::thread([this, client_fd] {
                    handle_connection(client_fd);
                    ::close(client_fd);
                    active_.fetch_sub(1);
                }).detach();
            } catch (const std::system_error&) {
                // Could not spawn a thread (resource exhaustion): shed this connection.
                active_.fetch_sub(1);
                ::close(client_fd);
            }
        }

        ::close(server_fd);
        // Let in-flight requests finish (their sockets have I/O timeouts, so this is bounded).
        for (int i = 0; i < 100 && active_.load() > 0; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        std::cout << "[skylit] http server stopped\n" << std::flush;
        return {};
    }

private:
    uint16_t port_;
    fs::path web_root_;
    std::string bind_host_;
    std::map<std::pair<std::string, std::string>, RouteHandler> routes_;
    std::atomic<int> active_{0};

    static std::atomic<bool>& stop_requested() {
        static std::atomic<bool> flag{false};
        return flag;
    }

    // Parses a request whose head (everything up to and excluding the blank
    // line) is `head`. Body is attached by the caller.
    static std::optional<HttpRequest> parse_head(std::string_view head) {
        HttpRequest req;
        auto next_line = [&head]() -> std::optional<std::string_view> {
            if (head.empty()) return std::nullopt;
            auto nl = head.find('\n');
            std::string_view line = head.substr(0, nl);
            head = (nl == std::string_view::npos) ? std::string_view{} : head.substr(nl + 1);
            if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
            return line;
        };

        auto request_line = next_line();
        if (!request_line) return std::nullopt;

        // METHOD SP TARGET SP VERSION
        auto sp1 = request_line->find(' ');
        if (sp1 == std::string_view::npos) return std::nullopt;
        auto sp2 = request_line->find(' ', sp1 + 1);
        if (sp2 == std::string_view::npos) return std::nullopt;
        std::string_view method = request_line->substr(0, sp1);
        std::string_view target = request_line->substr(sp1 + 1, sp2 - sp1 - 1);
        std::string_view version = request_line->substr(sp2 + 1);
        if (method.empty() || target.empty() || !version.starts_with("HTTP/")) return std::nullopt;
        if (target.front() != '/') return std::nullopt;
        req.method = std::string(method);

        if (auto qpos = target.find('?'); qpos != std::string_view::npos) {
            req.path = std::string(target.substr(0, qpos));
            req.query = url_decode(target.substr(qpos + 1));
        } else {
            req.path = std::string(target);
        }

        while (auto line = next_line()) {
            if (line->empty()) break;
            auto colon = line->find(':');
            if (colon == std::string_view::npos) continue;
            std::string key(line->substr(0, colon));
            std::string_view value = line->substr(colon + 1);
            auto first = value.find_first_not_of(" \t");
            value = (first == std::string_view::npos) ? std::string_view{} : value.substr(first);
            std::ranges::transform(key, key.begin(),
                                    [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            req.headers[key] = std::string(value);
        }
        return req;
    }

    // Decodes %XX percent-escapes (as produced by encodeURIComponent on the
    // frontend). Deliberately does NOT convert '+' to space — our frontend
    // never emits a raw '+' for a literal space, it always escapes special
    // characters via encodeURIComponent, so treating '+' as literal here
    // (rather than the classic application/x-www-form-urlencoded space
    // convention) matches what the client actually sends.
    static std::string url_decode(std::string_view in) {
        std::string out;
        out.reserve(in.size());
        auto hex_val = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        for (std::size_t i = 0; i < in.size(); ++i) {
            if (in[i] == '%' && i + 2 < in.size()) {
                int hi = hex_val(in[i + 1]);
                int lo = hex_val(in[i + 2]);
                if (hi >= 0 && lo >= 0) {
                    out.push_back(static_cast<char>((hi << 4) | lo));
                    i += 2;
                    continue;
                }
            }
            out.push_back(in[i]);
        }
        return out;
    }

    static std::string_view mime_type_for(const fs::path& p) {
        auto ext = p.extension().string();
        std::ranges::transform(ext, ext.begin(),
                               [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        static const std::unordered_map<std::string, std::string_view> kMime = {
            {".html", "text/html; charset=utf-8"},
            {".htm", "text/html; charset=utf-8"},
            {".js", "text/javascript; charset=utf-8"},
            {".mjs", "text/javascript; charset=utf-8"},
            {".css", "text/css; charset=utf-8"},
            {".json", "application/json; charset=utf-8"},
            {".svg", "image/svg+xml"},
            {".png", "image/png"},
            {".ico", "image/x-icon"},
        };
        if (auto it = kMime.find(ext); it != kMime.end()) return it->second;
        return "application/octet-stream";
    }

    // Resolves a request path against web_root_, refusing any path that
    // escapes the root. The containment test is done per path COMPONENT (a
    // plain string prefix test would accept a sibling such as "/srv/web-secret"
    // for a root of "/srv/web").
    std::optional<fs::path> resolve_static_path(std::string_view req_path) const {
        if (req_path.find('\0') != std::string_view::npos) return std::nullopt;
        std::string clean = req_path.empty() ? "/" : std::string(req_path);
        if (clean == "/") clean = "/index.html";

        fs::path candidate = web_root_ / fs::path(clean).relative_path();
        std::error_code ec;
        fs::path canonical_root = fs::weakly_canonical(web_root_, ec);
        if (ec) return std::nullopt;
        fs::path canonical_candidate = fs::weakly_canonical(candidate, ec);
        if (ec) return std::nullopt;

        auto rel = canonical_candidate.lexically_relative(canonical_root);
        if (rel.empty() || *rel.begin() == "..") return std::nullopt;  // traversal attempt
        return canonical_candidate;
    }

    HttpResponse serve_static(const HttpRequest& req) const {
        auto resolved = resolve_static_path(req.path);
        std::error_code ec;
        if (!resolved || !fs::is_regular_file(*resolved, ec)) return HttpResponse::not_found();
        std::ifstream file(*resolved, std::ios::binary);
        if (!file) return HttpResponse::not_found();
        std::string contents;
        auto size = fs::file_size(*resolved, ec);
        if (!ec) contents.reserve(static_cast<std::size_t>(size));
        contents.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
        return HttpResponse{.status = 200,
                             .content_type = std::string(mime_type_for(*resolved)),
                             .body = std::move(contents)};
    }

    static void set_socket_timeouts(int fd) {
        timeval tv{};
        tv.tv_sec = kIoTimeoutSeconds;
        ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        int one = 1;
        ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    }

    enum class ReadStatus { Ok, Closed, TooLarge, BadRequest, Timeout };

    // Reads one request (head + Content-Length body) from the socket.
    static ReadStatus read_request(int fd, HttpRequest& out) {
        const auto deadline =
            std::chrono::steady_clock::now() + std::chrono::seconds(kRequestDeadlineSeconds);
        std::string buf;
        buf.reserve(2048);
        std::size_t head_end = std::string::npos;
        char chunk[8192];

        while (head_end == std::string::npos) {
            if (std::chrono::steady_clock::now() > deadline) return ReadStatus::Timeout;
            ssize_t n = ::recv(fd, chunk, sizeof(chunk), 0);
            if (n == 0) return buf.empty() ? ReadStatus::Closed : ReadStatus::BadRequest;
            if (n < 0) {
                if (errno == EINTR) continue;
                // SO_RCVTIMEO expiry surfaces as EAGAIN (== EWOULDBLOCK on Linux/macOS).
                return errno == EAGAIN ? ReadStatus::Timeout : ReadStatus::Closed;
            }
            buf.append(chunk, static_cast<std::size_t>(n));
            // The terminator may be CRLFCRLF or bare LFLF (be lenient like the old parser).
            auto crlf = buf.find("\r\n\r\n");
            auto lf = buf.find("\n\n");
            if (crlf != std::string::npos && (lf == std::string::npos || crlf < lf)) {
                head_end = crlf + 4;
            } else if (lf != std::string::npos) {
                head_end = lf + 2;
            } else if (buf.size() > kMaxHeaderBytes) {
                return ReadStatus::TooLarge;
            }
        }
        if (head_end > kMaxHeaderBytes) return ReadStatus::TooLarge;

        auto parsed = parse_head(std::string_view(buf).substr(0, head_end));
        if (!parsed) return ReadStatus::BadRequest;
        out = std::move(*parsed);

        std::size_t body_len = 0;
        if (auto it = out.headers.find("content-length"); it != out.headers.end()) {
            const std::string& v = it->second;
            auto [ptr, ec] = std::from_chars(v.data(), v.data() + v.size(), body_len);
            if (ec != std::errc{} || ptr != v.data() + v.size()) return ReadStatus::BadRequest;
            if (body_len > kMaxBodyBytes) return ReadStatus::TooLarge;
        }
        out.body.assign(buf, head_end, std::string::npos);
        while (out.body.size() < body_len) {
            if (std::chrono::steady_clock::now() > deadline) return ReadStatus::Timeout;
            ssize_t n = ::recv(fd, chunk, sizeof(chunk), 0);
            if (n == 0) return ReadStatus::BadRequest;
            if (n < 0) {
                if (errno == EINTR) continue;
                return ReadStatus::Timeout;
            }
            out.body.append(chunk, static_cast<std::size_t>(n));
        }
        out.body.resize(body_len);
        return ReadStatus::Ok;
    }

    void handle_connection(int client_fd) const noexcept {
        try {
            set_socket_timeouts(client_fd);

            HttpRequest req;
            switch (read_request(client_fd, req)) {
                case ReadStatus::Ok: break;
                case ReadStatus::Closed: return;  // client went away / idle connection closed
                case ReadStatus::Timeout: send_response(client_fd, HttpResponse::error(408, "408 Request Timeout")); return;
                case ReadStatus::TooLarge: send_response(client_fd, HttpResponse::error(413, "413 Payload Too Large")); return;
                case ReadStatus::BadRequest: send_response(client_fd, HttpResponse::error(400, "400 Bad Request")); return;
            }

            HttpResponse resp;
            try {
                if (auto it = routes_.find({req.method, req.path}); it != routes_.end()) {
                    resp = it->second(req);
                } else if (req.method == "GET") {
                    resp = serve_static(req);
                } else {
                    resp = HttpResponse::not_found();
                }
            } catch (const std::exception& e) {
                std::cerr << std::format("[skylit] handler error on {} {}: {}\n", req.method, req.path, e.what());
                resp = HttpResponse::json(R"({"error":"internal server error"})", 500);
            } catch (...) {
                std::cerr << std::format("[skylit] handler error on {} {}: unknown exception\n", req.method, req.path);
                resp = HttpResponse::json(R"({"error":"internal server error"})", 500);
            }
            send_response(client_fd, resp);
        } catch (...) {
            // A connection thread must never let an exception escape (it would terminate the process).
        }
    }

    static void send_response(int fd, const HttpResponse& resp) {
        const bool is_api = resp.content_type.starts_with("application/json");
        std::string out = std::format(
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n"
            "X-Content-Type-Options: nosniff\r\nCache-Control: {}\r\n\r\n",
            resp.status, status_text(resp.status), resp.content_type, resp.body.size(),
            is_api ? "no-store" : "no-cache");
        out += resp.body;
        write_all(fd, out.data(), out.size());
    }

    // Best-effort full write. MSG_NOSIGNAL: a peer that already hung up yields
    // EPIPE instead of a process-killing SIGPIPE.
    static void write_all(int fd, const char* data, std::size_t len) {
        std::size_t sent = 0;
        while (sent < len) {
            ssize_t n = ::send(fd, data + sent, len - sent, MSG_NOSIGNAL);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) return;
            sent += static_cast<std::size_t>(n);
        }
    }

    static std::string_view status_text(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 408: return "Request Timeout";
            case 413: return "Payload Too Large";
            case 500: return "Internal Server Error";
            case 503: return "Service Unavailable";
            default: return "OK";
        }
    }
};

}  // namespace skylit
