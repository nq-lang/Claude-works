// Skylit Heatseeker Terminal — backend entry point.
//
// Milestone: shared exposure engine (Part E.1) wired to two live route
// families:
//   - GET /api/heatmap        (Part B: single-ticker heatmap sidecar)
//   - GET /api/quadrinity     (Part D, renamed/expanded per ARCHITECTURE.md
//                               §0: 2-4 synchronized heatmaps + confluence)
// plus the Part A skeleton's /api/health and static file serving.
//
// Both routes read from one LiveFeedManager instance, which owns the one
// ExpirationStore + SyntheticExposureSource pair — this is the concrete
// enforcement of Part E.1 ("one engine, not three divergent
// implementations"): there is exactly one place board state lives, and
// every route only reads snapshots of it.

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdlib>
#include <ctime>
#include <format>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "skylit/exposure_engine.hpp"
#include "skylit/http_server.hpp"
#include "skylit/json_serialize.hpp"
#include "skylit/live_feed.hpp"
#include "skylit/projection_engine.hpp"

namespace {

struct Args {
    std::uint16_t port = 8080;
    // 127.0.0.1 by default: VS Code Live Share forwards localhost ports, and nothing
    // else on the machine / LAN can reach the terminal. Use --host 0.0.0.0 (or
    // SKYLIT_HOST) only where a container needs it.
    std::string host = "127.0.0.1";
    std::string web_root = "./web";
    std::string projection_config;  // optional CSV override of the Part III.2 table
    bool ok = true;
    bool help = false;
};

bool parse_port(std::string_view text, std::uint16_t& out) {
    unsigned value = 0;
    auto [ptr, ec] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (ec != std::errc{} || ptr != text.data() + text.size() || value == 0 || value > 65535) return false;
    out = static_cast<std::uint16_t>(value);
    return true;
}

Args parse_args(int argc, char** argv) {
    Args args;
    // Environment first, so explicit flags win.
    if (const char* p = std::getenv("SKYLIT_PORT"); p && *p && !parse_port(p, args.port)) {
        std::cerr << std::format("[skylit] invalid SKYLIT_PORT '{}'\n", p);
        args.ok = false;
    }
    if (const char* h = std::getenv("SKYLIT_HOST"); h && *h) args.host = h;
    for (int i = 1; i < argc; ++i) {
        std::string_view a = argv[i];
        if (a == "--help" || a == "-h") {
            args.help = true;
        } else if (a == "--port" && i + 1 < argc) {
            if (!parse_port(argv[++i], args.port)) {
                std::cerr << std::format("[skylit] invalid --port '{}' (expected 1-65535)\n", argv[i]);
                args.ok = false;
            }
        } else if (a == "--host" && i + 1 < argc) {
            args.host = argv[++i];
        } else if (a == "--web-root" && i + 1 < argc) {
            args.web_root = argv[++i];
        } else if (a == "--projection-config" && i + 1 < argc) {
            args.projection_config = argv[++i];
        } else {
            std::cerr << std::format("[skylit] unknown or incomplete argument '{}'\n", a);
            args.ok = false;
        }
    }
    return args;
}

// Parses a comma-separated query param, e.g. "tickers=SPXW,SPY,QQQ,NVDA".
std::vector<std::string> parse_query_list(const std::string& query, const std::string& key) {
    std::vector<std::string> out;
    std::string needle = key + "=";
    auto pos = query.find(needle);
    if (pos == std::string::npos) return out;
    std::string rest = query.substr(pos + needle.size());
    if (auto amp = rest.find('&'); amp != std::string::npos) rest = rest.substr(0, amp);
    std::istringstream ss(rest);
    std::string item;
    while (std::getline(ss, item, ',')) {
        if (!item.empty()) out.push_back(item);
    }
    return out;
}

// Returns the param's whole raw value (up to the next '&'). It must NOT
// comma-split: multi-value params such as exposure=GEX,VEX,COLOR and
// expiration=dte:1,3 carry commas inside ONE value (an earlier version
// routed through parse_query_list and silently kept only the first item).
std::string query_param(const std::string& query, const std::string& key,
                         const std::string& fallback) {
    const std::string needle = key + "=";
    std::size_t pos = 0;
    while ((pos = query.find(needle, pos)) != std::string::npos) {
        if (pos == 0 || query[pos - 1] == '&') {
            std::string rest = query.substr(pos + needle.size());
            if (auto amp = rest.find('&'); amp != std::string::npos) rest = rest.substr(0, amp);
            return rest.empty() ? fallback : rest;
        }
        pos += needle.size();
    }
    return fallback;
}

}  // namespace

