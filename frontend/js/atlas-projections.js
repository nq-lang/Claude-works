// Skylit Heatseeker Terminal — Atlas Projections render layer.
//
// Rendering only. Every number drawn here comes from GET /api/projection,
// computed by the shared C++ engine (projection_engine.hpp on top of
// exposure_engine.hpp) — this file owns NO weighting/clamping logic.
//
// VISUAL REVISION (simplified single wedge, "highlighting from the
// nearest price"): per an explicit reference image, the forward
// projection is now a single narrow, expanding WEDGE — a straight-edged
// triangle from the last candle (the nearest price) out to the horizon,
// with one solid center line (the developing path) and a translucent
// fill — rather than the earlier dual inner/outer banked-curve pair with
// its own per-edge price labels. The per-strike WALL levels and their
// $exposure/% labels are now the Orb layer's job (atlas-orbs.js's dense
// diamond bands already label every major strike), so this layer no
// longer duplicates that; it only highlights the near-term drift band
// around the current price itself. The wedge's half-width still comes
// straight from the engine's own adjusted bar distances (confidence,
// King-pull, skew, air-pocket, freshness all already folded in by
// projection_engine.hpp) — this is a rendering simplification only, not
// new or different math.
//
// Four required outputs (Part I), in this visual language:
//   1. Projected forward range   - the shaded wedge
//   2. Upper/lower gravity zones - the wedge's own edges (bounded by the
//                                  engine's wall-adjusted distances)
//   3. Percent-from-spot levels  - the chart's own last-price axis tag
//                                  already shows the live price; the
//                                  Orb bands show every strike's own
//                                  level, so no separate pill is drawn
//                                  here (avoids duplicate/competing labels)
//   4. Developing path           - the solid center line
// A hatched "no data support" region is drawn when the window runs past
// the loaded expiration data (Part IV.5). There is no on-chart text badge
// — the toolbar's toggle/DTE buttons are the only label.
//
// Forward x-positions: Lightweight Charts has no bars past the last candle,
// so future bars are placed by extrapolating from the last two real bars'
// pixel spacing (logicalToCoordinate when the chart offers it, otherwise
// timeToCoordinate). The controller reserves room to the right with
// timeScale.rightOffset so the wedge is on screen.

