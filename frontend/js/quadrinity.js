// Skylit Heatseeker Terminal — Quadrinity view (Part D, renamed/expanded
// per ARCHITECTURE.md §0: SPXW/SPY/QQQ + NVDA, pane count 2-4).
//
// Deliberately reuses createHeatmapPanel (heatmap.js) for every pane rather
// than a second panel implementation — Quadrinity is explicitly "N
// synchronized instances of the same heatmap," so forking the render logic
// here would violate the one-implementation rule this whole build has been
// enforcing (Part E.1 at the backend, mirrored at the render layer since
// the Heatmap sidecar milestone). Each pane's own exposure/expiration
// controls are hidden (`hideControls`) so this view's single toolbar is the
// only place those settings live — otherwise confluence and the individual
// panes could silently disagree about which exposure lens they're showing.

(function (global) {
  'use strict';

  const DEFAULT_UNIVERSE = ['SPXW', 'SPY', 'QQQ', 'NVDA'];
  const MIN_PANES = 1;
  const MAX_PANES = 4;

  function createQuadrinityView(gridEl, toolbarEl, opts) {
    const allTickers = opts.tickerOptions && opts.tickerOptions.length
      ? opts.tickerOptions
      : DEFAULT_UNIVERSE;

    const state = {
      tickers: (opts.initialTickers || DEFAULT_UNIVERSE.slice(0, 3)).slice(0, MAX_PANES),
      showBadges: false,
      panels: [],          // { container, controller, ticker }
      confluencePoll: null,
    };

    // --- Toolbar -----------------------------------------------------
    toolbarEl.innerHTML = `
      <div class="quad-pane-count-group">
        ${[1, 2, 3, 4].map((n) => `<button class="quad-count-btn" data-count="${n}">${n} Panes</button>`).join('')}
      </div>
      <label class="quad-badges-toggle"><input type="checkbox" class="quad-badges-checkbox"> Badges</label>
      <button class="quad-add-pane-btn" title="Add pane">+ Pane</button>
      <div class="quad-confluence-banner"></div>
    `;

    const el = {
      countBtns: [...toolbarEl.querySelectorAll('.quad-count-btn')],
      badgesCheckbox: toolbarEl.querySelector('.quad-badges-checkbox'),
      addPaneBtn: toolbarEl.querySelector('.quad-add-pane-btn'),
      confluenceBanner: toolbarEl.querySelector('.quad-confluence-banner'),
    };

    function syncCountButtons() {
      el.countBtns.forEach((b) => b.classList.toggle('active', parseInt(b.dataset.count, 10) === state.tickers.length));
      el.addPaneBtn.style.display = state.tickers.length >= MAX_PANES ? 'none' : '';
    }

    el.countBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.dataset.count, 10);
        setPaneCount(n);
      });
    });

    el.badgesCheckbox.addEventListener('change', () => {
      state.showBadges = el.badgesCheckbox.checked;
      state.panels.forEach((p) => p.controller.setShowBadges(state.showBadges));
    });

    el.addPaneBtn.addEventListener('click', () => {
      if (state.tickers.length >= MAX_PANES) return;
      const unused = allTickers.find((t) => !state.tickers.includes(t)) || allTickers[0];
      state.tickers.push(unused);
      renderGrid();
    });

    function setPaneCount(n) {
      n = Math.max(MIN_PANES, Math.min(MAX_PANES, n));
      if (n < state.tickers.length) {
        state.tickers = state.tickers.slice(0, n);
      } else {
        while (state.tickers.length < n) {
          const unused = allTickers.find((t) => !state.tickers.includes(t)) || allTickers[0];
          state.tickers.push(unused);
        }
      }
      renderGrid();
    }

    // --- Grid ----------------------------------------------------------

    function destroyPanels() {
      state.panels.forEach((p) => p.controller.destroy());
      state.panels = [];
    }

    function renderGrid() {
      destroyPanels();
      syncCountButtons();
      gridEl.innerHTML = '';
      gridEl.style.gridTemplateColumns = `repeat(${state.tickers.length}, 1fr)`;

      state.tickers.forEach((ticker, idx) => {
        const paneEl = document.createElement('div');
        paneEl.className = 'quad-pane';
        gridEl.appendChild(paneEl);

        const controller = createHeatmapPanel(paneEl, {
          ticker,
          showBadges: state.showBadges,
          tickerOptions: allTickers,
          // Every heatmap here has the same stacked controls as Atlas (ticker,
          // DTE + Greek, Velocity Mode, EXTREME) and picks its OWN DTE and
          // Greek. Quadrinity additionally offers CHEX (charm exposure).
          greekOptions: ['GEX', 'VEX', 'GEX+VEX', 'CHEX'],
          onSelectionChange: () => fetchConfluence(),
          onTickerChange: (newTicker) => {
            state.tickers[idx] = newTicker;
            fetchConfluence();
          },
          // Closing is only offered once >MIN_PANES panes are open — a
          // trader needs at least 2 to compare, so the minimum is enforced
          // by simply not wiring a close button below that count.
          onClose: state.tickers.length > MIN_PANES
            ? () => { state.tickers.splice(idx, 1); renderGrid(); }
            : null,
        });

        state.panels.push({ container: paneEl, controller, ticker });
      });

      fetchConfluence();
    }

    // --- Confluence banner (Part D.2/D.3, generalized to N per
    // ARCHITECTURE.md §0) --------------------------------------------
    function renderConfluenceBanner(data) {
      const c = data.confluence;
      const isFullyAligned = c.aligned_count === c.total_count;
      const readLabel = c.majority_read === 'bullish' ? 'BULLISH' :
                         c.majority_read === 'bearish' ? 'BEARISH' : 'NEUTRAL';
      const readClass = c.majority_read === 'bullish' ? 'quad-read-bullish' :
                         c.majority_read === 'bearish' ? 'quad-read-bearish' : 'quad-read-neutral';
      const outliers = c.outlier_tickers.length
        ? ` &middot; outlier${c.outlier_tickers.length > 1 ? 's' : ''}: ${c.outlier_tickers.join(', ')}`
        : '';
      el.confluenceBanner.innerHTML = `
        <span class="quad-confluence-state ${isFullyAligned ? 'quad-full-align' : ''}">${c.state_label}</span>
        <span class="quad-read ${readClass}">${readLabel}</span>
        <span class="quad-outliers">${outliers}</span>
      `;
    }

    let confluenceSeq = 0;
    let confluenceInflight = 0;
    async function fetchConfluence(isPoll = false) {
      if (isPoll && (confluenceInflight || document.hidden)) return;
      const mySeq = ++confluenceSeq;
      confluenceInflight++;
      try {
        // Each pane may be on a different DTE / Greek, so the confluence read
        // is computed from every pane's OWN selection (specs parallel to
        // tickers), not one shared setting.
        const specs = state.panels.map((p) => {
          const sel = p.controller.getSelection();
          return `${sel.greek}~dte:${sel.dte}`;
        });
        const params = new URLSearchParams({ tickers: state.tickers.join(',') });
        if (specs.length === state.tickers.length) params.set('specs', specs.join(','));
        const res = await fetch(`/api/quadrinity?${params.toString()}`, { signal: AbortSignal.timeout(8000) });
        if (mySeq !== confluenceSeq) return;  // superseded by a newer request
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (mySeq !== confluenceSeq) return;
        renderConfluenceBanner(data);
      } catch (e) {
        if (mySeq === confluenceSeq) el.confluenceBanner.textContent = 'confluence unavailable';
      } finally {
        confluenceInflight--;
      }
    }

    renderGrid();
    // Confluence is a single cheap aggregate backend call — poll
    // independently of each panel's own 2s cadence so the banner tracks
    // the same live data without being coupled to panel internals.
    state.confluencePoll = setInterval(() => fetchConfluence(true), 3000);

    return {
      destroy() {
        clearInterval(state.confluencePoll);
        destroyPanels();
      },
    };
  }

  global.createQuadrinityView = createQuadrinityView;
})(window);
