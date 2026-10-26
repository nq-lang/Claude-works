// Skylit Heatseeker Terminal — Atlas chart controller (Part C).
//
// Owns the Lightweight Charts candlestick pane and everything drawn on top
// of it: Orbs (options node overlay, reusing the exact same
// SkylitColorScale + SkylitNodeUtils modules as the Heatmap sidecar so the
// two views can never show conflicting colors/filters for the same data),
// Dark Pool levels, and a Flow histogram pane.
//
// ARCHITECTURE (this revision): per the explicit correction, the ONLY
// controls allowed to live in a pane's own on-chart header are the ticker
// selector and its live price/%-change display. Every other control
// (interval, exposure type, expiration scope, node count, Orbs on/off +
// size/opacity, Dark Pool, Flow, Live/pan-tracking) is driven EXTERNALLY
// by a single global toolbar (see atlas-layout.js) via the setter methods
// on this controller's returned handle — the same "one shared toolbar
// drives every pane" pattern Quadrinity established for heatmap panels.
// This controller renders NO toolbar UI itself beyond the minimal header.
//
// Data flow, per ticker/timeframe change (a full context reload):
//   1. GET /api/candles          -> full bar history -> series.setData()
//   2. GET /api/heatmap          -> node board for Orbs
//   3. GET /api/darkpool         -> dark pool levels (if toggled on)
//   4. GET /api/flow             -> flow bars (if toggled on)
// Ongoing, every ~1s: GET /api/candles/latest -> series.update() on just
// the last 1-2 bars — tick-by-tick, no full redraw.

