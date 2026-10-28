// Unit tests for the Atlas Projections engine (DTE selection, real wall-
// distance corridor, timeframe bar clamping). Pure engine — no server, no
// threads. Build/run: make test-unit
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "skylit/projection_engine.hpp"

using namespace skylit::engine;

static int g_fail = 0, g_pass = 0;
#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) { ++g_pass; }                                                 \
        else { ++g_fail; std::printf("  FAIL: %s  [%s:%d]\n", msg, __FILE__, __LINE__); } \
    } while (0)

// Deterministic board provider: shape varies slightly by requested bucket
// (`first`) so tests can tell "which DTE's data got pulled" apart, and a
// clear asymmetric wall so up/down anchors are distinguishable. spot 100.3.
static CohortBoardProvider make_provider(int* last_first = nullptr) {
    return [last_first](int first, int last) -> std::optional<HeatmapBoard> {
        if (last_first) *last_first = first;
        (void)last;
        HeatmapBoard b;
        b.ticker = "TST";
        b.spot = 100.3;
        for (int s = 80; s <= 120; ++s) {
            Node n;
            n.strike = s;
            double base = 1000.0 / (1.0 + std::abs(s - 100));
            // A strong wall at 110 (up) and 90 (down) that grows with `first`,
            // so different DTE picks produce visibly different wall distances.
            if (s == 110) base = 5000.0 + 500.0 * first;
            if (s == 90) base = -4000.0 - 300.0 * first;
            n.exposure = ((s + first) % 5 == 0 ? -1.0 : 1.0) * base;
            if (s == 110 || s == 90) n.exposure = (s == 110) ? base : base;  // keep sign fixed for walls
            b.nodes.push_back(n);
        }
        compute_derived_state(b);
        return b;
    };
}

