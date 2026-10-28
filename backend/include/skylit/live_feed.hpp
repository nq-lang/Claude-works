// Live feed manager.
//
// Addresses the explicit requirement: candlestick/price data updates
// tick-by-tick, options/exposure data refreshes at least once per minute,
// continuously, not just on page load. Runs two background loops against
// the shared ExpirationStore (Part E.1 — one engine, all UI surfaces read
// from it) so Heatmaps, Atlas's sidecar, and Quadrinity all see the same
// live-updating boards.
//
// Data source note: driven by SyntheticExposureSource (see
// exposure_engine.hpp header comment) until a real market-data vendor is
// wired in. The cadence/threading model here is designed to be source-
// agnostic — swapping the synthetic tick/refresh calls for real vendor
// calls does not require changing this class's structure.

#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <ctime>
#include <deque>
#include <mutex>
#include <optional>
#include <random>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "skylit/candles.hpp"
#include "skylit/exposure_engine.hpp"

namespace skylit::live {

struct TickerConfig {
    std::string ticker;
    double base_spot;
    double strike_step;
    int strike_count;
    // Instrument treatment (documented in docs/TICKERS.md). Metadata only for now: the synthetic source
    // does not price off these; a real-data source must (VIX: forward-based, European, SOQ settle;
    // equities: American-style with dividends).
    std::string style = "american";      // "american" | "european"
    int multiplier = 100;                // contract multiplier
    std::string underlying_kind = "equity";  // "equity" | "etf" | "index" | "vol_index"
}; 

// Session-change badges (per spec): two named windows — "day" (09:30
// through 16:00) and "overnight" (18:00 through 09:30 the next day). The
// 16:00-18:00 gap isn't separately specified, so it's folded into
// "overnight" (post-close, pre-next-window). Simplification, called out in
// ARCHITECTURE.md: this reads the process's LOCAL wall clock as the
// session clock, since there's no real feed/timezone-aware market calendar
// wired in yet — correctness of the *demo* doesn't depend on real ET, but
// this is not a substitute for a real market-calendar/timezone library.
inline std::string session_label_for(std::chrono::system_clock::time_point now) {
    std::time_t tt = std::chrono::system_clock::to_time_t(now);
    std::tm local_tm{};
#if defined(_WIN32)
    localtime_s(&local_tm, &tt);
#else
    localtime_r(&tt, &local_tm);
#endif
    int minutes_of_day = local_tm.tm_hour * 60 + local_tm.tm_min;
    constexpr int kDayStart = 9 * 60 + 30;  // 09:30
    constexpr int kDayEnd = 16 * 60;        // 16:00
    if (minutes_of_day >= kDayStart && minutes_of_day < kDayEnd) return "day";
    return "overnight";
}

class LiveFeedManager {
public:
    // Expiration buckets seeded per ticker: "0dte" (today) plus "next1"
    // through "next10" (the next 10 expiration cycles). This is what makes
    // the Expiration subtab a genuine DATA-SCOPE change rather than a
    // display filter (see ARCHITECTURE.md's Expiration-scope section):
    // "Current + Next N" aggregates real, independently-generated/updated
    // per-bucket node data via ExpirationStore::aggregate() — it is not a
    // re-slice of one shared dataset. Each bucket gets its own King strike
    // and magnitude distribution (different RNG draw per bucket) so
    // aggregating more buckets visibly changes the resulting board, the
    // same way real multi-expiration OI actually would.
    static constexpr int kMaxNextExpirations = 50;

    static std::vector<std::string> all_expiration_buckets() {
        std::vector<std::string> out = {"0dte"};
        for (int i = 1; i <= kMaxNextExpirations; ++i) out.push_back("next" + std::to_string(i));
        return out;
    }

