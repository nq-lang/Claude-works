// Skylit Heatseeker Terminal — Atlas Projections (Beta) engine.
//
// Spec: Atlas-Projections-Feature-Task.md. This header is a forward-
// extrapolation layer ON TOP of the shared exposure/node engine
// (exposure_engine.hpp) — Part IV.1. It owns no node, King-Node, freshness,
// or air-pocket logic of its own: boards come in already computed via
// compute_derived_state(), and exposure-type handling reuses
// apply_exposure_type() from the shared engine.
//
// REVISION (DTE selection, not a bars slider): per explicit correction,
// Projections is driven by an EXACT DTE pick (0DTE..5DTE) rather than a
// generic "how many bars ahead" window. Selecting "2DTE" pulls exactly
// that expiration bucket's board and draws ITS gamma walls — no blending
// across cohorts, because "the data respective to the DTE is what should
// be displayed", not a synthetic mix.
//
// REVISION (positioning, not a forecast cone): the earlier build widened
// the corridor with a placeholder daily-vol number (sigma * sqrt(time)),
// which reads as a probability forecast — exactly what this feature is
// NOT supposed to be. There is also no real IV feed to back that number.
// The corridor edges are now driven ENTIRELY by the selected DTE's real
// gamma-wall distances (compute_anchors(), same function the
// King/Gatekeeper/Hedge roles already use) — genuine positioning data,
// not a volatility model. Bars are flat (unchanging across the forward
// horizon) because this is current positioning projected forward, not a
// widening uncertainty cone; "developing" means the WHOLE corridor is
// recomputed on every poll as dealer exposure actually shifts, the same
// way Orbs update live.
//
// Milestone scope now covers Part III (timeframe -> bar clamping only;
// there is no cohort blending any more) and the four Part I visual
// outputs, driven by real wall data. NOT yet built: II.4 magnitude-
// density directional skew, air-pocket local widening, King-Node
// pull/re-anchoring, freshness weighting, OPEX/Hedge-Node confidence
// reduction, Derived exposure type.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <functional>
#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "skylit/exposure_engine.hpp"

namespace skylit::engine {

// Maps the toolbar's interval label to seconds. One place, so every route
// interpreting "interval=..." (candles, flow, projections) agrees.
inline std::int64_t interval_to_seconds(const std::string& interval) {
    if (interval == "1m") return 60;
    if (interval == "3m") return 180;
    if (interval == "5m") return 300;
    if (interval == "15m") return 900;
    if (interval == "1h") return 3600;
    if (interval == "4h") return 14400;
    if (interval == "1D") return 86400;
    return 300;  // default: 5m
}

inline constexpr int kMaxProjectionDte = 6;

// One row of the timeframe -> bar-geometry table (Part III). Only used
// now to CLAMP how many bars a given timeframe can actually draw forward
// (a 1m chart cannot show a 5DTE horizon in a sane number of bars) — no
// cohort blending happens here any more; a DTE pick is drawn from its own
// bucket's data only.
struct TimeframeProfile {
    std::string interval;
    std::int64_t bar_seconds = 300;
    int max_window_bars = 1;
};

struct ProjectionConfig {
    std::vector<TimeframeProfile> profiles;

    double session_seconds = 23400.0;  // 6.5h regular session
    int loaded_max_sessions = 50;      // furthest expiration the store holds

    double regime_band_pct = 2.0;          // strikes within +/-2% of spot define the gamma regime
    double regime_width_amplitude = 0.30;  // net-gamma sign scales the wall distance by up to +/-30%
    double min_node_fraction = 0.35;       // a node is "meaningful" above this fraction of the board max
    double skew_amplitude = 0.25;          // magnitude-density skew's max pull on each wall distance
    double king_pull_strength = 0.35;      // how far a wall is pulled toward a farther King Node (0=no pull, 1=snap to King)
    double air_pocket_widen_positive = 1.15;  // multiplier applied to a Positive-context air pocket's far edge
    double air_pocket_widen_negative = 1.45;  // multiplier applied to a Negative-context air pocket's far edge (sharper move)
    double freshness_loosen_amplitude = 0.40; // max loosening from a fully-decayed (heavily retested) wall
    double hedge_confidence_penalty = 0.70;   // confidence multiplier when the wall itself is a Hedge Node
    double opex_confidence_penalty = 0.60;    // confidence multiplier during OPEX week
    double confidence_widen_amplitude = 0.50; // max widening applied at zero confidence
    FreshnessConfig freshness;

