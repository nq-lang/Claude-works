// Skylit Heatseeker Terminal — shared exposure color scale.
//
// Part B.3 requirement, restated as one continuous diverging gradient
// (matching the reference layout provided): deep purple (heaviest negative /
// "Barney") -> blue -> teal (near zero) -> green -> bright yellow (heaviest
// positive / "Pika"). This is a SINGLE function so Heatmaps, Quadrinity, and
// the Atlas sidecar all render identical colors for identical data — never
// three divergent color implementations (mirrors the Part E.1 "one engine"
// rule, applied to the render layer).
//
// Core invariant enforced here (Part B.3): color intensity is driven by
// ABSOLUTE magnitude relative to the board's own max, with sign only
// choosing which half of the gradient to sit in. A huge node of either sign
// visually dominates a small node of the opposite sign.

(function (global) {
  'use strict';

  // 5-stop diverging gradient, position 0..1 across the full negative-to-
  // positive range. Colors picked to match the reference mockup's gradient
  // bars (grad-spxw / grad-spy / grad-qqq) and King-node yellow highlight.
  const STOPS = [
    { t: 0.00, rgb: [54, 0, 92] },     // deep purple  — heaviest negative (Barney max)
    { t: 0.25, rgb: [34, 45, 133] },   // blue
    { t: 0.50, rgb: [30, 130, 148] },  // teal          — near zero
    { t: 0.75, rgb: [58, 173, 90] },   // green
    { t: 1.00, rgb: [252, 229, 35] },  // bright yellow — heaviest positive (Pika max)
  ];

  function lerp(a, b, t) { return a + (b - a) * t; }

  function colorAt(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < STOPS.length - 1; i++) {
      const a = STOPS[i], b = STOPS[i + 1];
      if (t >= a.t && t <= b.t) {
        const localT = (t - a.t) / (b.t - a.t || 1);
        const r = Math.round(lerp(a.rgb[0], b.rgb[0], localT));
        const g = Math.round(lerp(a.rgb[1], b.rgb[1], localT));
        const bch = Math.round(lerp(a.rgb[2], b.rgb[2], localT));
        return `rgb(${r},${g},${bch})`;
      }
    }
    const last = STOPS[STOPS.length - 1].rgb;
    return `rgb(${last[0]},${last[1]},${last[2]})`;
  }

  // exposure: signed value for this node.
  // maxAbsExposure: the board's own max |exposure| (never a global/shared
  // constant across tickers — SPXW and SPY have wildly different notional
  // scales, so each board is normalized against itself).
  function exposureToColor(exposure, maxAbsExposure) {
    if (!maxAbsExposure || maxAbsExposure <= 0) return colorAt(0.5);
    // Map signed exposure in [-max, +max] onto gradient position [0, 1].
    const clamped = Math.max(-maxAbsExposure, Math.min(maxAbsExposure, exposure));
    const t = (clamped / maxAbsExposure) * 0.5 + 0.5;
    return colorAt(t);
  }

  // Whether rendered text on top of this background should be black
  // (bright/high-luminance stops — green/yellow) or white (dark stops —
  // purple/blue/teal), matching the reference mockup's `.row.text-black`.
  function textColorFor(exposure, maxAbsExposure) {
    if (!maxAbsExposure || maxAbsExposure <= 0) return '#fff';
    const t = (Math.max(-maxAbsExposure, Math.min(maxAbsExposure, exposure)) / maxAbsExposure) * 0.5 + 0.5;
    return t > 0.62 ? '#000' : '#fff';
  }

  function maxAbsExposureOf(nodes) {
    let max = 0;
    for (const n of nodes) max = Math.max(max, Math.abs(n.exposure));
    return max;
  }

  // Opacity-aware variant for Atlas's Orb opacity slider — returns an
  // rgba() string so the orb's price-line color can be dimmed without
  // altering hue, same principle as heatmap.js's dimColor but exposed here
  // since Atlas needs it applied to a CSS/canvas color string, not a DOM
  // background-color.
  function exposureToColorWithOpacity(exposure, maxAbsExposure, opacity) {
    const rgb = exposureToColor(exposure, maxAbsExposure);
    const m = rgb.match(/rgb\((\d+),(\d+),(\d+)\)/);
    if (!m) return rgb;
    const [, r, g, b] = m.map(Number);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, opacity))})`;
  }

  // Strict two-tone variant for Atlas's Orbs overlay specifically (this
  // correction): unlike the heatmap ladder's 5-stop diverging gradient
  // above, Orbs on the candlestick chart use exactly two hues — bright
  // gold/yellow for positive (Pika) exposure, vivid purple for negative
  // (Barney) exposure, per the reference screenshots. Magnitude and decay
  // are expressed ONLY through opacity here, never through a hue blend —
  // an orb is always unambiguously "positive-gold" or "negative-purple,"
  // just more or less visible.
  const ORB_POSITIVE_RGB = [252, 191, 36];  // gold/amber
  const ORB_NEGATIVE_RGB = [168, 85, 247];  // vivid purple

  function exposureToOrbColor(exposure, opacity) {
    const [r, g, b] = exposure >= 0 ? ORB_POSITIVE_RGB : ORB_NEGATIVE_RGB;
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, opacity))})`;
  }

  global.SkylitColorScale = {
    exposureToColor, exposureToColorWithOpacity, exposureToOrbColor,
    textColorFor, maxAbsExposureOf, colorAt,
  };
})(window);