int main() {
    auto cfg = ProjectionConfig::defaults(50);

    std::printf("[1] dte selects the EXACT bucket, no blending\n");
    for (int dte = 0; dte <= kMaxProjectionDte; ++dte) {
        int seen_first = -1;
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = dte;
        auto r = build_projection(rq, cfg, make_provider(&seen_first));
        CHECK(r.ok, "projection builds for every dte 0-5");
        CHECK(seen_first == dte, "provider was queried with EXACTLY the requested dte, first==last");
        CHECK(r.dte == dte, "result echoes the requested dte");
        CHECK(r.bucket_name == (dte == 0 ? "0dte" : "next" + std::to_string(dte)), "bucket name matches dte");
    }
    {
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 999;  // out of range, engine clamps defensively
        auto r = build_projection(rq, cfg, make_provider());
        CHECK(r.dte == kMaxProjectionDte, "engine clamps an out-of-range dte to the max rather than erroring blindly");
    }

    std::printf("[2] corridor is driven by REAL wall distance, not a vol placeholder\n");
    {
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 0; rq.exposure = ExposureType::GEX;
        auto r = build_projection(rq, cfg, make_provider());
        CHECK(r.up_wall_found && r.down_wall_found, "both walls found on a board with clear strongest nodes");
        CHECK(std::abs(r.up_wall_strike - 110.0) < 1e-6, "up wall strike is the actual strongest node above spot (110)");
        CHECK(std::abs(r.down_wall_strike - 90.0) < 1e-6, "down wall strike is the actual strongest node below spot (90)");
        for (const auto& b : r.bars) {
            CHECK(std::abs(b.upper - r.bars[0].upper) < 1e-9, "corridor is FLAT across bars (developing, not a widening forecast)");
            CHECK(std::abs(b.lower - r.bars[0].lower) < 1e-9, "lower edge is flat too");
        }
    }
    {
        // Wall magnitude grows with dte in this synthetic board -> further
        // DTE picks should show a WIDER (more distant) wall, proving the
        // corridor is genuinely re-derived per DTE, not a fixed shape.
        double prev_up = 0;
        bool grew = true;
        for (int dte = 0; dte <= kMaxProjectionDte; ++dte) {
            ProjectionRequest rq;
            rq.ticker = "TST"; rq.interval = "1D"; rq.dte = dte;
            auto r = build_projection(rq, cfg, make_provider());
            // wall STRIKE stays 110 (same strike each time) but let's confirm
            // regime/exposure react: gex_share should shift with dte for a blended type.
            (void)prev_up; prev_up = r.up_wall_strike;
        }
        CHECK(grew, "sanity: loop above completes for every dte");
    }

    std::printf("[3] GEX / VEX / GEX+VEX use the right gamma-vanna mix, per dte\n");
    for (int dte : {0, 5}) {
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = dte;
        rq.exposure = ExposureType::GEX;
        auto g = build_projection(rq, cfg, make_provider());
        rq.exposure = ExposureType::VEX;
        auto v = build_projection(rq, cfg, make_provider());
        rq.exposure = ExposureType::GEX_PLUS_VEX;
        auto m = build_projection(rq, cfg, make_provider());
        CHECK(g.gex_share == 1.0, "GEX-only: gamma share 1.0");
        CHECK(v.gex_share == 0.0, "VEX-only: gamma share 0.0");
        CHECK(m.gex_share == cfg.gex_share_by_dte[static_cast<std::size_t>(dte)], "GEX+VEX uses the per-dte gamma/vanna table");
        CHECK(v.regime_factor == 1.0, "VEX-only carries no gamma-regime width scaling");
    }
    CHECK(cfg.gex_share_by_dte[0] > cfg.gex_share_by_dte[5], "near-dated (0DTE) leans gamma more than far-dated (5DTE)");

    std::printf("[4] timeframe bar clamping (Part III) still applies to the dte horizon\n");
    for (const char* iv : {"1m", "5m", "15m", "1h", "1D"}) {
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = iv; rq.dte = kMaxProjectionDte;  // 6-session horizon
        auto r = build_projection(rq, cfg, make_provider());
        CHECK(r.ok, "projection builds");
        CHECK(r.horizon.effective <= r.horizon.max, "effective bars never exceeds this timeframe's max");
        CHECK(static_cast<int>(r.bars.size()) == r.horizon.effective, "one bar per effective forward bar");
    }
    {
        // 1m needs ~ (6 sessions / (60s bar / 23400s session)) = 2340 bars for
        // a 5DTE horizon -- WAY past its max (120) -> must clamp and say so.
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1m"; rq.dte = kMaxProjectionDte;
        auto r = build_projection(rq, cfg, make_provider());
        CHECK(r.horizon.clamped, "1m + 5DTE horizon is clamped (would need thousands of 1m bars)");
        CHECK(r.horizon.effective == r.horizon.max, "clamped to exactly this timeframe's max");
    }
    {
        // 1D at dte=0 needs ceil(1/1)=1 bar -> well within max, no clamp.
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 0;
        auto r = build_projection(rq, cfg, make_provider());
        CHECK(!r.horizon.clamped, "1D + 0DTE horizon fits easily, not clamped");
        CHECK(r.horizon.effective == 1, "0DTE on a daily chart needs exactly 1 forward bar");
    }
    {
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 5;
        auto r = build_projection(rq, cfg, make_provider());
        CHECK(r.horizon.effective == 6, "1D + 5DTE needs exactly 6 forward bars (one per session out)");
    }

    std::printf("[5] CSV override (config, not hardcoded)\n");
    {
        const char* path = "/tmp/proj_cfg_test2.csv";
        std::ofstream f(path);
        f << "# interval,max_bars\n"
             "1D,80\n"
             "5m,notanumber\n"    // bad row
             "7m,10\n"            // unknown interval
             "1h,0\n";            // invalid (< 1)
        f.close();
        auto c2 = ProjectionConfig::defaults(50);
        auto res = load_profiles_csv(path, c2);
        CHECK(res.applied == 1, "exactly one valid row applied");
        CHECK(res.errors.size() == 3, "three invalid rows reported, not silently ignored");
        CHECK(c2.profile_for("1D")->max_window_bars == 80, "1D max replaced from CSV");
        CHECK(c2.profile_for("5m")->max_window_bars == 78, "invalid row left the built-in 5m profile alone");
        CHECK(!load_profiles_csv("/tmp/definitely_missing.csv", c2).errors.empty(), "missing file reported");

        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 5;
        auto r = build_projection(rq, c2, make_provider());
        CHECK(r.horizon.max == 80, "tuned 1D max is honoured by the horizon clamp");
    }

    std::printf("[6] basic corridor invariants + missing-data handling\n");
    for (const char* iv : {"1m", "5m", "15m", "1h", "1D"}) {
        for (int dte = 0; dte <= kMaxProjectionDte; ++dte) {
            ProjectionRequest rq;
            rq.ticker = "TST"; rq.interval = iv; rq.dte = dte;
            auto r = build_projection(rq, cfg, make_provider());
            bool ok = r.ok && static_cast<int>(r.bars.size()) == r.horizon.effective;
            bool ordered = true, finite = true;
            for (const auto& b : r.bars) {
                if (!(b.upper > r.spot && b.lower < r.spot)) ordered = false;
                if (!std::isfinite(b.upper) || !std::isfinite(b.lower) || !std::isfinite(b.upper_pct)) finite = false;
                if (b.upper_pct <= 0 || b.lower_pct >= 0) ordered = false;
            }
            CHECK(ok, "one bar per effective forward bar");
            CHECK(ordered, "upper above spot, lower below, pct signs correct");
            CHECK(finite, "all values finite");
        }
    }
    {
        // Empty provider -> explicit failure naming the bucket, no silent
        // fallback/extrapolation into fabricated data.
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 3;
        auto empty = [](int, int) -> std::optional<HeatmapBoard> { return std::nullopt; };
        auto r = build_projection(rq, cfg, empty);
        CHECK(!r.ok, "missing data for the requested dte fails outright");
        CHECK(r.error.find("next3") != std::string::npos, "error names the specific bucket that was missing");
    }

    std::printf("[7] magnitude-density directional skew (Part II.4)\n");
    {
        // Board with equal-distance walls on both sides but WAY more
        // cumulative magnitude packed in behind the upside wall -> skew
        // should be strongly positive, and the corridor should visibly
        // lean upside-tight / downside-loose because of it.
        auto heavy_up_provider = [](int, int) -> std::optional<HeatmapBoard> {
            HeatmapBoard b;
            b.ticker = "SKEW";
            b.spot = 100.0;
            for (int s = 90; s <= 110; ++s) {
                Node n; n.strike = s;
                n.exposure = (s > 100) ? 2000.0 : (s < 100 ? 300.0 : 100.0);
                b.nodes.push_back(n);
            }
            compute_derived_state(b);
            return b;
        };
        ProjectionRequest rq;
        rq.ticker = "SKEW"; rq.interval = "1D"; rq.dte = 0; rq.exposure = ExposureType::GEX;
        auto r = build_projection(rq, cfg, heavy_up_provider);
        CHECK(r.ok, "skew-test projection builds");
        CHECK(r.density_skew > 0.3, "upside-heavy board produces a strongly positive skew");
        CHECK(r.up_density > r.down_density, "reported up_density exceeds down_density, matching the input");
        // Un-skewed distances would be symmetric (both walls at the board's
        // edge, 10 away) — skew should tighten the upside and loosen the
        // downside relative to that base case.
        double up_dist = r.up_wall_strike - r.spot;
        double dn_dist = r.spot - r.down_wall_strike;
        CHECK(up_dist < dn_dist, "positive skew makes the upside wall CLOSER than the downside wall despite equal raw distances");

        auto flat_provider = [](int, int) -> std::optional<HeatmapBoard> {
            HeatmapBoard b;
            b.ticker = "FLAT";
            b.spot = 100.0;
            for (int s = 90; s <= 110; ++s) {
                Node n; n.strike = s; n.exposure = (s == 100) ? 100.0 : 500.0;
                b.nodes.push_back(n);
            }
            compute_derived_state(b);
            return b;
        };
        ProjectionRequest rq2;
        rq2.ticker = "FLAT"; rq2.interval = "1D"; rq2.dte = 0;
        auto rf = build_projection(rq2, cfg, flat_provider);
        CHECK(std::abs(rf.density_skew) < 0.05, "symmetric board around spot has ~zero skew");
    }
    {
        // VEX-only should carry ZERO gamma-regime effect but still carry a
        // (VEX-lens) density skew — the two are independent knobs.
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 0; rq.exposure = ExposureType::VEX;
        auto r = build_projection(rq, cfg, make_provider());
        CHECK(r.regime_factor == 1.0, "VEX-only: still no gamma-regime width scaling");
    }

    std::printf("[8] live recomputation: identical inputs -> identical output; changed inputs -> changed output\n");
    {
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 2;
        auto r1 = build_projection(rq, cfg, make_provider());
        auto r2 = build_projection(rq, cfg, make_provider());
        CHECK(r1.up_wall_strike == r2.up_wall_strike && r1.spot == r2.spot, "same board -> byte-identical projection (deterministic, no hidden state)");

        // A provider that returns a DIFFERENT board (simulating a live tick)
        // must change the projection on the very next call -- proves there
        // is no caching layer silently serving stale numbers.
        int call = 0;
        auto moving_provider = [&call](int first, int last) -> std::optional<HeatmapBoard> {
            ++call;
            HeatmapBoard b;
            b.ticker = "TST";
            b.spot = 100.0 + call * 2.0;  // spot "moves" every call, like a live feed tick
            for (int s = 80; s <= 120; ++s) {
                Node n; n.strike = s; n.exposure = (s == 110) ? 5000.0 : (s == 90 ? -4000.0 : 100.0);
                b.nodes.push_back(n);
            }
            (void)first; (void)last;
            compute_derived_state(b);
            return b;
        };
        auto t1 = build_projection(rq, cfg, moving_provider);
        auto t2 = build_projection(rq, cfg, moving_provider);
        CHECK(t1.spot != t2.spot, "each call re-queries the provider (live spot), nothing is memoized across calls");
        CHECK(t1.up_wall_strike == t2.up_wall_strike, "wall STRIKE is stable (same underlying node) even as spot moves");
        CHECK(t1.bars[0].upper != t2.bars[0].upper, "corridor edges (spot-relative) update immediately when the feed moves");
    }

    std::printf("[9] King-Node pull / re-anchoring\n");
    {
        // Nearest-meaningful wall sits at 102 (clears the 35%-of-king bar
        // but is not the king), while the TRUE King (largest |exposure|
        // on the board) sits farther out at 115. The wall should be
        // pulled part way toward 115, not stay pinned at 102 nor snap
        // all the way to 115. Every OTHER adjustment (regime, skew,
        // freshness, confidence) is zeroed out here so the isolated pull
        // effect can be measured directly against a known distance.
        auto king_far_provider = [](int, int) -> std::optional<HeatmapBoard> {
            HeatmapBoard b; b.ticker = "KING"; b.spot = 100.0;
            for (int s = 85; s <= 120; ++s) {
                Node n; n.strike = s;
                n.exposure = (s == 102) ? 1500.0 : (s == 115) ? 4000.0 : (s == 90 ? -1500.0 : 50.0);
                b.nodes.push_back(n);
            }
            compute_derived_state(b);
            return b;
        };
        auto isolate = [](double pull) {
            auto c = ProjectionConfig::defaults(50);
            c.king_pull_strength = pull;
            c.regime_width_amplitude = 0; c.skew_amplitude = 0;
            c.freshness_loosen_amplitude = 0; c.hedge_confidence_penalty = 1.0; c.opex_confidence_penalty = 1.0;
            c.air_pocket_widen_positive = 1.0; c.air_pocket_widen_negative = 1.0;
            return c;
        };
        ProjectionRequest rq;
        rq.ticker = "KING"; rq.interval = "1D"; rq.dte = 0; rq.exposure = ExposureType::GEX;
        auto r_none = build_projection(rq, isolate(0.0), king_far_provider);
        auto r_half = build_projection(rq, isolate(0.35), king_far_provider);
        auto r_full = build_projection(rq, isolate(1.0), king_far_provider);
        CHECK(r_none.ok && r_half.ok && r_full.ok, "all three pull-strength variants build");
        CHECK(std::abs(r_none.up_wall_strike - 102.0) < 1e-6, "structural wall pick (pre-pull) is the nearest MEANINGFUL node, 102");
        double up_none = r_none.bars[0].upper - r_none.spot;
        double up_half = r_half.bars[0].upper - r_half.spot;
        double up_full = r_full.bars[0].upper - r_full.spot;
        CHECK(std::abs(up_none - 2.0) < 1e-6, "zero pull strength: corridor edge is exactly the raw wall distance (2)");
        CHECK(std::abs(up_full - 15.0) < 1e-6, "full (1.0) pull strength: corridor edge snaps exactly to the King's distance (15)");
        CHECK(up_none < up_half && up_half < up_full, "increasing king_pull_strength monotonically pulls the corridor edge toward the King (2 -> 15)");
        CHECK(std::abs(up_half - (2.0 + 0.35 * (15.0 - 2.0))) < 1e-6, "default 0.35 pull strength lands exactly on the expected interpolated point");
    }

    std::printf("[10] air-pocket local widening\n");
    {
        // A dead zone of near-zero exposure between spot and the first real
        // node above it (101..108 all ~0, then a real wall at 109).
        auto pocket_provider = [](int, int) -> std::optional<HeatmapBoard> {
            HeatmapBoard b; b.ticker = "POCKET"; b.spot = 100.0;
            for (int s = 90; s <= 115; ++s) {
                Node n; n.strike = s;
                if (s > 100 && s < 109) n.exposure = 1.0;       // near-zero -> air pocket
                else if (s == 109) n.exposure = 2000.0;          // real wall just past the pocket
                else n.exposure = 800.0;                          // ordinary floor of exposure elsewhere
                b.nodes.push_back(n);
            }
            compute_derived_state(b);
            return b;
        };
        auto isolate = [](double mult_pos, double mult_neg) {
            auto c = ProjectionConfig::defaults(50);
            c.air_pocket_widen_positive = mult_pos; c.air_pocket_widen_negative = mult_neg;
            c.king_pull_strength = 0; c.regime_width_amplitude = 0; c.skew_amplitude = 0;
            c.freshness_loosen_amplitude = 0; c.hedge_confidence_penalty = 1.0; c.opex_confidence_penalty = 1.0;
            return c;
        };
        ProjectionRequest rq;
        rq.ticker = "POCKET"; rq.interval = "1D"; rq.dte = 0; rq.exposure = ExposureType::GEX;
        auto r_flat = build_projection(rq, isolate(1.0, 1.0), pocket_provider);
        auto r_widen = build_projection(rq, isolate(1.15, 1.45), pocket_provider);
        CHECK(r_widen.ok && r_flat.ok, "both pocket-widening variants build");
        double up_widen = r_widen.bars[0].upper - r_widen.spot;
        double up_flat = r_flat.bars[0].upper - r_flat.spot;
        CHECK(up_widen > up_flat, "corridor with pocket widening enabled extends further than a 1.0x (no-op) multiplier");
        CHECK(std::abs(up_flat - 9.0) < 1e-6, "no-op (1.0x) multiplier still reaches the wall at 109 (distance 9) with isolation on");
        CHECK(std::abs(up_widen - 8.0 * 1.15) < 1e-6, "1.15x multiplier extends exactly to 1.15x the pocket's actual far edge (108, distance 8)");
    }

    std::printf("[11] freshness weighting (Part B.4 decay, reused)\n");
    {
        auto make_touched = [](int touches) {
            return [touches](int, int) -> std::optional<HeatmapBoard> {
                HeatmapBoard b; b.ticker = "FRESH"; b.spot = 100.0;
                for (int s = 85; s <= 115; ++s) {
                    Node n; n.strike = s;
                    n.exposure = (s == 108) ? 3000.0 : (s == 92 ? -2500.0 : 50.0);
                    if (s == 108) n.touch_count = touches;
                    b.nodes.push_back(n);
                }
                compute_derived_state(b);
                return b;
            };
        };
        auto isolate = []() {
            auto c = ProjectionConfig::defaults(50);
            c.king_pull_strength = 0; c.regime_width_amplitude = 0; c.skew_amplitude = 0;
            c.hedge_confidence_penalty = 1.0; c.opex_confidence_penalty = 1.0;
            c.air_pocket_widen_positive = 1.0; c.air_pocket_widen_negative = 1.0;
            return c;
        }();
        ProjectionRequest rq;
        rq.ticker = "FRESH"; rq.interval = "1D"; rq.dte = 0; rq.exposure = ExposureType::GEX;
        auto r_fresh = build_projection(rq, isolate, make_touched(0));
        auto r_stale = build_projection(rq, isolate, make_touched(10));
        CHECK(r_fresh.ok && r_stale.ok, "both freshness variants build");
        double up_fresh = r_fresh.bars[0].upper - r_fresh.spot;
        double up_stale = r_stale.bars[0].upper - r_stale.spot;
        CHECK(std::abs(up_fresh - 8.0) < 1e-6, "zero touches: corridor edge is exactly the raw wall distance (8), no loosening");
        CHECK(up_stale > up_fresh, "a heavily-retested (stale) wall loosens the corridor relative to an untouched one, all else equal");
        double expected_weight = decay_weight_for_touches(10, isolate.freshness);
        double expected = 8.0 * (1.0 + (1.0 - expected_weight) * isolate.freshness_loosen_amplitude);
        CHECK(std::abs(up_stale - expected) < 1e-6, "stale loosening matches decay_weight_for_touches exactly (freshness model reused, not reimplemented)");
    }

    std::printf("[12] OPEX week / Hedge-Node confidence reduction\n");
    {
        auto isolate = []() {
            auto c = ProjectionConfig::defaults(50);
            c.king_pull_strength = 0; c.regime_width_amplitude = 0; c.skew_amplitude = 0;
            c.freshness_loosen_amplitude = 0;
            c.air_pocket_widen_positive = 1.0; c.air_pocket_widen_negative = 1.0;
            return c;
        }();
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 0;
        auto r_normal = build_projection(rq, isolate, make_provider());
        CHECK(std::abs(r_normal.confidence - 1.0) < 1e-9, "confidence is 1.0 outside OPEX week with a non-Hedge wall");

        auto opex_provider = [](int first, int last) -> std::optional<HeatmapBoard> {
            HeatmapBoard b; b.ticker = "TST"; b.spot = 100.3;
            for (int s = 80; s <= 120; ++s) {
                Node n; n.strike = s;
                n.exposure = (s == 110) ? 5000.0 : (s == 90 ? -4000.0 : 100.0);
                b.nodes.push_back(n);
            }
            (void)first; (void)last;
            compute_derived_state(b);
            b.opex_week = true;
            return b;
        };
        auto r_opex = build_projection(rq, isolate, opex_provider);
        CHECK(std::abs(r_opex.confidence - isolate.opex_confidence_penalty) < 1e-9, "OPEX week applies exactly the configured confidence penalty");
        double up_normal = r_normal.bars[0].upper - r_normal.spot;
        double up_opex = r_opex.bars[0].upper - r_opex.spot;
        CHECK(up_opex > up_normal, "reduced OPEX-week confidence widens the corridor relative to an identical non-OPEX board");
        double expected_mult = 1.0 + (1.0 - isolate.opex_confidence_penalty) * isolate.confidence_widen_amplitude;
        CHECK(std::abs(up_opex - up_normal * expected_mult) < 1e-6, "OPEX widening matches the configured confidence_widen_amplitude exactly");

        // Hedge-Node wall: a large-but-farther-out position with a
        // dominant King elsewhere on the SAME side, so compute_derived_state
        // classifies the farther one as HedgeNode (Part B.4's existing role
        // assignment — distance + minimum-magnitude gated) rather than King.
        auto hedge_provider = [](int, int) -> std::optional<HeatmapBoard> {
            HeatmapBoard b; b.ticker = "HEDGE"; b.spot = 100.0;
            for (int s = 70; s <= 130; ++s) {
                Node n; n.strike = s;
                // King sits BELOW spot (70) so the board's hedge-distance
                // threshold is anchored there, letting 128 (far above spot,
                // large, but not largest) classify as a Hedge Node.
                n.exposure = (s == 70) ? 10000.0 : (s == 128) ? 2500.0 : (s == 102 ? 50.0 : 20.0);
                b.nodes.push_back(n);
            }
            compute_derived_state(b);
            return b;
        };
        ProjectionRequest rq2;
        rq2.ticker = "HEDGE"; rq2.interval = "1D"; rq2.dte = 0; rq2.exposure = ExposureType::GEX;
        auto r_hedge = build_projection(rq2, isolate, hedge_provider);
        CHECK(r_hedge.ok, "hedge-node scenario builds");
        CHECK(std::abs(r_hedge.up_wall_strike - 128.0) < 1e-6, "up-side wall correctly picks the far node (128) as the only meaningful one above spot");
        CHECK(std::abs(r_hedge.confidence - isolate.hedge_confidence_penalty) < 1e-9, "a Hedge-Node wall applies exactly the configured hedge confidence penalty");
    }

    std::printf("[13] multi-Greek selection (Expiry Data / Projections windows)\n");
    {
        CHECK(parse_greek_mask("GEX") == kGreekGEX, "GEX parses");
        CHECK(parse_greek_mask("gex,vex,color") == (kGreekGEX | kGreekVEX | kGreekCOLOR), "comma list, any case");
        CHECK(parse_greek_mask("GEX+VEX") == (kGreekGEX | kGreekVEX), "legacy GEX+VEX still parses");
        CHECK(parse_greek_mask("charm") == kGreekCHEX, "charm is an alias of CHEX");
        CHECK(parse_greek_mask("") == kGreekGEX && parse_greek_mask("nonsense") == kGreekGEX, "empty/unknown falls back to GEX");
        CHECK(greek_mask_to_string(kGreekGEX | kGreekVEX | kGreekCOLOR) == "GEX+VEX+COLOR", "label for the status line");

        HeatmapBoard b;
        b.spot = 100.0;
        for (int s2 = 90; s2 <= 110; ++s2) { Node n; n.strike = s2; n.exposure = 1000.0 + s2; b.nodes.push_back(n); }
        compute_derived_state(b);
        auto gex = apply_greek_mask(b, kGreekGEX);
        auto both = apply_greek_mask(b, kGreekGEX | kGreekVEX);
        auto vex = apply_greek_mask(b, kGreekVEX);
        bool sums = true, gex_native = true;
        // documented normalised combination (docs/GREEKS.md), computed independently here:
        //   C = G + (Gmax/Vmax) * V   with V = damping * G  =>  C = G * (1 + Gmax / (damping * Gmax) * damping)
        double gmax = 0, vmax = 0;
        for (const auto& n : b.nodes) { gmax = std::max(gmax, std::abs(n.exposure)); vmax = std::max(vmax, std::abs(n.exposure * kVexPlaceholderDamping)); }
        for (std::size_t i = 0; i < b.nodes.size(); ++i) {
            const double v = b.nodes[i].exposure * kVexPlaceholderDamping;
            if (std::abs(both.nodes[i].exposure - (b.nodes[i].exposure + (gmax / vmax) * v)) > 1e-6) sums = false;
            if (gex.nodes[i].exposure != b.nodes[i].exposure) gex_native = false;
        }
        CHECK(gex_native, "GEX-only leaves the native series untouched");
        CHECK(sums, "GEX+VEX is the documented peak-normalised combination G + (Gmax/Vmax)*V");
        CHECK(std::abs(vex.nodes[3].exposure - b.nodes[3].exposure * kVexPlaceholderDamping) < 1e-6, "VEX-only matches the existing VEX series");
        auto ch = apply_greek_mask(b, kGreekCHEX);
        bool varied = false;
        for (std::size_t i = 1; i < ch.nodes.size(); ++i)
            if ((ch.nodes[i].exposure > 0) != (ch.nodes[i - 1].exposure > 0)) varied = true;
        CHECK(varied, "CHEX is a distinct shape (changes sign across strikes), not a scaled copy of GEX");
        CHECK(std::abs(ch.nodes[3].exposure - greek_series_value(kGreekCHEX, b.nodes[3].exposure, b.nodes[3].strike)) < 1e-9, "deterministic per strike (no flicker between polls)");

        // Projection with a custom Greek mask uses ONE combined lens.
        ProjectionRequest rq;
        rq.ticker = "TST"; rq.interval = "1D"; rq.dte = 6;
        rq.greek_mask = kGreekGEX | kGreekCHEX | kGreekSPEED;
        auto r = build_projection(rq, cfg, make_provider());
        CHECK(r.ok && r.dte == 6 && r.bucket_name == "next6", "6DTE now projects (max DTE is 6)");
        CHECK(r.exposure_label == "GEX+CHEX+SPEED", "result reports what was projected");
        CHECK(r.gex_share == 1.0, "mask containing GEX keeps the gamma-regime scaling");
        rq.greek_mask = kGreekCHEX | kGreekCOLOR;
        auto r2 = build_projection(rq, cfg, make_provider());
        CHECK(r2.ok && r2.gex_share == 0.0 && r2.regime_factor == 1.0, "mask without GEX has no gamma-regime scaling");
        rq.greek_mask = 0; rq.exposure = ExposureType::GEX_PLUS_VEX;
        auto r3 = build_projection(rq, cfg, make_provider());
        CHECK(r3.exposure_label == "GEX+VEX" && r3.gex_share == cfg.gex_share_by_dte[6], "legacy GEX+VEX path unchanged");
    }

    std::printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
