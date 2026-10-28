// Skylit Heatseeker Terminal — Atlas sidecar controller.
//
// The sidecar area next to Atlas's chart(s) can show either:
//   - a single full-featured Heatmap panel (default), or
//   - a "Quadrinity" row of 2-4 heatmap panels.
//
// REVISION: Quadrinity is now ONE toggle button (no separate checkbox +
// settings gear). Clicking it opens an anchored options popover — the
// same interaction pattern the chart toolbar's "Windows" button already
// uses — offering Off / 2 / 3 / 4 heatmaps; picking a count turns
// Quadrinity on with that many panels in one step, picking Off reverts
// to the single panel. There is no intermediate "on with some default
// count" state the way the old checkbox+gear produced.
//
// CORRECTION (this revision): panels lay out HORIZONTALLY, side by side —
// matching the reference screenshots/HTML exactly — never stacked
// vertically. An earlier revision stacked them vertically, which is wrong
// per the reference and also gives each panel less room to show its data
// (a narrow, short panel vs. a full-height column). Panels are now full
// sidecar-height columns, exactly like Quadrinity's own full-page grid —
// this brings the sidecar's layout DIRECTION in line with Quadrinity's,
// even though the two still use separate controller code (see the
// reasoning in this file's previous revision / ARCHITECTURE.md — the
// sidecar is a resizable-width region, not a fixed-width page section).
//
// Reuses createHeatmapPanel (heatmap.js) for every panel in both modes —
// no separate rendering implementation.

