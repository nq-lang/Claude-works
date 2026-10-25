// Skylit Heatseeker Terminal — Atlas chart drawing tools.
//
// Tools: Rectangle, Horizontal Line, Short Position, Long Position, Price
// Range (plus
// Cursor, the non-drawing pass-through mode — not itself a "drawing tool"
// but necessary so the user can get back to normal pan/zoom). An earlier
// revision also had a Trend Line tool; dropped per the explicit,
// authoritative tool list this revision was built against.
//
// Lightweight Charts ships no drawing-tools API itself, so this is a small
// canvas overlay built directly against the coordinate-conversion methods
// LWC v4 exposes (`series.priceToCoordinate`/`coordinateToPrice`,
// `chart.timeScale().timeToCoordinate`/`coordinateToTime`) — no external
// drawing library, per the zero-dependency policy (ARCHITECTURE.md §2).
//
// Placement: a horizontal toolbar box (icons side by side) per chart pane,
// with a grip handle at its far left so the whole toolbar can be dragged
// anywhere on the chart; its position is remembered. Per-pane, not global,
// since a drawing is an annotation on one specific chart. Verified this holds even with 4
// simultaneous panes (ARCHITECTURE.md §8/§9).
//
// PERSISTENCE (this revision): drawings are kept per-TICKER, not per-pane
// — switching a pane's ticker swaps in that ticker's own drawing set
// (matching how real charting platforms scope annotations to the symbol,
// not the window showing it: two panes both showing SPY see the same SPY
// drawings). Switching TIMEFRAME does NOT clear drawings, since they're
// anchored to real Unix timestamps (via LWC's coordinate conversion), not
// bar indices, so they still project to sensible pixel positions under a
// different bar spacing. Also persisted to localStorage
// (`skylit:drawings:<TICKER>`) so they survive a page reload — wrapped in
// try/catch since localStorage can throw (private browsing, quota).

