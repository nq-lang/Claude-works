// Skylit Heatseeker Terminal — shared time <-> logical-index mapping for the Atlas chart.
//
// Lightweight Charts positions bars by their *logical index* (0 = first bar, n-1 = newest), not by
// time, and its own time<->coordinate helpers return `null` outside the loaded data (e.g. in the empty
// room to the right of the newest bar where Projections draw). Two things in the Atlas need an exact,
// total mapping instead:
//   1. restoring a scrolled-back view after a history refresh (atlas.js): the window must come back at
//      the same *times* even though bar indices shifted;
//   2. anchoring drawings to (time, price) data coordinates (atlas-drawing.js): a drawing must
//      round-trip pixel -> data -> pixel with no shift, including to the right of the newest bar.
//
// The mapping is piecewise-linear between real bars (so uneven spacing such as overnight gaps is
// honoured exactly) and extrapolates past both ends using the timeframe's nominal bar length.
// `times` is the ascending array of bar times (Unix seconds) of the series currently on the chart.

(function (global) {
  'use strict';

  const INTERVAL_SECONDS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400 };

  function intervalSeconds(interval) {
    return INTERVAL_SECONDS[interval] || 300;
  }

  // First index i with times[i] >= t (times.length if none).
  function lowerBound(times, t) {
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // time (Unix s) -> fractional logical index. Exact inverse of logicalToTime.
  function timeToLogical(times, t, intervalSec) {
    const n = times.length;
    if (!n || t == null) return null;
    if (t <= times[0]) return (t - times[0]) / intervalSec;
    if (t >= times[n - 1]) return (n - 1) + (t - times[n - 1]) / intervalSec;
    const i = lowerBound(times, t);
    if (times[i] === t) return i;
    const a = times[i - 1], b = times[i];
    return (i - 1) + (t - a) / (b - a);
  }

  // fractional logical index -> time (Unix s).
  function logicalToTime(times, l, intervalSec) {
    const n = times.length;
    if (!n || l == null) return null;
    if (l <= 0) return times[0] + l * intervalSec;
    if (l >= n - 1) return times[n - 1] + (l - (n - 1)) * intervalSec;
    const i = Math.floor(l);
    return times[i] + (l - i) * (times[i + 1] - times[i]);
  }

  global.SkylitChartCoords = { intervalSeconds, timeToLogical, logicalToTime, INTERVAL_SECONDS };
})(window);