(function (global) {
  'use strict';

  const { exposureToOrbColor } = global.SkylitColorScale;
  const { applyNodeLimit } = global.SkylitNodeUtils;

  function createAtlasController(chartContainerEl, headerEl, opts) {
    const state = {
      ticker: opts.ticker,
      interval: opts.interval || '5m',
      exposureType: opts.exposureType || 'GEX',
      nodeLimit: opts.nodeLimit !== undefined ? opts.nodeLimit : 10,
      expiration: opts.expiration || '0dte',
      expirationN: opts.expirationN || 1,
      showOrbs: opts.showOrbs !== undefined ? opts.showOrbs : true,
      showDarkPool: !!opts.showDarkPool,
      showFlow: !!opts.showFlow,
      // Atlas Projections (Beta). projectionWindow 0 = timeframe default; the
      // BACKEND clamps it to the timeframe's max (Part III) and reports the
      // effective window back through onProjectionMeta.
      showProjection: !!opts.showProjection,
      projectionDte: opts.projectionDte || 0,
      // Projections has its OWN Greek selection (Projections window), separate
      // from the Expiry Data window's selection that drives Orbs.
      projectionExposure: opts.projectionExposure || 'GEX',
      barTimes: [],
      projectionRange: null,
      orbRange: null,
      // Orb rendering settings (this correction — the full 6-control set,
      // not just size/opacity). Defaults match the reference UI exactly.
      // See loadOrbs() for exactly how these compose into a rendered
      // line width/opacity per node.
      orbSettings: opts.orbSettings || { size: 50, minClamp: 2, maxClamp: 4, minOpacity: 35, maxOpacity: 60, kingOpacity: 100,
        posColor: '#fcbf24', negColor: '#a855f7' },
      tickerOptions: opts.tickerOptions || [opts.ticker],
      darkPoolLines: [],
      lastBarTime: null,
      candlePoll: null,
      slowPoll: null,
      userHasPanned: false,
      gestureActive: false,       // user is mid-drag/pan on the chart: data updates are held back
      pendingBars: new Map(),     // time -> bar, collected while a gesture is active
      viewContext: null,   // 'ticker|interval' the chart view currently belongs to
      rightOffset: 0,      // last rightOffset applied (projection room), change-only
      // For the on-chart price/%-change header — derived from the loaded
      // candle series itself (first bar's open vs latest close), so no
      // extra endpoint is needed just to show a price.
      seriesOpenAnchor: null,
    };

    // --- Chart + series setup ----------------------------------------
    const chart = LightweightCharts.createChart(chartContainerEl, {
      layout: {
        background: { type: 'solid', color: '#0a0a0d' },
        textColor: '#8a8a94',
        fontFamily: 'IBM Plex Mono, monospace',
      },
      grid: { vertLines: { color: '#15151b' }, horzLines: { color: '#15151b' } },
      rightPriceScale: { borderColor: '#1e1e24' },
      timeScale: { borderColor: '#1e1e24', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#cfd3da', downColor: '#4a4e5a',
      borderUpColor: '#cfd3da', borderDownColor: '#4a4e5a',
      wickUpColor: '#6b6b76', wickDownColor: '#6b6b76',
      // Projections extend the autoscale range so the forward corridor is
      // never clipped off-screen (the overlay is drawn on a canvas, which
      // Lightweight Charts' own autoscale knows nothing about).
      autoscaleInfoProvider: (original) => {
        const res = original();
        if (!res) return res;
        // Orbs and Projections both mark PRICE LEVELS from live exposure
        // data that may sit outside the range the candles alone have
        // traded through (e.g. a gamma wall the price hasn't reached
        // yet). Extending autoscale to include them is what keeps those
        // orbs/corridor visible instead of being clipped off-screen by
        // Lightweight Charts' own candle-only fit — see the comment on
        // state.orbRange in loadOrbs() and atlas-orbs.js's header.
        let min = res.priceRange.minValue, max = res.priceRange.maxValue;
        if (state.showOrbs && state.orbRange) { min = Math.min(min, state.orbRange.min); max = Math.max(max, state.orbRange.max); }
        if (state.showProjection && state.projectionRange) { min = Math.min(min, state.projectionRange.min); max = Math.max(max, state.projectionRange.max); }
        return { priceRange: { minValue: min, maxValue: max }, margins: res.margins };
      },
    });

    const flowSeries = chart.addHistogramSeries({
      priceScaleId: 'flow',
      priceFormat: { type: 'volume' },
      color: '#4caf7d',
    });
    chart.priceScale('flow').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      visible: false,
    });

    // Drawing tools (this feature): per-pane, since a drawing is an
    // annotation on a specific chart, not a cross-pane setting — see
    // atlas-drawing.js's header comment for why this doesn't live in the
    // global toolbar or the pane header.
    const drawingLayer = global.createDrawingLayer(chartContainerEl, chart, candleSeries, state.ticker);

    // --- Sizing -----------------------------------------------------------
    // The chart must track its CONTAINER, not just the window: the heatmap sidecar can be
    // shown/hidden and its divider dragged without any window resize event, which used to leave
    // the canvases at a stale size (dead strip on the right, crosshair/axis hit areas off).
    // Lightweight Charts keeps bar spacing and the right-edge anchor across a resize, so the
    // user's zoom level and scroll position survive; only the amount of history shown changes.
    function resize() {
      const w = chartContainerEl.clientWidth, h = chartContainerEl.clientHeight;
      if (w <= 0 || h <= 0) return;  // collapsed / display:none — keep the last good size
      chart.applyOptions({ width: w, height: h });
    }
    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(chartContainerEl);
    } else {
      window.addEventListener('resize', resize);
    }
    resize();

    // --- VIEW STATE (price axis + time axis) --------------------------------
    // Three kinds of state are kept strictly apart on this chart:
    //   data state    — the bars (candleSeries data, state.barTimes);
    //   view state    — price-axis scale (auto vs. user-set), visible time window, bar spacing;
    //   layout state  — container size.
    // ORDINARY DATA UPDATES (ticks, new candles, orb/projection polls, same-context re-fetches)
    // MUST NEVER write view state. Only a CONTEXT CHANGE (ticker / timeframe / pane rebuilt)
    // or an explicit user reset (Reset view button, axis double-click) may.
    //
    // Root cause of the old "chart snaps back" bug: every 1 s Orb/Projection poll (and every
    // toggle) re-applied `priceScale.applyOptions({ autoScale: true })`. Lightweight Charts
    // flips autoScale OFF the moment the user drags/zooms the price axis, so the next poll
    // silently turned it back ON and the manual scale was lost within a second. On the time
    // axis the symptom was patched per poll with setVisibleLogicalRange() behind a sticky flag.
    const coords = global.SkylitChartCoords;

    function priceAxisIsAuto() {
      try { return candleSeries.priceScale().options().autoScale !== false; }
      catch (e) { return true; }  // minimal chart implementations without the query API
    }
    // Orb/Projection price ranges are folded into autoscale via autoscaleInfoProvider, so when the
    // axis IS auto we still nudge it to re-evaluate after the range changes (previous behaviour).
    // When the user has set the scale manually we leave it alone: manual mode never rescales.
    function refreshPriceAutoscale() {
      if (priceAxisIsAuto()) chart.priceScale('right').applyOptions({ autoScale: true });
    }

    // Snapshot of the visible time window expressed in TIMES (not bar indices, which shift when
    // history is re-fetched). `pinned` = the newest bar (or the room after it) is on screen, i.e.
    // the user is at the live edge, where Lightweight Charts itself keeps following new bars
    // while preserving bar spacing and offset.
    function captureTimeView() {
      const ts = chart.timeScale();
      const lr = typeof ts.getVisibleLogicalRange === 'function' ? ts.getVisibleLogicalRange() : null;
      const times = state.barTimes;
      if (!lr || !times.length) return null;
      const iv = coords.intervalSeconds(state.interval);
      return {
        pinned: lr.to >= times.length - 1.5,  // newest bar (within half a bar) is on screen
        fromTime: coords.logicalToTime(times, lr.from, iv),
        toTime: coords.logicalToTime(times, lr.to, iv),
      };
    }
    function restoreTimeView(view) {
      if (!view) return;
      const iv = coords.intervalSeconds(state.interval);
      chart.timeScale().setVisibleLogicalRange({
        from: coords.timeToLogical(state.barTimes, view.fromTime, iv),
        to: coords.timeToLogical(state.barTimes, view.toTime, iv),
      });
    }
    // A fresh context (or an explicit reset): fit history, auto price scale.
    function applyInitialView() {
      state.userHasPanned = false;
      chart.priceScale('right').applyOptions({ autoScale: true });
      chart.timeScale().fitContent();
    }

    // --- Live-tracking interaction detection --------------------------
    // A drag/pan/axis-scale gesture is anchored by Lightweight Charts to the bar index it started
    // on. A new candle arriving mid-gesture re-bases that index, so the content under the pointer
    // slips by a bar (a visible hop). "The gesture wins": while the pointer is down we HOLD the
    // incoming bars (keyed by time, so none is lost) and apply them the instant it is released.
    function markUserPanned() { state.userHasPanned = true; }
    function gestureStart() { state.userHasPanned = true; state.gestureActive = true; }
    function gestureEnd() {
      if (!state.gestureActive) return;
      // Deferred one task: this listener runs in the capture phase, BEFORE Lightweight Charts
      // processes the same mouseup and ends its own drag. Applying the held bars here would still
      // re-base the drag anchor; after it, the gesture is fully finished.
      setTimeout(() => { state.gestureActive = false; flushPendingBars(); }, 0);
    }
    chartContainerEl.addEventListener('mousedown', gestureStart);
    chartContainerEl.addEventListener('wheel', markUserPanned, { passive: true });
    chartContainerEl.addEventListener('touchstart', gestureStart, { passive: true });
    window.addEventListener('mouseup', gestureEnd, true);
    window.addEventListener('touchend', gestureEnd, true);
    window.addEventListener('touchcancel', gestureEnd, true);
    window.addEventListener('blur', gestureEnd);

    // "Live" button: jump the TIME axis back to the newest bar (keeps zoom and the price scale).
    function resumeLiveTracking() {
      state.userHasPanned = false;
      chart.timeScale().scrollToRealTime();
    }
    // "Reset view": the explicit way back to the automatic view (fit history + auto price scale).
    function resetView() { applyInitialView(); }

    // --- Minimal on-chart header: ticker + price + %change ONLY --------
    // This is the entire on-chart control surface, per the explicit
    // correction — no interval/exposure/orbs/etc. controls live here.
    headerEl.innerHTML = `
      <select class="atlas-pane-ticker-select"></select>
      <span class="atlas-pane-price">--</span>
      <span class="atlas-pane-change">--</span>
    `;
    const el = {
      tickerSelect: headerEl.querySelector('.atlas-pane-ticker-select'),
      price: headerEl.querySelector('.atlas-pane-price'),
      change: headerEl.querySelector('.atlas-pane-change'),
    };
    state.tickerOptions.forEach((t) => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      if (t === state.ticker) o.selected = true;
      el.tickerSelect.appendChild(o);
    });
    el.tickerSelect.addEventListener('change', () => {
      state.ticker = el.tickerSelect.value;
      state.seriesOpenAnchor = null;
      drawingLayer.setActiveTicker(state.ticker);
      fullReload();
      if (opts.onTickerChange) opts.onTickerChange(state.ticker);
    });

    function updatePriceHeader(bars) {
      if (!bars || !bars.length) return;
      if (state.seriesOpenAnchor === null) state.seriesOpenAnchor = bars[0].open;
      const last = bars[bars.length - 1].close;
      // Tracked so Projections can anchor its wedge to the chart's OWN
      // trusted last close rather than the separately-polled /api/
      // projection response's own `spot` field, which can be a tick or
      // two stale relative to the candle just drawn (two independent
      // HTTP round trips landing a few hundred ms apart) — see
      // getBarGeometry() below and atlas-projections.js's use of it.
      state.lastClose = last;
      const changePct = ((last - state.seriesOpenAnchor) / state.seriesOpenAnchor) * 100;
      el.price.textContent = `$${last.toFixed(2)}`;
      el.change.textContent = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
      el.change.classList.toggle('positive', changePct >= 0);
      el.change.classList.toggle('negative', changePct < 0);
    }

    // --- Data loading ------------------------------------------------

    // --- Poll hygiene ---------------------------------------------------
    // The 1s timers must never stack requests when a response takes longer than
    // a second (a Live Share / forwarded-port link, a busy backend), and a late
    // response for a ticker / interval / selection that has since changed must
    // never be drawn over the newer one:
    //   * `inflight[name]` — timer ticks skip while the previous request is out;
    //   * `seq[name]`      — every (re)load bumps it; superseded replies are dropped;
    //   * `loadGen`        — bumped by fullReload() (ticker / interval change).
    // Every poll also carries a timeout: a request that hangs must free its slot, or the
    // in-flight guard would stop that poller for good.
    const POLL_TIMEOUT_MS = 8000;
    const pollSignal = () => AbortSignal.timeout(POLL_TIMEOUT_MS);
    const inflight = { candles: 0, orbs: 0, projection: 0 };
    const seq = { orbs: 0, projection: 0 };
    let loadGen = 0;

    async function loadCandles() {
      const gen = loadGen;
      const res = await fetch(`/api/candles?ticker=${encodeURIComponent(state.ticker)}&interval=${state.interval}`);
      const bars = await res.json();
      if (gen !== loadGen) return;  // ticker/interval changed while this was in flight
      // Context change (different ticker/timeframe, or first load) => fit + auto price scale.
      // Same context (history re-fetch / reconnect / same-ticker reselect) => this is a DATA
      // refresh: capture the view in times, swap the data, restore in the same task (no paint
      // in between, so no flicker) and leave the price axis alone.
      const context = `${state.ticker}|${state.interval}`;
      const sameContext = state.viewContext === context && state.barTimes.length > 0;
      const priorView = sameContext ? captureTimeView() : null;
      candleSeries.setData(bars);
      state.barTimes = bars.map((b) => b.time);
      state.lastBarTime = bars.length ? bars[bars.length - 1].time : null;
      state.seriesOpenAnchor = bars.length ? bars[0].open : null;
      updatePriceHeader(bars);
      if (sameContext) {
        if (priorView && !priorView.pinned) restoreTimeView(priorView);  // pinned: LWC keeps offset + spacing
      } else {
        state.viewContext = context;
        applyInitialView();
      }
    }

    // Incremental data path. /api/candles/latest returns the last TWO bars (just-closed +
    // currently-forming) every poll so the forming bar's in-progress
    // OHLC is always fresh. series.update() only ever correctly
    // targets the single most-recent point (match-last-time-or-
    // append-newer); feeding it the older of the two first made it
    // misread which bar was "last", which is what caused the
    // projection's convergence point (and Orbs) to visibly sit a few
    // candles behind the true latest candle. Drop anything not at or
    // after our own last-known bar time before calling update() at all.
    // NOTE (view state): update() is incremental and Lightweight Charts itself keeps a
    // scrolled-back window fixed (and follows only when the newest bar is on screen, keeping
    // bar spacing), so nothing here touches the time or price axis.
    function applyLatestBars(bars) {
      const lastKnown = state.barTimes.length ? state.barTimes[state.barTimes.length - 1] : null;
      const relevant = lastKnown == null ? bars : bars.filter((b) => b.time >= lastKnown);
      for (const bar of relevant) {
        candleSeries.update(bar);
        const n = state.barTimes.length;
        if (n && state.barTimes[n - 1] === bar.time) continue;
        if (!n || bar.time > state.barTimes[n - 1]) state.barTimes.push(bar.time);
      }
      if (relevant.length) state.lastBarTime = relevant[relevant.length - 1].time;
      updatePriceHeader(bars);
      projectionLayer.redraw();
    }
    // Bars held during a gesture + the fresh poll result, oldest first, de-duplicated by time.
    function takePendingWith(bars) {
      for (const bar of bars) state.pendingBars.set(bar.time, bar);
      return takePending();
    }
    function takePending() {
      const out = [...state.pendingBars.values()].sort((x, y) => x.time - y.time);
      state.pendingBars.clear();
      return out;
    }
    function flushPendingBars() {
      if (state.pendingBars.size) applyLatestBars(takePending());
    }

    async function pollLatestCandles() {
      if (inflight.candles || document.hidden) return;
      inflight.candles++;
      const gen = loadGen;
      try {
        const res = await fetch(`/api/candles/latest?ticker=${encodeURIComponent(state.ticker)}&interval=${state.interval}`, { signal: pollSignal() });
        const bars = await res.json();
        if (gen !== loadGen) return;  // ticker/interval switched mid-flight: these bars belong to the old series
        if (state.gestureActive) {  // hold until the pointer is released (see gestureStart)
          for (const bar of bars) state.pendingBars.set(bar.time, bar);
          return;
        }
        applyLatestBars(state.pendingBars.size ? takePendingWith(bars) : bars);
      } catch (e) { /* transient network hiccup — next poll will retry */ }
      finally { inflight.candles--; }
    }

    // Composes the full 6-control Orb Settings set into a concrete
    // {radius, opacity} for one node — used by the canvas orb layer
    // (atlas-orbs.js) to draw a soft dot-band. Design note: since a
    // proprietary exact formula isn't something we have access to (only
    // the visual reference and each control's plain-English behavior),
    // this is a deliberately transparent, documented approximation —
    // every control does exactly what its tooltip says, verified against
    // actual rendered output rather than an unknown internal formula.
    //   f = |exposure| / maxAbsExposure   (0..1, King node = 1.0)
    //   size:   sizeFraction = (minClamp + f*(maxClamp-minClamp)) / 100
    //           — an INTERPOLATION between the min/max clamp bounds
    //           (matching "Min Clamp: minimum size an orb can be" /
    //           "Max Clamp: maximum size an orb can reach" — floor/
    //           ceiling of the OUTPUT size range, not a clamp applied to
    //           the raw magnitude fraction, which collapsed to a constant
    //           size regardless of Orb Size in an earlier, incorrect
    //           version of this formula).
    //           radiusPx = max(1.5, orbSize/100 * sizeFraction * BASE_MAX_RADIUS_PX)
    //   opacity (non-King): same interpolation shape, from minOpacity to
    //           maxOpacity as f goes 0->1, THEN multiplied by a freshness-
    //           decay weight (this correction — see below) so a node
    //           that's been retested repeatedly visually fades even if
    //           its magnitude hasn't changed.
    //   opacity (King): King Opacity applies directly and unconditionally
    //           — a dedicated, independent control, never derived from
    //           the min/max opacity range — but still decays with
    //           retests, same as any other node.
    //
    // Freshness/retest decay (this correction): "as price passes through
    // the exposure levels and they decay in value so will the opacity of
    // the orbs decay as well." The backend already tracks touch_count per
    // node (incremented in live_feed.hpp's price_loop whenever a tick
    // crosses that strike) and serializes it — this was previously
    // computed but never actually consumed by the frontend. Mirrors
    // exposure_engine.hpp's decay_weight_for_touches() exactly (same
    // first_touch_weight/decay_per_touch/floor_weight defaults) so the
    // visual decay matches the backend's own definition of freshness
    // rather than inventing a second, divergent decay curve.
    const FRESHNESS = { firstTouchWeight: 1.0, decayPerTouch: 0.30, floorWeight: 0.15 };
    function decayWeightForTouches(touchCount) {
      if (touchCount <= 0) return FRESHNESS.firstTouchWeight;
      return Math.max(FRESHNESS.floorWeight, FRESHNESS.firstTouchWeight - touchCount * FRESHNESS.decayPerTouch);
    }

    function hexToRgba(hex, alpha) {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      const n = m ? parseInt(m[1], 16) : 0xfcbf24;
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha))})`;
    }

    const BASE_MAX_RADIUS_PX = 6.5;
    function computeOrbStyle(node, maxAbsExposure, isKing) {
      const f = maxAbsExposure > 0 ? Math.abs(node.exposure) / maxAbsExposure : 0;
      const s = state.orbSettings;
      const sizeFraction = (s.minClamp + f * (s.maxClamp - s.minClamp)) / 100;
      const radius = Math.max(1.5, (s.size / 100) * sizeFraction * BASE_MAX_RADIUS_PX);
      const baseOpacity = isKing ? s.kingOpacity / 100 : (s.minOpacity + f * (s.maxOpacity - s.minOpacity)) / 100;
      const opacity = baseOpacity * decayWeightForTouches(node.touch_count || 0);
      return { radius, opacity };
    }

    // Per the explicit correction: Orbs are the ONLY thing drawn on the
    // chart besides the candles themselves — rendered as soft dot-bands
    // via a canvas layer (atlas-orbs.js), not Lightweight Charts' price-
    // line API (which can only draw a thin line across the full chart
    // width and can't produce the reference's glowing dot-string look).
    // Color is strict two-tone (gold=positive, purple=negative) per the
    // reference, via exposureToOrbColor — never the heatmap ladder's
    // 5-stop diverging gradient, and never a floating strike-price label
    // (the Y-axis already shows price).
    const barGeometryHooks = {
      getBarGeometry() {
        const t = state.barTimes;
        if (!t.length) return null;
        return {
          lastTime: t[t.length - 1],
          prevTime: t.length > 1 ? t[t.length - 2] : null,
          lastLogical: t.length - 1,
          lastClose: state.lastClose,
        };
      },
    };
    const orbLayer = global.createOrbLayer(chartContainerEl, chart, candleSeries, barGeometryHooks);

    // Atlas Projections (Beta): render-only layer; all numbers come from
    // GET /api/projection (shared C++ engine).
    const projectionLayer = global.createProjectionLayer(chartContainerEl, chart, candleSeries, barGeometryHooks);

    // Reserve room to the right of the last candle so the forward corridor
    // is actually on screen (real Lightweight Charts honours rightOffset).
    // Change-only: re-applying an unchanged offset must never touch the view. A genuine change
    // (projection toggled / horizon changed) moves the live edge; a scrolled-back view is
    // restored so the toggle can't drag it forward.
    function applyProjectionRoom(windowBars) {
      const ts = chart.timeScale();
      if (typeof ts.applyOptions !== 'function') return;
      const next = state.showProjection ? Math.max(4, windowBars || 0) + 6 : 0;
      if (next === state.rightOffset) return;
      state.rightOffset = next;
      const view = captureTimeView();
      ts.applyOptions({ rightOffset: next });
      if (view && !view.pinned) restoreTimeView(view);
    }

    async function loadProjection(isPoll = false) {
      if (isPoll && (inflight.projection || document.hidden)) return;
      const mySeq = ++seq.projection;
      let started = false;
      if (!state.showProjection) {
        state.projectionRange = null;
        projectionLayer.clear();
        applyProjectionRoom(0);
        refreshPriceAutoscale();
        return;
      }
      try {
        const url = `/api/projection?ticker=${encodeURIComponent(state.ticker)}` +
          `&exposure=${encodeURIComponent(state.projectionExposure)}` +
          `&interval=${encodeURIComponent(state.interval)}` +
          `&dte=${state.projectionDte || 0}`;
        inflight.projection++; started = true;
        const res = await fetch(url, { signal: pollSignal() });
        if (mySeq !== seq.projection) return;  // a newer request superseded this one
        if (!res.ok) { projectionLayer.clear(); return; }
        const data = await res.json();
        if (mySeq !== seq.projection) return;
        applyProjectionRoom(data.horizon.effective_bars);
        const sup = data.bars.filter((b) => b.supported);
        state.projectionRange = sup.length
          ? { min: Math.min(...sup.map((b) => b.lower)), max: Math.max(...sup.map((b) => b.upper)) }
          : null;
        // Ask Lightweight Charts to re-run autoscale so the new range applies — only while the
        // price axis is automatic; a user-set scale is never overridden by a data poll.
        refreshPriceAutoscale();
        projectionLayer.render(data);
        if (opts.onProjectionMeta) opts.onProjectionMeta(data);
      } catch (e) { /* projection unavailable — leave chart bare rather than throw */ }
      finally { if (started) inflight.projection--; }
    }

    async function loadOrbs(isPoll = false) {
      if (isPoll && (inflight.orbs || document.hidden)) return;
      const mySeq = ++seq.orbs;
      let started = false;
      if (!state.showOrbs) { state.orbRange = null; orbLayer.clear(); refreshPriceAutoscale(); return; }
      try {
        inflight.orbs++; started = true;
        const res = await fetch(
          `/api/heatmap?ticker=${encodeURIComponent(state.ticker)}&exposure=${encodeURIComponent(state.exposureType)}&expiration=${encodeURIComponent(state.expiration)}`,
          { signal: pollSignal() }
        );
        if (mySeq !== seq.orbs) return;  // a newer request superseded this one
        const board = await res.json();
        if (mySeq !== seq.orbs) return;
        const maxAbs = Math.max(1, ...board.nodes.map((n) => Math.abs(n.exposure)));
        const filtered = applyNodeLimit(board.nodes, board.spot, state.nodeLimit);
        // Orbs mark real strike PRICES from live exposure data — a wall can
        // sit above/below every candle the chart has drawn so far (price
        // hasn't traded there yet). Recording the full strike range here
        // lets autoscaleInfoProvider (above) extend the visible price axis
        // to include it, so the positioning insight is never silently
        // dropped just because no candle has reached that level yet.
        state.orbRange = filtered.length
          ? { min: Math.min(...filtered.map((n) => n.strike)), max: Math.max(...filtered.map((n) => n.strike)) }
          : null;
        refreshPriceAutoscale();
        // Orb colors are user-configurable (Orbs window): positive/negative
        // exposure each have their own color; defaults are the original
        // gold / purple.
        const colorFor = (exposure, _maxAbs, opacity) => {
          const hex = exposure >= 0 ? state.orbSettings.posColor : state.orbSettings.negColor;
          return hexToRgba(hex || (exposure >= 0 ? '#fcbf24' : '#a855f7'), opacity);
        };
        orbLayer.render(filtered, maxAbs, colorFor, computeOrbStyle,
          { sizeScale: Math.max(0.2, (state.orbSettings.size || 50) / 50),
            showLabels: state.orbSettings.showLabels !== false });
      } catch (e) { /* board unavailable — leave chart bare rather than throw */ }
      finally { if (started) inflight.orbs--; }
    }

    function clearDarkPoolLines() {
      for (const line of state.darkPoolLines) candleSeries.removePriceLine(line);
      state.darkPoolLines = [];
    }

    async function loadDarkPool() {
      clearDarkPoolLines();
      if (!state.showDarkPool) return;
      try {
        const res = await fetch(`/api/darkpool?ticker=${encodeURIComponent(state.ticker)}`);
        const levels = await res.json();
        for (const lvl of levels) {
          state.darkPoolLines.push(candleSeries.createPriceLine({
            price: lvl.price,
            color: '#5b8dd6',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.LargeDashed,
            axisLabelVisible: true,
            title: `DP ${lvl.context}`,
          }));
        }
      } catch (e) { /* dark pool data unavailable — non-fatal */ }
    }

    async function loadFlow() {
      if (!state.showFlow) { flowSeries.setData([]); return; }
      try {
        const res = await fetch(`/api/flow?ticker=${encodeURIComponent(state.ticker)}&interval=${state.interval}`);
        const bars = await res.json();
        flowSeries.setData(bars.map((b) => ({
          time: b.time,
          value: Math.abs(b.net_flow),
          color: b.net_flow >= 0 ? 'rgba(76,175,125,0.7)' : 'rgba(240,97,109,0.7)',
        })));
      } catch (e) { /* flow data unavailable — non-fatal */ }
    }

    async function fullReload() {
      loadGen++;
      state.pendingBars.clear();
      await loadCandles();
      await Promise.all([loadOrbs(), loadDarkPool(), loadFlow(), loadProjection()]);
    }

    fullReload();
    // Candles, Orbs, and Projections all poll on the SAME 1s cadence:
    // Orbs/Projections are literally "the dealer-positioning read for the
    // current candle", so refreshing them any slower than the candle
    // itself is what made the projection look like it was tracking a few
    // candles behind. Dark pool / flow are supplementary context, not
    // part of this tracking requirement, so they stay on the slower poll.
    state.candlePoll = setInterval(() => {
      pollLatestCandles();
      if (state.showOrbs) loadOrbs(true);
      if (state.showProjection) loadProjection(true);
    }, 1000);
    state.slowPoll = setInterval(() => {
      if (state.showDarkPool) loadDarkPool();
      if (state.showFlow) loadFlow();
    }, 5000);

    return {
      destroy() {
        clearInterval(state.candlePoll);
        clearInterval(state.slowPoll);
        if (resizeObserver) resizeObserver.disconnect(); else window.removeEventListener('resize', resize);
        window.removeEventListener('mouseup', gestureEnd, true);
        window.removeEventListener('touchend', gestureEnd, true);
        window.removeEventListener('touchcancel', gestureEnd, true);
        window.removeEventListener('blur', gestureEnd);
        drawingLayer.destroy();
        orbLayer.destroy();
        projectionLayer.destroy();
        chart.remove();
      },
      // --- External setters (this revision): every non-header control is
      // driven by the global toolbar in atlas-layout.js through these.
      setTicker(t) {
        state.ticker = t;
        el.tickerSelect.value = t;
        state.seriesOpenAnchor = null;
        drawingLayer.setActiveTicker(t);
        fullReload();
      },
      setInterval(iv) { state.interval = iv; fullReload(); },
      // Expiry Data window selection: Greeks (comma list) + DTE set ("dte:0,1,3").
      // Drives Orbs only — Projections has its own selection below.
      setDataSelection({ exposure, expiration }) {
        state.exposureType = exposure;
        state.expiration = expiration;
        loadOrbs();
      },
      setExposureType(type) { state.exposureType = type; loadOrbs(); },
      setExpirationSelector(selector) { state.expiration = selector; loadOrbs(); },
      setProjectionExposure(type) { state.projectionExposure = type; loadProjection(); },
      setNodeLimit(limit) { state.nodeLimit = limit; loadOrbs(); },
      setShowOrbs(show) { state.showOrbs = show; loadOrbs(); },
      setOrbSettings(settings) { state.orbSettings = settings; loadOrbs(); },
      setShowProjection(show) { state.showProjection = show; loadProjection(); },
      setProjectionDte(dte) { state.projectionDte = dte; loadProjection(); },
      getProjectionState() { return projectionLayer.getState(); },
      setShowDarkPool(show) { state.showDarkPool = show; loadDarkPool(); },
      setShowFlow(show) {
        state.showFlow = show;
        chart.priceScale('flow').applyOptions({ visible: show });
        loadFlow();
      },
      resumeLive() { resumeLiveTracking(); },
      resetView() { resetView(); },
      getViewState() {
        const ts = chart.timeScale();
        return {
          priceManual: !priceAxisIsAuto(),
          timeManual: state.userHasPanned,
          logicalRange: typeof ts.getVisibleLogicalRange === 'function' ? ts.getVisibleLogicalRange() : null,
        };
      },
      isPanned() { return state.userHasPanned; },
      getTicker() { return state.ticker; },
      getDrawingLayer() { return drawingLayer; },
    };
  }

  global.createAtlasController = createAtlasController;
})(window);
