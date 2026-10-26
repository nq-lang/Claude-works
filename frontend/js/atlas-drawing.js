// Skylit Heatseeker Terminal — Atlas chart drawing tools.
//
// Tools: Rectangle, Horizontal Line, Short Position, Long Position, Price Range (plus Cursor, the
// non-drawing mode used to select/move drawings and to get back to normal pan/zoom).
//
// Lightweight Charts ships no drawing API, so this is a small canvas overlay (zero dependencies,
// ARCHITECTURE.md §2). Rewritten for the chart-optimization work order (WS2):
//
//  A. PLACEMENT PREVIEW. With a tool active, a highlighted (amber, dashed, semi-transparent) ghost of
//     the real shape follows the cursor, with an anchor handle and a price/time readout. For two-point
//     tools the ghost becomes the live in-progress shape between the placed point and the cursor.
//     Placement works both ways: press-drag-release, or click then click.
//  B. DISPLAYED / NOT DISPLAYED. Every drawing has a `visible` flag, editable in the settings dialog
//     (double-click a drawing, or the gear in the drawings list) and the drawings list (eye icon).
//     Hidden drawings are not drawn, not hit-testable/selectable/draggable and never influence
//     snapping. The flag is persisted with the drawing. A toolbar master eye temporarily hides ALL
//     drawings WITHOUT touching per-drawing state (it is not persisted).
//  C. PROJECTION CONSISTENCY / SPEED / SMOOTHNESS / ALIGNMENT.
//       * Two dedicated canvases above the chart: `committed` (finished drawings, redrawn only when the
//         view, the data or the drawings change) and `preview` (ghost + handles, redrawn when the
//         pointer moves). Neither forces a chart redraw, and pointer events never reach them (events
//         are captured on the container), so they cannot disturb the chart's own interaction.
//       * The pointer handlers only record the latest cursor position and schedule ONE
//         requestAnimationFrame; all geometry work happens in the frame, once per frame.
//       * Pixel <-> (time, price) conversion is cached in a "view snapshot" keyed by the chart view
//         (visible logical range, plot size, price-axis probe, bar count) and rebuilt only when that
//         key changes — not per pointer move, not per drawing.
//       * Drawings are anchored to DATA coordinates (Unix time, price) — never pixels — through the
//         shared mapping in chart-coords.js, which is also exact to the right of the newest bar.
//       * Preview and commit share ONE path: `snapPoint()` produces the point, `paintShape()` draws it
//         (mode 'preview' | 'committed' | 'selected'); the committed drawing stores exactly the point
//         the preview showed, so nothing shifts on click.
//       * Live data ticks only mark the committed layer dirty; they never clear or delay the preview.
//
// PERSISTENCE: per TICKER in localStorage (`skylit:drawings:<TICKER>`), try/catch-wrapped. Stored
// drawings from older versions (no id/visible) are normalised on load.