    explicit LiveFeedManager(std::vector<TickerConfig> tickers,
                              std::uint64_t seed = 42)
        : tickers_(std::move(tickers)), source_(seed), market_source_(seed + 1) {
        std::lock_guard lock(mutex_);
        auto now = std::chrono::duration_cast<std::chrono::seconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
        auto buckets = all_expiration_buckets();
        for (const auto& t : tickers_) {
            for (std::size_t bi = 0; bi < buckets.size(); ++bi) {
                // Each bucket's board is seeded from a distinct RNG state
                // (source_ advances with every call), so buckets have
                // genuinely different King strikes/magnitudes rather than
                // being copies of "0dte" with a different label.
                auto board = source_.generate_board(t.ticker, t.base_spot, t.strike_step,
                                                      t.strike_count, buckets[bi]);
                store_.set_board(t.ticker, buckets[bi], std::move(board));
            }

            // Seed enough tick history to render a meaningful chart on first
            // load (Part C.2) rather than starting from an empty/blank
            // chart and waiting hours for real ticks to accumulate. Seeded
            // with a bounded random walk anchored at base_spot; every tick
            // after this is a real (synthetic-but-live) update from
            // price_loop().
            std::mt19937_64 seed_rng(seed + std::hash<std::string>{}(t.ticker));
            std::normal_distribution<double> step(0.0, t.base_spot * 0.0004);
            constexpr std::int64_t kSeedTicks = 4 * 3600;  // 4 hours of 1s history
            std::deque<market::PriceTick> history;
            double price = t.base_spot;
            for (std::int64_t i = kSeedTicks; i > 0; --i) {
                price = std::max(0.01, price + step(seed_rng));
                history.push_back(market::PriceTick{now - i, price});
            }
            tick_history_[t.ticker] = std::move(history);

            // Session baseline (badges feature): seeded from the "0dte"
            // bucket only. KNOWN SIMPLIFICATION: badges currently reflect
            // 0DTE session change regardless of which expiration scope is
            // being viewed — extending badges to track the currently
            // AGGREGATED view (0dte+nextN) would need a baseline per scope
            // selection, not just per ticker; deferred, flagged here and
            // in ARCHITECTURE.md rather than silently mismatched.
            std::unordered_map<double, double> baseline;
            if (const auto* seeded = store_.get_board(t.ticker, "0dte")) {
                for (const auto& n : seeded->nodes) baseline[n.strike] = n.exposure;
            }
            session_baseline_[t.ticker] = std::move(baseline);
            session_label_[t.ticker] = session_label_for(std::chrono::system_clock::now());

            // Velocity Mode reference snapshots, per ticker x expiration
            // bucket. SYNTHETIC BACKFILL: with a synthetic source there is
            // no real intraday history to read, so each bucket's past is
            // generated by walking its current exposure BACKWARD under a
            // persistent per-strike trend (some strikes have been
            // accumulating, some unwinding, a few appeared recently) so
            // the pills show realistic structure from the first request
            // instead of reading 0% for an hour. With a real feed, replace
            // seed_velocity_history() with the vendor's stored snapshots;
            // annotate_velocity() and everything above it is unchanged.
            for (std::size_t bi = 0; bi < buckets.size(); ++bi) {
                if (const auto* b = store_.get_board(t.ticker, buckets[bi]))
                    seed_velocity_history(t.ticker + "|" + buckets[bi], *b,
                                          seed ^ (std::hash<std::string>{}(t.ticker) + bi * 7919));
            }
        }
        // The Badges pills (session_change_pct) and Velocity Mode's session
        // baseline are the same idea — change since the session opened — so
        // they share one reference: the session-open snapshot. (Seeding the
        // badge baseline from the live board instead made every pill read
        // ~0% until real drift accumulated.)
        for (const auto& t : tickers_) {
            auto it = session_open_snap_.find(t.ticker + "|0dte");
            if (it != session_open_snap_.end())
                session_baseline_[t.ticker] = std::unordered_map<double, double>(it->second.v.begin(), it->second.v.end());
        }
        last_history_append_ = now;
    }

    ~LiveFeedManager() { stop(); }

    void start() {
        running_ = true;
        price_thread_ = std::thread([this] { price_loop(); });
        exposure_thread_ = std::thread([this] { exposure_loop(); });
    }

