// Candle history, dark pool levels, and flow buckets — Atlas overlay data.
//
// Part C.2 requires tick-by-tick candlestick updates; Part C.8 requires
// dark pool levels; Part C.3/C.4 require a Flow overlay with per-bar
// call/put/net detail. This header keeps that data modeling separate from
// exposure_engine.hpp (which is strictly the options-positioning/node
// engine, Part E.1) since candles/dark-pool/flow are price-action and
// off-exchange-print concepts, not dealer-gamma concepts — different data,
// kept in a different module on purpose.
//
// Data source note: same caveat as exposure_engine.hpp — everything here is
// SYNTHETIC (a seeded random walk for price ticks, randomly placed dark
// pool prints, randomly generated flow bars) until a real market-data/tape
// vendor (e.g. the mentioned future IBKR connection) is wired in.

#pragma once

#include <algorithm>
#include <cstdint>
#include <deque>
#include <random>
#include <string>
#include <vector>

namespace skylit::market {

struct PriceTick {
    std::int64_t epoch_seconds;
    double price;
};

struct Candle {
    std::int64_t time;  // bucket start, unix seconds — matches Lightweight Charts' UTCTimestamp
    double open, high, low, close;
};

// Aggregates a tick history into OHLC bars of `interval_seconds` width.
// Shared by every interval the UI offers (1m/5m/15m/1h/1D) — one function,
// not per-interval special-casing, so "switching timeframe" (Part C.2)
// always produces a genuinely re-bucketed series from the same tick source.
inline std::vector<Candle> aggregate_candles(const std::deque<PriceTick>& ticks,
                                              std::int64_t interval_seconds) {
    std::vector<Candle> out;
    if (ticks.empty() || interval_seconds <= 0) return out;

    auto bucket_start = [&](std::int64_t t) { return (t / interval_seconds) * interval_seconds; };

    std::int64_t current_bucket = bucket_start(ticks.front().epoch_seconds);
    Candle c{current_bucket, ticks.front().price, ticks.front().price, ticks.front().price,
              ticks.front().price};

    for (const auto& tick : ticks) {
        std::int64_t b = bucket_start(tick.epoch_seconds);
        if (b != current_bucket) {
            out.push_back(c);
            current_bucket = b;
            c = Candle{b, tick.price, tick.price, tick.price, tick.price};
        }
        c.high = std::max(c.high, tick.price);
        c.low = std::min(c.low, tick.price);
        c.close = tick.price;
    }
    out.push_back(c);
    return out;
}

struct DarkPoolLevel {
    double price;
    double notional;      // approximate print size, in dollars
    std::string context;  // short label, e.g. "block print", "recurring level"
};

struct FlowBar {
    std::int64_t time;
    double call_volume;
    double put_volume;
    double net_flow;       // call_volume - put_volume, signed
    int trade_count;
    double bucket_put_call_ratio;
};

// Deterministic synthetic dark pool + flow generators. Same rationale as
// SyntheticExposureSource: keeps Atlas's overlay rendering, filtering, and
// Flow Bucket detail view genuinely buildable/testable before a real tape
// feed exists, without ever being mistaken for real prints.
class SyntheticMarketSource {
public:
    explicit SyntheticMarketSource(std::uint64_t seed) : rng_(seed) {}

    std::vector<DarkPoolLevel> generate_dark_pool(double spot, int count = 6) {
        std::vector<DarkPoolLevel> levels;
        std::uniform_real_distribution<double> offset_pct(-0.03, 0.03);
        std::uniform_real_distribution<double> notional(2'000'000, 80'000'000);
        static const char* contexts[] = {"block print", "recurring level", "single large print",
                                          "accumulation zone"};
        std::uniform_int_distribution<int> ctx_idx(0, 3);
        for (int i = 0; i < count; ++i) {
            double price = spot * (1.0 + offset_pct(rng_));
            levels.push_back(DarkPoolLevel{price, notional(rng_), contexts[ctx_idx(rng_)]});
        }
        std::ranges::sort(levels, {}, &DarkPoolLevel::price);
        return levels;
    }

    // One flow bar per candle bucket, so the Flow overlay always lines up
    // with the candles it's drawn beneath (Part C.3).
    std::vector<FlowBar> generate_flow(const std::vector<Candle>& candles) {
        std::vector<FlowBar> bars;
        std::uniform_real_distribution<double> vol(50'000, 4'000'000);
        std::uniform_int_distribution<int> trades(5, 400);
        for (const auto& c : candles) {
            double calls = vol(rng_);
            double puts = vol(rng_);
            FlowBar bar;
            bar.time = c.time;
            bar.call_volume = calls;
            bar.put_volume = puts;
            bar.net_flow = calls - puts;
            bar.trade_count = trades(rng_);
            bar.bucket_put_call_ratio = puts / std::max(calls, 1.0);
            bars.push_back(bar);
        }
        return bars;
    }

private:
    std::mt19937_64 rng_;
};

}  // namespace skylit::market
