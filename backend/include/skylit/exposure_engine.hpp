// Skylit Heatseeker Terminal — shared exposure/node engine.
//
// Part E.1: Heatmaps, Atlas's sidecar, and Quadrinity (formerly Trinity Mode)
// must all consume ONE computation engine — not three divergent
// implementations. This header is that engine. Nothing UI-specific lives
// here; it is pure data + computation, exposed to route handlers in
// src/main.cpp which serialize it to JSON for the frontend.
//
// Data source note: there is no live market-data vendor wired in yet (no
// credentials, no connector chosen). To keep every other layer (engine,
// API, frontend rendering, King Node math, freshness decay, live-update
// plumbing) genuinely buildable and testable now, this module includes a
// deterministic SYNTHETIC generator behind a source class a real feed
// would eventually replace. Swapping in a real vendor later means
// implementing that one interface — nothing above it changes. This is
// called out loudly in ARCHITECTURE.md so it's never mistaken for real
// market data.

#pragma once

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <map>
#include <random>
#include <string>
#include <vector>

namespace skylit::engine {

// ---------------------------------------------------------------------------
// Exposure type (Part B.5 / C.3 filter axis)
// ---------------------------------------------------------------------------

enum class ExposureType { GEX, VEX, GEX_PLUS_VEX };

inline const char* to_string(ExposureType t) {
    switch (t) {
        case ExposureType::GEX: return "GEX";
        case ExposureType::VEX: return "VEX";
        case ExposureType::GEX_PLUS_VEX: return "GEX+VEX";
    }
    return "GEX";
}

// ---------------------------------------------------------------------------
// Node — one strike's exposure state, plus all Part B.4 backend concepts
// ---------------------------------------------------------------------------

enum class NodeRole { Normal, KingNode, Gatekeeper, HedgeNode };

struct Node {
    double strike = 0.0;
    double exposure = 0.0;          // signed: + = Pika (long gamma), - = Barney (short gamma)
    NodeRole role = NodeRole::Normal;

    // Freshness / retest decay (Part B.4): touches since last reshuffle.
    int touch_count = 0;

    // Rate of change (Part B.4): signed delta in exposure magnitude since
    // the previous snapshot for this strike. First-class/queryable metric.
    double rate_of_change = 0.0;

    // Net % change in this strike's exposure since the start of the
    // current trading session period (badges feature — see
    // ARCHITECTURE.md's badges section and live_feed.hpp's session
    // baseline tracking). Distinct from rate_of_change: this is cumulative
    // over the whole session window (overnight 18:00-09:30, or day
    // 09:30-16:00), not a single-tick delta. 0 until a baseline exists.
    double session_change_pct = 0.0;

    // Velocity Mode (rate of change) — Velocity % = (|E_current| -
    // |E_reference|) / |E_reference| x 100, on the node's ABSOLUTE
    // magnitude so growth reads positive whether the underlying exposure
    // is long- or short-gamma. `velocity_new` marks a strike that has no
    // exposure in the reference snapshot (a node that APPEARED), where a
    // percentage is undefined. Filled per request by
    // LiveFeedManager::annotate_velocity(); 0/false when not requested.
    double velocity_pct = 0.0;
    bool velocity_new = false;