    // Fallback share of gamma-vs-vanna hedging force by DTE, used only to
    // blend GEX vs VEX for the "GEX+VEX" exposure view (Part III.1 intent
    // — near-dated flow leans gamma, further-dated leans vanna). This is
    // NOT cohort blending: it only mixes two views of the SAME single
    // bucket the user picked.
    std::array<double, kMaxProjectionDte + 1> gex_share_by_dte{0.90, 0.80, 0.65, 0.50, 0.35, 0.20, 0.15};

    const TimeframeProfile* profile_for(const std::string& interval) const {
        for (const auto& p : profiles)
            if (p.interval == interval) return &p;
        return nullptr;
    }

    double bar_sessions(const TimeframeProfile& p) const {
        return p.bar_seconds >= 86400 ? static_cast<double>(p.bar_seconds) / 86400.0
                                       : static_cast<double>(p.bar_seconds) / session_seconds;
    }

    static ProjectionConfig defaults(int loaded_max_sessions) {
        ProjectionConfig c;
        c.loaded_max_sessions = loaded_max_sessions;
        auto mk = [](const char* iv, int max_bars) {
            TimeframeProfile p;
            p.interval = iv;
            p.bar_seconds = interval_to_seconds(iv);
            p.max_window_bars = max_bars;
            return p;
        };
        // max_window_bars: how far forward each timeframe can reasonably
        // draw a 0-5 DTE horizon (up to 6 sessions). A 1m chart clamps
        // hard; a 1D chart has ample room.
        c.profiles = {
            mk("1m", 120), mk("3m", 100), mk("5m", 78), mk("15m", 40),
            mk("1h", 40),  mk("4h", 40),  mk("1D", 30),
        };
        return c;
    }
};

// --- Part III: forward-bar clamping -----------------------------------------

struct BarClamp {
    int requested = 0;
    int effective = 1;
    int max = 1;
    bool clamped = false;
};

inline BarClamp clamp_bars(const TimeframeProfile& p, int requested_bars) {
    BarClamp w;
    w.requested = requested_bars;
    w.max = std::max(1, p.max_window_bars);
    w.effective = std::clamp(requested_bars, 1, w.max);
    w.clamped = w.effective != requested_bars;
    return w;
}

// --- Part III.2: CSV override (tunable without recompiling) -----------------
//
// Row format (header/comment lines start with '#'): interval,max_bars
struct CsvLoadResult {
    int applied = 0;
    std::vector<std::string> errors;
};

inline CsvLoadResult load_profiles_csv(const std::string& path, ProjectionConfig& cfg) {
    CsvLoadResult res;
    std::ifstream in(path);
    if (!in) {
        res.errors.push_back("cannot open " + path);
        return res;
    }
    std::string line;
    int line_no = 0;
    while (std::getline(in, line)) {
        ++line_no;
        auto first = line.find_first_not_of(" \t\r");
        if (first == std::string::npos || line[first] == '#') continue;
        std::vector<std::string> f;
        std::stringstream ss(line);
        std::string cell;
        while (std::getline(ss, cell, ',')) {
            auto a = cell.find_first_not_of(" \t\r");
            auto b = cell.find_last_not_of(" \t\r");
            f.push_back(a == std::string::npos ? "" : cell.substr(a, b - a + 1));
        }
        auto fail = [&](const std::string& why) {
            res.errors.push_back("line " + std::to_string(line_no) + ": " + why);
        };
        if (f.size() < 2) { fail("expected at least 2 fields (interval,max_bars), got " + std::to_string(f.size())); continue; }
        static const std::vector<std::string> kKnown = {"1m", "3m", "5m", "15m", "1h", "4h", "1D"};
        if (std::find(kKnown.begin(), kKnown.end(), f[0]) == kKnown.end()) {
            fail("unknown interval '" + f[0] + "'");
            continue;
        }
        try {
            TimeframeProfile p;
            p.interval = f[0];
            p.bar_seconds = interval_to_seconds(f[0]);
            p.max_window_bars = std::stoi(f[1]);
            if (p.max_window_bars < 1) { fail("max_bars must be >= 1"); continue; }
            bool replaced = false;
            for (auto& existing : cfg.profiles) {
                if (existing.interval == p.interval) { existing = p; replaced = true; break; }
            }
            if (!replaced) cfg.profiles.push_back(p);
            ++res.applied;
        } catch (...) {
            fail("non-numeric value");
        }
    }
    return res;
}

// --- Gravity map (Part II.1 step 1) -----------------------------------------

struct SideAnchor {
    bool valid = false;
    double distance = 0.0;  // always >= 0, price units away from spot
    double strike = 0.0;
    NodeRole role = NodeRole::Normal;  // role of the chosen wall node (Part B.4 roles, reused as-is)
    int touch_count = 0;               // for freshness weighting (Part B.4 decay model, reused as-is)
};

struct CohortAnchors {
    SideAnchor up;
    SideAnchor down;
    double regime_score = 0.0;  // net/gross signed exposure near spot, in [-1, 1]
};

// Nearest MEANINGFUL node on each side of spot, by |exposure| ("magnitude
// over sign"). A node is meaningful if it clears min_node_fraction of the
// board's strongest node; if nothing on a side clears that bar, the
// strongest node on that side is used. Nodes come from the shared engine —
// this only reads them.
inline CohortAnchors compute_anchors(const HeatmapBoard& b, const ProjectionConfig& cfg) {
    CohortAnchors out;
    double max_abs = 0.0;
    for (const auto& n : b.nodes) max_abs = std::max(max_abs, std::abs(n.exposure));
    if (max_abs <= 0.0) return out;
    const double bar = cfg.min_node_fraction * max_abs;

    auto pick = [&](bool above) {
        const Node* nearest_meaningful = nullptr;
        const Node* strongest = nullptr;
        for (const auto& n : b.nodes) {
            bool side = above ? (n.strike > b.spot) : (n.strike < b.spot);
            if (!side) continue;
            if (!strongest || std::abs(n.exposure) > std::abs(strongest->exposure)) strongest = &n;
            if (std::abs(n.exposure) >= bar) {
                double d = std::abs(n.strike - b.spot);
                if (!nearest_meaningful || d < std::abs(nearest_meaningful->strike - b.spot))
                    nearest_meaningful = &n;
            }
        }
        const Node* chosen = nearest_meaningful ? nearest_meaningful : strongest;
        SideAnchor a;
        if (chosen) {
            a.valid = true;
            a.strike = chosen->strike;
            a.distance = std::abs(chosen->strike - b.spot);
            a.role = chosen->role;
            a.touch_count = chosen->touch_count;
        }
        return a;
    };
    out.up = pick(true);
    out.down = pick(false);

    double net = 0.0, gross = 0.0;
    const double band = cfg.regime_band_pct / 100.0 * b.spot;
    for (const auto& n : b.nodes) {
        if (std::abs(n.strike - b.spot) <= band) {
            net += n.exposure;
            gross += std::abs(n.exposure);
        }
    }
    out.regime_score = gross > 0.0 ? net / gross : 0.0;
    return out;
}

// --- Magnitude-density directional skew (Part II.4) -------------------------
//
// compute_anchors() finds the single nearest MEANINGFUL node per side —
// good for "where is the wall", blind to how much OTHER exposure sits
// behind it. Two boards can have the same nearest wall on each side but
// very different depth of positioning behind those walls; this measures
// that depth and turns it into a signed pull so the corridor leans toward
// the side actually backed by more dealer exposure, not just whichever
// side's nearest single node happens to be picked.
//
// Both sides are measured over the SAME symmetric band radius (rather
// than each side's own, possibly very different, wall distance) — using
// each side's own wall distance as its measurement window would silently
// favor whichever side's wall happens to sit further out, since a wider
// window naturally sums more nodes regardless of true concentration.
struct DensitySkew {
    double skew = 0.0;         // signed, in [-1, 1]; positive = upside-heavier
    double up_density = 0.0;   // sum |exposure| for strikes within band_radius above spot
    double down_density = 0.0; // same, below spot
};

inline DensitySkew compute_density_skew(const HeatmapBoard& b, double band_radius) {
    DensitySkew out;
    const double up_bound = b.spot + std::max(band_radius, 0.0);
    const double down_bound = b.spot - std::max(band_radius, 0.0);
    for (const auto& n : b.nodes) {
        if (n.strike > b.spot && n.strike <= up_bound) out.up_density += std::abs(n.exposure);
        else if (n.strike < b.spot && n.strike >= down_bound) out.down_density += std::abs(n.exposure);
    }
    const double total = out.up_density + out.down_density;
    out.skew = total > 0.0 ? (out.up_density - out.down_density) / total : 0.0;
    return out;
}



struct ProjectionRequest {
    std::string ticker;
    std::string interval = "5m";
    ExposureType exposure = ExposureType::GEX;
    int dte = 0;  // 0..kMaxProjectionDte — the EXACT expiration bucket to project
    // Non-zero = a multi-Greek selection (GEX/VEX/CHEX/COLOR/SPEED bitmask,
    // see exposure_engine.hpp) that overrides `exposure`: the selected
    // Greeks are summed into ONE combined lens. 0 keeps the legacy
    // GEX / VEX / GEX+VEX behavior (and its per-DTE gamma/vanna blend).
    unsigned greek_mask = 0;
};

struct ProjectionBar {
    int k = 0;
    bool supported = true;  // backed by loaded expiration data
    double upper = 0.0;      // absolute price
    double lower = 0.0;      // absolute price
    double mid = 0.0;        // corridor midline = developing path
    double upper_pct = 0.0;  // % from spot (positive)
    double lower_pct = 0.0;  // % from spot (negative)
};

struct ProjectionResult {
    bool ok = false;
    std::string error;

