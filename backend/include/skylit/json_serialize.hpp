// Hand-written JSON serialization for engine types.
//
// Kept intentionally minimal per the dependency policy in ARCHITECTURE.md
// §2: this only needs to WRITE JSON (the frontend never sends structured
// JSON bodies back in this milestone), so a tiny purpose-built serializer
// is cheaper and lower-risk than pulling in a general parser/writer library
// for one direction of one feature. Revisit (vendor nlohmann/json) once a
// route needs to parse a JSON request body.

#pragma once

#include <format>
#include <sstream>
#include <string>
#include <vector>

#include "skylit/candles.hpp"
#include "skylit/exposure_engine.hpp"
#include "skylit/projection_engine.hpp"

namespace skylit::json {

// True for the bytes JSON requires us to escape: '"', '\\' and the C0 control characters.
inline bool needs_escape(char c) {
    return c == '"' || c == '\\' || static_cast<unsigned char>(c) < 0x20;
}

inline std::string escape(const std::string& s) {
    // Fast path: nearly every string we serialize (tickers, labels) needs no escaping at all, so
    // return it unchanged instead of rebuilding it character by character.
    std::size_t i = 0;
    while (i < s.size() && !needs_escape(s[i])) ++i;
    if (i == s.size()) return s;

    std::string out;
    out.reserve(s.size() + 8);
    out.append(s, 0, i);
    for (; i < s.size(); ++i) {
        const char c = s[i];
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    // Remaining control characters must be \u-escaped to stay valid JSON.
                    constexpr char kHex[] = "0123456789abcdef";
                    out += "\\u00";
                    out += kHex[(static_cast<unsigned char>(c) >> 4) & 0xF];
                    out += kHex[static_cast<unsigned char>(c) & 0xF];
                } else {
                    out += c;
                }
        }
    }
    return out;
}

inline const char* role_name(engine::NodeRole r) {
    switch (r) {
        case engine::NodeRole::KingNode: return "king";
        case engine::NodeRole::Gatekeeper: return "gatekeeper";
        case engine::NodeRole::HedgeNode: return "hedge";
        case engine::NodeRole::Normal: return "normal";
    }
    return "normal";
}

inline const char* gamma_context_name(engine::GammaContext c) {
    return c == engine::GammaContext::Positive ? "positive" : "negative";
}

inline const char* roll_direction_name(engine::RollDirection d) {
    switch (d) {
        case engine::RollDirection::RollingFloorUp: return "rolling_floor_up";
        case engine::RollDirection::RollingCeilingDown: return "rolling_ceiling_down";
        case engine::RollDirection::None: return "none";
    }
    return "none";
}

inline const char* directional_read_name(engine::DirectionalRead r) {
    switch (r) {
        case engine::DirectionalRead::Bullish: return "bullish";
        case engine::DirectionalRead::Bearish: return "bearish";
        case engine::DirectionalRead::Neutral: return "neutral";
    }
    return "neutral";
}

inline std::string node_to_json(const engine::Node& n) {
    return std::format(
        R"({{"strike":{:.2f},"exposure":{:.2f},"role":"{}","touch_count":{},)"
        R"("rate_of_change":{:.2f},"distance_from_spot":{:.2f},"session_change_pct":{:.2f},)"
        R"("velocity_pct":{:.2f},"velocity_new":{}}})",
        n.strike, n.exposure, role_name(n.role), n.touch_count, n.rate_of_change,
        n.distance_from_spot, n.session_change_pct, n.velocity_pct,
        n.velocity_new ? "true" : "false");
}

inline std::string board_to_json(const engine::HeatmapBoard& board) {
    std::ostringstream nodes_json;
    for (std::size_t i = 0; i < board.nodes.size(); ++i) {
        if (i) nodes_json << ',';
        nodes_json << node_to_json(board.nodes[i]);
    }

    std::ostringstream pockets_json;
    for (std::size_t i = 0; i < board.air_pockets.size(); ++i) {
        if (i) pockets_json << ',';
        const auto& p = board.air_pockets[i];
        pockets_json << std::format(R"({{"low_strike":{:.2f},"high_strike":{:.2f},"context":"{}"}})",
                                     p.low_strike, p.high_strike, gamma_context_name(p.context));
    }

    const engine::Node* king = board.king_node();

    return std::format(
        R"({{"ticker":"{}","expiration_bucket":"{}","spot":{:.2f},)"
        R"("range":{{"upper":{:.2f},"lower":{:.2f},"midpoint":{:.2f}}},)"
        R"("king_strike":{},"floor_trend":"{}","ceiling_trend":"{}","opex_week":{},)"
        R"("nodes":[{}],"air_pockets":[{}]}})",
        escape(board.ticker), escape(board.expiration_bucket), board.spot, board.range.upper,
        board.range.lower, board.range.midpoint(), king ? std::format("{:.2f}", king->strike) : "null",
        roll_direction_name(board.floor_trend), roll_direction_name(board.ceiling_trend),
        board.opex_week ? "true" : "false", nodes_json.str(), pockets_json.str());
}

inline std::string confluence_to_json(const engine::ConfluenceResult& c) {
    std::ostringstream outliers_json;
    for (std::size_t i = 0; i < c.outlier_tickers.size(); ++i) {
        if (i) outliers_json << ',';
        outliers_json << '"' << escape(c.outlier_tickers[i]) << '"';
    }
    return std::format(
        R"({{"aligned_count":{},"total_count":{},"majority_read":"{}","state_label":"{}","outlier_tickers":[{}]}})",
        c.aligned_count, c.total_count, directional_read_name(c.majority_read),
        escape(c.state_label()), outliers_json.str());
}

