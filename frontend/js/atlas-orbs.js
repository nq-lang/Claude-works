// Skylit Heatseeker Terminal — Atlas Orbs rendering layer.
//
// VISUAL REVISION: per an explicit reference image, each strike's orb
// "band" is now a DENSE, continuous caterpillar of small diamonds (not a
// sparse dot-per-bar row) spanning the full chart width, fading in from
// the left (historical context) to full density from the current bar
// onward through the reserved forward space — and ending in a labeled
// pill showing "{strike} · {signed $exposure} · {percent of King}%", so
// the dealer-positioning read at every major strike is both visually
// continuous and numerically explicit, matching how the reference
// annotates each band. Rendering only — the node list, its exposure
// values, and which strike is King all come straight from
// GET /api/heatmap (the same data heatmap.js renders); this layer adds
// zero independent exposure math, same as every prior revision.
//
// Position: diamonds sit at the node's real STRIKE price (series.
// priceToCoordinate) and at real x pixels derived from the chart's own
// bar geometry (hooks.getBarGeometry, the same hook Projections uses) —
// never a synthetic offset — so a level the candles haven't traded
// through yet still renders (autoscale is extended for this by the
// controller in atlas.js, via state.orbRange).

(function (global) {
  'use strict';

  const DIAMOND_SPACING = 7;    // px between diamond centers in the dense band
  const DIAMOND_SIZE_MIN = 2.2;
  const DIAMOND_SIZE_MAX = 4.2;

  function createOrbLayer(chartWrapperEl, chart, series, hooks) {
    const canvas = document.createElement('canvas');
    canvas.className = 'atlas-orb-canvas';
    canvas.style.pointerEvents = 'none';
    chartWrapperEl.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let currentNodes = []; // [{ strike, exposure, colorWithAlpha, radius, opacity, isKing, percent }]
    let sizeScale = 1;     // Orbs window "Orb Size" (50% = 1x)
    let showLabels = true; // Orbs window "Show exposure labels"

    // Sharp resolution: backing store in device pixels, CSS size in
    // logical pixels — same fix as the Projections canvas, otherwise
    // HiDPI displays render every diamond/label soft.
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

    function convergenceX() {
      const info = hooks && hooks.getBarGeometry ? hooks.getBarGeometry() : null;
      const ts = chart.timeScale();
      if (info && info.lastLogical != null && typeof ts.logicalToCoordinate === 'function') {
        const x = ts.logicalToCoordinate(info.lastLogical);
        if (x != null) return x;
      }
      return canvas.clientWidth * 0.6; // fallback if geometry isn't ready yet
    }

    function drawDiamond(x, yy, half, color, alpha) {
      ctx.save();
      ctx.translate(x, yy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = color.replace(/[\d.]+\)$/, `${alpha})`);
      ctx.fillRect(-half, -half, half * 2, half * 2);
      ctx.restore();
    }

    function fmtMoney(v) {
      const abs = Math.abs(v);
      const k = abs / 1000;
      const text = k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
      return `${v < 0 ? '-' : ''}$${text}`;
    }

    // Dotted-border pill label at the right end of a band — matches the
    // reference's "{strike} · {$exposure} · {percent}%" callouts.
    function drawLabel(text, xRight, yy, color) {
      ctx.font = '10px IBM Plex Mono, monospace';
      const padX = 6, h = 15;
      const w = ctx.measureText(text).width + padX * 2;
      const left = xRight - w;
      const top = yy - h / 2;
      ctx.fillStyle = 'rgba(10, 10, 14, 0.82)';
      ctx.fillRect(left, top, w, h);
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = color.replace(/[\d.]+\)$/, '0.6)');
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = '#d8dce6';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, left + padX, yy + 0.5);
    }

    function drawNodeBand(node, cssW, xConverge) {
      const yy = series.priceToCoordinate(node.strike);
      if (yy === null) return;

      const half = (DIAMOND_SIZE_MIN + (DIAMOND_SIZE_MAX - DIAMOND_SIZE_MIN) * node.sizeFrac) * sizeScale;
      const spacing = Math.max(half * 2.4, DIAMOND_SPACING * Math.max(0.6, sizeScale));
      // Reserve room for the label only when labels are on; with them off the
      // band runs to the right edge.
      const labelW = showLabels ? 90 : 8;
      const bandRight = cssW - labelW;

      for (let x = spacing / 2; x < bandRight; x += spacing) {
        // Fade in across the historical region approaching the current
        // bar; full density from the current bar through the forward
        // (projected) region — this is the "highlighting from the
        // nearest price" transition the reference shows.
        const fadeSpan = Math.max(40, xConverge * 0.6);
        const t = (x - (xConverge - fadeSpan)) / fadeSpan;
        const fade = Math.max(0, Math.min(1, t));
        const alpha = node.opacity * (0.15 + 0.85 * fade);
        if (alpha <= 0.02) continue;
        drawDiamond(x, yy, node.isKing ? half * 1.25 : half, node.colorBase, alpha);
      }

      if (showLabels) {
        drawLabel(`${node.strike}  ${fmtMoney(node.exposure)}  ${Math.round(node.percent)}%`, bandRight - 4, yy, node.colorBase);
      }
    }

    function redraw() {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
      if (!currentNodes.length) return;
      const cssW = canvas.clientWidth;
      const xConverge = convergenceX();
      // King node drawn last so it sits visually on top of ordinary nodes.
      const ordered = [...currentNodes].sort((a, b) => (a.isKing ? 1 : 0) - (b.isKing ? 1 : 0));
      for (const n of ordered) drawNodeBand(n, cssW, xConverge);
    }

    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(chartWrapperEl);
    resizeCanvas();
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);

    return {
      // nodes: the SAME node list a heatmap.js panel would render for this
      // ticker/exposure/expiration — [{ strike, exposure, role }].
      // maxAbsExposure: number, colorForNode(exposure, maxAbs, opacity) ->
      // 'rgba(...)' string (heatmap.js's own color scale — colorscale.js),
      // styleForNode(node, maxAbs, isKing) -> { radius, opacity }.
      render(nodes, maxAbsExposure, colorForNode, styleForNode, renderOpts) {
        sizeScale = renderOpts && renderOpts.sizeScale ? renderOpts.sizeScale : 1;
        showLabels = !renderOpts || renderOpts.showLabels !== false;
        currentNodes = nodes.map((n) => {
          const isKing = n.role === 'king';
          const style = styleForNode(n, maxAbsExposure, isKing);
          const sizeFrac = maxAbsExposure > 0 ? Math.min(1, Math.abs(n.exposure) / maxAbsExposure) : 0;
          return {
            strike: n.strike,
            exposure: n.exposure,
            isKing,
            opacity: style.opacity,
            sizeFrac,
            percent: sizeFrac * 100,
            colorBase: colorForNode(n.exposure, maxAbsExposure, 1),
          };
        });
        redraw();
      },
      clear() { currentNodes = []; redraw(); },
      destroy() {
        resizeObserver.disconnect();
        canvas.remove();
      },
    };
  }

  global.createOrbLayer = createOrbLayer;
})(window);
