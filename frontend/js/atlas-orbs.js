// Skylit Heatseeker Terminal — Atlas Orbs rendering layer.
//
// Each strike's orb "band" is a DENSE, continuous caterpillar of small diamonds spanning the chart
// width, fading in from the left (history) to full density from the current bar onward through the
// reserved forward space, ending in a label pill. Rendering only: node lists, exposures and which
// strike is King/Barney come from the controller (atlas.js) — this layer adds zero exposure math.
//
// ORBS BELONG TO A PRICE LEVEL. Positions are never cached in pixels: every paint converts the
// strike through the chart's own `series.priceToCoordinate` at paint time.
//
// WHY THE OLD LAYER DRIFTED. It lived on a separate <canvas> redrawn only from the chart's
// *time-range* subscription. Anything that moves the price->pixel mapping without changing the time
// range (vertical pan / price-axis drag, autoscale after new data or a different visible window,
// resize of the price axis) never redrew it, and even a time-range callback runs BEFORE Lightweight
// Charts recomputes its autoscale for the new window — so the canvas drew with a one-step-old
// mapping. Result: orbs sitting above/below their level until the next unrelated redraw.
//
// FIX. When the library supports series primitives (v4.1+), the orbs are painted INSIDE the chart's
// own render pass (`series.attachPrimitive`), using the exact transform the candles and the axis use
// in that same frame — drift is impossible by construction, with zero extra subscriptions. Only on a
// chart implementation without primitives (the unit-test stub) does it fall back to an overlay
// canvas, which is then driven by a per-frame mapping check instead of the time-range event.
//
// GREEKS ARE NEVER MERGED. renderGroups() takes one group per Greek; each group is drawn and labelled
// on its own: "Pos|Neg <code> <value>" (codes in greeks.js). Labels that would collide are stacked in
// a deterministic order (largest |exposure| first) so none overlap or jitter between updates.