    void stop() {
        {
            // Flip the flag under the sleep mutex so a loop that is about to wait
            // cannot miss the wake-up (no lost-notification window).
            std::lock_guard lk(sleep_mutex_);
            if (!running_) return;
            running_ = false;
        }
        sleep_cv_.notify_all();
        if (price_thread_.joinable()) price_thread_.join();
        if (exposure_thread_.joinable()) exposure_thread_.join();
    }

    // Parses the frontend's expiration selector: "0dte" for today only, or
    // "current+N" (N clamped 1..kMaxNextExpirations) for the aggregated
    // multi-day scope. Returns the ordered list of buckets to aggregate.
    //
    // NEW selector form: "dte:0,1,3" — an explicit, possibly non-contiguous
    // set of DTE buckets (0..kMaxNextExpirations; bucket index == DTE,
    // exact for tickers with daily expirations). This is what the Expiry
    // Data window and the per-heatmap DTE dropdown send.
    static std::string bucket_name_for_dte(int dte) {
        return dte <= 0 ? std::string("0dte") : "next" + std::to_string(dte);
    }

    static std::vector<std::string> buckets_for_selector(const std::string& selector) {
        if (selector.rfind("dte:", 0) == 0) {
            std::vector<std::string> out;
            std::string rest = selector.substr(4), tok;
            auto flush = [&] {
                if (tok.empty()) return;
                try {
                    int d = std::stoi(tok);
                    d = std::max(0, std::min(kMaxNextExpirations, d));
                    auto name = bucket_name_for_dte(d);
                    if (std::find(out.begin(), out.end(), name) == out.end()) out.push_back(name);
                } catch (...) {}
                tok.clear();
            };
            for (char c : rest) { if (c == ',' || c == '_' || c == ' ') flush(); else tok.push_back(c); }
            flush();
            if (out.empty()) out.push_back("0dte");
            return out;
        }
        if (selector == "0dte" || selector.empty()) return {"0dte"};
        auto plus = selector.find('+');
        if (plus == std::string::npos) return {"0dte"};
        int n = 1;
        try {
            n = std::stoi(selector.substr(plus + 1));
        } catch (...) {
            n = 1;
        }
        n = std::max(1, std::min(kMaxNextExpirations, n));
        std::vector<std::string> out = {"0dte"};
        for (int i = 1; i <= n; ++i) out.push_back("next" + std::to_string(i));
        return out;
    }

    // Snapshot accessor for route handlers — copies out under lock so the
    // HTTP handler (running on the accept thread) never races the
    // background update threads. `expiration_selector` is a genuine
    // DATA-SCOPE change (see class comment / ARCHITECTURE.md): "0dte"
    // returns that bucket alone, "current+N" aggregates 0dte plus the next
    // N independently-tracked buckets via ExpirationStore::aggregate(), so
    // the returned node set (King strike, magnitudes, count) can and does
    // genuinely differ by scope — this is not a client-side re-filter of
    // one shared series.
    std::optional<engine::HeatmapBoard> snapshot(const std::string& ticker,
                                                  const std::string& expiration_selector = "0dte") const {
        std::lock_guard lock(mutex_);
        auto buckets = buckets_for_selector(expiration_selector);
        engine::HeatmapBoard board;
        if (buckets.size() == 1) {
            const engine::HeatmapBoard* b = store_.get_board(ticker, buckets.front());
            if (!b) return std::nullopt;
            board = *b;
        } else {
            board = store_.aggregate(ticker, buckets);
            if (board.nodes.empty()) return std::nullopt;
            engine::compute_derived_state(board);
        }
        apply_session_change_pct(ticker, board);
        return board;
    }

