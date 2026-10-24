// Backend math golden dump.
//
// Prints one line per case:  <key> \t json:<len>:<hash> \t raw:<len>:<hash>
//   json = the exact bytes the API would send;  raw = every double of the underlying result dumped
//   as a hex-float (%a), so the comparison is BIT-EXACT even where the JSON rounds to 2-4 decimals.
// Run under the fake-clock shim (see run_golden.sh) so the output is reproducible.
//
// Coverage: boards for every ticker x Greek-mask x expiration selector, Velocity Mode for every
// baseline x scope, Quadrinity boards + confluence, projections for every ticker x interval x DTE x
// Greek set, candles / latest candles, the RNG-driven dark pool + flow generators, the synthetic
// exposure source driven through hundreds of ticks/refreshes, and the LIVE evolution path (price
// ticks, exposure refreshes, history snapshots, the day->overnight session rollover) driven
// deterministically through tick_prices_once() / refresh_exposures_once().
//
// Test-only: `private` is opened for live_feed.hpp so the evolution methods can be called.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <deque>
#include <dlfcn.h>
#include <functional>
#include <mutex>
#include <optional>
#include <random>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
#include "skylit/candles.hpp"
#include "skylit/exposure_engine.hpp"

#define private public
#include "skylit/live_feed.hpp"
#undef private

#define main skylit_app_main
#include SKYLIT_MAIN_CPP
#undef main

