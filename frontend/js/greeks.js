// Skylit Heatseeker Terminal — single source of truth for Greek definitions on the frontend.
//
// Every surface that names a Greek (heatmap headers, Orbs labels, legends, tooltips) reads this
// table, so a code or a name can never differ between panels.
//
// CODES (confirmed with the owner): G = Gamma and S = Speed are fixed; the remaining letters are
// assigned so that every Greek is unique even though several share an initial (Vanna/Vega,
// Charm/Color/Delta, Zomma/...). Z (Zomma) is reserved: the terminal does not compute it yet.
//
// SIGN CONVENTION (assumption, not a fact): exposures are dealer-positioning values where
// Pos = positive exposure at that strike, Neg = negative exposure, exactly as the engine reports
// them. The same convention is used for every Greek, in labels, sidebars and tooltips.

(function (global) {
  'use strict';

  // Display order is the order Greeks appear side by side / stacked.
  const GREEKS = [
    { key: 'GEX',   code: 'G', name: 'Gamma', color: '#fcbf24', negColor: '#a855f7' },
    { key: 'VEX',   code: 'V', name: 'Vanna', color: '#38bdf8', negColor: '#fb7185' },
    { key: 'CHEX',  code: 'C', name: 'Charm', color: '#4ade80', negColor: '#f97316' },
    { key: 'COLOR', code: 'K', name: 'Color', color: '#e879f9', negColor: '#facc15' },
    { key: 'SPEED', code: 'S', name: 'Speed', color: '#2dd4bf', negColor: '#f472b6' },
  ];
  const RESERVED = [{ key: 'ZEX', code: 'Z', name: 'Zomma (not computed yet)' }];
  const BY_KEY = Object.fromEntries(GREEKS.map((g) => [g.key, g]));
  BY_KEY.CHARM = BY_KEY.CHEX;   // alias the backend also accepts
  // The ONLY sanctioned combination (explicit user choice). Its own code so it can never be mistaken for G or V.
  BY_KEY['GEX+VEX'] = { key: 'GEX+VEX', code: 'GV', name: 'Gamma+Vanna', color: '#f0abfc', negColor: '#fb923c' };

  function get(key) { return BY_KEY[String(key || '').toUpperCase()] || null; }
  function codeOf(key) { const g = get(key); return g ? g.code : '?'; }
  function nameOf(key) { const g = get(key); return g ? g.name : String(key); }

  // Splits a selection ("GEX,VEX", "GEX+VEX", "GEX") into the SEPARATE Greeks to display.
  // Greeks are NEVER merged: each entry is requested, ranked and drawn on its own. The only
  // exception is the explicit combined option "GEX+VEX", which stays one entry.
  function splitSelection(selection) {
    const raw = String(selection || 'GEX').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const k of raw) {
      if (k === 'GEX+VEX') { if (!out.includes(k)) out.push(k); continue; }
      const g = get(k);
      if (g && !out.includes(g.key)) out.push(g.key);
    }
    // Stable display order: table order, combined option last.
    const order = (k) => (k === 'GEX+VEX' ? 99 : GREEKS.findIndex((g) => g.key === k));
    out.sort((a, b) => order(a) - order(b));
    return out.length ? out : ['GEX'];
  }

  // K / M / B with sensible precision (3 significant digits), sign handled by the caller.
  function fmtExposure(v) {
    const a = Math.abs(v);
    const f = (x, s) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + s;
    if (a >= 1e9) return f(a / 1e9, 'B');
    if (a >= 1e6) return f(a / 1e6, 'M');
    if (a >= 1e3) return f(a / 1e3, 'K');
    return a >= 100 ? a.toFixed(0) : a.toFixed(1);
  }
  // "Pos G 1.24M" / "Neg S 310K"
  function levelLabel(key, exposure) {
    return `${exposure >= 0 ? 'Pos' : 'Neg'} ${codeOf(key)} ${fmtExposure(exposure)}`;
  }

  global.SkylitGreeks = { GREEKS, RESERVED, get, codeOf, nameOf, splitSelection, fmtExposure, levelLabel };
})(window);
