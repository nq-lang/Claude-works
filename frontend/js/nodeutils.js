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

  // Shared "Current + Next N" expiration-count options — matches the
  // discrete list in the reference UI exactly (not a dense 1-10 range).
  // Used by heatmap.js, atlas-layout.js, and quadrinity.js so the three
  // surfaces never drift out of sync with each other.
  const EXPIRATION_N_OPTIONS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50];

  global.SkylitNodeUtils = { nearestStrikeIndex, applyNodeLimit, EXPIRATION_N_OPTIONS };
})(window);
