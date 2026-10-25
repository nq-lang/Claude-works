// TEST-ONLY stub of the Lightweight Charts API surface atlas.js touches.
// Not shipped to users (not referenced by index.html) — exists solely so
// atlas.js's own control flow can be exercised without depending on the
// unpkg CDN, which this sandbox's network egress restrictions block. Does
// NOT verify Lightweight Charts' actual rendering — only that our code
// calls its API correctly and doesn't throw. See TESTING.md for the caveat
// this leaves and what still needs verifying in a real (networked)
// Codespace.
(function (global) {
  'use strict';

  function makeSeries(kind) {
    const calls = { setData: [], update: [], createPriceLine: [], removePriceLine: [] };
    const priceLines = [];
    return {
      __kind: kind,
      __calls: calls,
      setData(data) { calls.setData.push(data); },
      update(bar) { calls.update.push(bar); },
      createPriceLine(opts) {
        calls.createPriceLine.push(opts);
        const handle = { __opts: opts };
        priceLines.push(handle);
        return handle;
      },
      removePriceLine(handle) {
        calls.removePriceLine.push(handle);
        const idx = priceLines.indexOf(handle);
        if (idx >= 0) priceLines.splice(idx, 1);
      },
      // Fake but internally-consistent coordinate math, just enough for
      // atlas-drawing.js's drawing layer to run without throwing: maps a
      // price directly to a pixel-ish number and back losslessly.
      priceToCoordinate(price) { return price === null || price === undefined ? null : price * 2; },
      coordinateToPrice(coord) { return coord === null || coord === undefined ? null : coord / 2; },
    };
  }

  function makePriceScale() {
    let opts = {};
    return { applyOptions(o) { opts = { ...opts, ...o }; }, __opts: () => opts };
  }

  function makeTimeScale() {
    let visibleRange = { from: 0, to: 100 };
    let scrollToRealTimeCalls = 0;
    const subscribers = [];
    return {
      fitContent() {},
      getVisibleLogicalRange() { return { ...visibleRange }; },
      setVisibleLogicalRange(r) { visibleRange = { ...r }; },
      scrollToRealTime() { scrollToRealTimeCalls++; },
      __scrollToRealTimeCalls: () => scrollToRealTimeCalls,
      __setVisibleRangeForTest(r) { visibleRange = { ...r }; },
      // Same fake-but-consistent mapping approach as the series price
      // coordinates above — enough for atlas-drawing.js to compute
      // pixel positions and round-trip them without throwing.
      timeToCoordinate(time) { return time === null || time === undefined ? null : time % 1000; },
      coordinateToTime(coord) { return coord === null || coord === undefined ? null : coord; },
      subscribeVisibleTimeRangeChange(cb) { subscribers.push(cb); },
      unsubscribeVisibleTimeRangeChange(cb) {
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
      },
    };
  }

  global.LightweightCharts = {
    LineStyle: { Solid: 0, Dotted: 1, LargeDashed: 3 },
    CrosshairMode: { Normal: 0 },
    __allSeries: [],  // test-introspection hook: every series ever created
    createChart(container, options) {
      const priceScales = { right: makePriceScale() };
      const series = [];
      const timeScale = makeTimeScale();
      const chartObj = {
        __options: options,
        __series: series,
        __timeScale: timeScale,
        addCandlestickSeries(opts) {
          const s = makeSeries('candlestick');
          s.__seriesOptions = opts;
          series.push(s);
          global.LightweightCharts.__allSeries.push(s);
          return s;
        },
        addHistogramSeries(opts) {
          const s = makeSeries('histogram');
          s.__seriesOptions = opts;
          if (opts && opts.priceScaleId) priceScales[opts.priceScaleId] = makePriceScale();
          series.push(s);
          global.LightweightCharts.__allSeries.push(s);
          return s;
        },
        priceScale(id) {
          if (!priceScales[id]) priceScales[id] = makePriceScale();
          return priceScales[id];
        },
        timeScale() {
          return timeScale;
        },
        applyOptions() {},
        remove() {},
      };
      global.LightweightCharts.__lastChart = chartObj;
      return chartObj;
    },
  };
})(window);