    // Aggregated board over an inclusive expiration-bucket index range
    // (0 = "0dte", N = "nextN") — used by the Projections layer to pull a
    // DTE cohort (e.g. buckets 3..7) from the SAME ExpirationStore and the
    // SAME aggregate()/compute_derived_state() path as every other view.
    // Spot always comes from the "0dte" board (ticker-wide price).
    std::optional<engine::HeatmapBoard> snapshot_bucket_range(const std::string& ticker, int first,
                                                               int last) const {
        std::lock_guard lock(mutex_);
        first = std::max(0, first);
        last = std::min(kMaxNextExpirations, last);
        if (last < first) return std::nullopt;
        std::vector<std::string> buckets;
        for (int i = first; i <= last; ++i) buckets.push_back(i == 0 ? "0dte" : "next" + std::to_string(i));
        engine::HeatmapBoard board = store_.aggregate(ticker, buckets);
        if (board.nodes.empty()) return std::nullopt;
        if (const auto* b0 = store_.get_board(ticker, "0dte")) board.spot = b0->spot;
        engine::compute_derived_state(board);
        return board;
    }

    // -----------------------------------------------------------------
    // Velocity Mode (rate of change). Velocity % = (|E_current| -
    // |E_reference|) / |E_reference| x 100, per strike, on ABSOLUTE
    // exposure magnitude (sign-agnostic: a short-gamma node that grows
    // more negative is "accumulating" and reads positive).
    //
    // E is the selected-Greek exposure summed across the velocity SCOPE's
    // expiration buckets, so scope is independent of what the board
    // itself displays (e.g. view 2DTE while measuring 0DTE-only urgency).
    // The reference is one of: the session-open snapshot, a rolling
    // 5m/15m/1h-ago snapshot, or the previous-day-close snapshot. A
    // strike with no exposure in the reference but some now is flagged
    // `velocity_new` (no meaningful percentage); one whose exposure has
    // vanished reads -100%.
    // -----------------------------------------------------------------
    struct VelocityRequest {
        bool enabled = false;
        std::string baseline = "session";      // session | 5m | 15m | 1h | prev_close
        std::vector<std::string> buckets;      // velocity scope; empty = the board's own buckets
        unsigned greek_mask = engine::kGreekGEX;
    };

    void annotate_velocity(const std::string& ticker, engine::HeatmapBoard& board,
                            const VelocityRequest& vr) const {
        if (!vr.enabled) return;
        std::lock_guard lock(mutex_);
        const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                             std::chrono::system_clock::now().time_since_epoch()).count();
        std::int64_t back_seconds = 0;
        bool rolling = false;
        if (vr.baseline == "5m") { back_seconds = 300; rolling = true; }
        else if (vr.baseline == "15m") { back_seconds = 900; rolling = true; }
        else if (vr.baseline == "1h") { back_seconds = 3600; rolling = true; }

        std::unordered_map<double, double> cur, ref;
        for (const auto& bucket : vr.buckets) {
            const engine::HeatmapBoard* b = store_.get_board(ticker, bucket);
            if (!b) continue;
            if (cur.empty()) {  // one allocation up front instead of a rehash cascade while filling
                cur.reserve(b->nodes.size() * 2);
                ref.reserve(b->nodes.size() * 2);
            }
            for (const auto& n : b->nodes)
                cur[n.strike] += engine::greek_mask_value(vr.greek_mask, n.exposure, n.strike);

            const ExposureSnap* snap = nullptr;
            const std::string key = ticker + "|" + bucket;
            if (rolling) {
                auto hit = exposure_history_.find(key);
                if (hit != exposure_history_.end() && !hit->second.empty()) {
                    const std::int64_t target = now - back_seconds;
                    const ExposureSnap* best = &hit->second.front();
                    for (const auto& sn : hit->second)
                        if (std::llabs(sn.t - target) < std::llabs(best->t - target)) best = &sn;
                    snap = best;
                }
            } else if (vr.baseline == "prev_close") {
                auto pit = prev_close_snap_.find(key);
                if (pit != prev_close_snap_.end()) snap = &pit->second;
            } else {
                auto sit = session_open_snap_.find(key);
                if (sit != session_open_snap_.end()) snap = &sit->second;
            }
            if (!snap) continue;
            for (const auto& [strike, e] : snap->v)
                ref[strike] += engine::greek_mask_value(vr.greek_mask, e, strike);
        }