    // Distance from current spot, used to scale Hedge Node influence
    // (Part B.4: "influence should scale down with distance from spot").
    double distance_from_spot = 0.0;
};

// Part B.4 freshness/retest decay model: first touch strongest, decays with
// each subsequent touch. Tunable — free function, not baked into Node, so
// it stays config-driven per Part E.4.
struct FreshnessConfig {
    double first_touch_weight = 1.0;
    double decay_per_touch = 0.30;   // each additional touch reduces weight by this fraction
    double floor_weight = 0.15;      // never decays below this — a node is never fully "dead"
};

inline double decay_weight_for_touches(int touch_count, const FreshnessConfig& cfg = {}) {
    if (touch_count <= 0) return cfg.first_touch_weight;
    double w = cfg.first_touch_weight - (touch_count * cfg.decay_per_touch);
    return std::max(w, cfg.floor_weight);
}

// ---------------------------------------------------------------------------
// Range boundaries / midpoint (Part B.4)
// ---------------------------------------------------------------------------

struct RangeBoundaries {
    double upper = 0.0;
    double lower = 0.0;
    double midpoint() const { return (upper + lower) / 2.0; }
};

// ---------------------------------------------------------------------------
// Air pockets (Part B.4)
// ---------------------------------------------------------------------------

enum class GammaContext { Positive, Negative };

struct AirPocket {
    double low_strike = 0.0;
    double high_strike = 0.0;
    GammaContext context = GammaContext::Positive;
    // Positive context => milder/slower expected move through it.
    // Negative context => sharper/more violent expected move through it.
};

// ---------------------------------------------------------------------------
// Rolling floor/ceiling detection (Part B.4) — computed from rate-of-change
// history, not hand-labeled.
// ---------------------------------------------------------------------------

enum class RollDirection { None, RollingFloorUp, RollingCeilingDown };

// ---------------------------------------------------------------------------
// OPEX awareness (Part B.4)
// ---------------------------------------------------------------------------

struct SimpleDate {
    int year, month, day;
};

// Third Friday of the given month/year (standard monthly OPEX convention),
// via Zeller's congruence for the 1st-of-month weekday.
inline SimpleDate third_friday(int year, int month) {
    int y = year;
    int m = month;
    if (m < 3) y -= 1;
    int k = y % 100;
    int j = y / 100;
    int q = 1;
    int dow = (q + 13 * (m + 1) / 5 + k + k / 4 + j / 4 + 5 * j) % 7;  // 0=Sat,1=Sun,...
    int zeller_to_sun = (dow + 6) % 7;                                  // 0=Sun,...,6=Sat
    int first_friday_day = 1 + ((5 - zeller_to_sun + 7) % 7);
    int third_friday_day = first_friday_day + 14;
    return SimpleDate{year, month, third_friday_day};
}

inline bool is_opex_week(const SimpleDate& today) {
    SimpleDate opex = third_friday(today.year, today.month);
    int opex_start = opex.day - 4;
    return today.year == opex.year && today.month == opex.month && today.day >= opex_start &&
           today.day <= opex.day;
}

// ---------------------------------------------------------------------------
// Confluence (Part D.2/D.3, generalized for Quadrinity's variable N per §0
// of ARCHITECTURE.md — was hardcoded 3/3 for Trinity, now N/N for 2-4 panes)
// ---------------------------------------------------------------------------

enum class DirectionalRead { Bullish, Bearish, Neutral };

struct ConfluenceResult {
    int aligned_count = 0;
    int total_count = 0;
    DirectionalRead majority_read = DirectionalRead::Neutral;
    std::vector<std::string> outlier_tickers;  // tickers disagreeing with the majority

    std::string state_label() const {
        return std::to_string(aligned_count) + "/" + std::to_string(total_count) + " aligned";
    }
};

// ---------------------------------------------------------------------------
// A full single-ticker, single-expiration-bucket board
// ---------------------------------------------------------------------------

struct HeatmapBoard {
    std::string ticker;
    std::string expiration_bucket;   // e.g. "0DTE", "2025-09-19", "current+2"
    double spot = 0.0;
    std::vector<Node> nodes;         // sorted by strike ascending
    RangeBoundaries range;
    std::vector<AirPocket> air_pockets;
    RollDirection floor_trend = RollDirection::None;
    RollDirection ceiling_trend = RollDirection::None;
    bool opex_week = false;

    // Highest-*absolute*-value node wins the King Node, per Part B.3's core
    // invariant: "the absolute value of a node's exposure determines its
    // visual intensity/prominence — never its sign alone."
    const Node* king_node() const {
        const Node* best = nullptr;
        for (const auto& n : nodes) {
            if (!best || std::abs(n.exposure) > std::abs(best->exposure)) best = &n;
        }
        return best;
    }
};

// ---------------------------------------------------------------------------
// Per-expiration-bucket storage (Part C.5 / E.2)
//
// Critical requirement being modeled here: the SAME strike can carry a
// genuinely different (even opposite-sign) exposure value depending on which
// expiration bucket is selected. Boards are keyed by (ticker, bucket) as
// independent datasets — never one flattened per-ticker table with a
// client-side filter on top.
// ---------------------------------------------------------------------------

class ExpirationStore {
public:
    void set_board(const std::string& ticker, const std::string& expiration_bucket,
                    HeatmapBoard board) {
        boards_[key(ticker, expiration_bucket)] = std::move(board);
    }