(function (global) {
  'use strict';

  // Line-and-node icons (stroke = currentColor) in the same visual language
  // as the reference toolbar: endpoints are small circles.
  const ICON = (inner) => `<svg viewBox="0 0 28 28" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const ICONS = {
    cursor: ICON('<path d="M8 5l12 7.5-5.2 1.4L12.4 20z"/>'),
    rect: ICON('<rect x="7" y="7" width="14" height="14"/><circle cx="7" cy="7" r="2" fill="#1b1b1f"/><circle cx="21" cy="7" r="2" fill="#1b1b1f"/><circle cx="7" cy="21" r="2" fill="#1b1b1f"/><circle cx="21" cy="21" r="2" fill="#1b1b1f"/>'),
    hline: ICON('<circle cx="6" cy="14" r="2" fill="#1b1b1f"/><path d="M8 14h15"/>'),
    short: ICON('<path d="M6 6h16M6 14h16M6 22h16"/><circle cx="6" cy="6" r="2" fill="#1b1b1f"/><circle cx="6" cy="22" r="2" fill="#1b1b1f"/><text x="14" y="19" font-size="8" font-family="monospace" fill="currentColor" stroke="none" text-anchor="middle">S</text>'),
    long: ICON('<path d="M6 6h16M6 14h16M6 22h16"/><circle cx="22" cy="6" r="2" fill="#1b1b1f"/><circle cx="22" cy="22" r="2" fill="#1b1b1f"/><text x="14" y="12" font-size="8" font-family="monospace" fill="currentColor" stroke="none" text-anchor="middle">L</text>'),
    range: ICON('<path d="M5 6h18M5 22h18M14 20V9"/><path d="M11 12l3-3 3 3"/><circle cx="22" cy="6" r="2" fill="#1b1b1f"/><circle cx="6" cy="22" r="2" fill="#1b1b1f"/>'),
    clear: ICON('<path d="M7 9h14M11 9V6h6v3M9 9l1 13h8l1-13M12 13v6M16 13v6"/>'),
  };
  const TOOLS = [
    { id: 'cursor', label: 'Cursor' },
    { id: 'rect', label: 'Rectangle' },
    { id: 'hline', label: 'Horizontal Line' },
    { id: 'short', label: 'Short Position' },
    { id: 'long', label: 'Long Position' },
    { id: 'range', label: 'Price Range \u2014 measure the price area from start to end' },
  ];
  const POS_KEY = 'skylit:drawing-toolbar-pos';

  const STORAGE_PREFIX = 'skylit:drawings:';
  // Default risk:reward when a position tool is drawn with a single drag:
  // the drag distance sets the REWARD (take-profit) distance; the
  // stop-loss distance defaults to half that, i.e. a 2:1 reward:risk
  // setup — a common sane default that's still fully computed/displayed
  // rather than hardcoded to a trivial 1:1.
  const DEFAULT_RISK_FRACTION = 0.5;

  function loadFromStorage(ticker) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + ticker);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  function saveToStorage(ticker, drawings) {
    try {
      localStorage.setItem(STORAGE_PREFIX + ticker, JSON.stringify(drawings));
    } catch (e) { /* private-browsing/quota — drawings stay in-memory only */ }
  }

  function fmtPts(n) {
    return (n >= 0 ? '+' : '') + n.toFixed(2);
  }

  function createDrawingLayer(chartWrapperEl, chart, series, initialTicker) {
    const state = {
      tool: 'cursor',
      currentTicker: initialTicker,
      // Per-ticker drawing sets (this revision) — loaded lazily from
      // localStorage the first time each ticker is seen.
      drawingsByTicker: { [initialTicker]: loadFromStorage(initialTicker) },
      draftStart: null,
      draftEnd: null,
      dragging: false,
    };

    function currentDrawings() {
      if (!state.drawingsByTicker[state.currentTicker]) {
        state.drawingsByTicker[state.currentTicker] = loadFromStorage(state.currentTicker);
      }
      return state.drawingsByTicker[state.currentTicker];
    }
    function persistCurrent() {
      saveToStorage(state.currentTicker, currentDrawings());
    }

    // --- Tool strip: horizontal box + drag grip --------------------------
    const strip = document.createElement('div');
    strip.className = 'atlas-drawing-strip';
    strip.innerHTML =
      '<div class="atlas-drawing-grip" title="Drag to move the toolbar"><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
      TOOLS.map((t) =>
        `<button class="atlas-drawing-tool atlas-drawing-tool-${t.id} ${t.id === 'cursor' ? 'active' : ''}" data-tool="${t.id}" title="${t.label}">${ICONS[t.id]}</button>`
      ).join('') +
      `<button class="atlas-drawing-tool atlas-drawing-clear" title="Clear all drawings on this ticker">${ICONS.clear}</button>`;
    chartWrapperEl.appendChild(strip);

    // Drag the whole toolbar anywhere on the chart. The position is stored
    // as a FRACTION of the chart area so it survives resizes / layout changes.
    function clampStrip(x, y) {
      const wrap = chartWrapperEl.getBoundingClientRect();
      const sr = strip.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(x, Math.max(0, wrap.width - sr.width))),
        y: Math.max(0, Math.min(y, Math.max(0, wrap.height - sr.height))),
      };
    }
    function placeStrip(x, y) {
      const c = clampStrip(x, y);
      strip.style.left = `${c.x}px`;
      strip.style.top = `${c.y}px`;
      return c;
    }
    function applySavedPosition() {
      let pos = null;
      try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { /* ignore */ }
      const wrap = chartWrapperEl.getBoundingClientRect();
      if (pos && Number.isFinite(pos.fx) && Number.isFinite(pos.fy)) placeStrip(pos.fx * wrap.width, pos.fy * wrap.height);
      else placeStrip(12, 12);
    }
    const grip = strip.querySelector('.atlas-drawing-grip');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('dragging');
      const wrap = chartWrapperEl.getBoundingClientRect();
      const sr = strip.getBoundingClientRect();
      const offX = e.clientX - sr.left, offY = e.clientY - sr.top;
      const onMove = (ev) => { placeStrip(ev.clientX - wrap.left - offX, ev.clientY - wrap.top - offY); };
      const onUp = (ev) => {
        grip.releasePointerCapture(ev.pointerId);
        grip.classList.remove('dragging');
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        const w = chartWrapperEl.getBoundingClientRect();
        const r = strip.getBoundingClientRect();
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ fx: (r.left - w.left) / w.width, fy: (r.top - w.top) / w.height }));
        } catch (err) { /* position just isn't remembered */ }
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
    });

    const toolBtns = [...strip.querySelectorAll('.atlas-drawing-tool[data-tool]')];
    toolBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.tool = btn.dataset.tool;
        toolBtns.forEach((b) => b.classList.toggle('active', b === btn));
        canvas.style.pointerEvents = state.tool === 'cursor' ? 'none' : 'auto';
        canvas.style.cursor = state.tool === 'cursor' ? 'default' : 'crosshair';
      });
    });
    strip.querySelector('.atlas-drawing-clear').addEventListener('click', () => {
      state.drawingsByTicker[state.currentTicker] = [];
      persistCurrent();
      redraw();
    });

    // --- Canvas overlay ----------------------------------------------
    const canvas = document.createElement('canvas');
    canvas.className = 'atlas-drawing-canvas';
    canvas.style.pointerEvents = 'none'; // cursor tool by default: clicks pass through to the chart
    chartWrapperEl.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    function resizeCanvas() {
      const rect = chartWrapperEl.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      redraw();
    }

    function toPixel(point) {
      const x = chart.timeScale().timeToCoordinate(point.time);
      const y = series.priceToCoordinate(point.price);
      return { x, y };
    }

    function drawSimpleShape(shape, p1px, p2px) {
      ctx.strokeStyle = 'rgba(94, 189, 255, 0.9)';
      ctx.fillStyle = 'rgba(94, 189, 255, 0.12)';
      ctx.lineWidth = 1.5;
      if (shape === 'hline') {
        ctx.beginPath();
        ctx.moveTo(0, p1px.y);
        ctx.lineTo(canvas.width, p1px.y);
        ctx.stroke();
      } else if (shape === 'rect') {
        const x = Math.min(p1px.x, p2px.x);
        const y = Math.min(p1px.y, p2px.y);
        const w = Math.abs(p2px.x - p1px.x);
        const h = Math.abs(p2px.y - p1px.y);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }
    }

    // Long/Short Position tools (this feature): a single drag from entry
    // (p1) to a reward-defining point (p2). The drag's price DISTANCE sets
    // the take-profit distance; stop-loss defaults to half that distance
    // (2:1 reward:risk) on the opposite side of entry. Draws a profit zone
    // (green) and loss zone (red), an entry line, and a stats label with
    // exact point distances and the computed R:R ratio — this is the
    // "display how many points are set for stop loss / take profit" ask.
    function computePositionLevels(type, p1, p2) {
      const rewardDistance = Math.abs(p2.price - p1.price);
      const riskDistance = rewardDistance * DEFAULT_RISK_FRACTION;
      const isLong = type === 'long';
      const takeProfitPrice = isLong ? p1.price + rewardDistance : p1.price - rewardDistance;
      const stopLossPrice = isLong ? p1.price - riskDistance : p1.price + riskDistance;
      const riskRewardRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
      return { entryPrice: p1.price, takeProfitPrice, stopLossPrice, rewardDistance, riskDistance, riskRewardRatio };
    }

    function drawPositionTool(type, p1, p2) {
      const levels = computePositionLevels(type, p1, p2);
      const x1px = toPixel(p1);
      const x2px = toPixel(p2);
      if (x1px.x === null || x2px.x === null) return;
      const xLeft = Math.min(x1px.x, x2px.x);
      const xRight = Math.max(x1px.x, x2px.x);
      const width = Math.max(2, xRight - xLeft);

      const entryY = series.priceToCoordinate(levels.entryPrice);
      const tpY = series.priceToCoordinate(levels.takeProfitPrice);
      const slY = series.priceToCoordinate(levels.stopLossPrice);
      if (entryY === null || tpY === null || slY === null) return;

      // Profit zone (entry -> take profit): green.
      ctx.fillStyle = 'rgba(34, 197, 94, 0.22)';
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.9)';
      ctx.fillRect(xLeft, Math.min(entryY, tpY), width, Math.abs(tpY - entryY));
      ctx.strokeRect(xLeft, Math.min(entryY, tpY), width, Math.abs(tpY - entryY));

      // Loss zone (entry -> stop loss): red.
      ctx.fillStyle = 'rgba(240, 97, 109, 0.22)';
      ctx.strokeStyle = 'rgba(240, 97, 109, 0.9)';
      ctx.fillRect(xLeft, Math.min(entryY, slY), width, Math.abs(slY - entryY));
      ctx.strokeRect(xLeft, Math.min(entryY, slY), width, Math.abs(slY - entryY));

      // Entry line.
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(xLeft, entryY);
      ctx.lineTo(xRight, entryY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Stats label.
      const label = `${type === 'long' ? 'LONG' : 'SHORT'}  Entry ${levels.entryPrice.toFixed(2)}` +
        `  TP ${levels.takeProfitPrice.toFixed(2)} (${fmtPts(type === 'long' ? levels.rewardDistance : -levels.rewardDistance)} pts)` +
        `  SL ${levels.stopLossPrice.toFixed(2)} (${fmtPts(type === 'long' ? -levels.riskDistance : levels.riskDistance)} pts)` +
        `  R:R 1:${levels.riskRewardRatio.toFixed(2)}`;
      ctx.font = '11px "IBM Plex Mono", monospace';
      const textY = type === 'long' ? Math.min(entryY, tpY) - 6 : Math.max(entryY, tpY) + 14;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      const metrics = ctx.measureText(label);
      ctx.fillRect(xLeft, textY - 11, metrics.width + 8, 15);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, xLeft + 4, textY);
    }

    // Price Range tool: measures the area from where the drag STARTED to
    // where it was EXTENDED — price distance, percent move relative to the
    // start price, and how many bars it spans. Green when the end is above
    // the start, red when below.
    function barsBetween(xa, xb) {
      const ts = chart.timeScale();
      if (typeof ts.logicalToCoordinate !== 'function') return null;
      const c0 = ts.logicalToCoordinate(0), c1 = ts.logicalToCoordinate(1);
      if (c0 == null || c1 == null) return null;
      const perBar = Math.abs(c1 - c0);
      return perBar > 0 ? Math.round(Math.abs(xb - xa) / perBar) : null;
    }
    function drawRangeTool(p1, p2) {
      const a = toPixel(p1), b = toPixel(p2);
      if (a.x === null || b.x === null || a.y === null || b.y === null) return;
      const up = p2.price >= p1.price;
      const rgb = up ? '34, 197, 94' : '240, 97, 109';
      const x = Math.min(a.x, b.x), w = Math.max(2, Math.abs(b.x - a.x));
      const yTop = Math.min(a.y, b.y), h = Math.max(1, Math.abs(b.y - a.y));
      ctx.fillStyle = `rgba(${rgb}, 0.16)`;
      ctx.strokeStyle = `rgba(${rgb}, 0.9)`;
      ctx.lineWidth = 1.25;
      ctx.fillRect(x, yTop, w, h);
      ctx.strokeRect(x, yTop, w, h);
      // Arrow from the start price toward the end price down the middle.
      const cx = x + w / 2;
      ctx.beginPath();
      ctx.moveTo(cx, a.y);
      ctx.lineTo(cx, b.y);
      const dir = b.y < a.y ? 1 : -1;       // pixel y grows downward
      ctx.moveTo(cx - 4, b.y + 6 * dir);
      ctx.lineTo(cx, b.y);
      ctx.lineTo(cx + 4, b.y + 6 * dir);
      ctx.stroke();

      const pts = p2.price - p1.price;
      const pct = p1.price ? (pts / p1.price) * 100 : 0;
      const bars = barsBetween(a.x, b.x);
      const label = `${fmtPts(pts)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)` + (bars != null ? `  \u00b7  ${bars} bars` : '');
      ctx.font = '11px "IBM Plex Mono", monospace';
      const tw = ctx.measureText(label).width + 12;
      const lx = Math.max(2, Math.min(cx - tw / 2, canvas.width - tw - 2));
      const ly = up ? Math.max(2, yTop - 22) : Math.min(canvas.height - 20, yTop + h + 6);
      ctx.fillStyle = 'rgba(12, 13, 20, 0.88)';
      ctx.fillRect(lx, ly, tw, 17);
      ctx.strokeStyle = `rgba(${rgb}, 0.8)`;
      ctx.strokeRect(lx + 0.5, ly + 0.5, tw - 1, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 6, ly + 12);
    }

    function drawOne(d) {
      if (d.type === 'range') { drawRangeTool(d.p1, d.p2); return; }
      if (d.type === 'rect' || d.type === 'hline') {
        drawSimpleShape(d.type, toPixel(d.p1), toPixel(d.p2));
      } else if (d.type === 'long' || d.type === 'short') {
        drawPositionTool(d.type, d.p1, d.p2);
      }
    }

    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const d of currentDrawings()) drawOne(d);
      if (state.dragging && state.draftStart && state.draftEnd) {
        drawOne({ type: state.tool, p1: state.draftStart, p2: state.draftEnd });
      }
    }

    function pointFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const time = chart.timeScale().coordinateToTime(x);
      const price = series.coordinateToPrice(y);
      return { time, price };
    }

    canvas.addEventListener('mousedown', (e) => {
      if (state.tool === 'cursor') return;
      const p = pointFromEvent(e);
      if (p.time === null || p.price === null) return;
      state.dragging = true;
      state.draftStart = { time: p.time, price: p.price };
      state.draftEnd = { time: p.time, price: p.price };
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!state.dragging) return;
      const p = pointFromEvent(e);
      if (p.time === null || p.price === null) return;
      state.draftEnd = { time: p.time, price: p.price };
      redraw();
    });
    window.addEventListener('mouseup', () => {
      if (!state.dragging) return;
      state.dragging = false;
      if (state.draftStart && state.draftEnd) {
        currentDrawings().push({ type: state.tool, p1: state.draftStart, p2: state.draftEnd });
        persistCurrent();
      }
      state.draftStart = null;
      state.draftEnd = null;
      redraw();
    });

    const resizeObserver = new ResizeObserver(() => { resizeCanvas(); applySavedPosition(); });
    resizeObserver.observe(chartWrapperEl);
    resizeCanvas();
    applySavedPosition();

    // Keep drawings anchored to correct time/price as the chart pans/zooms
    // or as timeframe changes (real timestamps still map correctly under
    // a different bar spacing — see file header comment).
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);

    return {
      destroy() {
        resizeObserver.disconnect();
        strip.remove();
        canvas.remove();
      },
      // Called by atlas.js whenever the pane's ticker changes (this
      // feature: per-ticker persistence) — swaps in that ticker's own
      // drawing set (loading from localStorage on first use) and redraws.
      setActiveTicker(ticker) {
        state.currentTicker = ticker;
        redraw();
      },
      getDrawingCount() { return currentDrawings().length; },
      getTool() { return state.tool; },
      clearAll() {
        state.drawingsByTicker[state.currentTicker] = [];
        persistCurrent();
        redraw();
      },
    };
  }

  global.createDrawingLayer = createDrawingLayer;
})(window);