        for (auto& n : board.nodes) {
            n.velocity_pct = 0.0;
            n.velocity_new = false;
            const auto ci = cur.find(n.strike);  // one hash lookup each (was count() + operator[])
            const auto ri = ref.find(n.strike);
            const double c = std::abs(ci != cur.end() ? ci->second : 0.0);
            const double r = std::abs(ri != ref.end() ? ri->second : 0.0);
            if (r < 1e-9) {
                n.velocity_new = c > 1e-9;
            } else {
                n.velocity_pct = (c - r) / r * 100.0;
            }
        }
    }

    std::vector<engine::HeatmapBoard> snapshot_many(const std::vector<std::string>& tickers,
                                                      const std::string& expiration_selector = "0dte") const {
        std::vector<engine::HeatmapBoard> out;
        for (const auto& t : tickers) {
            if (auto b = snapshot(t, expiration_selector)) out.push_back(std::move(*b));
        }
        return out;
    }

    const std::vector<TickerConfig>& configs() const { return tickers_; }
    std::vector<std::string> known_tickers() const {
        std::vector<std::string> out;
        for (const auto& t : tickers_) out.push_back(t.ticker);
        return out;
    }

    // Part C.2: candlestick series for the requested timeframe, aggregated
    // fresh from tick history each call so switching intervals is a genuine
    // re-bucketing (never a cached/stale series).
    std::vector<market::Candle> candles(const std::string& ticker,
                                         std::int64_t interval_seconds) const {
        std::lock_guard lock(mutex_);
        auto it = tick_history_.find(ticker);
        if (it == tick_history_.end()) return {};
        return market::aggregate_candles(it->second, interval_seconds);
    }

    // Cheap poll target for tick-by-tick updates: only the last two bars
    // (the just-closed one + the currently-forming one), not the whole
    // history — this is what the frontend polls at ~1s cadence.
    std::vector<market::Candle> latest_candles(const std::string& ticker,
                                                std::int64_t interval_seconds,
                                                int count = 2) const {
        if (count <= 0) return {};
        std::lock_guard lock(mutex_);
        auto it = tick_history_.find(ticker);
        if (it == tick_history_.end()) return {};
        // Only the newest `count` bars are needed: aggregate just that tail (see candles.hpp) rather
        // than the whole 24h history on every 1s poll of every chart pane.
        return market::aggregate_candles_tail(it->second, interval_seconds, static_cast<std::size_t>(count));
    }

    std::vector<market::DarkPoolLevel> dark_pool(const std::string& ticker) {
        double spot = 0.0;
        {
            std::lock_guard lock(mutex_);
            if (const auto* b = store_.get_board(ticker, "0dte")) spot = b->spot;
        }
        if (spot <= 0.0) return {};
        // Regenerated per call rather than cached: acceptable for a
        // synthetic source; a real feed would instead push actual prints
        // and this method would just return the current cached set.
        std::lock_guard market_lock(market_mutex_);  // market_source_ owns a mutable RNG
        return market_source_.generate_dark_pool(spot);
    }

    std::vector<market::FlowBar> flow(const std::string& ticker, std::int64_t interval_seconds) {
        auto bars = candles(ticker, interval_seconds);
        std::lock_guard market_lock(market_mutex_);  // market_source_ owns a mutable RNG
        return market_source_.generate_flow(bars);
    }

private:
    struct ExposureSnap {
        std::int64_t t = 0;
        // strike -> raw (GEX-series) exposure, strike-ascending and unique. A flat vector instead of
        // a hash map: ~200 keys x 130 snapshots of these are kept, and every use either iterates the
        // whole snapshot or sums it per strike (order-independent), so this is ~4x smaller and
        // allocation-free per element without changing a single result.
        std::vector<std::pair<double, double>> v;
    };