(function (global) {
  'use strict';

  const DEFAULT_PANE_COUNT = 2;
  const MIN_PANES = 2;
  const MAX_PANES = 4;

  function createAtlasSidecar(containerEl, opts) {
    const tickerOptions = opts.tickerOptions && opts.tickerOptions.length
      ? opts.tickerOptions : [opts.defaultTicker || 'SPY'];
    const defaultTicker = opts.defaultTicker || tickerOptions[0];

    const state = {
      quadrinityMode: false,
      visible: true,
      paneCount: DEFAULT_PANE_COUNT,
      tickers: [defaultTicker, tickerOptions.find((t) => t !== defaultTicker) || tickerOptions[0]],
      showBadges: false,   // header badges icon: applies to every Atlas heatmap
      singlePanel: null,   // { controller } — used when quadrinityMode is false
      panels: [],          // [{ controller }] — used when quadrinityMode is true
    };

    containerEl.innerHTML = `
      <div class="sidecar-header-controls">
        <label class="sidecar-quad-toggle">
          <input type="checkbox" class="sidecar-show-checkbox" checked> Show Heatmap
        </label>
        <span class="sidecar-header-spacer"></span>
        <button class="sidecar-badges-btn" title="Badges: show each node's change since the session opened">&#9873; Badges</button>
        <button class="sidecar-quad-toggle-btn" title="Quadrinity: show 2-4 heatmaps side by side">&#9881; Quadrinity</button>
      </div>
      <div class="sidecar-panels"></div>
    `;
    const el = {
      showCheckbox: containerEl.querySelector('.sidecar-show-checkbox'),
      quadToggleBtn: containerEl.querySelector('.sidecar-quad-toggle-btn'),
      badgesBtn: containerEl.querySelector('.sidecar-badges-btn'),
      panels: containerEl.querySelector('.sidecar-panels'),
    };
    // LAYOUT STATE: "Show Heatmap" OFF removes the whole sidecar from the layout (display:none, so
    // the flex chart pane takes the freed width and the chart's ResizeObserver resizes the canvas)
    // and PAUSES every heatmap panel's polling. A restore control lives in the toolbar (index.html,
    // via onVisibilityChange) because this header is hidden together with the sidecar.
    function setVisible(show) {
      state.visible = show;
      el.showCheckbox.checked = show;
      containerEl.style.display = show ? '' : 'none';
      const panels = state.singlePanel ? [state.singlePanel] : state.panels;
      panels.forEach((p) => (show ? p.controller.resume() : p.controller.pause()));
      if (opts.onVisibilityChange) opts.onVisibilityChange(show);
    }
    el.showCheckbox.addEventListener('change', () => setVisible(el.showCheckbox.checked));

    // --- Quadrinity options popover --------------------------------------
    // Off / 2 / 3 / 4 — a single-select list, same anchored-popover
    // interaction as the chart toolbar's "Windows" button, positioned
    // below the toggle it belongs to.
    const popover = document.createElement('div');
    popover.className = 'sidecar-quad-popover';
    popover.style.display = 'none';
    popover.innerHTML = `
      <div class="sidecar-quad-popover-title">Heatmaps to show</div>
      <button class="sidecar-quad-count-btn" data-count="0">Off</button>
      ${[2, 3, 4].map((n) => `<button class="sidecar-quad-count-btn" data-count="${n}">${n}</button>`).join('')}
    `;
    document.body.appendChild(popover);
    function syncPopoverActive() {
      const active = state.quadrinityMode ? state.paneCount : 0;
      popover.querySelectorAll('.sidecar-quad-count-btn').forEach((b) =>
        b.classList.toggle('active', parseInt(b.dataset.count, 10) === active));
    }
    function syncToggleLabel() {
      el.quadToggleBtn.innerHTML = state.quadrinityMode
        ? `&#9881; Quadrinity (${state.paneCount})` : `&#9881; Quadrinity`;
      el.quadToggleBtn.classList.toggle('active', state.quadrinityMode);
    }
    popover.querySelectorAll('.sidecar-quad-count-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const count = parseInt(btn.dataset.count, 10);
        if (count === 0) { state.quadrinityMode = false; renderSingle(); } else { setPaneCount(count); }
        syncPopoverActive();
        syncToggleLabel();
        popover.style.display = 'none';
      });
    });
    el.quadToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      syncPopoverActive();
      if (popover.style.display === 'none') {
        const rect = el.quadToggleBtn.getBoundingClientRect();
        popover.style.left = `${rect.left}px`;
        popover.style.top = `${rect.bottom + 6}px`;
        popover.style.display = 'block';
      } else {
        popover.style.display = 'none';
      }
    });
    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && e.target !== el.quadToggleBtn) popover.style.display = 'none';
    });

    function destroyAll() {
      if (state.singlePanel) { state.singlePanel.controller.destroy(); state.singlePanel = null; }
      state.panels.forEach((p) => p.controller.destroy());
      state.panels = [];
    }

    function renderSingle() {
      destroyAll();
      el.panels.className = 'sidecar-panels sidecar-panels-single';
      el.panels.innerHTML = '';
      const controller = createHeatmapPanel(el.panels, {
        ticker: state.tickers[0],
        tickerOptions,
        showBadges: state.showBadges,
        greekOptions: ['GEX', 'VEX', 'GEX+VEX'],   // Atlas heatmaps: gamma, vanna, or both combined
        compactControls: true,                      // DTE/Greek/Velocity/EXTREME live in the heatmap's settings
        settingsKey: 'atlas:single',                // applied settings persist per panel
        onSettingsApplied: (cfg) => {   // the header Badges button always mirrors the last applied setting
          state.showBadges = cfg.showBadges; el.badgesBtn.classList.toggle('active', state.showBadges);
        },
      });
      state.singlePanel = { controller };
      state.showBadges = controller.getSettings().showBadges;   // the header Badges button mirrors the applied setting
      el.badgesBtn.classList.toggle('active', state.showBadges);
      if (opts.onPaneCountChange) opts.onPaneCountChange(1);
    }

    function renderMulti() {
      destroyAll();
      el.panels.className = 'sidecar-panels sidecar-panels-horizontal';
      el.panels.innerHTML = '';
      while (state.tickers.length < state.paneCount) {
        const unused = tickerOptions.find((t) => !state.tickers.includes(t)) || tickerOptions[0];
        state.tickers.push(unused);
      }
      state.tickers = state.tickers.slice(0, state.paneCount);

      state.tickers.forEach((ticker, idx) => {
        const paneEl = document.createElement('div');
        paneEl.className = 'sidecar-horizontal-pane';
        el.panels.appendChild(paneEl);
        const controller = createHeatmapPanel(paneEl, {
          ticker,
          tickerOptions,
          showBadges: state.showBadges,
          greekOptions: ['GEX', 'VEX', 'GEX+VEX'],
          compactControls: true,
          settingsKey: `atlas:multi:${idx}`,
          onSettingsApplied: (cfg) => {   // the header Badges button always mirrors the last applied setting
            state.showBadges = cfg.showBadges; el.badgesBtn.classList.toggle('active', state.showBadges);
          },
        });
        state.panels.push({ controller });
      });
      if (opts.onPaneCountChange) opts.onPaneCountChange(state.paneCount);
    }

    // Picking a count from the popover is what TURNS Quadrinity on — there
    // is no separate "on with a leftover/default count" state to pass
    // through first.
    function setPaneCount(n) {
      state.paneCount = Math.max(MIN_PANES, Math.min(MAX_PANES, n));
      state.quadrinityMode = true;
      renderMulti();
    }

    // Header Badges icon (across from "Show Heatmap"): toggles the
    // change-since-open pills on every heatmap in the sidecar.
    el.badgesBtn.addEventListener('click', () => {
      state.showBadges = !state.showBadges;
      el.badgesBtn.classList.toggle('active', state.showBadges);
      if (state.singlePanel) state.singlePanel.controller.setShowBadges(state.showBadges);
      state.panels.forEach((p) => p.controller.setShowBadges(state.showBadges));
    });

    renderSingle();
    syncToggleLabel();

    return {
      destroy() {
        destroyAll();
        popover.remove();
      },
      setVisible,
      isVisible() { return state.visible; },
      isQuadrinityMode() { return state.quadrinityMode; },
      getPaneCount() { return state.quadrinityMode ? state.paneCount : 1; },
    };
  }

  global.createAtlasSidecar = createAtlasSidecar;
})(window);