    const HeatmapBoard* get_board(const std::string& ticker,
                                   const std::string& expiration_bucket) const {
        auto it = boards_.find(key(ticker, expiration_bucket));
        return it == boards_.end() ? nullptr : &it->second;
    }

    HeatmapBoard* get_board_mut(const std::string& ticker, const std::string& expiration_bucket) {
        auto it = boards_.find(key(ticker, expiration_bucket));
        return it == boards_.end() ? nullptr : &it->second;
    }

    std::vector<std::string> buckets_for(const std::string& ticker) const {
        std::vector<std::string> out;
        const std::string prefix = ticker + "|";
        for (const auto& [k, v] : boards_) {
            if (k.starts_with(prefix)) out.push_back(v.expiration_bucket);
        }
        return out;
    }

    // "Current + Next N" aggregation (Part C.5): sums/reconciles exposure
    // across the requested buckets per strike rather than picking one bucket
    // and pretending it's the aggregate.
    HeatmapBoard aggregate(const std::string& ticker,
                            const std::vector<std::string>& buckets) const {
        HeatmapBoard combined;
        combined.ticker = ticker;
        combined.expiration_bucket =
            buckets.size() <= 1 ? "0dte" : ("0dte+" + std::to_string(buckets.size() - 1));

        std::map<double, double> strike_totals;
        double spot = 0.0;
        for (const auto& bucket : buckets) {
            const HeatmapBoard* b = get_board(ticker, bucket);
            if (!b) continue;
            spot = b->spot;
            for (const auto& n : b->nodes) {
                strike_totals[n.strike] += n.exposure;
            }
        }
        combined.spot = spot;
        for (auto& [strike, exposure] : strike_totals) {
            Node n;
            n.strike = strike;
            n.exposure = exposure;
            n.distance_from_spot = std::abs(strike - spot);
            combined.nodes.push_back(n);
        }
        return combined;
    }

private:
    static std::string key(const std::string& ticker, const std::string& bucket) {
        return ticker + "|" + bucket;
    }