    // Establishes ExposureSnap::v's invariant (sorted, one entry per strike, LAST write wins - the
    // semantics the previous map-assignment had).
    static void normalize_snap(std::vector<std::pair<double, double>>& v) {
        auto by_strike = [](const auto& a, const auto& b) { return a.first < b.first; };
        if (!std::is_sorted(v.begin(), v.end(), by_strike)) std::stable_sort(v.begin(), v.end(), by_strike);
        std::size_t w = 0;
        for (std::size_t r = 0; r < v.size(); ++r) {
            if (w > 0 && v[w - 1].first == v[r].first) v[w - 1] = v[r];
            else v[w++] = v[r];
        }
        v.resize(w);
    }

    static ExposureSnap snap_of(const engine::HeatmapBoard& b, std::int64_t t) {
        ExposureSnap s;
        s.t = t;
        s.v.reserve(b.nodes.size());
        for (const auto& n : b.nodes) s.v.emplace_back(n.strike, n.exposure);
        normalize_snap(s.v);
        return s;
    }

    // Constructor-time only (mutex held by caller).
    void seed_velocity_history(const std::string& key, const engine::HeatmapBoard& b,
                                std::uint64_t rng_seed) {
        std::mt19937_64 rng(rng_seed);
        std::normal_distribution<double> trend_dist(0.0, 0.003);   // per-minute growth rate
        std::uniform_real_distribution<double> unit(0.0, 1.0);
        std::normal_distribution<double> noise(0.0, 0.015);
        const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                             std::chrono::system_clock::now().time_since_epoch()).count();

        std::unordered_map<double, double> trend;
        for (const auto& n : b.nodes) {
            double tr = trend_dist(rng);
            if (unit(rng) < 0.15) tr *= 3.0;  // a few strikes are moving much faster
            trend[n.strike] = tr;
        }
        auto back = [&](double minutes, double extra_noise, double absent_fraction) {
            ExposureSnap s;
            s.t = now - static_cast<std::int64_t>(minutes * 60.0);
            for (const auto& n : b.nodes) {
                if (unit(rng) < absent_fraction) continue;  // strike had no exposure back then
                double factor = std::exp(-trend[n.strike] * minutes) * (1.0 + noise(rng) * extra_noise);
                s.v.emplace_back(n.strike, n.exposure * factor);
            }
            normalize_snap(s.v);
            return s;
        };

        constexpr int kHistoryMinutes = 130;
        std::deque<ExposureSnap> hist;
        for (int m = kHistoryMinutes; m >= 1; --m) hist.push_back(back(m, 1.0, 0.0));
        exposure_history_[key] = std::move(hist);

        // Session open: minutes since 09:30 local, clamped to a plausible
        // window (outside market hours, assume a mid-session distance).
        std::time_t tt = static_cast<std::time_t>(now);
        std::tm lt{};
        localtime_r(&tt, &lt);
        double since_open = (lt.tm_hour * 60 + lt.tm_min) - (9 * 60 + 30);
        if (since_open < 30 || since_open > 390) since_open = 180;
        session_open_snap_[key] = back(since_open, 2.0, 0.04);