// Builds the board a heatmap/orbs/quadrinity request asks for: the DTE-set
// scope (`expiration`), the multi-Greek selection (`exposure`), and — when
// `velocity=1` — Velocity Mode annotations (baseline + expiration scope).
// One function so /api/heatmap and /api/quadrinity cannot drift apart.
std::optional<skylit::engine::HeatmapBoard> prepare_board(
    skylit::live::LiveFeedManager& feed, const std::string& ticker,
    const std::string& exposure_raw, const std::string& expiration,
    const std::string& velocity_flag, const std::string& velocity_baseline,
    const std::string& velocity_scope, const std::string& velocity_dtes) {
    namespace engine = skylit::engine;
    auto snap = feed.snapshot(ticker, expiration);
    if (!snap) return std::nullopt;
    const unsigned mask = engine::parse_greek_mask(exposure_raw);
    auto board = engine::apply_greek_mask(*snap, mask);

    if (velocity_flag == "1" || velocity_flag == "true") {
        skylit::live::LiveFeedManager::VelocityRequest vr;
        vr.enabled = true;
        vr.baseline = velocity_baseline.empty() ? "session" : velocity_baseline;
        vr.greek_mask = mask;
        using LFM = skylit::live::LiveFeedManager;
        if (velocity_scope == "0dte") vr.buckets = {"0dte"};
        else if (velocity_scope == "all") vr.buckets = LFM::all_expiration_buckets();
        else if (velocity_scope == "custom") vr.buckets = LFM::buckets_for_selector("dte:" + velocity_dtes);
        else vr.buckets = LFM::buckets_for_selector(expiration);  // "match": same buckets as the view
        feed.annotate_velocity(ticker, board, vr);
    }
    return board;
}