inline std::string candle_to_json(const market::Candle& c) {
    return std::format(R"({{"time":{},"open":{:.4f},"high":{:.4f},"low":{:.4f},"close":{:.4f}}})",
                        c.time, c.open, c.high, c.low, c.close);
}

inline std::string candles_to_json(const std::vector<market::Candle>& candles) {
    std::ostringstream out;
    out << '[';
    for (std::size_t i = 0; i < candles.size(); ++i) {
        if (i) out << ',';
        out << candle_to_json(candles[i]);
    }
    out << ']';
    return out.str();
}

inline std::string dark_pool_to_json(const std::vector<market::DarkPoolLevel>& levels) {
    std::ostringstream out;
    out << '[';
    for (std::size_t i = 0; i < levels.size(); ++i) {
        if (i) out << ',';
        const auto& lvl = levels[i];
        out << std::format(R"({{"price":{:.2f},"notional":{:.0f},"context":"{}"}})", lvl.price,
                            lvl.notional, escape(lvl.context));
    }
    out << ']';
    return out.str();
}

inline std::string flow_bar_to_json(const market::FlowBar& bar) {
    return std::format(
        R"({{"time":{},"call_volume":{:.0f},"put_volume":{:.0f},"net_flow":{:.0f},)"
        R"("trade_count":{},"bucket_put_call_ratio":{:.3f}}})",
        bar.time, bar.call_volume, bar.put_volume, bar.net_flow, bar.trade_count,
        bar.bucket_put_call_ratio);
}

inline std::string flow_to_json(const std::vector<market::FlowBar>& bars) {
    std::ostringstream out;
    out << '[';
    for (std::size_t i = 0; i < bars.size(); ++i) {
        if (i) out << ',';
        out << flow_bar_to_json(bars[i]);
    }
    out << ']';
    return out.str();
}


// --- Atlas Projections (Beta) ---------------------------------------------

inline std::string projection_profile_to_json(const engine::TimeframeProfile& p,
                                               const engine::ProjectionConfig& cfg) {
    return std::format(
        R"({{"interval":"{}","bar_seconds":{},"bar_sessions":{:.6f},"max_window_bars":{}}})",
        escape(p.interval), p.bar_seconds, cfg.bar_sessions(p), p.max_window_bars);
}

// The Part III bar-geometry table, served so the UI clamps from the SAME
// source of truth as the backend (no second copy of the table in
// JavaScript). Projections is now DTE-selected (0-5), not window-sized —
// this table only bounds how many forward bars a timeframe can draw.
inline std::string projection_config_to_json(const engine::ProjectionConfig& cfg) {
    std::ostringstream profiles;
    for (std::size_t i = 0; i < cfg.profiles.size(); ++i) {
        if (i) profiles << ',';
        profiles << projection_profile_to_json(cfg.profiles[i], cfg);
    }
    return std::format(
        R"({{"profiles":[{}],"max_dte":{},"loaded_max_sessions":{},"session_seconds":{:.0f}}})",
        profiles.str(), engine::kMaxProjectionDte, cfg.loaded_max_sessions, cfg.session_seconds);
}

inline std::string projection_to_json(const engine::ProjectionResult& r,
                                       const engine::ProjectionConfig& cfg) {
    std::ostringstream bars;
    for (std::size_t i = 0; i < r.bars.size(); ++i) {
        if (i) bars << ',';
        const auto& b = r.bars[i];
        bars << std::format(
            R"({{"k":{},"upper":{:.4f},"lower":{:.4f},"mid":{:.4f},)"
            R"("upper_pct":{:.4f},"lower_pct":{:.4f},"supported":{}}})",
            b.k, b.upper, b.lower, b.mid, b.upper_pct, b.lower_pct, b.supported ? "true" : "false");
    }
    return std::format(
        R"({{"ticker":"{}","exposure":"{}","dte":{},"bucket":"{}","spot":{:.4f},"beta":true,)"
        R"("label":"Positioning scenario \u2014 not a probability forecast. Shows where dealer exposure sits ahead, not where price will be.",)"
        R"("timeframe":{},)"
        R"("horizon":{{"requested_bars":{},"effective_bars":{},"max_bars":{},"clamped":{}}},)"
        R"("zone_half_thickness":{:.4f},"gex_share":{:.4f},"regime_score":{:.4f},"regime_factor":{:.4f},"confidence":{:.4f},)"
        R"("up_wall":{},"down_wall":{},"density_skew":{:.4f},"up_density":{:.2f},"down_density":{:.2f},)"
        R"("bars":[{}]}})",
        escape(r.ticker), escape(r.exposure_label), r.dte, escape(r.bucket_name), r.spot,
        projection_profile_to_json(r.profile, cfg), r.horizon.requested, r.horizon.effective,
        r.horizon.max, r.horizon.clamped ? "true" : "false", r.zone_half_thickness, r.gex_share,
        r.regime_score, r.regime_factor, r.confidence,
        r.up_wall_found ? std::format(R"({{"strike":{:.4f},"distance":{:.4f}}})", r.up_wall_strike, r.up_wall_strike - r.spot)
                        : std::string("null"),
        r.down_wall_found ? std::format(R"({{"strike":{:.4f},"distance":{:.4f}}})", r.down_wall_strike, r.spot - r.down_wall_strike)
                          : std::string("null"),
        r.density_skew, r.up_density, r.down_density,
        bars.str());
}

}  // namespace skylit::json
