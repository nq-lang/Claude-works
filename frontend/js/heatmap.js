// Skylit Heatseeker Terminal — Heatmap panel renderer (Part B).
//
// Built as a reusable factory (createHeatmapPanel) rather than a page-
// specific script, because Quadrinity (Part D, renamed per ARCHITECTURE.md
// §0) is explicitly "N synchronized instances of the same heatmap engine" —
// so the panel DOM/render logic must be the same function called 2-4 times,
// not a second implementation. This mirrors the backend's one-engine rule
// (Part E.1) at the render layer.
//
// Visual spec followed here matches the reference layout provided: ticker
// header with live price + change%, King-node subheader, per-strike colored
// rows using the shared diverging color scale (colorscale.js), a white pill
// marking the current spot price, and a footer min/max + gradient bar.

(function (global) {
  'use strict';

  const { exposureToColor, textColorFor, maxAbsExposureOf } = global.SkylitColorScale;
  const { nearestStrikeIndex } = global.SkylitNodeUtils;

  function fmtMoney(v) {
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    return `${sign}$${(abs / 1000).toFixed(1)}K`;
  }

  function fmtStrike(strike) {
    // Match reference: whole numbers shown without decimals, fractional
    // strikes (e.g. weekly QQQ 609.8) keep one decimal.
    return Number.isInteger(strike) ? String(strike) : strike.toFixed(1);
  }

  // Lowers brightness of an "rgb(r,g,b)" string toward black by `factor`
  // (0..1, where 1 = unchanged, 0 = black) WITHOUT changing hue — used by
  // the "Highlight nodes only" toggle so non-node rows still communicate
  // sign/magnitude via color, just dimmed rather than fully desaturated.
  function dimColor(rgbString, factor) {
    const m = rgbString.match(/rgb\((\d+),(\d+),(\d+)\)/);
    if (!m) return rgbString;
    const [, r, g, b] = m.map(Number);
    return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
  }

  // (nearestStrikeIndex provided by nodeutils.js, shared with atlas.js's
  // Orbs overlay. applyNodeLimit — also in nodeutils.js — is NOT used
  // here any more: the heatmap's row list must always be complete.)

  function createHeatmapPanel(container, opts) {
    const state = {
      ticker: opts.ticker,
      // Per-heatmap data selection (each heatmap is independent): ONE
      // expiration (0-6 DTE) and ONE Greek from `greekOptions`. Atlas
      // offers GEX/VEX; Quadrinity also offers CHEX (charm).
      greek: opts.greek || 'GEX',
      dte: opts.dte !== undefined ? opts.dte : 0,
      greekOptions: opts.greekOptions || ['GEX', 'VEX'],
      onSelectionChange: opts.onSelectionChange || null,
      // Velocity Mode (rate of change): pills show how fast each node's
      // absolute exposure is changing vs a reference — see velocity docs in
      // live_feed.hpp (annotate_velocity). baseline: session|5m|15m|1h|prev_close.
      // scope: match|0dte|all|custom (custom uses velocityDtes).
      velocityMode: !!opts.velocityMode,
      velocityBaseline: opts.velocityBaseline || 'session',
      velocityScope: opts.velocityScope || 'match',
      velocityDtes: opts.velocityDtes || [0],
      // REMOVED (critical correctness requirement): the heatmap's
      // scrollable price ladder must always contain EVERY strike the
      // backend returns for the selected DTE/expiration, however far
      // OTM, with no client-side truncation — scrolling must never hit
      // a dead end that isn't the true end of the data. There is
      // deliberately no nodeLimit state any more; see render() below.
      tickerOptions: opts.tickerOptions || [opts.ticker],
      onTickerChange: opts.onTickerChange || null,
      onClose: opts.onClose || null,
      onBoard: opts.onBoard || null,   // (board) => void — fires on every successful fetch
      hideControls: !!opts.hideControls,
      showBadges: opts.showBadges !== undefined ? !!opts.showBadges : false,
      // "Highlight nodes only": dims (lowers brightness of, does not
      // change hue of) every row that isn't King/Gatekeeper/Hedge, so the
      // structurally significant strikes visually pop out of the noise —
      // matches the reference's "de-emphasize non-node strikes" example.
      highlightNodesOnly: !!opts.highlightNodesOnly,
      // "Extremes Only" (this feature): independent of highlightNodesOnly
      // (which dims by structural ROLE). This dims everything except the
      // `extremesCount` most-positive and `extremesCount` most-negative
      // strikes by raw exposure magnitude, ranked across the FULL board
      // so "most positive/negative" never shifts just because the node-
      // count filter happened to hide the true extreme that session.
      // EXTREME tab: highlights the N most-positive and N most-negative
      // strikes (N = 5 by default).
      extremesOnly: !!opts.extremesOnly,
      extremesCount: opts.extremesCount || 5,
      firstSpot: null,
      hasRenderedOnce: false,
      pollHandle: null,
    };

    // --- SETTINGS: defaults, applied state, draft state ---------------------------
    // ONE definition of the defaults (Reset reads it; nothing is hard-coded in handlers).
    // `state` holds the APPLIED configuration — the only thing the heatmap renders from and the
    // only thing that is persisted. `draft` is what the settings panel edits; it changes nothing
    // on the heatmap until Apply. Closing the panel with unapplied edits DISCARDS them.
    const DEFAULTS = Object.freeze({
      greek: 'GEX', dte: 0,
      velocityMode: false, velocityBaseline: 'session', velocityScope: 'match', velocityDtes: [0],
      showBadges: false, highlightNodesOnly: false, extremesOnly: false, extremesCount: 5,
    });
    const SETTING_KEYS = Object.keys(DEFAULTS);
    const VEL_BASELINES = ['session', '5m', '15m', '1h', 'prev_close'];
    const VEL_SCOPES = ['match', '0dte', 'all', 'custom'];
    const pickSettings = (src) => { const o = {}; for (const k of SETTING_KEYS) o[k] = Array.isArray(src[k]) ? [...src[k]] : src[k]; return o; };
    const sameSettings = (a, b) => SETTING_KEYS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
    // Returns an error string, or null when the configuration is valid.
    function validateSettings(c) {
      if (!state.greekOptions.includes(c.greek)) return `Greek must be one of ${state.greekOptions.join(', ')}`;
      if (!Number.isInteger(c.dte) || c.dte < 0 || c.dte > 6) return 'Expiration must be 0-6 DTE';
      if (!VEL_BASELINES.includes(c.velocityBaseline)) return 'Unknown velocity baseline';
      if (!VEL_SCOPES.includes(c.velocityScope)) return 'Unknown velocity scope';
      if (c.velocityScope === 'custom' && !(Array.isArray(c.velocityDtes) && c.velocityDtes.length && c.velocityDtes.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) return 'Pick at least one custom velocity expiration';
      if (!Number.isInteger(c.extremesCount) || c.extremesCount < 1 || c.extremesCount > 20) return 'EXTREME strikes per side must be 1-20';
      return null;
    }
    const settingsKey = opts.settingsKey ? `skylit:heatmap-settings:${opts.settingsKey}` : null;
    function persistSettings() {
      if (!settingsKey) return;
      try { localStorage.setItem(settingsKey, JSON.stringify(pickSettings(state))); } catch (e) { /* not persisted */ }
    }
    if (settingsKey) {
      try {
        const saved = JSON.parse(localStorage.getItem(settingsKey) || 'null');
        if (saved && typeof saved === 'object') {
          const merged = { ...pickSettings(state), ...saved };
          if (!validateSettings(merged)) Object.assign(state, pickSettings(merged));   // a corrupt/stale save is ignored
        }
      } catch (e) { /* ignore */ }
    }
    const draft = pickSettings(state);
    // Quick controls that live OUTSIDE the settings panel apply immediately; once moved inside it
    // (compact mode) they edit the draft like everything else.
    const inPanel = !!opts.compactControls;

    const GREEK_NAMES = { GEX: 'Gamma', VEX: 'Vanna', 'GEX+VEX': 'Gamma+Vanna', CHEX: 'Charm', COLOR: 'Color', SPEED: 'Speed' };
    container.innerHTML = `
      <div class="hm-panel">
        <div class="hm-header">
          <div class="hm-header-top">
            <select class="hm-ticker-select"></select>
            <div class="hm-price">
              <span class="hm-price-val">--</span>
              <span class="hm-change-badge">--</span>
              ${state.onClose ? '<button class="hm-close-btn" title="Remove pane">&times;</button>' : ''}
            </div>
          </div>
          <div class="hm-selection-line"></div>
          <div class="hm-ctrl-stack">
            <button class="hm-ctrl-btn hm-dte-btn" title="Expiration and Greek for this heatmap"><span class="hm-dte-label"></span><span class="hm-caret">&#9662;</span></button>
            <button class="hm-ctrl-btn hm-velocity-btn" title="Velocity Mode: rate of change of each node's exposure">&#9889; Velocity Mode</button>
            <button class="hm-ctrl-btn hm-extreme-btn" title="Highlight the 5 most positive and 5 most negative strikes">EXTREME</button>
          </div>
        </div>
        <div class="hm-subheader">
          <div class="hm-king-label" title="King = the strike with the most POSITIVE exposure for this Greek and expiry"><span class="hm-king-dot"></span> King <span class="hm-king-strike"></span></div>
          <div class="hm-neg-label" style="display:none;" title="Barney = the strike with the most NEGATIVE exposure for this Greek and expiry"><span class="hm-neg-dot"></span> Barney <span class="hm-neg-strike"></span></div>
          <button class="hm-settings-gear" title="Heatmap settings">&#9881;</button>
        </div>
        <div class="hm-rows"></div>
        <div class="hm-footer">
          <span class="hm-min">--</span>
          <span class="hm-max">--</span>
          <span class="hm-fresh" title="Age of the data on screen (time since the last successful refresh)">--</span>
          <div class="hm-gradient-bar"></div>
        </div>
      </div>
    `;

    // --- DTE + Greek dropdown (per heatmap) ------------------------------------
    const dteBtn = container.querySelector('.hm-dte-btn');
    const dteMenu = document.createElement('div');
    dteMenu.className = 'hm-dte-menu';
    dteMenu.style.display = 'none';
    dteMenu.innerHTML = `
      <div class="hm-settings-row-label">Expiration</div>
      <div class="hm-menu-chips hm-menu-dte">${[0, 1, 2, 3, 4, 5, 6].map((d) => `<button class="hm-menu-chip" data-dte="${d}">${d}DTE</button>`).join('')}</div>
      <div class="hm-settings-row-label">Greek</div>
      <div class="hm-menu-chips hm-menu-greek">${state.greekOptions.map((k) => `<button class="hm-menu-chip" data-greek="${k}">${k}<small>${GREEK_NAMES[k] || ''}</small></button>`).join('')}</div>
    `;
    document.body.appendChild(dteMenu);
    // Where the expiration / Greek chips currently live: the dropdown menu, or
    // (compact mode) the settings popover they get moved into.
    let chipHost = dteMenu;
    function syncSelectionLine() {
      const bits = [`${state.dte}DTE`, state.greek];
      if (state.velocityMode) bits.push('Velocity');
      if (state.extremesOnly) bits.push('EXTREME');
      container.querySelector('.hm-selection-line').textContent = bits.join(' \u00b7 ');
    }
    function syncDteUi() {
      syncSelectionLine();
      container.querySelector('.hm-dte-label').textContent = `${state.dte}DTE \u00b7 ${state.greek}`;
      const v = inPanel ? draft : state;   // chips inside the settings panel show the DRAFT
      chipHost.querySelectorAll('[data-dte]').forEach((b) => b.classList.toggle('active', parseInt(b.dataset.dte, 10) === v.dte));
      chipHost.querySelectorAll('[data-greek]').forEach((b) => b.classList.toggle('active', b.dataset.greek === v.greek));
    }
    function notifySelection() { if (state.onSelectionChange) state.onSelectionChange({ greek: state.greek, dte: state.dte }); }
    dteMenu.querySelectorAll('[data-dte]').forEach((b) => b.addEventListener('click', () => {
      if (inPanel) { draft.dte = parseInt(b.dataset.dte, 10); refreshDraftUi(); return; }
      state.dte = draft.dte = parseInt(b.dataset.dte, 10);
      state.hasRenderedOnce = false;   // a different expiry's King/spot may sit elsewhere: re-center
      persistSettings(); syncDteUi(); notifySelection(); fetchAndRender();
    }));
    dteMenu.querySelectorAll('[data-greek]').forEach((b) => b.addEventListener('click', () => {
      if (inPanel) { draft.greek = b.dataset.greek; refreshDraftUi(); return; }
      state.greek = draft.greek = b.dataset.greek;
      persistSettings(); syncDteUi(); notifySelection(); fetchAndRender();
    }));
    dteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dteMenu.style.display === 'none') {
        const r = dteBtn.getBoundingClientRect();
        dteMenu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 270))}px`;
        dteMenu.style.top = `${r.bottom + 4}px`;
        dteMenu.style.display = 'block';
      } else dteMenu.style.display = 'none';
    });
    // document-level listeners are removed in destroy() (via this signal); otherwise
    // every rebuilt panel would leave two of them behind, pinning its detached popover DOM.
    const lifecycle = new AbortController();
    document.addEventListener('click', (e) => {
      if (!dteMenu.contains(e.target) && e.target !== dteBtn && !dteBtn.contains(e.target)) dteMenu.style.display = 'none';
    }, { signal: lifecycle.signal });
    syncDteUi();

    const velocityBtn = container.querySelector('.hm-velocity-btn');
    const extremeBtn = container.querySelector('.hm-extreme-btn');
    function syncToggleButtons() {
      syncSelectionLine();
      const v = inPanel ? draft : state;
      velocityBtn.classList.toggle('active', v.velocityMode);
      extremeBtn.classList.toggle('active', v.extremesOnly);
    }
    velocityBtn.addEventListener('click', () => {
      if (inPanel) { draft.velocityMode = !draft.velocityMode; refreshDraftUi(); return; }
      state.velocityMode = draft.velocityMode = !state.velocityMode; persistSettings(); syncToggleButtons(); fetchAndRender();
    });
    extremeBtn.addEventListener('click', () => {
      if (inPanel) { draft.extremesOnly = !draft.extremesOnly; refreshDraftUi(); return; }
      state.extremesOnly = draft.extremesOnly = !state.extremesOnly;
      if (el && el.extremesCheckbox) el.extremesCheckbox.checked = state.extremesOnly;
      persistSettings(); syncToggleButtons(); fetchAndRender();
    });
    syncToggleButtons();

    // --- Settings gear popover (this correction): consolidates exposure
    // type, expiration scope, node count, badges, and highlight-nodes
    // into one gear-triggered panel instead of always-visible rows —
    // matches the reference's settings-subtab pattern. Built as a
    // separate DOM tree appended to document.body (not inside `container`)
    // so it can float above the panel without being clipped by any
    // overflow:hidden ancestor (e.g. the sidecar's scroll container).
    const gearBtn = container.querySelector('.hm-settings-gear');
    const settingsPopover = document.createElement('div');
    settingsPopover.className = 'hm-settings-popover';
    settingsPopover.style.display = 'none';
    settingsPopover.innerHTML = `
      <div class="hm-settings-popover-title">Heatmap Settings</div>
      <div class="hm-settings-row-label">Velocity baseline</div>
      <select class="hm-vel-baseline">
        <option value="session">Session open (09:30)</option>
        <option value="5m">Rolling 5 min</option>
        <option value="15m">Rolling 15 min</option>
        <option value="1h">Rolling 1 hour</option>
        <option value="prev_close">Previous day close</option>
      </select>
      <div class="hm-settings-row-label">Velocity expirations</div>
      <select class="hm-vel-scope">
        <option value="match">Match this heatmap</option>
        <option value="0dte">0DTE only</option>
        <option value="all">All expirations</option>
        <option value="custom">Custom DTEs&hellip;</option>
      </select>
      <div class="hm-vel-custom" style="display:none;">
        ${[0, 1, 2, 3, 4, 5, 6].map((d) => `<label><input type="checkbox" data-vdte="${d}">${d}</label>`).join('')}
      </div>
      <label class="hm-badges-toggle">
        <input type="checkbox" class="hm-badges-checkbox" ${state.showBadges ? 'checked' : ''}>
        Badges
      </label>
      <label class="hm-badges-toggle">
        <input type="checkbox" class="hm-highlight-checkbox" ${state.highlightNodesOnly ? 'checked' : ''}>
        Highlight Nodes
      </label>
      <label class="hm-badges-toggle hm-extremes-label">
        <input type="checkbox" class="hm-extremes-checkbox" ${state.extremesOnly ? 'checked' : ''}>
        EXTREME
      </label>
      <select class="hm-extremes-count">
        ${[4, 5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}" ${n === state.extremesCount ? 'selected' : ''}>${n} strikes each side</option>`).join('')}
      </select>
      <div class="hm-settings-error" style="display:none;"></div>
      <div class="hm-settings-actions">
        <button class="hm-settings-reset" title="Restore the default settings and apply them">Reset</button>
        <button class="hm-settings-apply" title="Save these settings and apply them to the heatmap" disabled>Apply</button>
      </div>
    `;
    document.body.appendChild(settingsPopover);

    // Compact mode (Atlas heatmaps): the expiration / Greek / Velocity Mode /
    // EXTREME controls live INSIDE this heatmap's settings instead of taking
    // header space. The existing nodes are MOVED (not cloned) so every
    // handler and sync keeps working; the header keeps just the ticker and a
    // one-line readout of what is being displayed.
    if (opts.compactControls) {
      container.querySelector('.hm-panel').classList.add('hm-compact');
      settingsPopover.classList.add('hm-popover-compact');
      const box = document.createElement('div');
      box.className = 'hm-compact-controls';
      while (dteMenu.firstChild) box.appendChild(dteMenu.firstChild);
      box.appendChild(velocityBtn);
      box.appendChild(extremeBtn);
      settingsPopover.insertBefore(box, settingsPopover.children[1]);
      dteMenu.remove();
      chipHost = box;
      syncDteUi();
    }

    if (gearBtn) {
      gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (settingsPopover.style.display === 'none') {
          const rect = gearBtn.getBoundingClientRect();
          settingsPopover.style.left = `${Math.max(4, rect.right - 220)}px`;
          settingsPopover.style.top = `${rect.bottom + 6}px`;
          settingsPopover.style.display = 'block';
          const w = settingsPopover.offsetWidth;
          settingsPopover.style.left = `${Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8))}px`;
          const h = settingsPopover.offsetHeight;
          if (rect.bottom + 6 + h > window.innerHeight - 8) settingsPopover.style.top = `${Math.max(8, window.innerHeight - h - 8)}px`;
        } else {
          settingsPopover.style.display = 'none'; discardDraft();
        }
      });
      document.addEventListener('click', (e) => {
        if (settingsPopover.style.display !== 'none' && !settingsPopover.contains(e.target) && e.target !== gearBtn) { settingsPopover.style.display = 'none'; discardDraft(); }
      }, { signal: lifecycle.signal });
    }

    const el = {
      tickerSelect: container.querySelector('.hm-ticker-select'),
      priceVal: container.querySelector('.hm-price-val'),
      changeBadge: container.querySelector('.hm-change-badge'),
      closeBtn: container.querySelector('.hm-close-btn'),
      kingStrike: container.querySelector('.hm-king-strike'),
      negLabel: container.querySelector('.hm-neg-label'),
      negStrike: container.querySelector('.hm-neg-strike'),
      velBaseline: settingsPopover.querySelector('.hm-vel-baseline'),
      velScope: settingsPopover.querySelector('.hm-vel-scope'),
      velCustom: settingsPopover.querySelector('.hm-vel-custom'),
      badgesCheckbox: settingsPopover.querySelector('.hm-badges-checkbox'),
      highlightCheckbox: settingsPopover.querySelector('.hm-highlight-checkbox'),
      extremesCheckbox: settingsPopover.querySelector('.hm-extremes-checkbox'),
      extremesCountSelect: settingsPopover.querySelector('.hm-extremes-count'),
      rows: container.querySelector('.hm-rows'),
      fresh: container.querySelector('.hm-fresh'),
      min: container.querySelector('.hm-min'),
      max: container.querySelector('.hm-max'),
      gradientBar: container.querySelector('.hm-gradient-bar'),
    };

    // Populate the diverging gradient bar once (visual legend, footer).
    el.gradientBar.style.background =
      'linear-gradient(to right, rgb(54,0,92), rgb(34,45,133), rgb(30,130,148), rgb(58,173,90), rgb(252,229,35))';
    el.velBaseline.value = state.velocityBaseline;
    el.velScope.value = state.velocityScope;
    el.velCustom.style.display = state.velocityScope === 'custom' ? 'flex' : 'none';
    el.velCustom.querySelectorAll('[data-vdte]').forEach((c) => { c.checked = state.velocityDtes.includes(parseInt(c.dataset.vdte, 10)); });

    state.tickerOptions.forEach((t) => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      if (t === state.ticker) o.selected = true;
      el.tickerSelect.appendChild(o);
    });
    el.tickerSelect.addEventListener('change', () => {
      state.ticker = el.tickerSelect.value;
      state.firstSpot = null; // reset session-change baseline on ticker switch
      state.hasRenderedOnce = false; // re-center scroll on the new ticker's spot
      if (state.onTickerChange) state.onTickerChange(state.ticker);
      fetchAndRender();
    });

    if (el.closeBtn) {
      el.closeBtn.addEventListener('click', () => state.onClose && state.onClose());
    }

    // Panel controls edit the DRAFT only; nothing reaches the heatmap until Apply.
    el.velBaseline.addEventListener('change', () => { draft.velocityBaseline = el.velBaseline.value; refreshDraftUi(); });
    el.velScope.addEventListener('change', () => { draft.velocityScope = el.velScope.value; refreshDraftUi(); });
    el.velCustom.querySelectorAll('[data-vdte]').forEach((c) => c.addEventListener('change', () => {
      draft.velocityDtes = [...el.velCustom.querySelectorAll('[data-vdte]')].filter((x) => x.checked).map((x) => parseInt(x.dataset.vdte, 10));
      refreshDraftUi();
    }));
    el.badgesCheckbox.addEventListener('change', () => { draft.showBadges = el.badgesCheckbox.checked; refreshDraftUi(); });
    el.highlightCheckbox.addEventListener('change', () => { draft.highlightNodesOnly = el.highlightCheckbox.checked; refreshDraftUi(); });
    el.extremesCheckbox.addEventListener('change', () => { draft.extremesOnly = el.extremesCheckbox.checked; refreshDraftUi(); });
    el.extremesCountSelect.addEventListener('change', () => { draft.extremesCount = parseInt(el.extremesCountSelect.value, 10); refreshDraftUi(); });

    const applyBtn = settingsPopover.querySelector('.hm-settings-apply');
    const resetBtn = settingsPopover.querySelector('.hm-settings-reset');
    const errEl = settingsPopover.querySelector('.hm-settings-error');
    function showError(msg) { errEl.textContent = msg || ''; errEl.style.display = msg ? 'block' : 'none'; }
    // Push the draft into every control in the panel; Apply is only enabled with pending changes.
    function refreshDraftUi() {
      el.velBaseline.value = draft.velocityBaseline;
      el.velScope.value = draft.velocityScope;
      el.velCustom.style.display = draft.velocityScope === 'custom' ? 'flex' : 'none';
      el.velCustom.querySelectorAll('[data-vdte]').forEach((c) => { c.checked = draft.velocityDtes.includes(parseInt(c.dataset.vdte, 10)); });
      el.badgesCheckbox.checked = draft.showBadges;
      el.highlightCheckbox.checked = draft.highlightNodesOnly;
      el.extremesCheckbox.checked = draft.extremesOnly;
      el.extremesCountSelect.value = String(draft.extremesCount);
      syncDteUi(); syncToggleButtons();
      applyBtn.disabled = sameSettings(draft, state);
      showError('');
    }
    // Commit a configuration as the new APPLIED state: validate, store, render, persist.
    function commitSettings(cfg) {
      const err = validateSettings(cfg);
      if (err) { showError(err); return false; }       // the draft is kept so the user can fix it
      const dteChanged = cfg.dte !== state.dte, selChanged = dteChanged || cfg.greek !== state.greek;
      Object.assign(state, pickSettings(cfg));
      if (dteChanged) state.hasRenderedOnce = false;   // another expiry's King/spot may sit elsewhere: re-center
      Object.assign(draft, pickSettings(state));
      persistSettings();
      refreshDraftUi(); syncDteUi(); syncToggleButtons();
      if (selChanged) notifySelection();
      if (opts.onSettingsApplied) opts.onSettingsApplied(pickSettings(state));
      fetchAndRender();
      return true;
    }
    applyBtn.addEventListener('click', () => { if (!applyBtn.disabled) commitSettings(draft); });
    resetBtn.addEventListener('click', () => commitSettings(pickSettings(DEFAULTS)));   // restores defaults AND applies them
    function discardDraft() { Object.assign(draft, pickSettings(state)); refreshDraftUi(); }
    refreshDraftUi();

    function render(board) {
      if (state.firstSpot === null) state.firstSpot = board.spot;
      state.lastOkAt = Date.now(); paintFreshness();
      const changePct = ((board.spot - state.firstSpot) / state.firstSpot) * 100;
      el.priceVal.textContent = `$${board.spot.toFixed(2)}`;
      el.changeBadge.textContent = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
      el.changeBadge.classList.toggle('positive', changePct >= 0);
      el.changeBadge.classList.toggle('negative', changePct < 0);

      // King = most POSITIVE strike, Barney = most NEGATIVE strike (owner definitions), computed over
      // the FULL board for this (ticker, Greek, DTE) with hysteresis keyed to that same scope.
      const memKey = `${state.ticker}|${state.greek}|${state.dte}`;
      if (state.extremesMemoryKey !== memKey) { state.extremesMemoryKey = memKey; state.extremesMemory = null; }
      const ext = SkylitNodeUtils.classifyExtremes(board.nodes, board.spot, state.extremesMemory);
      state.extremesMemory = { king: ext.king ? ext.king.strike : null, barney: ext.barney ? ext.barney.strike : null };
      const kingNode = ext.king, negNode = ext.barney;
      el.kingStrike.textContent = kingNode ? `@ ${fmtStrike(kingNode.strike)}` : '';
      el.negLabel.style.display = negNode ? '' : 'none';
      if (negNode) el.negStrike.textContent = `@ ${fmtStrike(negNode.strike)}`;

      if (!board.nodes.length) {   // explicit empty state — never a blank panel
        el.rows.innerHTML = `<div class="hm-empty">No ${state.greek} exposure for ${state.ticker} at ${state.dte}DTE.</div>`;
        el.min.textContent = '--'; el.max.textContent = '--';
        return;
      }

      // Every strike the backend returned for this DTE/expiration, full
      // stop — no client-side limiting. See the removed-nodeLimit comment
      // above for why this must never truncate, however far OTM a strike is.
      let nodes = [...board.nodes].sort((a, b) => b.strike - a.strike); // high strikes on top

      const maxAbs = maxAbsExposureOf(board.nodes); // scale from FULL board, not the filtered subset
      const spotIdx = nearestStrikeIndex(nodes, board.spot);

      // "Extremes Only": ranked across the FULL board (not the node-count-
      // filtered subset) so the true top/bottom strikes are always the
      // ones highlighted, even if the node-count filter would otherwise
      // have hidden one of them from view entirely.
      let extremeStrikes = null;
      if (state.extremesOnly) {
        const byExposure = [...board.nodes].sort((a, b) => b.exposure - a.exposure);
        const topPositive = byExposure.slice(0, state.extremesCount);
        const topNegative = byExposure.slice(-state.extremesCount);
        extremeStrikes = new Set([...topPositive, ...topNegative].map((n) => n.strike));
      }

      // Every poll rebuilds the row list (exposure values, and potentially
      // which strikes rank in the node-count filter, can both change
      // between polls). A naive rebuild resets el.rows.scrollTop to 0 each
      // time, which makes it impossible for a user to actually scroll
      // around and look at other strikes — the view would keep snapping
      // back. Preserve scroll position across rebuilds; only auto-center
      // on the current spot the very first time this panel renders.
      const preservedScrollTop = el.rows.scrollTop;
      const isFirstRender = !state.hasRenderedOnce;

      el.rows.innerHTML = '';
      nodes.forEach((n, i) => {
        const row = document.createElement('div');
        row.className = 'hm-row';
        const bg = exposureToColor(n.exposure, maxAbs);
        const fg = textColorFor(n.exposure, maxAbs);

        const isKing = !!kingNode && n.strike === kingNode.strike;
        const isGatekeeper = n.role === 'gatekeeper';
        const isHedge = n.role === 'hedge';
        const isStructuralNode = isKing || isGatekeeper || isHedge;

        // Two independent dimming criteria, "Extremes Only" taking
        // priority when both are active (it's the more specific ask —
        // "only the most positive/negative N strikes" — vs. "Highlight
        // Nodes"'s role-based King/Gatekeeper/Hedge criterion):
        //   - Extremes Only: dim everything except the `extremesCount`
        //     most-positive and most-negative strikes by raw exposure.
        //   - Highlight Nodes: dim everything except King/Gatekeeper/Hedge.
        // Either way, dimmed rows keep their hue (still communicate sign/
        // magnitude at a glance) but lose brightness/opacity so the
        // highlighted strikes visually pop out of the noise.
        const isHighlighted = state.extremesOnly
          ? extremeStrikes.has(n.strike)
          : (!state.highlightNodesOnly || isStructuralNode);
        if (!isHighlighted) {
          row.style.backgroundColor = dimColor(bg, 0.28);
          row.style.color = 'rgba(255,255,255,0.35)';
        } else {
          row.style.backgroundColor = bg;
          row.style.color = fg;
        }

        const isNeg = !!negNode && n.strike === negNode.strike;
        let badge = '';
        if (isNeg) badge = '<span class="hm-badge hm-badge-neg" title="Barney — most negative strike"></span>';
        else if (isKing) badge = '<span class="hm-badge hm-badge-king" title="King — most positive strike"></span>';
        else if (isGatekeeper) badge = '<span class="hm-badge hm-badge-gate" title="Gatekeeper Node"></span>';
        else if (isHedge) badge = '<span class="hm-badge hm-badge-hedge" title="Hedge Node"></span>';

        // Session-change % badge (spec: green = position size growing
        // since session start, red = shrinking/unwinding). Only rendered
        // when the "Badges" toggle is on, and only when the change clears
        // a small threshold — otherwise every row would carry noisy ±0.3%
        // badges that don't match the reference's sparser look.
        let pctBadge = '';
        if (state.velocityMode) {
          // Velocity pill: green outline = exposure accumulating, red outline
          // = unwinding, NEW = a node that did not exist at the reference.
          if (n.velocity_new) {
            pctBadge = '<span class="hm-vel-pill hm-vel-new" title="New node: no exposure at the reference">NEW</span>';
          } else if (Math.abs(n.velocity_pct) >= 1) {
            const up = n.velocity_pct >= 0;
            const mag = Math.abs(n.velocity_pct) > 999 ? '>999' : Math.abs(n.velocity_pct).toFixed(0);
            pctBadge = `<span class="hm-vel-pill ${up ? 'hm-vel-pos' : 'hm-vel-neg'}" title="Velocity vs ${state.velocityBaseline}">${up ? '+' : '-'}${mag}%</span>`;
          }
        } else if (state.showBadges && Math.abs(n.session_change_pct) >= 1) {
          const isPositive = n.session_change_pct >= 0;
          const sign = isPositive ? '+' : '';
          pctBadge = `<span class="hm-pct-badge ${isPositive ? 'hm-pct-positive' : 'hm-pct-negative'}">${sign}${n.session_change_pct.toFixed(0)}%</span>`;
        }

        if (i === spotIdx) {
          row.classList.add('hm-row-current');
          row.innerHTML = `<span class="hm-current-marker">${fmtStrike(n.strike)}</span>${badge}${pctBadge}<span class="hm-value">${fmtMoney(n.exposure)}</span>`;
        } else {
          row.innerHTML = `<span class="hm-strike">${fmtStrike(n.strike)}</span>${badge}${pctBadge}<span class="hm-value">${fmtMoney(n.exposure)}</span>`;
        }
        el.rows.appendChild(row);
      });

      if (isFirstRender) {
        // First paint: center the view on the current spot row rather than
        // dropping the user at the top of a (potentially long) strike list.
        const spotRow = el.rows.children[spotIdx];
        if (spotRow) {
          const target = spotRow.offsetTop - el.rows.clientHeight / 2 + spotRow.clientHeight / 2;
          el.rows.scrollTop = Math.max(0, target);
        }
        state.hasRenderedOnce = true;
      } else {
        el.rows.scrollTop = preservedScrollTop;
      }

      const exposures = board.nodes.map((n) => n.exposure);
      el.min.textContent = fmtMoney(Math.min(...exposures));
      el.max.textContent = fmtMoney(Math.max(...exposures));

      if (state.onBoard) state.onBoard(board);
    }

    // Explicit refreshes (ticker / DTE / Greek / toggle changes) always fetch and
    // supersede anything still in flight; the 2s timer skips a tick while a
    // request is outstanding or the tab is hidden, so slow links cannot pile up.
    let renderSeq = 0;
    let inflight = 0;
    // Freshness: age of the data on screen. LIVE while < 6 s old; STALE (red) beyond that, so a
    // frozen feed can never masquerade as live data.
    function paintFreshness() {
      if (!el.fresh) return;
      if (!state.lastOkAt) { el.fresh.textContent = '--'; el.fresh.classList.remove('stale'); return; }
      const age = (Date.now() - state.lastOkAt) / 1000;
      const stale = age >= 6;
      el.fresh.textContent = stale ? `STALE ${Math.round(age)}s` : 'LIVE';
      el.fresh.classList.toggle('stale', stale);
    }
    const freshTimer = setInterval(paintFreshness, 1000);

    async function fetchAndRender(isPoll = false) {
      if (isPoll && (inflight || document.hidden)) return;
      const mySeq = ++renderSeq;
      inflight++;
      try {
        let url = `/api/heatmap?ticker=${encodeURIComponent(state.ticker)}` +
          `&exposure=${encodeURIComponent(state.greek)}&expiration=${encodeURIComponent('dte:' + state.dte)}`;
        if (state.velocityMode) {
          url += `&velocity=1&velocity_baseline=${encodeURIComponent(state.velocityBaseline)}` +
            `&velocity_scope=${encodeURIComponent(state.velocityScope)}` +
            `&velocity_dtes=${encodeURIComponent(state.velocityDtes.join(','))}`;
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });  // a hung request must free the in-flight slot
        if (mySeq !== renderSeq) return;  // superseded by a newer request
        if (!res.ok) throw new Error(`status ${res.status}`);
        const board = await res.json();
        if (mySeq !== renderSeq) return;
        render(board);
      } catch (e) {
        if (mySeq === renderSeq) {
          el.rows.innerHTML = `<div class="hm-error">Unable to load ${state.ticker} (${state.dte}DTE ${state.greek}): ${e.message}. Retrying every 2 s.</div>`;
          paintFreshness();
        }
      } finally {
        inflight--;
      }
    }

    // Poll cadence: 2s. Backend price-ticks every 1s and refreshes exposure
    // every >=60s (live_feed.hpp); polling at 2s keeps the panel visually
    // "live" without hammering the server. Will move to WebSocket push per
    // ARCHITECTURE.md §2 amendment once that transport exists.
    fetchAndRender();
    state.pollHandle = setInterval(() => fetchAndRender(true), 2000);

    // pause()/resume(): used by the Atlas sidecar when "Show Heatmap" is OFF so a hidden panel does
    // no network, parsing or DOM work. Settings/selection are kept; resume() refreshes at once.
    function pausePolling() {
      if (state.pollHandle === null) return;
      clearInterval(state.pollHandle); state.pollHandle = null;
      renderSeq++;  // drop any reply still in flight: nothing is drawn while hidden
    }
    function resumePolling() {
      if (state.pollHandle !== null) return;
      fetchAndRender();
      state.pollHandle = setInterval(() => fetchAndRender(true), 2000);
    }

    return {
      pause: pausePolling,
      resume: resumePolling,
      destroy() { clearInterval(state.pollHandle); clearInterval(freshTimer); renderSeq++; lifecycle.abort(); settingsPopover.remove(); dteMenu.remove(); },
      setTicker(t) { state.ticker = t; state.hasRenderedOnce = false; el.tickerSelect.value = t; fetchAndRender(); },
      setGreek(g) { state.greek = draft.greek = g; persistSettings(); refreshDraftUi(); fetchAndRender(); },
      setDte(d) { state.dte = draft.dte = d; state.hasRenderedOnce = false; persistSettings(); refreshDraftUi(); fetchAndRender(); },
      getSelection() { return { greek: state.greek, dte: state.dte }; },
      setShowBadges(show) {
        state.showBadges = draft.showBadges = show;
        persistSettings(); refreshDraftUi();
        fetchAndRender();
      },
      setHighlightNodesOnly(show) {
        state.highlightNodesOnly = draft.highlightNodesOnly = show;
        persistSettings(); refreshDraftUi();
        fetchAndRender();
      },
      setExtreme(show) { state.extremesOnly = draft.extremesOnly = show; persistSettings(); refreshDraftUi(); fetchAndRender(); },
      setVelocityMode(show) { state.velocityMode = draft.velocityMode = show; persistSettings(); refreshDraftUi(); fetchAndRender(); },
      resetToDefaults() { return commitSettings(pickSettings(DEFAULTS)); },
      getSettings() { return pickSettings(state); },
    };
  }

  global.createHeatmapPanel = createHeatmapPanel;
})(window);