    std::map<std::string, HeatmapBoard> boards_;
};

// ---------------------------------------------------------------------------
// Board computation from raw per-strike exposure (shared by all ticker
// boards — King Node, Gatekeeper, range, air pockets all derive from this
// one function so no UI surface can diverge in how it computes them).
// ---------------------------------------------------------------------------

struct BoardComputeConfig {
    FreshnessConfig freshness;
    double gatekeeper_min_fraction_of_king = 0.35;  // must clear this fraction of king magnitude
    double air_pocket_density_threshold = 0.02;     // fraction of king magnitude below which a
                                                      // strike gap counts as an air pocket
};

inline void compute_derived_state(HeatmapBoard& board, const BoardComputeConfig& cfg = {}) {
    std::ranges::sort(board.nodes, {}, &Node::strike);

    const Node* king_ptr = board.king_node();
    if (!king_ptr) return;
    double king_strike = king_ptr->strike;
    double king_abs = std::abs(king_ptr->exposure);

    // Hedge Node distance threshold (Part B.4: "sit farther away from
    // spot ... influence should scale down with distance"). Must be scaled
    // against the board's own strike SPAN, not the King-to-spot distance —
    // when King sits close to spot (the common case), using that tiny gap
    // as the yardstick falsely classifies nearly every other strike as a
    // "hedge node." Using the full board range fixes that.
    double board_span = board.nodes.empty() ? 0.0
                                              : (board.nodes.back().strike - board.nodes.front().strike);
    double hedge_distance_threshold = board_span * 0.35;

    for (auto& n : board.nodes) {
        n.distance_from_spot = std::abs(n.strike - board.spot);
        if (std::abs(n.exposure) == king_abs) {
            n.role = NodeRole::KingNode;
            continue;
        }
        bool between_spot_and_king = (n.strike > std::min(board.spot, king_strike) &&
                                       n.strike < std::max(board.spot, king_strike));
        bool material = std::abs(n.exposure) >= cfg.gatekeeper_min_fraction_of_king * king_abs;
        if (between_spot_and_king && material) {
            n.role = NodeRole::Gatekeeper;
        } else if (hedge_distance_threshold > 0 && n.distance_from_spot > hedge_distance_threshold &&
                   std::abs(n.exposure) >= cfg.gatekeeper_min_fraction_of_king * king_abs * 0.5) {
            // Also require some minimum magnitude — Part B.4 describes Hedge
            // Nodes as "large" positions, not merely "far away."
            n.role = NodeRole::HedgeNode;
        } else {
            n.role = NodeRole::Normal;
        }
    }

    if (!board.nodes.empty()) {
        board.range.lower = board.nodes.front().strike;
        board.range.upper = board.nodes.back().strike;
    }

    board.air_pockets.clear();
    for (std::size_t i = 0; i + 1 < board.nodes.size(); ++i) {
        const Node& a = board.nodes[i];
        const Node& b = board.nodes[i + 1];
        bool low_density = std::abs(a.exposure) < cfg.air_pocket_density_threshold * king_abs &&
                            std::abs(b.exposure) < cfg.air_pocket_density_threshold * king_abs;
        if (low_density && (b.strike - a.strike) > 0) {
            GammaContext ctx =
                (a.exposure + b.exposure) >= 0 ? GammaContext::Positive : GammaContext::Negative;
            board.air_pockets.push_back(AirPocket{a.strike, b.strike, ctx});
        }
    }
}

// ---------------------------------------------------------------------------
// Exposure-type filter (Part B.5 / C.3) — moved here from src/main.cpp so
// the Projections layer (projection_engine.hpp) and every route share ONE
// implementation instead of each carrying a copy.
//
// The synthetic source only generates one undifferentiated "exposure"
// series, so GEX and VEX views are derived (VEX modeled as a damped
// fraction of the same series) rather than backed by independently-modeled
// Greeks — flagged clearly so it's not mistaken for real vanna math.
// GEX+VEX sums both.
// ---------------------------------------------------------------------------

inline constexpr double kVexPlaceholderDamping = 0.4;

inline HeatmapBoard apply_exposure_type(HeatmapBoard board, ExposureType type) {
    if (type == ExposureType::GEX) return board;  // native series already "is" GEX here
    for (auto& n : board.nodes) {
        double vex_component = n.exposure * kVexPlaceholderDamping;
        if (type == ExposureType::VEX) {
            n.exposure = vex_component;
        } else {  // GEX_PLUS_VEX
            n.exposure = n.exposure + vex_component;
        }
    }
    compute_derived_state(board);
    return board;
}

inline ExposureType parse_exposure_type(const std::string& s) {
    if (s == "VEX") return ExposureType::VEX;
    if (s == "GEX+VEX" || s == "GEXVEX") return ExposureType::GEX_PLUS_VEX;
    return ExposureType::GEX;
}

// ---------------------------------------------------------------------------
// Multi-Greek selection (Expiry Data / Projections windows, Quadrinity).
//
// A request may select any subset of five Greek exposures; the board shown
// is the per-strike SUM of the selected series (same convention GEX+VEX
// already used). The synthetic source only generates one undifferentiated
// exposure series, so every non-GEX Greek is a deterministic PLACEHOLDER
// derived from it — stable per strike (no flicker between polls), distinct
// in shape per Greek, and scaling with the live series so it still moves
// as the feed does. These are NOT real vanna/charm/color/speed math; they
// exist so the whole selection/aggregation/velocity pipeline can be
// exercised end to end until the real per-Greek feed is wired in. Replace
// greek_series_value() with the real per-Greek per-strike exposure then —
// nothing else in the pipeline needs to change.
// ---------------------------------------------------------------------------

inline constexpr unsigned kGreekGEX = 1u;
inline constexpr unsigned kGreekVEX = 2u;
inline constexpr unsigned kGreekCHEX = 4u;    // charm exposure
inline constexpr unsigned kGreekCOLOR = 8u;
inline constexpr unsigned kGreekSPEED = 16u;

inline double greek_series_value(unsigned bit, double gex, double strike) {
    switch (bit) {
        case kGreekGEX: return gex;
        case kGreekVEX: return gex * kVexPlaceholderDamping;
        case kGreekCHEX: return gex * 0.35 * std::cos(strike * 0.37);
        case kGreekCOLOR: return gex * 0.22 * std::sin(strike * 0.53 + 1.1);
        case kGreekSPEED: return gex * 0.15 * std::cos(strike * 0.29 + 2.0);
    }
    return gex;
}

// Sum of the selected Greeks' series at one strike.
inline double greek_mask_value(unsigned mask, double gex, double strike) {
    double total = 0.0;
    for (unsigned bit : {kGreekGEX, kGreekVEX, kGreekCHEX, kGreekCOLOR, kGreekSPEED})
        if (mask & bit) total += greek_series_value(bit, gex, strike);
    return total;
}

// Accepts "GEX", "GEX+VEX" (legacy), "GEX,VEX,COLOR", "CHARM" (alias of
// CHEX), any case. Empty / unrecognised input falls back to GEX.
inline unsigned parse_greek_mask(const std::string& s) {
    unsigned mask = 0;
    std::string tok;
    auto flush = [&] {
        for (auto& c : tok) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        if (tok == "GEX") mask |= kGreekGEX;
        else if (tok == "VEX") mask |= kGreekVEX;
        else if (tok == "CHEX" || tok == "CHARM") mask |= kGreekCHEX;
        else if (tok == "COLOR") mask |= kGreekCOLOR;
        else if (tok == "SPEED") mask |= kGreekSPEED;
        else if (tok == "GEXVEX") mask |= (kGreekGEX | kGreekVEX);
        tok.clear();
    };
    for (char c : s) {
        if (c == ',' || c == '+' || c == ' ' || c == '_' || c == '|') flush();
        else tok.push_back(c);
    }
    flush();
    return mask ? mask : kGreekGEX;
}

inline std::string greek_mask_to_string(unsigned mask) {
    std::string out;
    auto add = [&](unsigned bit, const char* name) {
        if (!(mask & bit)) return;
        if (!out.empty()) out += "+";
        out += name;
    };
    add(kGreekGEX, "GEX");
    add(kGreekVEX, "VEX");
    add(kGreekCHEX, "CHEX");
    add(kGreekCOLOR, "COLOR");
    add(kGreekSPEED, "SPEED");
    return out.empty() ? "GEX" : out;
}

inline HeatmapBoard apply_greek_mask(HeatmapBoard board, unsigned mask) {
    if (mask == kGreekGEX) return board;  // native series already "is" GEX here
    for (auto& n : board.nodes) {
        const double before = n.exposure;
        n.exposure = greek_mask_value(mask, before, n.strike);
        if (std::abs(before) > 1e-12) n.rate_of_change *= n.exposure / before;
    }
    compute_derived_state(board);
    return board;
}

// Rolling floor/ceiling (Part B.4): compares dominant floor/ceiling strike
// across two snapshots and classifies migration direction. Computed from
// rate-of-change data, not hand-labeled.
inline RollDirection detect_floor_roll(double previous_floor_strike, double current_floor_strike) {
    return current_floor_strike > previous_floor_strike ? RollDirection::RollingFloorUp
                                                          : RollDirection::None;
}
inline RollDirection detect_ceiling_roll(double previous_ceiling_strike,
                                          double current_ceiling_strike) {
    return current_ceiling_strike < previous_ceiling_strike ? RollDirection::RollingCeilingDown
                                                              : RollDirection::None;
}

// ---------------------------------------------------------------------------
// Confluence computation (Part D.2/D.3, generalized to N tickers)
// ---------------------------------------------------------------------------

inline DirectionalRead read_for_board(const HeatmapBoard& board) {
    const Node* king = board.king_node();
    if (!king) return DirectionalRead::Neutral;
    // Simple, explicit rule (kept intentionally legible rather than clever):
    // King Node above spot with positive exposure => bullish pin/pull;
    // King Node below spot with positive exposure => bullish support;
    // negative-exposure King Node => bearish/accelerant read.
    if (king->exposure >= 0) return DirectionalRead::Bullish;
    return DirectionalRead::Bearish;
}

inline ConfluenceResult compute_confluence(const std::vector<HeatmapBoard>& boards) {
    ConfluenceResult result;
    result.total_count = static_cast<int>(boards.size());
    if (boards.empty()) return result;

    std::map<DirectionalRead, int> counts;
    std::map<DirectionalRead, std::vector<std::string>> members;
    for (const auto& b : boards) {
        DirectionalRead r = read_for_board(b);
        counts[r]++;
        members[r].push_back(b.ticker);
    }

    DirectionalRead majority = DirectionalRead::Neutral;
    int majority_count = 0;
    for (auto& [read, count] : counts) {
        if (count > majority_count) {
            majority_count = count;
            majority = read;
        }
    }

    result.majority_read = majority;
    result.aligned_count = majority_count;
    for (auto& [read, tickers] : members) {
        if (read != majority) {
            for (auto& t : tickers) result.outlier_tickers.push_back(t);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// SYNTHETIC data source (placeholder until a real market-data vendor is
// wired in — see file header note). Deterministic given a seed, so tests
// are repeatable; drifts spot and exposure slightly per call to simulate
// the Part E.3 "high-frequency live updates" / tick-by-tick price + >=1/min
// options refresh requirement without a real feed.
// ---------------------------------------------------------------------------

class SyntheticExposureSource {
public:
    explicit SyntheticExposureSource(std::uint64_t seed = 42) : rng_(seed) {}

    HeatmapBoard generate_board(const std::string& ticker, double base_spot, double strike_step,
                                 int strike_count, const std::string& expiration_bucket) {
        HeatmapBoard board;
        board.ticker = ticker;
        board.expiration_bucket = expiration_bucket;
        board.spot = base_spot;

        std::normal_distribution<double> exposure_dist(0.0, 1.0);
        std::uniform_int_distribution<int> offset_dist(-3, 3);
        double king_strike = base_spot + strike_step * offset_dist(rng_);

        for (int i = -strike_count / 2; i <= strike_count / 2; ++i) {
            double strike = base_spot + i * strike_step;
            double falloff =
                std::exp(-std::abs(strike - king_strike) / (strike_step * strike_count * 0.25));
            double sign = exposure_dist(rng_) >= 0 ? 1.0 : -1.0;
            double base_magnitude = 500'000.0 * falloff * (1.0 + std::abs(exposure_dist(rng_)));

            Node n;
            n.strike = strike;
            n.exposure = sign * base_magnitude;
            if (std::abs(strike - king_strike) < strike_step / 2.0) {
                // Force the intended King Node to actually be the largest —
                // keeps generated boards visually sensible for the demo.
                n.exposure = (n.exposure >= 0 ? 1 : -1) * base_magnitude * 6.0;
            }
            board.nodes.push_back(n);
        }

        compute_derived_state(board);
        return board;
    }

    // Simulates one live price tick (sub-second/per-second cadence driven by
    // the caller — see LiveFeedManager in src/main.cpp).
    void tick_price(HeatmapBoard& board, double max_step = 0.15) {
        std::uniform_real_distribution<double> step(-max_step, max_step);
        board.spot += step(rng_);
    }

    // Simulates one options/exposure refresh (>=1/min cadence — see
    // LiveFeedManager). Records rate_of_change per node as it goes, per
    // Part B.4's "first-class, queryable metric" requirement.
    void refresh_exposure(HeatmapBoard& board, double drift_fraction = 0.05) {
        std::uniform_real_distribution<double> drift(-drift_fraction, drift_fraction);
        for (auto& n : board.nodes) {
            double delta = n.exposure * drift(rng_);
            n.rate_of_change = delta;
            n.exposure += delta;
        }
        compute_derived_state(board);
    }

private:
    std::mt19937_64 rng_;
};

}  // namespace skylit::engine
