// Shared node-list utilities.
//
// Extracted so the Heatmap sidecar (heatmap.js) and Atlas's Orbs overlay
// (atlas.js) apply IDENTICAL "top N by magnitude, always keep spot" and
// "nearest strike to spot" logic — one implementation, per the same
// one-engine spirit as Part E.1, applied here to the render layer instead
// of the backend.

(function (global) {
  'use strict';

  function nearestStrikeIndex(nodes, spot) {
    let bestIdx = -1, bestDist = Infinity;
    nodes.forEach((n, i) => {
      const d = Math.abs(n.strike - spot);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    return bestIdx;
  }

  // Always keeps the strike nearest spot regardless of the limit (Part
  // B.5: "current spot price must always be visible").
  function applyNodeLimit(nodes, spot, limit) {
    if (!limit || limit >= nodes.length) return nodes;
    const spotIdx = nearestStrikeIndex(nodes, spot);
    const byMagnitude = nodes
      .map((n, i) => ({ n, i }))
      .sort((a, b) => Math.abs(b.n.exposure) - Math.abs(a.n.exposure));
    const keepIdx = new Set(byMagnitude.slice(0, limit).map((x) => x.i));
    keepIdx.add(spotIdx);
    return nodes.filter((_, i) => keepIdx.has(i));
  }

  // KING / BARNEY nodes (owner's definitions), computed PER GREEK AND PER EXPIRY SCOPE:
  //   King   = the strike with the largest POSITIVE exposure   (must be > 0)
  //   Barney = the strike with the most NEGATIVE exposure      (must be < 0)
  // Scope: the full strike table the backend returned for that (ticker, Greek, expiry set) — never
  // the node-limit-filtered subset, so changing "Nodes" can't change which strike is King.
  // Ties: equal exposure -> the strike nearest spot, then the lower strike (deterministic).
  // Hysteresis (documented, prevents flicker between near-equal strikes): the previous holder is
  // kept while it still has the right sign and the challenger beats it by less than HYSTERESIS
  // (relative to the holder's magnitude). Pass the previous result's strike in `prev`.
  const HYSTERESIS = 0.02;
  function classifyExtremes(nodes, spot, prev) {
    let king = null, barney = null;
    const better = (cand, cur, sign) => {
      if (!cur) return true;
      const a = sign * cand.exposure, b = sign * cur.exposure;
      if (a !== b) return a > b;
      const da = Math.abs(cand.strike - spot), db = Math.abs(cur.strike - spot);
      return da !== db ? da < db : cand.strike < cur.strike;
    };
    for (const n of nodes) {
      if (n.exposure > 0 && better(n, king, 1)) king = n;
      if (n.exposure < 0 && better(n, barney, -1)) barney = n;
    }
    const sticky = (best, sign, prevStrike) => {
      if (!best || prevStrike == null) return best;
      const held = nodes.find((n) => n.strike === prevStrike);
      if (!held || sign * held.exposure <= 0) return best;
      return sign * best.exposure - sign * held.exposure < HYSTERESIS * Math.abs(held.exposure) ? held : best;
    };
    return {
      king: sticky(king, 1, prev && prev.king), barney: sticky(barney, -1, prev && prev.barney),
    };
  }

  // Shared "Current + Next N" expiration-count options — matches the
  // discrete list in the reference UI exactly (not a dense 1-10 range).
  // Used by heatmap.js, atlas-layout.js, and quadrinity.js so the three
  // surfaces never drift out of sync with each other.
  const EXPIRATION_N_OPTIONS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50];

  global.SkylitNodeUtils = { nearestStrikeIndex, applyNodeLimit, classifyExtremes, EXPIRATION_N_OPTIONS };
})(window);
