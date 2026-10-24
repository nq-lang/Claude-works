// TEST-ONLY renderer standing in for Lightweight Charts.
//
// The real library loads from unpkg.com, which this sandbox blocks, so a
// screenshot of the real page shows an empty chart. Unlike
// lightweight_charts_stub.js (API-shape only, draws nothing), this stub
// actually PAINTS candles, a price axis and a last-price line to a canvas,
// with the same coordinate conventions the overlay layers rely on
// (inverted price axis, logical index -> x, rightOffset room, autoscale
// via autoscaleInfoProvider). That lets a Playwright screenshot show our
// overlay (Orbs / Projections) sitting on a chart-like background.
//
// It is NOT Lightweight Charts: candle styling, crosshair, panning/zoom and
// exact autoscale margins differ. What it does prove is that OUR code draws
// the right shapes at the right coordinates; real-library pixels still need
// a networked run (see TESTING.md).
(function (global) {
  'use strict';

  const PRICE_AXIS_W = 62;
  const TIME_AXIS_H = 22;

  function makeSeries(chart, kind, opts) {
    const s = {
      __kind: kind, __opts: opts || {}, data: [], priceLines: [],
      __calls: { setData: [], update: [], createPriceLine: [], removePriceLine: [] },
      setData(d) { s.data = d.slice(); s.__calls.setData.push(d); chart.__invalidate(); },
      update(bar) {
        const n = s.data.length;
        if (n && s.data[n - 1].time === bar.time) s.data[n - 1] = bar; else s.data.push(bar);
        s.__calls.update.push(bar); chart.__invalidate();
      },
      applyOptions(o) { s.__opts = { ...s.__opts, ...o }; chart.__invalidate(); },
      createPriceLine(o) { const h = { __opts: o }; s.priceLines.push(h); s.__calls.createPriceLine.push(o); chart.__invalidate(); return h; },
      removePriceLine(h) { const i = s.priceLines.indexOf(h); if (i >= 0) s.priceLines.splice(i, 1); s.__calls.removePriceLine.push(h); chart.__invalidate(); },
      priceToCoordinate(p) { return p == null ? null : chart.__priceToY(p); },
      coordinateToPrice(y) { return y == null ? null : chart.__yToPrice(y); },
    };
    return s;
  }

  function createChart(container, options) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;z-index:1;';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const subs = [];
    const chart = {
      __options: options, __series: [], __rightOffset: 0, __fit: true, __barSpacing: 6,
      __width: container.clientWidth || 600, __height: container.clientHeight || 400,
      __range: { lo: 0, hi: 1 }, __raf: 0,
    };

    const candle = () => chart.__series.find((s) => s.__kind === 'candlestick');
    const plotW = () => chart.__width - PRICE_AXIS_W;
    const plotH = () => chart.__height - TIME_AXIS_H;

    function computeRange() {
      const s = candle();
      if (!s || !s.data.length) return { lo: 0, hi: 1 };
      let lo = Infinity, hi = -Infinity;
      for (const b of s.data) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); }
      let res = { priceRange: { minValue: lo, maxValue: hi }, margins: { above: 0, below: 0 } };
      const provider = s.__opts.autoscaleInfoProvider;
      if (provider) res = provider(() => res) || res;
      const pad = (res.priceRange.maxValue - res.priceRange.minValue) * 0.06 || 1;
      return { lo: res.priceRange.minValue - pad, hi: res.priceRange.maxValue + pad };
    }
    chart.__priceToY = (p) => { const r = chart.__range; return plotH() * (1 - (p - r.lo) / (r.hi - r.lo)); };
    chart.__yToPrice = (y) => { const r = chart.__range; return r.lo + (1 - y / plotH()) * (r.hi - r.lo); };

    function n() { const s = candle(); return s ? s.data.length : 0; }
    function logicalToX(l) {
      // last bar sits `rightOffset` bars left of the plot's right edge
      return plotW() - (chart.__rightOffset + (n() - 1 - l) + 0.5) * chart.__barSpacing;
    }
    function fit() {
      if (!chart.__fit || !n()) return;
      chart.__barSpacing = Math.max(1.5, Math.min(14, plotW() / (n() + chart.__rightOffset + 1)));
    }

    function draw() {
      chart.__raf = 0;
      const W = chart.__width, H = chart.__height;
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      fit();
      chart.__range = computeRange();
      ctx.fillStyle = (options && options.layout && options.layout.background && options.layout.background.color) || '#0a0a0d';
      ctx.fillRect(0, 0, W, H);

      // grid + price labels
      ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const { lo, hi } = chart.__range;
      const step = niceStep((hi - lo) / 7);
      for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
        const y = chart.__priceToY(p);
        ctx.strokeStyle = '#15151b'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW(), y); ctx.stroke();
        ctx.fillStyle = '#8a8a94'; ctx.fillText(p.toFixed(step < 1 ? 2 : 0), plotW() + 6, y);
      }
      ctx.strokeStyle = '#1e1e24'; ctx.beginPath(); ctx.moveTo(plotW() + 0.5, 0); ctx.lineTo(plotW() + 0.5, plotH()); ctx.stroke();

      const s = candle();
      if (s) {
        const bw = Math.max(1, chart.__barSpacing * 0.7);
        s.data.forEach((b, i) => {
          const x = logicalToX(i);
          if (x < -10 || x > plotW() + 10) return;
          const up = b.close >= b.open;
          ctx.strokeStyle = '#6b6b76';
          ctx.beginPath(); ctx.moveTo(x, chart.__priceToY(b.high)); ctx.lineTo(x, chart.__priceToY(b.low)); ctx.stroke();
          ctx.fillStyle = up ? '#cfd3da' : '#4a4e5a';
          const y1 = chart.__priceToY(Math.max(b.open, b.close)), y2 = chart.__priceToY(Math.min(b.open, b.close));
          ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
        });
        if (s.data.length) {
          const last = s.data[s.data.length - 1].close, y = chart.__priceToY(last);
          ctx.setLineDash([3, 3]); ctx.strokeStyle = '#8a8a94';
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW(), y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#cfd3da'; ctx.fillRect(plotW(), y - 8, PRICE_AXIS_W, 16);
          ctx.fillStyle = '#0a0a0d'; ctx.fillText(last.toFixed(2), plotW() + 6, y);
        }
        for (const pl of s.priceLines) {
          const y = chart.__priceToY(pl.__opts.price);
          ctx.strokeStyle = pl.__opts.color || '#5b8dd6'; ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW(), y); ctx.stroke(); ctx.setLineDash([]);
        }
      }
      subs.slice().forEach((cb) => cb());
    }
    function niceStep(raw) {
      const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
      return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
    }
    chart.__invalidate = () => { if (!chart.__raf) chart.__raf = requestAnimationFrame(draw); };

    const priceScales = {};
    const timeScale = {
      fitContent() { chart.__fit = true; chart.__invalidate(); },
      getVisibleLogicalRange() { return { from: 0, to: n() + chart.__rightOffset }; },
      setVisibleLogicalRange() { chart.__fit = false; },
      scrollToRealTime() { chart.__invalidate(); },
      applyOptions(o) { if (o && o.rightOffset != null) { chart.__rightOffset = o.rightOffset; chart.__invalidate(); } },
      logicalToCoordinate(l) { return logicalToX(l); },
      timeToCoordinate(t) {
        const s = candle(); if (!s) return null;
        const i = s.data.findIndex((b) => b.time === t);
        return i < 0 ? null : logicalToX(i);
      },
      coordinateToTime(x) {
        const s = candle(); if (!s || !s.data.length) return null;
        const i = Math.round(n() - 1 - (plotW() - x) / chart.__barSpacing + chart.__rightOffset + 0.5 - 0.5);
        return s.data[Math.max(0, Math.min(s.data.length - 1, i))].time;
      },
      subscribeVisibleTimeRangeChange(cb) { subs.push(cb); },
      unsubscribeVisibleTimeRangeChange(cb) { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); },
    };

    Object.assign(chart, {
      addCandlestickSeries(o) { const s = makeSeries(chart, 'candlestick', o); chart.__series.push(s); global.LightweightCharts.__allSeries.push(s); return s; },
      addHistogramSeries(o) { const s = makeSeries(chart, 'histogram', o); chart.__series.push(s); global.LightweightCharts.__allSeries.push(s); return s; },
      priceScale(id) { return priceScales[id] || (priceScales[id] = { applyOptions() { chart.__invalidate(); } }); },
      timeScale() { return timeScale; },
      applyOptions(o) {
        if (o && o.width) chart.__width = o.width;
        if (o && o.height) chart.__height = o.height;
        chart.__invalidate();
      },
      remove() { canvas.remove(); },
    });
    global.LightweightCharts.__lastChart = chart;
    return chart;
  }

  global.LightweightCharts = {
    LineStyle: { Solid: 0, Dotted: 1, LargeDashed: 3 },
    CrosshairMode: { Normal: 0 },
    __allSeries: [],
    createChart,
  };
})(window);