(function (global) {
  'use strict';

  const coords = global.SkylitChartCoords;

  // Line-and-node icons (stroke = currentColor) in the same visual language as the reference toolbar.
  const ICON = (inner) => `<svg viewBox="0 0 28 28" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const SMALL = (inner) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const ICONS = {
    cursor: ICON('<path d="M8 5l12 7.5-5.2 1.4L12.4 20z"/>'),
    rect: ICON('<rect x="7" y="7" width="14" height="14"/><circle cx="7" cy="7" r="2" fill="#1b1b1f"/><circle cx="21" cy="7" r="2" fill="#1b1b1f"/><circle cx="7" cy="21" r="2" fill="#1b1b1f"/><circle cx="21" cy="21" r="2" fill="#1b1b1f"/>'),
    hline: ICON('<circle cx="6" cy="14" r="2" fill="#1b1b1f"/><path d="M8 14h15"/>'),
    short: ICON('<path d="M6 6h16M6 14h16M6 22h16"/><circle cx="6" cy="6" r="2" fill="#1b1b1f"/><circle cx="6" cy="22" r="2" fill="#1b1b1f"/><text x="14" y="19" font-size="8" font-family="monospace" fill="currentColor" stroke="none" text-anchor="middle">S</text>'),
    long: ICON('<path d="M6 6h16M6 14h16M6 22h16"/><circle cx="22" cy="6" r="2" fill="#1b1b1f"/><circle cx="22" cy="22" r="2" fill="#1b1b1f"/><text x="14" y="12" font-size="8" font-family="monospace" fill="currentColor" stroke="none" text-anchor="middle">L</text>'),
    range: ICON('<path d="M5 6h18M5 22h18M14 20V9"/><path d="M11 12l3-3 3 3"/><circle cx="22" cy="6" r="2" fill="#1b1b1f"/><circle cx="6" cy="22" r="2" fill="#1b1b1f"/>'),
    clear: ICON('<path d="M7 9h14M11 9V6h6v3M9 9l1 13h8l1-13M12 13v6M16 13v6"/>'),
    eye: SMALL('<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: SMALL('<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" opacity=".45"/><path d="M3 3l18 18"/>'),
    list: SMALL('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
    gear: SMALL('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  };
  const TOOLS = [
    { id: 'cursor', label: 'Cursor' },
    { id: 'rect', label: 'Rectangle' },
    { id: 'hline', label: 'Horizontal Line' },
    { id: 'short', label: 'Short Position' },
    { id: 'long', label: 'Long Position' },
    { id: 'range', label: 'Price Range — measure the price area from start to end' },
  ];
  const NAMES = { rect: 'Rectangle', hline: 'Horizontal line', short: 'Short position', long: 'Long position', range: 'Price range' };
  const POINTS_NEEDED = { hline: 1, rect: 2, short: 2, long: 2, range: 2 };
  const POS_KEY = 'skylit:drawing-toolbar-pos';
  const STORAGE_PREFIX = 'skylit:drawings:';
  // Default risk:reward when a position tool is drawn with a single drag: the drag distance sets the
  // REWARD distance; the stop-loss distance defaults to half of it (2:1).
  const DEFAULT_RISK_FRACTION = 0.5;
  const DRAG_THRESHOLD_PX = 4;      // movement that turns press-release into a drag placement
  const HANDLE_R = 5, HIT_R = 8, EDGE_HIT = 5;
  const GHOST_DX = 80, GHOST_DY = -50;  // size (px) of the pre-click ghost of a two-point tool
  const PREVIEW_RGB = '255, 209, 102';  // amber: clearly not any committed-drawing colour

  let idSeq = 0;
  const newId = () => `d${Date.now().toString(36)}${(idSeq++).toString(36)}`;

  function normalize(d) {
    if (!d || !POINTS_NEEDED[d.type] || !d.p1 || !d.p2) return null;
    return {
      id: d.id || newId(),
      type: d.type,
      p1: { time: d.p1.time, price: d.p1.price },
      p2: { time: d.p2.time, price: d.p2.price },
      visible: d.visible !== false,   // older saves have no flag => displayed
    };
  }
  function loadFromStorage(ticker) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + ticker);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.map(normalize).filter(Boolean) : [];
    } catch (e) { return []; }
  }
  function saveToStorage(ticker, drawings) {
    try { localStorage.setItem(STORAGE_PREFIX + ticker, JSON.stringify(drawings)); }
    catch (e) { /* private-browsing/quota — drawings stay in memory only */ }
  }

  const fmtPts = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const fmtTime = (t) => (t == null ? '' : new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' '));  // UTC, like the chart axis
  const clone = (d) => ({ ...d, p1: { ...d.p1 }, p2: { ...d.p2 } });

  // Position-tool maths (unchanged): drag distance = reward; stop = half of it on the other side.
  function computePositionLevels(type, p1, p2) {
    const rewardDistance = Math.abs(p2.price - p1.price);
    const riskDistance = rewardDistance * DEFAULT_RISK_FRACTION;
    const isLong = type === 'long';
    return {
      entryPrice: p1.price,
      takeProfitPrice: isLong ? p1.price + rewardDistance : p1.price - rewardDistance,
      stopLossPrice: isLong ? p1.price - riskDistance : p1.price + riskDistance,
      rewardDistance, riskDistance,
      riskRewardRatio: riskDistance > 0 ? rewardDistance / riskDistance : 0,
    };
  }

  // hooks (all optional): { getBarTimes(): number[] ascending, getIntervalSeconds(): number }
  function createDrawingLayer(wrapper, chart, series, initialTicker, hooks) {
    hooks = hooks || {};
    const ts = chart.timeScale();

    // ------------------------------------------------------------------ state
    // DRAWING STATE (this module) is kept apart from VIEW STATE (the chart, owned by atlas.js) and
    // LAYOUT STATE (container size, `size` below).
    const state = {
      tool: 'cursor',
      ticker: initialTicker,
      byTicker: { [initialTicker]: loadFromStorage(initialTicker) },
      placing: null,        // { p1 } after the first point of a two-point tool has been placed
      gesture: null,        // pointer-down in progress: { kind:'place'|'edit', ... }
      cursor: null,         // last pointer position in wrapper pixels { x, y } (null = outside)
      selectedId: null,
      hideAll: false,       // temporary master override (not persisted)
    };
    const drawings = () => (state.byTicker[state.ticker] || (state.byTicker[state.ticker] = loadFromStorage(state.ticker)));
    const persist = () => saveToStorage(state.ticker, drawings());
    const byId = (id) => drawings().find((d) => d.id === id) || null;

    // ------------------------------------------------------- tool strip (DOM)
    const strip = document.createElement('div');
    strip.className = 'atlas-drawing-strip';
    strip.innerHTML =
      '<div class="atlas-drawing-grip" title="Drag to move the toolbar"><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
      TOOLS.map((t) =>
        `<button class="atlas-drawing-tool atlas-drawing-tool-${t.id} ${t.id === 'cursor' ? 'active' : ''}" data-tool="${t.id}" title="${t.label}">${ICONS[t.id]}</button>`
      ).join('') +
      `<button class="atlas-drawing-tool atlas-drawing-clear" title="Clear all drawings on this ticker">${ICONS.clear}</button>` +
      `<span class="atlas-drawing-sep"></span>` +
      `<button class="atlas-drawing-mini atlas-drawing-master-btn" title="Hide / show ALL drawings (temporary; each drawing keeps its own Displayed setting)">${ICONS.eye}</button>` +
      `<button class="atlas-drawing-mini atlas-drawing-list-btn" title="Drawings list">${ICONS.list}</button>`;
    wrapper.appendChild(strip);
    const masterBtn = strip.querySelector('.atlas-drawing-master-btn');
    const listBtn = strip.querySelector('.atlas-drawing-list-btn');

    // Drag the whole toolbar anywhere on the chart; position stored as a fraction of the chart area.
    function clampStrip(x, y) {
      const wrap = wrapper.getBoundingClientRect();
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
      const wrap = wrapper.getBoundingClientRect();
      if (pos && Number.isFinite(pos.fx) && Number.isFinite(pos.fy)) placeStrip(pos.fx * wrap.width, pos.fy * wrap.height);
      else placeStrip(12, 12);
    }
    const grip = strip.querySelector('.atlas-drawing-grip');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('dragging');
      const wrap = wrapper.getBoundingClientRect();
      const sr = strip.getBoundingClientRect();
      const offX = e.clientX - sr.left, offY = e.clientY - sr.top;
      const onMove = (ev) => { placeStrip(ev.clientX - wrap.left - offX, ev.clientY - wrap.top - offY); };
      const onUp = (ev) => {
        grip.releasePointerCapture(ev.pointerId);
        grip.classList.remove('dragging');
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        const w = wrapper.getBoundingClientRect();
        const r = strip.getBoundingClientRect();
        try { localStorage.setItem(POS_KEY, JSON.stringify({ fx: (r.left - w.left) / w.width, fy: (r.top - w.top) / w.height })); }
        catch (err) { /* position just isn't remembered */ }
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
    });

    const toolBtns = [...strip.querySelectorAll('.atlas-drawing-tool[data-tool]')];
    function setTool(id) {
      state.tool = id;
      state.placing = null;
      state.gesture = null;
      toolBtns.forEach((b) => b.classList.toggle('active', b.dataset.tool === id));
      wrapper.classList.toggle('atlas-drawing-armed', id !== 'cursor');
      if (id !== 'cursor') { state.selectedId = null; closeModal(); }
      invalidate(DIRTY_PREVIEW | DIRTY_COMMITTED);
    }
    toolBtns.forEach((btn) => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
    strip.querySelector('.atlas-drawing-clear').addEventListener('click', () => api.clearAll());
    masterBtn.addEventListener('click', () => {
      state.hideAll = !state.hideAll;
      masterBtn.classList.toggle('active', state.hideAll);
      masterBtn.innerHTML = state.hideAll ? ICONS.eyeOff : ICONS.eye;
      if (state.hideAll) { state.selectedId = null; closeModal(); }
      invalidate(DIRTY_COMMITTED);
      refreshList();
    });

    // ------------------------------------------------------------- canvases
    function makeCanvas(cls, z) {
      const c = document.createElement('canvas');
      c.className = cls;
      c.style.pointerEvents = 'none';   // events are captured on the container instead
      c.style.zIndex = String(z);
      wrapper.appendChild(c);
      return c;
    }
    // Order matters: the FIRST .atlas-drawing-canvas is the committed layer (existing tests read it).
    const committedCanvas = makeCanvas('atlas-drawing-canvas atlas-drawing-committed', 10);
    const previewCanvas = makeCanvas('atlas-drawing-canvas atlas-drawing-preview', 11);
    const cctx = committedCanvas.getContext('2d');
    const pctx = previewCanvas.getContext('2d');
    const size = { w: 0, h: 0, dpr: 1, left: 0, top: 0 };   // LAYOUT STATE (css px)

    function resizeCanvases() {
      const rect = wrapper.getBoundingClientRect();
      size.w = Math.max(1, Math.round(rect.width));
      size.h = Math.max(1, Math.round(rect.height));
      size.dpr = global.devicePixelRatio || 1;
      for (const [c, ctx] of [[committedCanvas, cctx], [previewCanvas, pctx]]) {
        c.width = Math.round(size.w * size.dpr);
        c.height = Math.round(size.h * size.dpr);
        c.style.width = `${size.w}px`;
        c.style.height = `${size.h}px`;
        ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      }
      invalidate(DIRTY_COMMITTED | DIRTY_PREVIEW | DIRTY_VIEW);
    }

    // ---------------------------------------------------- view snapshot (cache)
    // pixel <-> (time, price). Everything derived from the chart's current view lives here and is
    // rebuilt ONLY when `key` changes (visible logical range, plot size, price-axis probe, bar count).
    const view = { key: '', x0: 0, pxPerBar: 0, plotW: 0, plotH: 0, times: [], iv: 300, linear: false };
    const PROBE_A = 100, PROBE_B = 200;   // reference prices to detect any price-axis change

    function safe(fn, dflt) { try { const v = fn(); return v === undefined ? dflt : v; } catch (e) { return dflt; } }

    function refreshView() {
      const times = hooks.getBarTimes ? hooks.getBarTimes() : [];
      const iv = hooks.getIntervalSeconds ? hooks.getIntervalSeconds() : 300;
      const canLogical = typeof ts.coordinateToLogical === 'function' && typeof ts.logicalToCoordinate === 'function' && times.length > 0;
      const axisW = safe(() => chart.priceScale('right').width(), 0) || 0;
      const axisH = safe(() => ts.height(), 0) || 0;
      const plotW = Math.max(1, size.w - axisW), plotH = Math.max(1, size.h - axisH);
      const lr = safe(() => ts.getVisibleLogicalRange(), null);
      const pa = safe(() => series.priceToCoordinate(PROBE_A), null), pb = safe(() => series.priceToCoordinate(PROBE_B), null);
      const key = `${lr ? lr.from + ',' + lr.to : 'n'}|${plotW}x${plotH}|${pa}/${pb}|${times.length}:${times.length ? times[0] + '/' + times[times.length - 1] : 0}|${canLogical ? 1 : 0}`;
      if (key === view.key) return false;
      view.key = key; view.times = times; view.iv = iv; view.plotW = plotW; view.plotH = plotH; view.linear = canLogical;
      if (canLogical) {
        const x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(1);
        if (x0 == null || x1 == null || x1 === x0) view.linear = false;
        else { view.x0 = x0; view.pxPerBar = x1 - x0; }
      }
      return true;
    }
    // data -> pixel
    function timeToX(t) {
      if (view.linear) return view.x0 + coords.timeToLogical(view.times, t, view.iv) * view.pxPerBar;
      return ts.timeToCoordinate(t);     // minimal chart implementations: bar-time only
    }
    function priceToY(p) { return series.priceToCoordinate(p); }
    // pixel -> data
    function xToTime(x) {
      if (view.linear) return coords.logicalToTime(view.times, (x - view.x0) / view.pxPerBar, view.iv);
      return ts.coordinateToTime(x);
    }
    function yToPrice(y) { return series.coordinateToPrice(y); }

    // The ONE point funnel for preview and commit. Snapping, if ever added (OHLC / levels / other
    // drawings — hidden ones excluded), goes here so the ghost always equals what is placed.
    function snapPoint(x, y) {
      const time = xToTime(x), price = yToPrice(y);
      if (time == null || price == null) return null;
      return { time, price };
    }
    const inPlot = (x, y) => x >= 0 && y >= 0 && x < view.plotW && y < view.plotH;

    // --------------------------------------------------------------- geometry
    // Pixel geometry of a drawing (same for preview/committed/selected): null if it can't be placed.
    function geom(d) {
      const x1 = timeToX(d.p1.time), x2 = timeToX(d.p2.time);
      const y1 = priceToY(d.p1.price), y2 = priceToY(d.p2.price);
      if (x1 == null || y1 == null) return null;
      if (d.type === 'hline') return { x1, y1, x2: x1, y2: y1, a: { x: x1, y: y1 }, b: null };
      if (x2 == null || y2 == null) return null;
      if (d.type === 'rect') return { x1, y1, x2, y2, a: { x: x1, y: y1 }, b: { x: x2, y: y2 } };
      if (d.type === 'range') return { x1, y1, x2, y2, a: { x: x1, y: y1 }, b: { x: x2, y: y2 } };
      const lv = computePositionLevels(d.type, d.p1, d.p2);
      const entryY = priceToY(lv.entryPrice), tpY = priceToY(lv.takeProfitPrice), slY = priceToY(lv.stopLossPrice);
      if (entryY == null || tpY == null || slY == null) return null;
      return { x1, y1, x2, y2, lv, entryY, tpY, slY, a: { x: x1, y: entryY }, b: { x: x2, y: tpY } };
    }

    // ----------------------------------------------------------------- painting
    // mode: 'committed' | 'selected' | 'preview'. One code path for all three.
    function paintShape(ctx, d, g, mode) {
      const prev = mode === 'preview';
      const fillMul = prev ? 0.7 : 1;
      const lw = prev ? 2 : (mode === 'selected' ? 2 : 1.5);
      const col = (rgb, a) => `rgba(${prev ? PREVIEW_RGB : rgb}, ${a})`;
      ctx.lineWidth = lw;
      ctx.setLineDash(prev ? [6, 4] : []);
      if (d.type === 'hline') {
        ctx.strokeStyle = col('94, 189, 255', prev ? 1 : 0.9);
        ctx.beginPath(); ctx.moveTo(0, g.y1); ctx.lineTo(view.plotW, g.y1); ctx.stroke();
      } else if (d.type === 'rect') {
        const x = Math.min(g.x1, g.x2), y = Math.min(g.y1, g.y2), w = Math.abs(g.x2 - g.x1), h = Math.abs(g.y2 - g.y1);
        ctx.fillStyle = col('94, 189, 255', 0.12 * fillMul + (prev ? 0.05 : 0));
        ctx.strokeStyle = col('94, 189, 255', prev ? 1 : 0.9);
        ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      } else if (d.type === 'long' || d.type === 'short') {
        const xl = Math.min(g.x1, g.x2), w = Math.max(2, Math.abs(g.x2 - g.x1)), xr = xl + w;
        ctx.fillStyle = col('34, 197, 94', 0.22 * fillMul); ctx.strokeStyle = col('34, 197, 94', prev ? 1 : 0.9);
        ctx.fillRect(xl, Math.min(g.entryY, g.tpY), w, Math.abs(g.tpY - g.entryY));
        ctx.strokeRect(xl, Math.min(g.entryY, g.tpY), w, Math.abs(g.tpY - g.entryY));
        ctx.fillStyle = col('240, 97, 109', 0.22 * fillMul); ctx.strokeStyle = col('240, 97, 109', prev ? 1 : 0.9);
        ctx.fillRect(xl, Math.min(g.entryY, g.slY), w, Math.abs(g.slY - g.entryY));
        ctx.strokeRect(xl, Math.min(g.entryY, g.slY), w, Math.abs(g.slY - g.entryY));
        ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.moveTo(xl, g.entryY); ctx.lineTo(xr, g.entryY); ctx.stroke(); ctx.setLineDash([]);
        const lv = g.lv, isLong = d.type === 'long';
        const label = `${isLong ? 'LONG' : 'SHORT'}  Entry ${lv.entryPrice.toFixed(2)}` +
          `  TP ${lv.takeProfitPrice.toFixed(2)} (${fmtPts(isLong ? lv.rewardDistance : -lv.rewardDistance)} pts)` +
          `  SL ${lv.stopLossPrice.toFixed(2)} (${fmtPts(isLong ? -lv.riskDistance : lv.riskDistance)} pts)` +
          `  R:R 1:${lv.riskRewardRatio.toFixed(2)}`;
        ctx.font = '11px "IBM Plex Mono", monospace';
        const textY = isLong ? Math.min(g.entryY, g.tpY) - 6 : Math.max(g.entryY, g.tpY) + 14;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(xl, textY - 11, tw + 8, 15);
        ctx.fillStyle = '#fff'; ctx.fillText(label, xl + 4, textY);
      } else if (d.type === 'range') {
        const up = d.p2.price >= d.p1.price;
        const rgb = up ? '34, 197, 94' : '240, 97, 109';
        const x = Math.min(g.x1, g.x2), w = Math.max(2, Math.abs(g.x2 - g.x1));
        const yTop = Math.min(g.y1, g.y2), h = Math.max(1, Math.abs(g.y2 - g.y1));
        ctx.fillStyle = col(rgb, 0.16 * fillMul); ctx.strokeStyle = col(rgb, prev ? 1 : 0.9);
        ctx.lineWidth = prev ? 2 : 1.25;
        ctx.fillRect(x, yTop, w, h); ctx.strokeRect(x, yTop, w, h);
        const cx = x + w / 2, dir = g.y2 < g.y1 ? 1 : -1;   // pixel y grows downward
        ctx.beginPath();
        ctx.moveTo(cx, g.y1); ctx.lineTo(cx, g.y2);
        ctx.moveTo(cx - 4, g.y2 + 6 * dir); ctx.lineTo(cx, g.y2); ctx.lineTo(cx + 4, g.y2 + 6 * dir);
        ctx.stroke();
        const pts = d.p2.price - d.p1.price, pct = d.p1.price ? (pts / d.p1.price) * 100 : 0;
        const bars = view.linear && view.pxPerBar ? Math.round(Math.abs(g.x2 - g.x1) / Math.abs(view.pxPerBar)) : null;
        const label = `${fmtPts(pts)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)` + (bars != null ? `  ·  ${bars} bars` : '');
        ctx.font = '11px "IBM Plex Mono", monospace';
        const tw = ctx.measureText(label).width + 12;
        const lx = Math.max(2, Math.min(cx - tw / 2, view.plotW - tw - 2));
        const ly = up ? Math.max(2, yTop - 22) : Math.min(view.plotH - 20, yTop + h + 6);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(12, 13, 20, 0.88)'; ctx.fillRect(lx, ly, tw, 17);
        ctx.strokeStyle = col(rgb, 0.8); ctx.lineWidth = 1; ctx.strokeRect(lx + 0.5, ly + 0.5, tw - 1, 16);
        ctx.fillStyle = '#fff'; ctx.fillText(label, lx + 6, ly + 12);
      }
      ctx.setLineDash([]);
    }
    function paintHandle(ctx, x, y, hot) {
      ctx.beginPath(); ctx.arc(x, y, HANDLE_R + (hot ? 1.5 : 0), 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = `rgb(${PREVIEW_RGB})`; ctx.stroke();
    }
    function paintReadout(ctx, x, y, p) {
      const label = `${p.price.toFixed(2)}  ·  ${fmtTime(p.time)}`;
      ctx.font = '11px "IBM Plex Mono", monospace';
      const tw = ctx.measureText(label).width + 12;
      let lx = x + 12, ly = y - 26;
      if (lx + tw > view.plotW) lx = x - tw - 12;
      if (ly < 2) ly = y + 12;
      ctx.fillStyle = 'rgba(12, 13, 20, 0.92)'; ctx.fillRect(lx, ly, tw, 17);
      ctx.strokeStyle = `rgba(${PREVIEW_RGB}, 0.9)`; ctx.lineWidth = 1; ctx.strokeRect(lx + 0.5, ly + 0.5, tw - 1, 16);
      ctx.fillStyle = `rgb(${PREVIEW_RGB})`; ctx.fillText(label, lx + 6, ly + 12);
    }

    // ------------------------------------------------------------ render loop
    // At most ONE frame of work per animation frame; handlers only set dirty bits.
    const DIRTY_COMMITTED = 1, DIRTY_PREVIEW = 2, DIRTY_VIEW = 4;
    let dirty = 0, rafId = 0, destroyed = false;
    const stats = { committedFrames: 0, previewFrames: 0, previewMsAvg: 0 };
    let lastPreview = null;   // { type, p1, p2, mode } as last painted — for tests / diagnostics

    function invalidate(bits) {
      dirty |= bits;
      if (!rafId && !destroyed) rafId = requestAnimationFrame(frame);
    }

    // The shape currently being edited (move/resize) replaces the stored one only while editing.
    function effective(d) { return state.gesture && state.gesture.kind === 'edit' && state.gesture.id === d.id ? state.gesture.temp : d; }

    function renderCommitted() {
      stats.committedFrames++;
      cctx.clearRect(0, 0, size.w, size.h);
      if (state.hideAll) return;
      cctx.save();
      cctx.beginPath(); cctx.rect(0, 0, view.plotW, view.plotH); cctx.clip();   // never paint over the axes
      for (const d0 of drawings()) {
        if (d0.visible === false) continue;
        const d = effective(d0);
        const g = geom(d);
        if (!g) continue;
        const sel = d0.id === state.selectedId;
        paintShape(cctx, d, g, sel ? 'selected' : 'committed');
        if (sel) { paintHandle(cctx, g.a.x, g.a.y); if (g.b) paintHandle(cctx, g.b.x, g.b.y); }
      }
      cctx.restore();
    }

    function previewShape() {
      if (state.tool === 'cursor' || !state.cursor || state.gesture && state.gesture.kind === 'edit') return null;
      const { x, y } = state.cursor;
      if (!inPlot(x, y)) return null;
      const P = snapPoint(x, y);
      if (!P) return null;
      let p2 = P;
      if (POINTS_NEEDED[state.tool] === 2) {
        if (state.placing) { p2 = P; }
        else {
          // Before the first click: a default-size ghost so the user sees the real shape, anchored at the cursor.
          p2 = snapPoint(x + GHOST_DX, y + GHOST_DY) || P;
        }
      }
      const p1 = state.placing ? state.placing.p1 : P;
      return { type: state.tool, p1, p2, anchor: P };
    }

    function renderPreview() {
      const t0 = performance.now();
      pctx.clearRect(0, 0, size.w, size.h);
      if (state.tool === 'cursor' && !state.gesture && state.cursor) {
        // Hover feedback (pointer cursor over a drawing) is computed here, once per frame — never in the move handler.
        const over = drawings().length ? !!hitTest(state.cursor.x, state.cursor.y) : false;
        if (over !== wrapper.classList.contains('atlas-drawing-hover')) wrapper.classList.toggle('atlas-drawing-hover', over);
      }
      const s = previewShape();
      lastPreview = null;
      if (s && !state.hideAll) {
        pctx.save();
        pctx.beginPath(); pctx.rect(0, 0, view.plotW, view.plotH); pctx.clip();
        const g = geom(s);
        if (g) {
          paintShape(pctx, s, g, 'preview');
          paintHandle(pctx, g.a.x, g.a.y, !state.placing);
          if (state.placing && g.b) paintHandle(pctx, g.b.x, g.b.y, true);
          const ax = state.placing ? (g.b ? g.b.x : g.a.x) : g.a.x, ay = state.placing ? (g.b ? g.b.y : g.a.y) : g.a.y;
          paintReadout(pctx, ax, ay, state.placing ? s.p2 : s.p1);
          lastPreview = { type: s.type, p1: s.p1, p2: s.p2, placing: !!state.placing };
        }
        pctx.restore();
      }
      stats.previewFrames++;
      stats.previewMsAvg += (performance.now() - t0 - stats.previewMsAvg) * 0.1;
    }

    function frame() {
      rafId = 0;
      if (destroyed) return;
      if (refreshView()) dirty |= DIRTY_COMMITTED | DIRTY_PREVIEW;   // view changed: re-project everything
      const bits = dirty; dirty = 0;
      if (bits & DIRTY_COMMITTED) renderCommitted();
      if (bits & DIRTY_PREVIEW) renderPreview();
    }

    // ----------------------------------------------------------- hit testing
    function distToSegment(px, py, ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }
    function hitShape(d, g, x, y) {
      if (d.type === 'hline') return Math.abs(y - g.y1) <= EDGE_HIT;
      if (d.type === 'rect' || d.type === 'range') {
        return x >= Math.min(g.x1, g.x2) - EDGE_HIT && x <= Math.max(g.x1, g.x2) + EDGE_HIT &&
               y >= Math.min(g.y1, g.y2) - EDGE_HIT && y <= Math.max(g.y1, g.y2) + EDGE_HIT;
      }
      const xl = Math.min(g.x1, g.x2), xr = Math.max(xl + 2, Math.max(g.x1, g.x2));
      const top = Math.min(g.entryY, g.tpY, g.slY), bot = Math.max(g.entryY, g.tpY, g.slY);
      return x >= xl - EDGE_HIT && x <= xr + EDGE_HIT && y >= top - EDGE_HIT && y <= bot + EDGE_HIT;
    }
    // Only VISIBLE drawings are considered; hidden ones can't be selected, dragged or resized.
    function hitTest(x, y) {
      if (state.hideAll) return null;
      const sel = state.selectedId && byId(state.selectedId);
      if (sel && sel.visible !== false) {
        const g = geom(sel);
        if (g) {
          if (g.b && Math.hypot(x - g.b.x, y - g.b.y) <= HIT_R) return { id: sel.id, mode: 'resize', anchor: 'p2' };
          if (Math.hypot(x - g.a.x, y - g.a.y) <= HIT_R && sel.type !== 'hline') return { id: sel.id, mode: 'resize', anchor: 'p1' };
        }
      }
      const list = drawings();
      for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i];
        if (d.visible === false) continue;
        const g = geom(d);
        if (g && hitShape(d, g, x, y)) return { id: d.id, mode: 'move' };
      }
      return null;
    }

    // ------------------------------------------------------------ interaction
    const isUi = (t) => strip.contains(t) || (modalEl && modalEl.contains(t)) || (listEl && listEl.contains(t));
    function localXY(e) {
      // Rect is re-read at most once per gesture start / frame-independent move via the cached `size`
      // offsets, so pointer moves never trigger layout.
      return { x: e.clientX - size.left, y: e.clientY - size.top };
    }
    function syncOrigin() { const r = wrapper.getBoundingClientRect(); size.left = r.left; size.top = r.top; }

    function onDown(e) {
      if (e.button !== 0 || isUi(e.target)) return;
      syncOrigin();
      refreshView();
      const { x, y } = localXY(e);
      if (!inPlot(x, y)) return;                         // price/time axes belong to the chart
      state.cursor = { x, y };
      if (state.tool !== 'cursor') {
        e.stopPropagation(); e.preventDefault();         // no chart pan while placing
        const P = snapPoint(x, y);
        if (!P) return;
        const startedPlacing = !!state.placing;
        if (!state.placing) state.placing = { p1: P };
        state.gesture = { kind: 'place', startedPlacing, downX: x, downY: y };
        invalidate(DIRTY_PREVIEW);
        return;
      }
      const hit = hitTest(x, y);
      if (!hit) {
        if (state.selectedId) { state.selectedId = null; closeModal(); invalidate(DIRTY_COMMITTED); refreshList(); }
        return;                                          // let the chart pan as usual
      }
      e.stopPropagation(); e.preventDefault();
      state.selectedId = hit.id;
      const d = byId(hit.id), g = geom(d);
      state.gesture = { kind: 'edit', id: hit.id, mode: hit.mode, anchor: hit.anchor, downX: x, downY: y, temp: clone(d),
                        ax: g.x1, ay: g.y1, bx: g.x2, by: g.y2, moved: false };
      invalidate(DIRTY_COMMITTED | DIRTY_PREVIEW);
      refreshList();
    }

    function onMove(e) {
      // Only record the pointer; all work happens in the next animation frame.
      const x = e.clientX - size.left, y = e.clientY - size.top;
      state.cursor = { x, y };
      const gs = state.gesture;
      if (gs && gs.kind === 'edit') {
        const dx = x - gs.downX, dy = y - gs.downY;
        if (!gs.moved && Math.hypot(dx, dy) < 2) return;
        gs.moved = true;
        const t = gs.temp, src = byId(gs.id);
        const conv = (px, py) => snapPoint(px, py);
        if (gs.mode === 'resize') {
          const P = conv(x, y); if (P) t[gs.anchor] = P;
        } else {
          const A = conv(gs.ax + dx, gs.ay + dy), B = conv(gs.bx + dx, gs.by + dy);
          if (A && B) { t.p1 = A; t.p2 = src.type === 'hline' ? A : B; }
        }
        invalidate(DIRTY_COMMITTED);
        return;
      }
      invalidate(DIRTY_PREVIEW);
    }

    function commit(type, p1, p2) {
      const d = { id: newId(), type, p1: { ...p1 }, p2: { ...p2 }, visible: true };
      drawings().push(d);
      persist();
      invalidate(DIRTY_COMMITTED | DIRTY_PREVIEW);
      refreshList();
      return d;
    }

    function onUp(e) {
      const gs = state.gesture;
      if (!gs) return;
      state.gesture = null;
      syncOrigin();
      const x = e.clientX - size.left, y = e.clientY - size.top;
      if (gs.kind === 'edit') {
        if (gs.moved) { const d = byId(gs.id); d.p1 = gs.temp.p1; d.p2 = gs.temp.p2; persist(); }
        invalidate(DIRTY_COMMITTED | DIRTY_PREVIEW);
        return;
      }
      const P = snapPoint(Math.max(0, Math.min(x, view.plotW - 1)), Math.max(0, Math.min(y, view.plotH - 1)));
      const type = state.tool;
      if (!state.placing || !P || type === 'cursor') { state.placing = null; invalidate(DIRTY_PREVIEW); return; }
      const moved = Math.hypot(x - gs.downX, y - gs.downY) > DRAG_THRESHOLD_PX;
      if (POINTS_NEEDED[type] === 1) { commit(type, state.placing.p1, state.placing.p1); state.placing = null; }
      else if (!gs.startedPlacing && !moved) { /* first click of click-click placement: keep the anchor */ }
      else { commit(type, state.placing.p1, P); state.placing = null; }
      invalidate(DIRTY_PREVIEW);
    }

    function onKey(e) {
      const typing = e.target && /^(input|textarea|select)$/i.test(e.target.tagName);
      if (e.key === 'Escape') {
        if (state.gesture && state.gesture.kind === 'edit') { state.gesture = null; invalidate(DIRTY_COMMITTED); }
        else if (state.placing) { state.placing = null; state.gesture = null; invalidate(DIRTY_PREVIEW); }
        else if (modalEl) closeModal();
        else if (state.selectedId) { state.selectedId = null; invalidate(DIRTY_COMMITTED); refreshList(); }
        else if (state.tool !== 'cursor') setTool('cursor');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId && !typing) {
        api.deleteDrawing(state.selectedId);
      }
    }
    function onLeave() { state.cursor = null; invalidate(DIRTY_PREVIEW); }
    function onDbl(e) {
      if (isUi(e.target) || state.tool !== 'cursor') return;
      syncOrigin();
      const { x, y } = localXY(e);
      const hit = hitTest(x, y);
      if (hit) { e.stopPropagation(); state.selectedId = hit.id; invalidate(DIRTY_COMMITTED); openModal(hit.id); }
    }

    wrapper.addEventListener('mousedown', onDown, true);
    wrapper.addEventListener('mousemove', onMove, true);
    wrapper.addEventListener('mouseleave', onLeave);
    wrapper.addEventListener('dblclick', onDbl, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);

    // ----------------------------------------------- settings dialog + list UI
    let modalEl = null, listEl = null;
    function labelOf(d, i) { return `${NAMES[d.type]} · ${d.p1.price.toFixed(2)}${d.type === 'hline' ? '' : ' → ' + d.p2.price.toFixed(2)}`; }

    function setVisible(id, visible) {
      const d = byId(id); if (!d) return;
      d.visible = !!visible;
      if (!d.visible && state.selectedId === id) state.selectedId = null;   // hidden => not selectable
      if (!d.visible && state.gesture && state.gesture.id === id) state.gesture = null;
      persist();
      invalidate(DIRTY_COMMITTED | DIRTY_PREVIEW);
      refreshList();
    }

    function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }
    function openModal(id) {
      const d = byId(id); if (!d) return;
      closeModal();
      modalEl = document.createElement('div');
      modalEl.className = 'atlas-drawing-modal';
      modalEl.innerHTML = `
        <div class="atlas-drawing-modal-head"><span class="atlas-drawing-modal-title"></span>
          <button class="atlas-drawing-modal-close" title="Close">&times;</button></div>
        <label class="atlas-drawing-switch"><input type="checkbox" class="atlas-drawing-visible-toggle">
          <span class="atlas-drawing-switch-track"></span><span class="atlas-drawing-switch-label"></span></label>
        <div class="atlas-drawing-modal-meta"></div>
        <div class="atlas-drawing-modal-actions"><button class="atlas-drawing-delete">Delete drawing</button></div>`;
      const title = modalEl.querySelector('.atlas-drawing-modal-title');
      const toggle = modalEl.querySelector('.atlas-drawing-visible-toggle');
      const lbl = modalEl.querySelector('.atlas-drawing-switch-label');
      const meta = modalEl.querySelector('.atlas-drawing-modal-meta');
      const sync = () => {
        const cur = byId(id); if (!cur) return;
        title.textContent = NAMES[cur.type];
        toggle.checked = cur.visible !== false;
        lbl.textContent = toggle.checked ? 'Displayed' : 'Not displayed';
        meta.textContent = `${fmtTime(cur.p1.time)} @ ${cur.p1.price.toFixed(2)}` + (cur.type === 'hline' ? '' : `  →  ${fmtTime(cur.p2.time)} @ ${cur.p2.price.toFixed(2)}`);
      };
      sync();
      toggle.addEventListener('change', () => { setVisible(id, toggle.checked); sync(); });   // applies immediately
      modalEl.querySelector('.atlas-drawing-modal-close').addEventListener('click', closeModal);
      modalEl.querySelector('.atlas-drawing-delete').addEventListener('click', () => { api.deleteDrawing(id); });
      wrapper.appendChild(modalEl);
    }

    function refreshList() {
      if (!listEl) return;
      const list = drawings();
      listEl.innerHTML = list.length ? '' : '<div class="atlas-drawing-list-empty">No drawings on this ticker</div>';
      list.forEach((d, i) => {
        const row = document.createElement('div');
        const hidden = d.visible === false;
        row.className = 'atlas-drawing-row' + (hidden ? ' hidden' : '') + (d.id === state.selectedId ? ' selected' : '');
        row.dataset.id = d.id;
        row.innerHTML = `<button class="atlas-drawing-eye" title="${hidden ? 'Show' : 'Hide'} drawing">${hidden ? ICONS.eyeOff : ICONS.eye}</button>` +
          `<span class="atlas-drawing-row-label"></span><button class="atlas-drawing-gear" title="Settings">${ICONS.gear}</button>`;
        row.querySelector('.atlas-drawing-row-label').textContent = labelOf(d, i);
        row.querySelector('.atlas-drawing-eye').addEventListener('click', (e) => { e.stopPropagation(); setVisible(d.id, d.visible === false); });
        row.querySelector('.atlas-drawing-gear').addEventListener('click', (e) => { e.stopPropagation(); openModal(d.id); });
        row.addEventListener('click', () => { if (d.visible !== false) { state.selectedId = d.id; invalidate(DIRTY_COMMITTED); refreshList(); } });
        listEl.appendChild(row);
      });
    }
    listBtn.addEventListener('click', () => {
      if (listEl) { listEl.remove(); listEl = null; listBtn.classList.remove('active'); return; }
      listEl = document.createElement('div');
      listEl.className = 'atlas-drawing-list';
      const sr = strip.getBoundingClientRect(), wr = wrapper.getBoundingClientRect();
      listEl.style.left = `${Math.max(0, sr.left - wr.left)}px`;
      listEl.style.top = `${sr.bottom - wr.top + 6}px`;
      wrapper.appendChild(listEl);
      listBtn.classList.add('active');
      refreshList();
    });

    // ----------------------------------------------------- lifecycle / wiring
    const resizeObserver = new ResizeObserver(() => { syncOrigin(); resizeCanvases(); applySavedPosition(); });
    resizeObserver.observe(wrapper);
    syncOrigin();
    resizeCanvases();
    applySavedPosition();

    // View changes arrive as events (pan/zoom/scroll) ...
    const onRange = () => invalidate(DIRTY_VIEW);
    if (typeof ts.subscribeVisibleLogicalRangeChange === 'function') ts.subscribeVisibleLogicalRangeChange(onRange);
    else ts.subscribeVisibleTimeRangeChange(onRange);
    // ... except price-axis changes (axis drag, autoscale after new data), which LWC doesn't announce.
    // atlas.js calls notifyViewMayHaveChanged() after data lands, wheel/mouse activity re-checks the
    // snapshot, and a slow safety probe (the snapshot key is a handful of cached reads) covers the rest.
    const probe = setInterval(() => invalidate(DIRTY_VIEW), 250);
    const onWheelish = () => invalidate(DIRTY_VIEW);
    wrapper.addEventListener('wheel', onWheelish, { passive: true });
    wrapper.addEventListener('mouseup', onWheelish, true);
    wrapper.addEventListener('mousemove', (e) => { if (e.buttons) invalidate(DIRTY_VIEW); }, true);   // axis drags

    const api = {
      destroy() {
        destroyed = true;
        if (rafId) cancelAnimationFrame(rafId);
        clearInterval(probe);
        resizeObserver.disconnect();
        wrapper.removeEventListener('mousedown', onDown, true);
        wrapper.removeEventListener('mousemove', onMove, true);
        wrapper.removeEventListener('mouseleave', onLeave);
        wrapper.removeEventListener('dblclick', onDbl, true);
        window.removeEventListener('mouseup', onUp, true);
        window.removeEventListener('keydown', onKey, true);
        if (typeof ts.unsubscribeVisibleLogicalRangeChange === 'function') ts.unsubscribeVisibleLogicalRangeChange(onRange);
        closeModal();
        if (listEl) listEl.remove();
        strip.remove(); committedCanvas.remove(); previewCanvas.remove();
      },
      // Called by atlas.js whenever the pane's ticker changes: swap in that ticker's own drawing set.
      setActiveTicker(ticker) {
        state.ticker = ticker;
        state.placing = null; state.gesture = null; state.selectedId = null;
        closeModal();
        invalidate(DIRTY_COMMITTED | DIRTY_PREVIEW);
        refreshList();
      },
      // Called by atlas.js after any data/overlay update that can change the view (new bars, autoscale).
      notifyViewMayHaveChanged() { invalidate(DIRTY_VIEW); },
      getDrawingCount() { return drawings().length; },
      getDrawings() { return drawings().map(clone); },
      getTool() { return state.tool; },
      setTool,
      setDrawingVisible(id, visible) { setVisible(id, visible); },
      deleteDrawing(id) {
        const i = drawings().findIndex((d) => d.id === id);
        if (i < 0) return;
        drawings().splice(i, 1);
        if (state.selectedId === id) state.selectedId = null;
        closeModal(); persist(); invalidate(DIRTY_COMMITTED | DIRTY_PREVIEW); refreshList();
      },
      clearAll() {
        state.byTicker[state.ticker] = [];
        state.selectedId = null; closeModal();
        persist(); invalidate(DIRTY_COMMITTED | DIRTY_PREVIEW); refreshList();
      },
      // Diagnostics (tests, profiling): what the overlay last painted and how often.
      getStats() { return { ...stats }; },
      getPreview() { return lastPreview; },
      pixelOf(p) { refreshView(); return { x: timeToX(p.time), y: priceToY(p.price) }; },
      pointAt(x, y) { refreshView(); return snapPoint(x, y); },
    };
    return api;
  }

  global.createDrawingLayer = createDrawingLayer;
})(window);