namespace {
namespace engine = skylit::engine;
namespace live = skylit::live;
namespace market = skylit::market;
namespace sj = skylit::json;

std::uint64_t fnv(const std::string& s) {
    std::uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    return h;
}

struct Raw {
    std::string s;
    void d(double v) { char b[48]; std::snprintf(b, sizeof b, "%a ", v); s += b; }
    void i(long long v) { s += std::to_string(v); s += ' '; }
    void t(const std::string& v) { s += v; s += '|'; }
};

std::size_t g_lines = 0;
std::uint64_t g_digest = 1469598103934665603ULL;
void emit(const std::string& key, const std::string& json, const std::string& raw) {
    char line[256];
    std::snprintf(line, sizeof line, "%s\tjson:%zu:%016llx\traw:%zu:%016llx\n", key.c_str(), json.size(),
                  static_cast<unsigned long long>(fnv(json)), raw.size(), static_cast<unsigned long long>(fnv(raw)));
    std::fputs(line, stdout);
    g_digest = (g_digest ^ fnv(line)) * 1099511628211ULL;
    ++g_lines;
}

std::string raw_board(const engine::HeatmapBoard& b) {
    Raw r;
    r.t(b.ticker); r.t(b.expiration_bucket); r.d(b.spot);
    r.d(b.range.upper); r.d(b.range.lower);
    r.i(static_cast<int>(b.floor_trend)); r.i(static_cast<int>(b.ceiling_trend)); r.i(b.opex_week);
    for (const auto& a : b.air_pockets) { r.d(a.low_strike); r.d(a.high_strike); r.i(static_cast<int>(a.context)); }
    r.s += "#";
    for (const auto& n : b.nodes) {
        r.d(n.strike); r.d(n.exposure); r.i(static_cast<int>(n.role)); r.i(n.touch_count); r.d(n.rate_of_change);
        r.d(n.session_change_pct); r.d(n.velocity_pct); r.i(n.velocity_new); r.d(n.distance_from_spot);
    }
    return r.s;
}

std::string raw_projection(const engine::ProjectionResult& p) {
    Raw r;
    r.i(p.ok); r.t(p.error); r.t(p.ticker); r.i(static_cast<int>(p.exposure)); r.i(p.dte); r.t(p.bucket_name);
    r.t(p.exposure_label); r.t(p.profile.interval); r.i(p.profile.bar_seconds); r.i(p.profile.max_window_bars);
    r.i(p.horizon.requested); r.i(p.horizon.effective); r.i(p.horizon.max); r.i(p.horizon.clamped);
    r.d(p.bar_sessions); r.d(p.spot); r.d(p.zone_half_thickness); r.d(p.gex_share); r.d(p.regime_score);
    r.d(p.regime_factor); r.i(p.up_wall_found); r.i(p.down_wall_found); r.d(p.up_wall_strike);
    r.d(p.down_wall_strike); r.d(p.density_skew); r.d(p.up_density); r.d(p.down_density); r.d(p.confidence);
    for (const auto& b : p.bars) { r.i(b.k); r.i(b.supported); r.d(b.upper); r.d(b.lower); r.d(b.mid); r.d(b.upper_pct); r.d(b.lower_pct); }
    return r.s;
}

std::string raw_candles(const std::vector<market::Candle>& v) {
    Raw r;
    for (const auto& c : v) { r.i(c.time); r.d(c.open); r.d(c.high); r.d(c.low); r.d(c.close); }
    return r.s;
}
std::string raw_flow(const std::vector<market::FlowBar>& v) {
    Raw r;
    for (const auto& f : v) { r.i(f.time); r.d(f.call_volume); r.d(f.put_volume); r.d(f.net_flow); r.i(f.trade_count); r.d(f.bucket_put_call_ratio); }
    return r.s;
}
std::string raw_dark(const std::vector<market::DarkPoolLevel>& v) {
    Raw r;
    for (const auto& l : v) { r.d(l.price); r.d(l.notional); r.t(l.context); }
    return r.s;
}

const std::vector<std::string> kTickers = {"SPXW", "SPY", "QQQ", "NVDA"};
const std::vector<std::string> kIntervals = {"1m", "3m", "5m", "15m", "1h", "4h", "1D"};

void board_case(live::LiveFeedManager& feed, const std::string& tag, const std::string& tk, const std::string& greek,
                const std::string& exp, const std::string& vel, const std::string& base, const std::string& scope,
                const std::string& dtes) {
    auto b = prepare_board(feed, tk, greek, exp, vel, base, scope, dtes);
    const std::string key = tag + "/board/" + tk + "/" + greek + "/" + exp + "/v" + vel + "/" + base + "/" + scope + "/" + dtes;
    if (!b) { emit(key, "null", "null"); return; }
    emit(key, sj::board_to_json(*b), raw_board(*b));
}

void projection_case(live::LiveFeedManager& feed, const engine::ProjectionConfig& cfg, const std::string& tag,
                     const std::string& tk, const std::string& interval, int dte, const std::string& exposure) {
    // Mirrors the /api/projection route (main.cpp) exactly, including the real OPEX-week override.
    engine::ProjectionRequest pr;
    pr.ticker = tk; pr.interval = interval; pr.dte = dte;
    const unsigned mask = engine::parse_greek_mask(exposure);
    if (mask == engine::kGreekGEX) pr.exposure = engine::ExposureType::GEX;
    else if (mask == engine::kGreekVEX) pr.exposure = engine::ExposureType::VEX;
    else if (mask == (engine::kGreekGEX | engine::kGreekVEX)) pr.exposure = engine::ExposureType::GEX_PLUS_VEX;
    else pr.greek_mask = mask;
    auto result = engine::build_projection(pr, cfg, [&](int first, int last) {
        auto board = feed.snapshot_bucket_range(pr.ticker, first, last);
        if (board) {
            std::time_t now = std::time(nullptr);
            std::tm utc{};
            gmtime_r(&now, &utc);
            board->opex_week = engine::is_opex_week(engine::SimpleDate{utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday});
        }
        return board;
    });
    emit(tag + "/proj/" + tk + "/" + interval + "/d" + std::to_string(dte) + "/" + exposure, sj::projection_to_json(result, cfg),
         raw_projection(result));
}

void candle_cases(live::LiveFeedManager& feed, const std::string& tag, const std::string& tk) {
    for (const auto& iv : kIntervals) {
        auto sec = engine::interval_to_seconds(iv);
        auto full = feed.candles(tk, sec);
        emit(tag + "/candles/" + tk + "/" + iv, sj::candles_to_json(full), raw_candles(full));
        auto lat = feed.latest_candles(tk, sec);
        emit(tag + "/latest/" + tk + "/" + iv, sj::candles_to_json(lat), raw_candles(lat));
        auto lat5 = feed.latest_candles(tk, sec, 5);
        emit(tag + "/latest5/" + tk + "/" + iv, sj::candles_to_json(lat5), raw_candles(lat5));
    }
    emit(tag + "/candles/" + tk + "/unknown-interval", sj::candles_to_json(feed.candles(tk, 0)), "");
}

const std::vector<std::string> kGreeks = {"GEX", "VEX", "GEX,VEX", "CHEX", "COLOR", "SPEED", "GEX,VEX,CHEX", "GEX,VEX,CHEX,COLOR,SPEED"};
const std::vector<std::string> kExpirations = {"0dte", "current+1", "current+3", "current+50", "dte:0", "dte:1", "dte:0,1,3",
                                               "dte:2,4,6", "dte:0,1,2,3,4,5,6", "dte:0,50", "dte:7", "bogus"};
}  // namespace