int main(int argc, char** argv) {
    namespace engine = skylit::engine;
    Args args = parse_args(argc, argv);
    if (args.help || !args.ok) {
        std::cout << "usage: skylit_server [--port N] [--host IPV4] [--web-root DIR] [--projection-config CSV]\n"
                     "  env: SKYLIT_PORT (default 8080), SKYLIT_HOST (default 127.0.0.1)\n";
        return args.ok ? EXIT_SUCCESS : EXIT_FAILURE;
    }
    skylit::HttpServer::install_signal_handlers();

    // Ticker universe: Part B/C's SPY/SPX-style single-ticker views, plus
    // Quadrinity's SPXW/SPY/QQQ/NVDA quartet (ARCHITECTURE.md §0). Seeded
    // with plausible round-number spot/strike-step values for a legible
    // demo board; not real market levels.
    std::vector<skylit::live::TickerConfig> tickers = {
        {"SPXW", 5700.0, 5.0, 40},
        {"SPY", 570.0, 1.0, 40},
        {"QQQ", 480.0, 1.0, 40},
        {"NVDA", 135.0, 1.0, 40},
    };

    skylit::live::LiveFeedManager feed(tickers);
    feed.start();

    skylit::HttpServer server(args.port, args.web_root, args.host);

    // Part III.2: config-driven timeframe->DTE table, tunable without a rebuild.
    auto projection_cfg =
        engine::ProjectionConfig::defaults(skylit::live::LiveFeedManager::kMaxNextExpirations);
    if (!args.projection_config.empty()) {
        auto loaded = engine::load_profiles_csv(args.projection_config, projection_cfg);
        std::cerr << std::format("[skylit] projection config {}: {} row(s) applied\n",
                                  args.projection_config, loaded.applied);
        for (const auto& e : loaded.errors) std::cerr << "[skylit]   config warning: " << e << "\n";
    }

    server.route("GET", "/api/health", [](const skylit::HttpRequest&) {
        return skylit::HttpResponse::json(
            R"({"status":"ok","service":"skylit-heatseeker","stage":"engine-wired"})");
    });

    // Part B: single-ticker heatmap. GET /api/heatmap?ticker=SPY&exposure=GEX&expiration=0dte
    // `expiration` is a genuine data-scope selector — see live_feed.hpp's
    // class comment and ARCHITECTURE.md's Expiration-scope section.
    // "0dte" (default) or "current+N" (N=1..10).
    server.route("GET", "/api/heatmap", [&feed](const skylit::HttpRequest& req) {
        std::string ticker = query_param(req.query, "ticker", "SPY");
        std::string exposure_raw = query_param(req.query, "exposure", "GEX");
        std::string expiration = query_param(req.query, "expiration", "0dte");

        auto board = prepare_board(
            feed, ticker, exposure_raw, expiration, query_param(req.query, "velocity", "0"),
            query_param(req.query, "velocity_baseline", "session"),
            query_param(req.query, "velocity_scope", "match"),
            query_param(req.query, "velocity_dtes", "0"));
        if (!board) {
            return skylit::HttpResponse::json(
                std::format(R"({{"error":"unknown ticker","ticker":"{}"}})", skylit::json::escape(ticker)), 404);
        }
        return skylit::HttpResponse::json(skylit::json::board_to_json(*board));
    });

    // Part D / Quadrinity: GET /api/quadrinity?tickers=SPXW,SPY,QQQ,NVDA&exposure=GEX&expiration=0dte
    // Pane count must stay within 2-4 per ARCHITECTURE.md §0. The same
    // expiration scope is applied across every pane — deliberately, so
    // confluence stays comparing apples to apples (see quadrinity.js's
    // header comment for the analogous reasoning on exposure type).
    server.route("GET", "/api/quadrinity", [&feed](const skylit::HttpRequest& req) {
        std::vector<std::string> requested = parse_query_list(req.query, "tickers");
        if (requested.empty()) requested = {"SPXW", "SPY", "QQQ"};
        if (requested.size() < 2 || requested.size() > 4) {
            return skylit::HttpResponse::json(
                R"({"error":"quadrinity supports 2-4 tickers per pane"})", 400);
        }
        std::string exposure_raw = query_param(req.query, "exposure", "GEX");
        std::string expiration = query_param(req.query, "expiration", "0dte");

        // Optional per-pane selections: `specs=EXPOSURE~EXPIRATION,EXPOSURE~EXPIRATION,...`
        // parallel to `tickers` (each pane on the Quadrinity page now picks
        // its own DTE and Greek). Absent/short -> fall back to the shared
        // exposure/expiration, so older callers keep working.
        std::vector<std::string> specs = parse_query_list(req.query, "specs");
        std::vector<engine::HeatmapBoard> filtered;
        filtered.reserve(requested.size());
        for (std::size_t i = 0; i < requested.size(); ++i) {
            std::string exp_i = exposure_raw, dte_i = expiration;
            if (i < specs.size()) {
                auto tilde = specs[i].find('~');
                if (tilde != std::string::npos) {
                    exp_i = specs[i].substr(0, tilde);
                    dte_i = specs[i].substr(tilde + 1);
                }
            }
            auto board = prepare_board(feed, requested[i], exp_i, dte_i, "0", "", "", "");
            if (board) filtered.push_back(std::move(*board));
        }

        auto confluence = engine::compute_confluence(filtered);

        std::ostringstream boards_json;
        for (std::size_t i = 0; i < filtered.size(); ++i) {
            if (i) boards_json << ',';
            boards_json << skylit::json::board_to_json(filtered[i]);
        }

        return skylit::HttpResponse::json(std::format(
            R"({{"panes":[{}],"confluence":{}}})", boards_json.str(),
            skylit::json::confluence_to_json(confluence)));
    });


    // Atlas Projections (Beta) — Part III table, served so the UI clamps the
    // projection window from the same source of truth as the backend.
    server.route("GET", "/api/projection/config", [&projection_cfg](const skylit::HttpRequest&) {
        return skylit::HttpResponse::json(skylit::json::projection_config_to_json(projection_cfg));
    });

    // GET /api/projection?ticker=SPY&exposure=GEX&interval=5m&dte=2
    // `dte` (0-5) picks the EXACT expiration bucket to project — no
    // window/cohort blending. Forward bar count is derived from dte and
    // CLAMPED server-side to the timeframe's max (Part III); the response
    // reports requested/effective/clamped so no client can silently
    // persist an invalid timeframe/dte combination.
    server.route("GET", "/api/projection", [&feed, &projection_cfg](const skylit::HttpRequest& req) {
        engine::ProjectionRequest pr;
        pr.ticker = query_param(req.query, "ticker", "SPY");
        pr.interval = query_param(req.query, "interval", "5m");
        {
            // Legacy single/paired selections keep the original engine path
            // (including its per-DTE gamma/vanna blend); anything else
            // (CHEX / COLOR / SPEED, or 3+ Greeks) is a custom combined lens.
            const unsigned mask = engine::parse_greek_mask(query_param(req.query, "exposure", "GEX"));
            if (mask == engine::kGreekGEX) pr.exposure = engine::ExposureType::GEX;
            else if (mask == engine::kGreekVEX) pr.exposure = engine::ExposureType::VEX;
            else if (mask == (engine::kGreekGEX | engine::kGreekVEX)) pr.exposure = engine::ExposureType::GEX_PLUS_VEX;
            else pr.greek_mask = mask;
        }
        try {
            pr.dte = std::stoi(query_param(req.query, "dte", "0"));
        } catch (...) {
            pr.dte = 0;
        }
        if (pr.dte < 0 || pr.dte > engine::kMaxProjectionDte) {
            return skylit::HttpResponse::json(
                std::format(R"({{"error":"dte must be 0-{}"}})", engine::kMaxProjectionDte), 400);
        }

        auto known = feed.known_tickers();
        if (std::ranges::find(known, pr.ticker) == known.end()) {
            return skylit::HttpResponse::json(
                std::format(R"({{"error":"unknown ticker","ticker":"{}"}})", skylit::json::escape(pr.ticker)),
                404);
        }
        auto result = engine::build_projection(
            pr, projection_cfg, [&feed, &pr](int first, int last) {
                auto board = feed.snapshot_bucket_range(pr.ticker, first, last);
                if (board) {
                    // Real calendar OPEX-week check (Part B.4's own
                    // is_opex_week/third_friday helpers — reused, not
                    // reimplemented) so the confidence-reduction logic in
                    // build_projection reflects the actual current week
                    // rather than always reading the board's default false.
                    std::time_t now = std::time(nullptr);
                    std::tm utc{};
#if defined(_WIN32)
                    gmtime_s(&utc, &now);
#else
                    gmtime_r(&now, &utc);
#endif
                    engine::SimpleDate today{utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday};
                    board->opex_week = engine::is_opex_week(today);
                }
                return board;
            });
        if (!result.ok) {
            return skylit::HttpResponse::json(
                std::format(R"({{"error":"{}"}})", skylit::json::escape(result.error)), 400);
        }
        return skylit::HttpResponse::json(skylit::json::projection_to_json(result, projection_cfg));
    });

    server.route("GET", "/api/tickers", [&feed](const skylit::HttpRequest&) {
        auto known = feed.known_tickers();
        std::ostringstream out;
        for (std::size_t i = 0; i < known.size(); ++i) {
            if (i) out << ',';
            out << '"' << known[i] << '"';
        }
        return skylit::HttpResponse::json(std::format(R"({{"tickers":[{}]}})", out.str()));
    });

    // Part C.2: full candle series for a ticker+interval. Called on load
    // and whenever ticker/timeframe changes (a genuine re-fetch, not a
    // client-side re-slice of one cached series).
    server.route("GET", "/api/candles", [&feed](const skylit::HttpRequest& req) {
        std::string ticker = query_param(req.query, "ticker", "SPY");
        std::string interval = query_param(req.query, "interval", "5m");
        auto bars = feed.candles(ticker, engine::interval_to_seconds(interval));
        return skylit::HttpResponse::json(skylit::json::candles_to_json(bars));
    });

    // Cheap poll target for tick-by-tick chart updates (Part C.2): only the
    // last couple of bars, called every ~1s by the frontend instead of
    // re-fetching the whole history.
    server.route("GET", "/api/candles/latest", [&feed](const skylit::HttpRequest& req) {
        std::string ticker = query_param(req.query, "ticker", "SPY");
        std::string interval = query_param(req.query, "interval", "5m");
        auto bars = feed.latest_candles(ticker, engine::interval_to_seconds(interval));
        return skylit::HttpResponse::json(skylit::json::candles_to_json(bars));
    });

    // Part C.8: dark pool / off-exchange print levels.
    server.route("GET", "/api/darkpool", [&feed](const skylit::HttpRequest& req) {
        std::string ticker = query_param(req.query, "ticker", "SPY");
        auto levels = feed.dark_pool(ticker);
        return skylit::HttpResponse::json(skylit::json::dark_pool_to_json(levels));
    });

    // Part C.3/C.4: Flow overlay, bucketed to the same interval as the
    // candles so the two stay visually aligned.
    server.route("GET", "/api/flow", [&feed](const skylit::HttpRequest& req) {
        std::string ticker = query_param(req.query, "ticker", "SPY");
        std::string interval = query_param(req.query, "interval", "5m");
        auto bars = feed.flow(ticker, engine::interval_to_seconds(interval));
        return skylit::HttpResponse::json(skylit::json::flow_to_json(bars));
    });

    auto result = server.serve_forever();
    feed.stop();
    if (!result) {
        std::cerr << std::format("[skylit] fatal: {}\n", result.error().message);
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