(function (global) {
  'use strict';

  const COLORS = {
    fill: 'rgba(130, 170, 230, 0.16)',
    fillUnsupported: 'rgba(120, 120, 130, 0.06)',
    edge: 'rgba(150, 190, 240, 0.55)',
    path: 'rgba(190, 215, 255, 0.95)',
    text: '#d8dce6',
    hatch: 'rgba(160, 160, 170, 0.35)',
  };

  function createProjectionLayer(chartWrapperEl, chart, series, hooks) {
    const canvas = document.createElement('canvas');
    canvas.className = 'atlas-projection-canvas';
    canvas.style.pointerEvents = 'none';
    chartWrapperEl.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let data = null; // last /api/projection response
    let layout = null; // computed at draw time, exposed via getState() for tests

    // Sharp resolution: backing store in device pixels, CSS size in
    // logical pixels, transform scaled once per resize.
    function resizeCanvas() {
      const rect = chartWrapperEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }

    function computeXAxis() {
      const info = hooks.getBarGeometry();
      if (!info || info.lastTime == null) return null;
      const ts = chart.timeScale();
      let x0 = null, x1 = null;
      if (typeof ts.logicalToCoordinate === 'function' && info.lastLogical != null) {
        x0 = ts.logicalToCoordinate(info.lastLogical);
        x1 = ts.logicalToCoordinate(info.lastLogical - 1);
      }
      if (x0 == null || x1 == null) {
        x0 = ts.timeToCoordinate(info.lastTime);
        x1 = info.prevTime != null ? ts.timeToCoordinate(info.prevTime) : null;
      }
      if (x0 == null || x1 == null) return null;
      const dx = x0 - x1;
      if (!(dx > 0)) return null;
      return { x0, dx };
    }

    function y(price) { return series.priceToCoordinate(price); }

    function drawHatch(x, yTop, w, h) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, yTop, w, h);
      ctx.clip();
      ctx.strokeStyle = COLORS.hatch;
      ctx.lineWidth = 1;
      for (let i = -h; i < w; i += 7) {
        ctx.beginPath();
        ctx.moveTo(x + i, yTop + h);
        ctx.lineTo(x + i + h, yTop);
        ctx.stroke();
      }
      ctx.restore();
    }

    function redraw() {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
      if (!data || !data.bars || !data.bars.length) return;
      const axis = computeXAxis();
      layout = axis;
      if (!axis) return;

      // Anchor the wedge's PRICE LEVEL to the chart's own trusted last
      // close rather than this response's own `data.spot` — the two are
      // usually equal but come from independent HTTP round trips (candles
      // vs. projection poll), so `data.spot` can trail the candle just
      // drawn by a tick, which read as the wedge sitting a bit off from
      // "the recent candlestick" vertically. The engine's computed
      // upper/lower/mid are kept as OFFSETS from data.spot and reapplied
      // around the trusted close, so the wedge's WIDTH is still exactly
      // what the engine computed — only its vertical position is kept
      // from ever lagging the candle.
      const barInfo = hooks.getBarGeometry();
      const spot = barInfo && barInfo.lastClose != null ? barInfo.lastClose : data.spot;
      const spotY = y(spot);
      if (spotY == null) return;

      const lastSupportedIdx = data.bars.reduce((acc, b, i) => (b.supported ? i : acc), -1);
      const lastSupported = lastSupportedIdx >= 0 ? data.bars[lastSupportedIdx] : null;
      if (!lastSupported) return;

      // logicalToCoordinate(lastLogical) returns the CENTER of the last
      // candle, not its right edge — starting the wedge there made it
      // visually begin from the middle of the candle body rather than
      // hugging up against it. Nudging the start forward by ~40% of a
      // bar's width lines the apex up with the candle's right edge
      // instead, so the wedge reads as emerging directly from the
      // nearest price rather than floating a half-candle away from it.
      const p0x = axis.x0 + axis.dx * 0.4, p0y = spotY;
      const xEnd = axis.x0 + (lastSupportedIdx + 1) * axis.dx;
      const upY = y(spot + (lastSupported.upper - data.spot));
      const dnY = y(spot + (lastSupported.lower - data.spot));
      const midY = y(spot + (lastSupported.mid - data.spot));
      if (upY == null || dnY == null || midY == null) return;

      // Bowed wedge, "highlighting from the nearest price" — it must open
      // up IMMEDIATELY at the candle (steep initial slope), then flatten
      // toward the horizon, not grow at a constant linear rate (which
      // reads as "nothing happens for a while, then it opens up" since a
      // straight wedge is necessarily razor-thin near its own apex). A
      // single quadratic curve with its control point directly above/
      // below the start (same x as p0, y at the final level) produces
      // exactly that: near t=0 the curve moves almost straight toward
      // the control point (near-vertical departure from the candle), then
      // bends over and flattens as it approaches the end point — same
      // shape language as a real expected-move cone, without changing
      // WHERE it ends up (still exactly the engine's computed upper/
      // lower/mid levels).
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(p0x, upY, xEnd, upY);
      ctx.lineTo(xEnd, dnY);
      ctx.quadraticCurveTo(p0x, dnY, p0x, p0y);
      ctx.closePath();
      ctx.fillStyle = COLORS.fill;
      ctx.fill();
      ctx.strokeStyle = COLORS.edge;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Solid developing-path center line — same bowed shape.
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(p0x, midY, xEnd, midY);
      ctx.strokeStyle = COLORS.path;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Unsupported tail (Part IV.5): hatched, no wedge, no confidence.
      if (lastSupportedIdx < data.bars.length - 1) {
        const tailStartX = xEnd;
        const tailEndX = axis.x0 + data.bars.length * axis.dx;
        const top = Math.min(upY, dnY) - 10;
        const bot = Math.max(upY, dnY) + 10;
        ctx.fillStyle = COLORS.fillUnsupported;
        ctx.fillRect(tailStartX, top, tailEndX - tailStartX, bot - top);
        drawHatch(tailStartX, top, tailEndX - tailStartX, bot - top);
        ctx.fillStyle = COLORS.text;
        ctx.font = '10px IBM Plex Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText('no expiration data beyond here', tailStartX + 6, (top + bot) / 2);
      }
    }

    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(chartWrapperEl);
    resizeCanvas();
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);

    return {
      render(response) { data = response; redraw(); },
      clear() { data = null; layout = null; ctx.clearRect(0, 0, canvas.width, canvas.height); },
      redraw,
      // Test/introspection hook: what the layer is currently showing.
      getState() { return { data, layout }; },
      destroy() { resizeObserver.disconnect(); canvas.remove(); },
    };
  }

  global.createProjectionLayer = createProjectionLayer;
})(window);