int main() {
    std::vector<live::TickerConfig> tickers = {{"SPXW", 5700.0, 5.0, 40}, {"SPY", 570.0, 1.0, 40}, {"QQQ", 480.0, 1.0, 40}, {"NVDA", 135.0, 1.0, 40}};
    using AdvanceFn = void (*)(long);
    auto advance = reinterpret_cast<AdvanceFn>(dlsym(RTLD_DEFAULT, "skylit_fake_time_advance"));
    if (!advance) { std::fprintf(stderr, "golden_dump must run under the fake-clock shim (LD_PRELOAD)\n"); return 2; }
    const auto cfg = engine::ProjectionConfig::defaults(live::LiveFeedManager::kMaxNextExpirations);

    // ---------------------------------------------------------------- static state (fresh feed)
    {
        live::LiveFeedManager feed(tickers);
        for (const auto& tk : kTickers)
            for (const auto& g : kGreeks)
                for (const auto& e : kExpirations) board_case(feed, "static", tk, g, e, "0", "session", "match", "0");
        for (const auto& tk : kTickers)
            for (const char* base : {"session", "5m", "15m", "1h", "prev_close", "weird"})
                for (const char* scope : {"match", "0dte", "all", "custom"})
                    for (const char* g : {"GEX", "GEX,VEX", "CHEX"})
                        for (const char* e : {"dte:0", "dte:1,2", "current+3"})
                            board_case(feed, "static", tk, g, e, "1", base, scope, "0,2");
        // Quadrinity: 2/3/4 panes, per-pane specs
        const std::vector<std::vector<std::pair<std::string, std::string>>> quads = {
            {{"SPXW", "GEX~dte:0"}, {"SPY", "GEX~dte:0"}},
            {{"SPXW", "VEX~dte:1"}, {"SPY", "GEX~dte:0"}, {"QQQ", "GEX,VEX~dte:0,1"}},
            {{"SPXW", "GEX~dte:0"}, {"SPY", "GEX~dte:0"}, {"QQQ", "GEX~dte:0"}, {"NVDA", "CHEX~dte:2"}},
            {{"QQQ", "GEX~dte:0"}, {"NVDA", "GEX~dte:0"}, {"SPY", "VEX~dte:3"}, {"SPXW", "VEX~dte:3"}},
        };
        int qi = 0;
        for (const auto& q : quads) {
            std::vector<engine::HeatmapBoard> boards;
            std::string joined;
            for (const auto& [tk, spec] : q) {
                auto tilde = spec.find('~');
                auto b = prepare_board(feed, tk, spec.substr(0, tilde), spec.substr(tilde + 1), "0", "", "", "");
                if (b) { joined += sj::board_to_json(*b); boards.push_back(std::move(*b)); }
            }
            auto conf = engine::compute_confluence(boards);
            Raw r; r.i(conf.aligned_count); r.i(conf.total_count); r.i(static_cast<int>(conf.majority_read));
            for (const auto& o : conf.outlier_tickers) r.t(o);
            emit("static/quad/" + std::to_string(qi++), sj::confluence_to_json(conf) + joined, r.s);
        }
        // Projections
        emit("static/projection-config", sj::projection_config_to_json(cfg), "");
        for (const auto& tk : kTickers)
            for (const auto& iv : kIntervals)
                for (int dte = -1; dte <= 7; ++dte)
                    for (const char* g : {"GEX", "VEX", "GEX,VEX", "CHEX", "GEX,VEX,CHEX,COLOR"})
                        projection_case(feed, cfg, "static", tk, iv, dte, g);
        for (const auto& tk : kTickers) candle_cases(feed, "static", tk);
        // RNG-driven generators: call order is part of the contract (stateful RNG).
        for (const auto& tk : kTickers) {
            for (int rep = 0; rep < 2; ++rep) {
                auto dp = feed.dark_pool(tk);
                emit("static/darkpool/" + tk + "/" + std::to_string(rep), sj::dark_pool_to_json(dp), raw_dark(dp));
                for (const char* iv : {"1m", "5m"}) {
                    auto fl = feed.flow(tk, engine::interval_to_seconds(iv));
                    emit("static/flow/" + tk + "/" + iv + "/" + std::to_string(rep), sj::flow_to_json(fl), raw_flow(fl));
                }
            }
        }
        auto unknown = feed.snapshot("NOPE", "0dte");
        emit("static/unknown-ticker", unknown ? "found" : "null", "");
    }

    // ---------------------------------------------------------------- synthetic source, driven directly
    for (std::uint64_t seed : {42ULL, 7ULL, 123456789ULL}) {
        engine::SyntheticExposureSource src(seed);
        auto board = src.generate_board("SPY", 570.0, 1.0, 40, "0dte");
        auto deep = src.generate_board("SPXW", 5700.0, 5.0, 40, "next3");
        for (int step = 1; step <= 300; ++step) {
            src.tick_price(board); src.tick_price(deep, 0.5);
            if (step % 10 == 0) { src.refresh_exposure(board); src.refresh_exposure(deep, 0.1); }
            if (step % 25 == 0) {
                emit("engine/" + std::to_string(seed) + "/spy/" + std::to_string(step), sj::board_to_json(board), raw_board(board));
                emit("engine/" + std::to_string(seed) + "/spxw/" + std::to_string(step), sj::board_to_json(deep), raw_board(deep));
            }
        }
    }

    // ---------------------------------------------------------------- live evolution (25 simulated minutes,
    // started at 15:45 UTC so the 16:00 day->overnight session rollover happens inside the run)
    {
        live::LiveFeedManager feed(tickers);
        const std::vector<int> dump_at = {1, 60, 301, 600, 905, 1500};
        std::size_t next = 0;
        for (int step = 1; step <= 1500; ++step) {
            advance(1);
            feed.tick_prices_once();
            if (step % 10 == 0) feed.refresh_exposures_once();
            if (next < dump_at.size() && step == dump_at[next]) {
                ++next;
                const std::string tag = "evo@" + std::to_string(step);
                for (const auto& tk : kTickers) {
                    for (const char* g : {"GEX", "GEX,VEX", "CHEX"})
                        for (const char* e : {"dte:0", "dte:1,2", "current+3"}) board_case(feed, tag, tk, g, e, "0", "session", "match", "0");
                    for (const char* base : {"session", "5m", "15m", "1h", "prev_close"})
                        for (const char* scope : {"match", "all", "custom"})
                            board_case(feed, tag, tk, "GEX", "dte:0", "1", base, scope, "0,2");
                    for (const char* iv : {"1m", "5m"}) {
                        auto sec = engine::interval_to_seconds(iv);
                        auto full = feed.candles(tk, sec);
                        emit(tag + "/candles/" + tk + "/" + iv, sj::candles_to_json(full), raw_candles(full));
                        auto lat = feed.latest_candles(tk, sec);
                        emit(tag + "/latest/" + tk + "/" + iv, sj::candles_to_json(lat), raw_candles(lat));
                    }
                    for (int dte : {0, 3, 6}) for (const char* g : {"GEX", "GEX,VEX"}) projection_case(feed, cfg, tag, tk, "5m", dte, g);
                }
            }
        }
    }

    std::printf("# lines %zu digest %016llx\n", g_lines, static_cast<unsigned long long>(g_digest));
    return 0;
}