(function (global) {
  'use strict';

  const DIAMOND_SPACING = 7;    // px between diamond centers in the dense band
  const DIAMOND_SIZE_MIN = 2.2;
  const DIAMOND_SIZE_MAX = 4.2;
  const LABEL_H = 15;
  const LABEL_SLOT = 16;        // vertical step when stacking colliding labels

  function createOrbLayer(chartWrapperEl, chart, series, hooks) {
    let groups = [];       // [{ greek, code, nodes:[{ strike, exposure, isKing, isBarney, opacity, sizeFrac, colorBase }] }]
    let sizeScale = 1;     // Orbs window "Orb Size" (50% = 1x)
    let showLabels = true; // Orbs window "Show exposure labels"
    let drawn = {};        // strike key -> y used by the LAST paint (diagnostics / drift tests)
    let lastLabels = [];   // labels of the last paint: { text, y, labelY, greek } (diagnostics / tests)

    const G = global.SkylitGreeks;

    function convergenceX(cssW) {
      const info = hooks && hooks.getBarGeometry ? hooks.getBarGeometry() : null;
      const ts = chart.timeScale();
      if (info && info.lastLogical != null && typeof ts.logicalToCoordinate === 'function') {
        const x = ts.logicalToCoordinate(info.lastLogical);
        if (x != null) return x;
      }
      return cssW * 0.6; // fallback if geometry isn't ready yet
    }

    function drawDiamond(ctx, x, yy, half, color, alpha) {
      ctx.save();
      ctx.translate(x, yy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = color.replace(/[\d.]+\)$/, `${alpha})`);
      ctx.fillRect(-half, -half, half * 2, half * 2);
      ctx.restore();
    }

    function drawPill(ctx, text, xRight, yy, color, textColor) {
      ctx.font = '10px IBM Plex Mono, monospace';
      const padX = 6;
      const w = ctx.measureText(text).width + padX * 2;
      const left = xRight - w, top = yy - LABEL_H / 2;
      ctx.fillStyle = 'rgba(10, 10, 14, 0.82)';
      ctx.fillRect(left, top, w, LABEL_H);
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = color.replace(/[\d.]+\)$/, '0.7)');
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, w - 1, LABEL_H - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = textColor || '#d8dce6';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, left + padX, yy + 0.5);
      return left;
    }

    // Deterministic collision layout on a grid of label ROWS (LABEL_SLOT px apart). Labels are placed
    // largest-|exposure| first (ties: Greek order, then strike). Each label takes its own row first;
    // labels whose bands are close share that row side by side (right to left); when a row is full
    // it spills to the nearest neighbouring row (+1, -1, +2, -2 ...). Rows are LABEL_SLOT apart, so
    // nothing overlaps; nothing is dropped; and since the result depends only on the data, it does
    // not jitter between repaints.
    const ROW_CAPACITY_PX = 330;
    function layoutLabels(ctx, items) {
      ctx.font = '10px IBM Plex Mono, monospace';
      const order = (it) => G.GREEKS.findIndex((g) => g.key === it.greek);
      items.sort((a, b) => Math.abs(b.exposure) - Math.abs(a.exposure) || order(a) - order(b) || a.strike - b.strike);
      const rows = new Map();   // row index -> px already used (from the right edge)
      for (const it of items) {
        const text = G.levelLabel(it.greek, it.exposure);
        const tag = it.king ? 'KING' : it.barney ? 'BARNEY' : '';
        it.w = ctx.measureText(text).width + 12 + (tag ? ctx.measureText(tag).width + 12 + 3 : 0);
        const r0 = Math.round(it.y / LABEL_SLOT);
        let row = r0;
        for (let t = 0; t < 40; t++) {
          const dr = t === 0 ? 0 : (t % 2 ? (t + 1) / 2 : -t / 2);
          const used = rows.get(r0 + dr) || 0;
          if (used === 0 || used + it.w <= ROW_CAPACITY_PX) { row = r0 + dr; break; }
        }
        const used = rows.get(row) || 0;
        it.labelY = row * LABEL_SLOT; it.slot = Math.round((it.labelY - it.y) / LABEL_SLOT);
        it.xRight = it.right - used;
        rows.set(row, used + it.w + 3);
      }
    }

    function drawNodeBand(ctx, node, cssW, xConverge) {
      const yy = series.priceToCoordinate(node.strike);
      if (yy === null) return null;
      drawn[`${node.greek}@${node.strike}`] = yy;
      const king = node.isKing || node.isBarney;
      const half = (DIAMOND_SIZE_MIN + (DIAMOND_SIZE_MAX - DIAMOND_SIZE_MIN) * node.sizeFrac) * sizeScale;
      const spacing = Math.max(half * 2.4, DIAMOND_SPACING * Math.max(0.6, sizeScale));
      const labelW = showLabels ? 112 : 8;
      const bandRight = cssW - labelW;
      for (let x = spacing / 2; x < bandRight; x += spacing) {
        // Fade in across the historical region approaching the current bar; full density from the
        // current bar through the forward (projected) region.
        const fadeSpan = Math.max(40, xConverge * 0.6);
        const fade = Math.max(0, Math.min(1, (x - (xConverge - fadeSpan)) / fadeSpan));
        const alpha = node.opacity * (0.15 + 0.85 * fade);
        if (alpha <= 0.02) continue;
        drawDiamond(ctx, x, yy, king ? half * 1.25 : half, node.colorBase, alpha);
      }
      return { y: yy, bandRight };
    }

    // One paint = one consistent mapping: everything below reads the chart's CURRENT transform.
    function paint(ctx, cssW, cssH) {
      drawn = {}; lastLabels = [];
      if (!groups.length) return;
      const xConverge = convergenceX(cssW);
      const labels = [];
      // Kings/Barneys last so they sit visually on top of ordinary nodes.
      const all = [];
      for (const g of groups) for (const n of g.nodes) all.push({ g, n });
      all.sort((a, b) => ((a.n.isKing || a.n.isBarney) ? 1 : 0) - ((b.n.isKing || b.n.isBarney) ? 1 : 0));
      for (const { g, n } of all) {
        const r = drawNodeBand(ctx, { ...n, greek: g.greek }, cssW, xConverge);
        if (r && showLabels) labels.push({ greek: g.greek, strike: n.strike, exposure: n.exposure, y: r.y, right: r.bandRight - 4, color: n.colorBase, king: n.isKing, barney: n.isBarney });
      }
      if (!labels.length) return;
      layoutLabels(ctx, labels);
      for (const it of labels) {
        lastLabels.push({ text: G.levelLabel(it.greek, it.exposure), greek: it.greek, strike: it.strike, y: it.y, labelY: it.labelY, xRight: it.xRight, w: it.w, king: !!it.king, barney: !!it.barney });
        if (Math.abs(it.labelY - it.y) > 3) {   // thin connector from the band to its (grid-snapped / displaced) label
          ctx.strokeStyle = it.color.replace(/[\d.]+\)$/, '0.45)'); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(it.xRight - 4, it.y); ctx.lineTo(it.xRight - 4, it.labelY); ctx.stroke();
        }
        const left = drawPill(ctx, G.levelLabel(it.greek, it.exposure), it.xRight, it.labelY, it.color);
        if (it.king || it.barney) {   // node-type tag, left of the value pill
          drawPill(ctx, it.king ? 'KING' : 'BARNEY', left - 3, it.labelY, it.color, it.king ? '#ffe08a' : '#e4c1ff');
        }
      }
    }

    // ---- paint target 1: inside the chart's own render pass (series primitive) ----------------
    let primitive = null, requestUpdate = null, canvas = null, ctx2d = null, resizeObserver = null, rafId = 0, lastSig = '';
    if (typeof series.attachPrimitive === 'function') {
      const renderer = {
        draw(target) {
          target.useMediaCoordinateSpace(({ context, mediaSize }) => paint(context, mediaSize.width, mediaSize.height));
        },
      };
      const view = { zOrder: () => 'top', renderer: () => renderer };
      primitive = {
        attached(p) { requestUpdate = p.requestUpdate; },
        detached() { requestUpdate = null; },
        updateAllViews() {},
        paneViews: () => [view],
      };
      series.attachPrimitive(primitive);
    } else {
      // ---- paint target 2 (fallback): overlay canvas for chart implementations without primitives
      canvas = document.createElement('canvas');
      canvas.className = 'atlas-orb-canvas';
      canvas.style.pointerEvents = 'none';
      chartWrapperEl.appendChild(canvas);
      ctx2d = canvas.getContext('2d');
      const redraw = () => {
        ctx2d.save(); ctx2d.setTransform(1, 0, 0, 1, 0, 0); ctx2d.clearRect(0, 0, canvas.width, canvas.height); ctx2d.restore();
        paint(ctx2d, canvas.clientWidth, canvas.clientHeight);
      };
      const resizeCanvas = () => {
        const rect = chartWrapperEl.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
        canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        redraw();
      };
      resizeObserver = new ResizeObserver(resizeCanvas);
      resizeObserver.observe(chartWrapperEl);
      resizeCanvas();
      // Repaint whenever the price->pixel OR time->pixel mapping changes (checked once per frame),
      // not only on time-range events.
      const sig = () => {
        const ts = chart.timeScale();
        const lr = typeof ts.getVisibleLogicalRange === 'function' ? ts.getVisibleLogicalRange() : null;
        return `${lr ? lr.from + ',' + lr.to : ''}|${series.priceToCoordinate(100)}|${series.priceToCoordinate(200)}|${canvas.clientWidth}`;
      };
      const tick = () => { rafId = requestAnimationFrame(tick); const s = sig(); if (s !== lastSig) { lastSig = s; redraw(); } };
      rafId = requestAnimationFrame(tick);
      chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
      var fallbackRedraw = redraw;   // eslint-disable-line no-var
    }
    const refresh = () => { if (primitive) { if (requestUpdate) requestUpdate(); } else fallbackRedraw(); };

    function setGroups(gs, renderOpts) {
      sizeScale = renderOpts && renderOpts.sizeScale ? renderOpts.sizeScale : 1;
      showLabels = !renderOpts || renderOpts.showLabels !== false;
      groups = gs;
      refresh();
    }

    return {
      // groups: [{ greek, nodes:[{ strike, exposure, isKing, isBarney, opacity, sizeFrac, colorBase }] }]
      renderGroups: setGroups,
      clear() { groups = []; refresh(); },
      getDrawn() { return { ...drawn }; },
      getLabels() { return lastLabels.map((l) => ({ ...l })); },   // diagnostics: strike -> y used by the last paint
      destroy() {
        if (primitive && typeof series.detachPrimitive === 'function') series.detachPrimitive(primitive);
        if (rafId) cancelAnimationFrame(rafId);
        if (resizeObserver) resizeObserver.disconnect();
        if (canvas) canvas.remove();
      },
    };
  }

  global.createOrbLayer = createOrbLayer;
})(window);