    std::string ticker;
    ExposureType exposure = ExposureType::GEX;
    int dte = 0;
    std::string bucket_name;  // "0dte", "next1", ... — which data this came from
    std::string exposure_label;  // what was actually projected: "GEX", "GEX+VEX", "GEX+COLOR", ...

    TimeframeProfile profile;
    BarClamp horizon;
    double bar_sessions = 0.0;

    double spot = 0.0;
    double zone_half_thickness = 0.0;
    double gex_share = 1.0;
    double regime_score = 0.0;
    double regime_factor = 1.0;
    bool up_wall_found = false;
    bool down_wall_found = false;
    double up_wall_strike = 0.0;
    double down_wall_strike = 0.0;
    double density_skew = 0.0;   // signed, [-1,1]; positive = upside-heavier magnitude density
    double up_density = 0.0;
    double down_density = 0.0;
    double confidence = 1.0;     // [0,1]; reduced by Hedge-Node walls and OPEX week

    std::vector<ProjectionBar> bars;
};

// Provider of an aggregated board over an inclusive bucket-index range
// (0 = "0dte", N = "nextN"). Implemented by LiveFeedManager; injected so
// this header stays independent of the feed/threading layer.
using CohortBoardProvider = std::function<std::optional<HeatmapBoard>(int first, int last)>;

inline ProjectionResult build_projection(const ProjectionRequest& req, const ProjectionConfig& cfg,
                                          const CohortBoardProvider& provider) {
    ProjectionResult r;
    r.ticker = req.ticker;
    r.exposure = req.exposure;
    r.dte = std::clamp(req.dte, 0, kMaxProjectionDte);
    r.bucket_name = r.dte == 0 ? "0dte" : "next" + std::to_string(r.dte);

    const TimeframeProfile* prof = cfg.profile_for(req.interval);
    if (!prof) {
        r.error = "unknown interval";
        return r;
    }
    r.profile = *prof;
    r.bar_sessions = cfg.bar_sessions(*prof);

    // Horizon: project through the END of the picked DTE (dte=0 -> through
    // today's remaining session, dte=5 -> through 6 sessions out), clamped
    // to how many bars this timeframe can actually draw (Part III).
    const double horizon_sessions = r.dte + 1.0;
    const int requested_bars = std::max(1, static_cast<int>(std::ceil(horizon_sessions / r.bar_sessions)));
    r.horizon = clamp_bars(*prof, requested_bars);

    auto board = provider(r.dte, r.dte);
    if (!board || board->nodes.size() < 2) {
        r.error = "no exposure data available for " + r.bucket_name;
        return r;
    }
    r.spot = board->spot;
    const double strike_gap = board->nodes.size() > 1 ? board->nodes[1].strike - board->nodes[0].strike : 0.0;
    r.zone_half_thickness = std::max(0.0, strike_gap) * 0.5;

    // Custom multi-Greek selection: ONE combined lens (sum of the selected
    // Greeks). Its gamma share is 1 only when GEX is part of the mix, so
    // the gamma-sign regime width scaling applies exactly when gamma does
    // (same rule pure-VEX already follows: no gamma, no regime scaling).
    const bool custom = req.greek_mask != 0;
    const bool need_gex = custom ? true : req.exposure != ExposureType::VEX;
    const bool need_vex = custom ? false : req.exposure != ExposureType::GEX;
    r.gex_share = custom ? ((req.greek_mask & kGreekGEX) ? 1.0 : 0.0)
                  : req.exposure == ExposureType::GEX   ? 1.0
                  : req.exposure == ExposureType::VEX ? 0.0
                                                       : cfg.gex_share_by_dte[static_cast<std::size_t>(r.dte)];  // r.dte clamped to 0..kMaxProjectionDte above
    r.exposure_label = custom ? greek_mask_to_string(req.greek_mask) : to_string(req.exposure);

    // Config knobs for the four remaining Part II/B.4 behaviors below are
    // pulled in via cfg (added to ProjectionConfig further up this file).

    HeatmapBoard gex_board, vex_board;
    CohortAnchors gex_anchor, vex_anchor;
    if (need_gex) {
        gex_board = custom ? apply_greek_mask(*board, req.greek_mask)
                           : apply_exposure_type(*board, ExposureType::GEX);
        gex_anchor = compute_anchors(gex_board, cfg);
    }
    if (need_vex) { vex_board = apply_exposure_type(*board, ExposureType::VEX); vex_anchor = compute_anchors(vex_board, cfg); }

    auto blend_side = [&](const SideAnchor& g, const SideAnchor& v) -> std::optional<double> {
        double num = 0, den = 0;
        if (need_gex && g.valid) { num += r.gex_share * g.distance; den += r.gex_share; }
        if (need_vex && v.valid) { num += (1.0 - r.gex_share) * v.distance; den += (1.0 - r.gex_share); }
        if (den <= 0.0) return std::nullopt;
        return num / den;
    };
    auto up_d = blend_side(gex_anchor.up, vex_anchor.up);
    auto dn_d = blend_side(gex_anchor.down, vex_anchor.down);
    r.up_wall_found = up_d.has_value();
    r.down_wall_found = dn_d.has_value();
    if (r.up_wall_found) r.up_wall_strike = r.spot + *up_d;
    if (r.down_wall_found) r.down_wall_strike = r.spot - *dn_d;

    // King-pull, air-pocket widening, freshness and OPEX/Hedge confidence
    // below all read STRUCTURE (which strike is King, where the air
    // pockets sit, which role/touch-count the wall node carries) from
    // whichever lens carries the majority share for this dte/exposure
    // pick — the raw wall DISTANCE above is still a true blend of both
    // lenses; only these secondary adjustments use a single "dominant
    // lens" board to stay tractable.
    const HeatmapBoard& primary_board = r.gex_share >= 0.5 ? (need_gex ? gex_board : vex_board)
                                                            : (need_vex ? vex_board : gex_board);
    const CohortAnchors& primary_anchor = r.gex_share >= 0.5 ? (need_gex ? gex_anchor : vex_anchor)
                                                              : (need_vex ? vex_anchor : gex_anchor);

    // No wall on a side (rare — a completely flat board): fall back to a
    // generic buffer rather than leaving that side unconstrained/absent,
    // so the corridor always closes.
    const double fallback = std::max(r.zone_half_thickness * 10.0, r.spot * 0.005);
    double up_dist = up_d.value_or(fallback);
    double dn_dist = dn_d.value_or(fallback);

    // --- King-Node pull / re-anchoring -------------------------------------
    // The nearest-MEANINGFUL-node rule (compute_anchors) can pick a wall
    // that is close but modest while the board's single largest position
    // (the King Node — same role the heatmap itself surfaces) sits further
    // out on the same side. Real dealer hedging pressure concentrates at
    // the King strike more than at a merely-adequate nearer one, so that
    // side's distance is pulled PART WAY toward the King's distance
    // (never snapped fully — this is a pull, not a replacement) whenever
    // the King sits on that side and is farther than the picked wall.
    if (const Node* king = primary_board.king_node()) {
        const double king_dist = std::abs(king->strike - r.spot);
        if (king->strike > r.spot && king_dist > up_dist) {
            up_dist += cfg.king_pull_strength * (king_dist - up_dist);
        } else if (king->strike < r.spot && king_dist > dn_dist) {
            dn_dist += cfg.king_pull_strength * (king_dist - dn_dist);
        }
    }

    // --- Air-pocket local widening ------------------------------------------
    // An air pocket (a run of strikes with negligible exposure — see
    // compute_derived_state) between spot and the picked wall means price
    // can slip through that stretch with little dealer resistance before
    // hitting anything real. The wall distance is pushed out to the far
    // edge of the pocket (plus a small buffer) so the corridor reflects
    // where resistance genuinely resumes, not the nearer edge of the gap;
    // a Negative-context pocket (net short gamma inside it) widens
    // further than a Positive one, per the same context AirPocket already
    // carries for the heatmap's own display.
    auto widen_through_pockets = [&](double dist, bool above) {
        double widened = dist;
        for (const auto& pocket : primary_board.air_pockets) {
            bool between = above ? (pocket.low_strike >= r.spot && pocket.high_strike <= r.spot + dist)
                                  : (pocket.high_strike <= r.spot && pocket.low_strike >= r.spot - dist);
            if (!between) continue;
            double far_edge_dist = above ? (pocket.high_strike - r.spot) : (r.spot - pocket.low_strike);
            double mult = pocket.context == GammaContext::Negative ? cfg.air_pocket_widen_negative
                                                                    : cfg.air_pocket_widen_positive;
            widened = std::max(widened, far_edge_dist * mult);
        }
        return widened;
    };
    up_dist = widen_through_pockets(up_dist, true);
    dn_dist = widen_through_pockets(dn_dist, false);

    // --- Freshness weighting -------------------------------------------------
    // A wall built on a strike that has been retested many times is
    // "used up" relative to a fresh, untouched one (Part B.4's decay
    // model — reused as-is via decay_weight_for_touches, not
    // re-implemented here). A heavily-decayed wall loosens outward
    // rather than holding as tightly as a fresh one.
    auto loosen_for_freshness = [&](double dist, const SideAnchor& a) {
        if (!a.valid) return dist;
        double w = decay_weight_for_touches(a.touch_count, cfg.freshness);
        return dist * (1.0 + (1.0 - w) * cfg.freshness_loosen_amplitude);
    };
    up_dist = loosen_for_freshness(up_dist, primary_anchor.up);
    dn_dist = loosen_for_freshness(dn_dist, primary_anchor.down);

    // Magnitude-density skew (Part II.4): computed per exposure lens (GEX
    // and/or VEX) over a SYMMETRIC band (the wider of that lens's own two
    // wall distances, so neither side's window is arbitrarily narrower
    // than the other's — see compute_density_skew's header comment),
    // then blended the same way the anchors themselves were blended.
    double skew = 0.0, up_density = 0.0, down_density = 0.0;
    {
        double num = 0, den = 0;
        if (need_gex) {
            const double band = std::max(gex_anchor.up.valid ? gex_anchor.up.distance : up_dist,
                                          gex_anchor.down.valid ? gex_anchor.down.distance : dn_dist);
            auto s = compute_density_skew(gex_board, band);
            num += r.gex_share * s.skew; den += r.gex_share;
            up_density += s.up_density; down_density += s.down_density;
        }
        if (need_vex) {
            const double band = std::max(vex_anchor.up.valid ? vex_anchor.up.distance : up_dist,
                                          vex_anchor.down.valid ? vex_anchor.down.distance : dn_dist);
            auto s = compute_density_skew(vex_board, band);
            num += (1.0 - r.gex_share) * s.skew; den += (1.0 - r.gex_share);
            up_density += s.up_density; down_density += s.down_density;
        }
        skew = den > 0.0 ? num / den : 0.0;
    }
    r.density_skew = skew;
    r.up_density = up_density;
    r.down_density = down_density;

    // Positive skew (more magnitude backing the upside wall) pulls the
    // corridor toward that side: the heavier wall tightens (stronger
    // magnet, price held closer to it) and the lighter side loosens
    // (less resistance, more room to run) — both scaled by
    // skew_amplitude so a maximal 1.0 skew can move a wall by at most
    // that fraction of its own distance.
    up_dist = std::max(up_dist * (1.0 - skew * cfg.skew_amplitude), r.zone_half_thickness);
    dn_dist = std::max(dn_dist * (1.0 + skew * cfg.skew_amplitude), r.zone_half_thickness);

    // --- OPEX week / Hedge-Node confidence reduction --------------------------
    // Confidence starts at 1.0 and is reduced (never increased) by two
    // independent signals already tracked elsewhere in the engine: (a)
    // the picked wall itself being a Hedge Node — Part B.4 describes
    // these as large-but-distant positions with influence that "should
    // scale down with distance", i.e. a weaker anchor than a King or
    // Gatekeeper to begin with; (b) the board being in OPEX week
    // (board.opex_week, Part B.4's existing calendar check), when
    // existing positions are actively unwinding/rolling and near-term
    // walls are least reliable. Lower confidence widens the corridor
    // rather than silently keeping a falsely-tight one.
    double confidence = 1.0;
    if (primary_anchor.up.valid && primary_anchor.up.role == NodeRole::HedgeNode) confidence *= cfg.hedge_confidence_penalty;
    if (primary_anchor.down.valid && primary_anchor.down.role == NodeRole::HedgeNode) confidence *= cfg.hedge_confidence_penalty;
    if (board->opex_week) confidence *= cfg.opex_confidence_penalty;
    r.confidence = confidence;
    const double confidence_widen = 1.0 + (1.0 - confidence) * cfg.confidence_widen_amplitude;
    up_dist *= confidence_widen;
    dn_dist *= confidence_widen;

    r.regime_score = need_gex ? gex_anchor.regime_score : 0.0;
    // Positive net gamma pulls price toward the walls (narrows the
    // corridor); negative net gamma (dealers short gamma) tends to
    // amplify moves toward them (widens it). Only the gamma share of the
    // mix carries this effect — pure VEX carries none.
    r.regime_factor = 1.0 - r.gex_share * cfg.regime_width_amplitude * r.regime_score;

    const double upper = r.spot + up_dist * r.regime_factor;
    const double lower = r.spot - dn_dist * r.regime_factor;
    const double mid = 0.5 * (upper + lower);

    // "Developing, not forecast": the corridor is the CURRENT wall levels
    // held flat across the forward horizon (recomputed live on every
    // poll) — not a widening statistical cone.
    for (int k = 1; k <= r.horizon.effective; ++k) {
        ProjectionBar b;
        b.k = k;
        b.supported = true;  // a single real DTE bucket is either present (handled above) or the whole request fails
        b.upper = upper;
        b.lower = lower;
        b.mid = mid;
        b.upper_pct = (upper - r.spot) / r.spot * 100.0;
        b.lower_pct = (lower - r.spot) / r.spot * 100.0;
        r.bars.push_back(b);
    }

    r.ok = true;
    return r;
}

}  // namespace skylit::engine