        // Previous close: a deeper, independently drifted reference (the
        // trend is scaled to ~2.7h of movement rather than a literal 18h
        // so magnitudes stay readable), with a few strikes absent so "NEW"
        // pills appear against this baseline too.
        prev_close_snap_[key] = back(18.0 * 60.0 * 0.15, 3.0, 0.06);
    }

    // Must be called with mutex_ already held.
    //
    // IMPORTANT sign semantics: this is a MAGNITUDE change, not a signed
    // change. Green ("+X%") means dealers' position SIZE at this strike
    // grew since the baseline — new positions opened/rolled to this level,
    // regardless of which side (Pika/Barney) it's on. Red ("-X%") means
    // the position shrank — dealers unwinding hedges at this level. A
    // Barney (negative-exposure) node moving from -466K toward -445K has
    // SHRUNK in magnitude (dealers covered some short gamma) even though
    // the raw signed value went up — that must read as a RED/decreasing
    // badge, not green. Using (current - baseline)/|baseline| directly
    // (a signed-value delta) gets this backwards for exactly that case;
    // magnitude-of-magnitude is the correct comparison.
    //
    // Known edge case, not specially handled: if a strike's exposure
    // flips sides entirely (e.g. baseline +100K Pika -> now -50K Barney),
    // this still reports a magnitude-shrink percentage (-50%) rather than
    // flagging the sign flip itself. The spec describes badges in terms of
    // position SIZE growing/shrinking, not a distinct "flipped sides"
    // state, so this is treated as within scope of "shrank" — a full flip
    // indicator would be a reasonable future addition if desired.
    void apply_session_change_pct(const std::string& ticker, engine::HeatmapBoard& board) const {
        auto it = session_baseline_.find(ticker);
        if (it == session_baseline_.end()) return;
        for (auto& n : board.nodes) {
            auto bit = it->second.find(n.strike);
            if (bit != it->second.end() && bit->second != 0.0) {
                double baseline_abs = std::abs(bit->second);
                double current_abs = std::abs(n.exposure);
                n.session_change_pct = (current_abs - baseline_abs) / baseline_abs * 100.0;
            }
        }
    }

    // Must be called with mutex_ already held. Detects whether the trading
    // session period has rolled over (day <-> overnight) since the last
    // check, and if so, re-seeds that ticker's baseline from the CURRENT
    // board — badges then read "0%" at the instant a new period begins and
    // accumulate from there, matching the spec's per-period framing.
    bool maybe_roll_session_baseline(const std::string& ticker) {
        std::string label = session_label_for(std::chrono::system_clock::now());
        auto it = session_label_.find(ticker);
        if (it != session_label_.end() && it->second == label) return false;  // no rollover

        const engine::HeatmapBoard* b = store_.get_board(ticker, "0dte");
        if (!b) return false;
        std::unordered_map<double, double> baseline;
        for (const auto& n : b->nodes) baseline[n.strike] = n.exposure;
        session_baseline_[ticker] = std::move(baseline);
        session_label_[ticker] = label;
        return true;
    }

    // Detects whether price crossed a given strike between two ticks
    // (either direction) — this is what "touching" a node means for the
    // freshness-decay feature: as price passes through an exposure
    // level, that level's touch_count increments and its visual
    // prominence (Orb opacity) decays from there, per
    // decay_weight_for_touches() in exposure_engine.hpp.
    static bool crossed(double old_spot, double new_spot, double strike) {
        return (old_spot <= strike && strike <= new_spot) || (new_spot <= strike && strike <= old_spot);
    }

    void price_loop() {
        // Tick-by-tick price: every 1s. A real feed would push on-tick
        // instead of polling on a fixed interval; 1s is the practical
        // minimum sane interval for a synthetic source without flooding
        // the (currently HTTP-polling, not WebSocket-push — see
        // ARCHITECTURE.md §2 amendment) frontend.
        //
        // Spot is ticker-wide, not per-expiration — SPY's price doesn't
        // have a separate value "for the 0DTE view" vs "for next week's
        // expiration." So this ticks ONE bucket ("0dte") to get the new
        // spot, then propagates that same spot to every other bucket for
        // the ticker, rather than running kMaxNextExpirations+1 independent
        // random walks that would drift apart from each other nonsensically.
        while (running_) {
            tick_prices_once();
            interruptible_sleep(std::chrono::seconds(1));
        }
    }

    // One price tick for every ticker: the body of price_loop(), moved here unchanged so a
    // deterministic test can drive it without threads or sleeping.
    void tick_prices_once() {
        std::lock_guard lock(mutex_);
        auto now = std::chrono::duration_cast<std::chrono::seconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
        for (const auto& t : tickers_) {
            auto* primary = store_.get_board_mut(t.ticker, "0dte");
            if (!primary) continue;
            double old_spot = primary->spot;
            source_.tick_price(*primary);
            double new_spot = primary->spot;

            // Freshness/retest decay (this feature): every bucket's
            // nodes get touch_count bumped when the tick crossed
            // their strike — applied per-bucket since each
            // expiration's node set is independent data, not just
            // the "0dte" board.
            for (const auto& bucket : all_expiration_buckets()) {
                auto* b = store_.get_board_mut(t.ticker, bucket);
                if (!b) continue;
                if (bucket != "0dte") b->spot = new_spot;
                for (auto& node : b->nodes) {
                    if (crossed(old_spot, new_spot, node.strike)) ++node.touch_count;
                }
            }

            auto& history = tick_history_[t.ticker];
            history.push_back(market::PriceTick{now, new_spot});
            // Bound memory: cap at 24h of 1s ticks per ticker.
            constexpr std::size_t kMaxTicks = 24 * 3600;
            while (history.size() > kMaxTicks) history.pop_front();
        }
    }

    // Sleeps for `d`, returning early (immediately) once stop() is called.
    void interruptible_sleep(std::chrono::seconds d) {
        std::unique_lock lk(sleep_mutex_);
        sleep_cv_.wait_for(lk, d, [this] { return !running_.load(); });
    }

    void exposure_loop() {
        // Options/exposure refresh: at least once per minute, per the
        // explicit requirement. Set to 60s exactly (the stated minimum
        // cadence) rather than slower, since Codespaces CPU cost of a
        // synthetic recompute over a small node set is negligible.
        //
        // Unlike spot, each expiration bucket's OPEN INTEREST genuinely
        // evolves independently — this week's gamma build-up is not next
        // week's — so every bucket gets its own refresh_exposure() call,
        // not a shared/propagated value.
        //
        // Velocity Mode is specified as refreshed in real time, so the
        // refresh now runs every 10s (still comfortably "at least once per
        // minute"). History snapshots for the rolling-window baselines
        // are appended at most once a minute regardless.
        while (running_) {
            interruptible_sleep(std::chrono::seconds(10));
            if (!running_) break;
            refresh_exposures_once();
        }
    }

    // One exposure refresh for every ticker x bucket: the body of exposure_loop(), moved here
    // unchanged for deterministic testing.
    void refresh_exposures_once() {
        std::lock_guard lock(mutex_);
        const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                             std::chrono::system_clock::now().time_since_epoch()).count();
        const bool append_history = now - last_history_append_ >= 60;
        for (const auto& t : tickers_) {
            const bool rolled = maybe_roll_session_baseline(t.ticker);
            for (const auto& bucket : all_expiration_buckets()) {
                if (auto* b = store_.get_board_mut(t.ticker, bucket)) {
                    if (rolled) {
                        // New trading period: yesterday's session-open
                        // becomes the previous-close reference, and
                        // session velocity restarts from 0.
                        const std::string key = t.ticker + "|" + bucket;
                        prev_close_snap_[key] = snap_of(*b, now);
                        session_open_snap_[key] = snap_of(*b, now);
                    }
                    source_.refresh_exposure(*b);
                    if (append_history) {
                        auto& h = exposure_history_[t.ticker + "|" + bucket];
                        h.push_back(snap_of(*b, now));
                        while (h.size() > 130) h.pop_front();
                    }
                }
            }
        }
        if (append_history) last_history_append_ = now;
    }

    std::vector<TickerConfig> tickers_;
    engine::SyntheticExposureSource source_;
    market::SyntheticMarketSource market_source_;
    engine::ExpirationStore store_;
    std::unordered_map<std::string, std::deque<market::PriceTick>> tick_history_;
    std::unordered_map<std::string, std::unordered_map<double, double>> session_baseline_;
    std::unordered_map<std::string, std::string> session_label_;
    // Velocity Mode references, keyed "TICKER|bucket".
    std::unordered_map<std::string, std::deque<ExposureSnap>> exposure_history_;
    std::unordered_map<std::string, ExposureSnap> session_open_snap_;
    std::unordered_map<std::string, ExposureSnap> prev_close_snap_;
    std::int64_t last_history_append_ = 0;
    mutable std::mutex mutex_;
    std::mutex market_mutex_;  // guards market_source_ (dark pool / flow RNG)
    std::mutex sleep_mutex_;
    std::condition_variable sleep_cv_;
    std::atomic<bool> running_{false};
    std::thread price_thread_;
    std::thread exposure_thread_;
};

}  // namespace skylit::live
