// Backend micro-benchmarks: the per-request compute cost of every API path the frontend polls,
// measured in-process (no sockets) so the numbers isolate the engine / serialization cost.
//
// Build/run: `make bench`.  Compiled against whichever source tree SKYLIT_MAIN_CPP points at, so
// the same file benchmarks the baseline and the optimized code.
//
// Test-only hack: `private` is made public for the include below so the benchmark can fast-forward
// the tick history to a long-uptime state (the server keeps up to 24h of 1-second ticks).
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <ctime>
#include <deque>
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

// Only live_feed.hpp is compiled with `private` opened; everything it depends on is already included above.
#define private public
#include "skylit/live_feed.hpp"
#undef private

#define main skylit_app_main
#include SKYLIT_MAIN_CPP
#undef main

namespace {
using Clock = std::chrono::steady_clock;

struct Row { const char* name; double us; std::size_t bytes; };
std::vector<Row> rows;

// Runs `fn` repeatedly for ~budget_ms and records the best (minimum) per-slice mean time per call.
void bench(const char* name, const std::function<std::size_t()>& fn, int budget_ms = 900) {
    std::size_t bytes = fn();  // warm-up + payload size
    // min over 9 slices: on a shared/noisy machine the minimum is the least-disturbed estimate.
    double best = 1e30;
    for (int rep = 0; rep < 9; ++rep) {
        int n = 0;
        auto t0 = Clock::now();
        while (std::chrono::duration<double, std::milli>(Clock::now() - t0).count() < budget_ms / 9.0) {
            fn();
            ++n;
        }
        double us = std::chrono::duration<double, std::micro>(Clock::now() - t0).count() / n;
        best = std::min(best, us);
    }
    rows.push_back({name, best, bytes});
}
}  // namespace

int main() {
    namespace engine = skylit::engine;
    namespace live = skylit::live;
    std::vector<live::TickerConfig> tickers = {
        {"SPXW", 5700.0, 5.0, 40}, {"SPY", 570.0, 1.0, 40}, {"QQQ", 480.0, 1.0, 40}, {"NVDA", 135.0, 1.0, 40}};

    // ---- startup cost (constructor seeds boards, tick history, velocity history)
    double startup_ms = 0;
    {
        startup_ms = 1e30;
        for (int i = 0; i < 7; ++i) {
            auto t0 = Clock::now();
            { live::LiveFeedManager f(tickers); (void)f; }
            startup_ms = std::min(startup_ms, std::chrono::duration<double, std::milli>(Clock::now() - t0).count());
        }
    }
    live::LiveFeedManager feed(tickers);

    auto projection_cfg = engine::ProjectionConfig::defaults(live::LiveFeedManager::kMaxNextExpirations);
    auto board_json = [&](const char* tk, const char* exposure, const char* expiration, bool velocity) {
        auto b = prepare_board(feed, tk, exposure, expiration, velocity ? "1" : "0", "15m", "match", "0");
        return b ? skylit::json::board_to_json(*b).size() : 0u;
    };
    auto projection_json = [&](const char* tk, const char* interval, int dte, const char* exposure) {
        engine::ProjectionRequest pr;
        pr.ticker = tk; pr.interval = interval; pr.dte = dte;
        const unsigned mask = engine::parse_greek_mask(exposure);
        if (mask == engine::kGreekGEX) pr.exposure = engine::ExposureType::GEX;
        else if (mask == engine::kGreekVEX) pr.exposure = engine::ExposureType::VEX;
        else if (mask == (engine::kGreekGEX | engine::kGreekVEX)) pr.exposure = engine::ExposureType::GEX_PLUS_VEX;
        else pr.greek_mask = mask;
        auto r = engine::build_projection(pr, projection_cfg, [&](int a, int z) { return feed.snapshot_bucket_range(tk, a, z); });
        return skylit::json::projection_to_json(r, projection_cfg).size();
    };

    // ---- heatmap / orbs path (polled every 1-2 s per panel)
    bench("heatmap 0dte GEX", [&] { return board_json("SPY", "GEX", "dte:0", false); });
    bench("heatmap dte:0,1,2 GEX+VEX", [&] { return board_json("SPXW", "GEX,VEX", "dte:0,1,2", false); });
    bench("heatmap 0dte GEX + velocity(15m)", [&] { return board_json("SPY", "GEX", "dte:0", true); });
    bench("heatmap current+50 GEX (51 buckets)", [&] { return board_json("QQQ", "GEX", "current+50", false); });
    bench("quadrinity 4 panes + confluence", [&] {
        std::vector<engine::HeatmapBoard> bs;
        for (const char* t : {"SPXW", "SPY", "QQQ", "NVDA"}) bs.push_back(*prepare_board(feed, t, "GEX", "dte:0", "0", "", "", ""));
        auto c = engine::compute_confluence(bs);
        std::size_t n = skylit::json::confluence_to_json(c).size();
        for (auto& b : bs) n += skylit::json::board_to_json(b).size();
        return n;
    });
    // ---- projection path (polled every 1 s when Projections is on)
    bench("projection 5m dte0 GEX", [&] { return projection_json("SPY", "5m", 0, "GEX"); });
    bench("projection 15m dte3 GEX+VEX", [&] { return projection_json("SPXW", "15m", 3, "GEX,VEX"); });
    bench("projection 1h dte6 custom(GEX,VEX,CHEX)", [&] { return projection_json("NVDA", "1h", 6, "GEX,VEX,CHEX"); });

    // ---- candle path (polled every 1 s per chart pane), at 4h and at ~24h of tick history
    auto candles_full = [&](const char* tk, std::int64_t sec) { return skylit::json::candles_to_json(feed.candles(tk, sec)).size(); };
    auto candles_latest = [&](const char* tk, std::int64_t sec) { return skylit::json::candles_to_json(feed.latest_candles(tk, sec)).size(); };
    bench("candles full 1m (4h history)", [&] { return candles_full("SPY", 60); });
    bench("candles/latest 1m (4h history)", [&] { return candles_latest("SPY", 60); });
    // fast-forward SPY to a full 24h history (86,400 ticks)
    {
        std::lock_guard lk(feed.mutex_);
        auto& h = feed.tick_history_["SPY"];
        const auto first = h.front().epoch_seconds;
        std::deque<skylit::market::PriceTick> big;
        double p = 570.0;
        for (std::int64_t i = 0; i < 24 * 3600 - static_cast<std::int64_t>(h.size()); ++i) {
            p += ((i * 7919) % 200 - 100) * 1e-4;
            big.push_back({first - 24 * 3600 + i, p});
        }
        for (auto& t : h) big.push_back(t);
        h = std::move(big);
    }
    bench("candles/latest 1m (24h history)", [&] { return candles_latest("SPY", 60); });
    bench("candles/latest 15m (24h history)", [&] { return candles_latest("SPY", 900); });
    bench("candles full 5m (24h history)", [&] { return candles_full("SPY", 300); });
    bench("flow 5m (24h history)", [&] { return skylit::json::flow_to_json(feed.flow("SPY", 300)).size(); });
    bench("darkpool", [&] { return skylit::json::dark_pool_to_json(feed.dark_pool("SPY")).size(); });

    std::printf("startup (LiveFeedManager ctor): %.1f ms\n", startup_ms);
    std::printf("%-46s %12s %10s\n", "benchmark", "us/call", "bytes");
    for (const auto& r : rows) std::printf("%-46s %12.1f %10zu\n", r.name, r.us, r.bytes);
    return 0;
}
