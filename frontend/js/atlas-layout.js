// Skylit Heatseeker Terminal — Atlas multi-window layout manager.
//
// Owns the SINGLE global toolbar that drives every open pane uniformly:
// interval, exposure type, expiration scope, node count, Orbs on/off +
// size/opacity (via a settings popover with explicit Save/Reset), Dark
// Pool, Flow, and Live/resume. This is the fix for the reported bug where
// node count (and other settings) were per-pane and didn't stay in sync —
// there is now exactly ONE source of truth for each of these, applied to
// every pane's createAtlasController instance through its setter methods,
// the same "one shared toolbar drives every pane" pattern Quadrinity
// established for heatmap panels.
//
// Each pane's own on-chart header (rendered by atlas.js) is intentionally
// minimal: ticker selector + live price/%-change, nothing else — per the
// explicit correction that no other control may live in the chart area.
//
// Also owns the pane-layout picker modal (Single/2-Up/2-Stack/3-Up/
// 3-Stack/4-Up) and the Window Settings panel (per-pane ticker selection).

(function (global) {
  'use strict';

  // Ten layouts, matching the reference "Pane layout" picker exactly
  // (Single / 2-Up / 2-Stack / 3-Up / 3-Stack / 1+2 / 1|2 / 4-Grid / 4-Up /
  // 4-Stack). Grid placement for the two asymmetric layouts (1+2, 1|2) is
  // expressed via each pane's own gridArea in atlas-grid-1plus2 /
  // atlas-grid-1pipe2 rather than a uniform template.
  const LAYOUTS = [
    { id: 'single', title: 'Single', icon: 'single', description: 'One focused chart with the full workspace.', panes: 1, gridClass: 'atlas-grid-single' },
    { id: '2up', title: '2-Up', icon: '2up', description: 'Two charts side by side for a fast comparison read.', panes: 2, gridClass: 'atlas-grid-2up' },
    { id: '2stack', title: '2-Stack', icon: '2stack', description: 'Two stacked charts for a taller top-versus-bottom view.', panes: 2, gridClass: 'atlas-grid-2stack' },
    { id: '3up', title: '3-Up', icon: '3up', description: 'Three equal comparison charts across the desktop workspace.', panes: 3, gridClass: 'atlas-grid-3up' },
    { id: '3stack', title: '3-Stack', icon: '3stack', description: 'Three stacked charts for a focused vertical workspace.', panes: 3, gridClass: 'atlas-grid-3stack' },
    { id: '1plus2', title: '1 + 2', icon: '1plus2', description: 'One wide primary chart above two comparison charts.', panes: 3, gridClass: 'atlas-grid-1plus2' },
    { id: '1pipe2', title: '1 | 2', icon: '1pipe2', description: 'One tall primary chart on the left with two stacked references.', panes: 3, gridClass: 'atlas-grid-1pipe2' },
    { id: '4grid', title: '4-Grid', icon: '4grid', description: 'A balanced 2x2 grid for broad market comparison.', panes: 4, gridClass: 'atlas-grid-4up' },
    { id: '4up', title: '4-Up', icon: '4up', description: 'Four columns side by side \u2014 one timeframe per pane.', panes: 4, gridClass: 'atlas-grid-4upwide' },
    { id: '4stack', title: '4-Stack', icon: '4stack', description: 'Four stacked charts for a tall single-column workspace.', panes: 4, gridClass: 'atlas-grid-4stack' },
  ];

  const INTERVALS = ['1m', '3m', '5m', '15m', '1h', '4h', '1D'];
  const NODE_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
  const ORB_DEFAULTS = { size: 50, minClamp: 2, maxClamp: 4, minOpacity: 35, maxOpacity: 60, kingOpacity: 100,
    posColor: '#fcbf24', negColor: '#a855f7', showLabels: true };

  // --- Expiry Data / Projections vocabulary --------------------------------
  const DTE_OPTIONS = [0, 1, 2, 3, 4, 5, 6];
  const GREEKS = [
    { key: 'GEX', label: 'Gamma exposure', short: 'GEX' },
    { key: 'VEX', label: 'Vanna exposure', short: 'VEX' },
    { key: 'CHEX', label: 'Charm exposure', short: 'CHEX' },
    { key: 'COLOR', label: 'Color exposure', short: 'COLOR' },
    { key: 'SPEED', label: 'Speed exposure', short: 'SPEED' },
  ];
  function joinNice(list) {
    if (list.length <= 1) return list.join('');
    return `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`;
  }
  function dteLabel(dtes) { return joinNice([...dtes].sort((a, b) => a - b).map((d) => `${d}DTE`)); }
  function greekLabel(keys) { return joinNice(GREEKS.filter((k) => keys.includes(k.key)).map((k) => k.short)); }

  // Reusable centered window, same shell/CSS as the Layout picker so every
  // Atlas settings window looks and behaves the same way.
  function createWindow({ kicker, title, sub, width }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'atlas-layout-modal-backdrop';
    backdrop.style.display = 'none';
    backdrop.innerHTML = `
      <div class="atlas-layout-modal atlas-window" style="width:${width || 560}px">
        <div class="atlas-layout-modal-header">
          <div>
            <div class="atlas-layout-modal-kicker">${kicker}</div>
            <div class="atlas-layout-modal-title">${title}</div>
          </div>
          <button class="atlas-layout-modal-close">&times;</button>
        </div>
        <div class="atlas-layout-modal-sub">${sub}</div>
        <div class="atlas-window-body"></div>
      </div>`;
    document.body.appendChild(backdrop);
    const api = {
      backdrop,
      body: backdrop.querySelector('.atlas-window-body'),
      open() { backdrop.style.display = 'flex'; },
      close() { backdrop.style.display = 'none'; },
      remove() { backdrop.remove(); },
    };
    backdrop.querySelector('.atlas-layout-modal-close').addEventListener('click', api.close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) api.close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.close(); });
    return api;
  }

  // A row of toggle chips. multi: any subset (never below `min`); single:
  // exactly one. Calls onChange(selectedArray) after every change.
  function createChips(container, options, selected, { multi, min = 1, onChange }) {
    const sel = new Set(selected);
    function paint() {
      container.querySelectorAll('.atlas-chip').forEach((c) => c.classList.toggle('active', sel.has(c.dataset.key)));
    }
    container.innerHTML = options.map((o) => `
      <button class="atlas-chip" data-key="${o.key}" title="${o.label || ''}">
        <span class="atlas-chip-main">${o.text}</span>${o.sub ? `<span class="atlas-chip-sub">${o.sub}</span>` : ''}
      </button>`).join('');
    container.querySelectorAll('.atlas-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.key;
        if (multi) {
          if (sel.has(key)) { if (sel.size <= min) return; sel.delete(key); } else sel.add(key);
        } else { sel.clear(); sel.add(key); }
        paint();
        onChange([...sel]);
        if (api.onAfterChange) api.onAfterChange();
      });
    });
    paint();
    const api = { set(keys) { sel.clear(); keys.forEach((k) => sel.add(k)); paint(); if (api.onAfterChange) api.onAfterChange(); } };
    return api;
  }

  function iconSvg(kind) {
    const box = '<span class="atlas-layout-icon-box"></span>';
    switch (kind) {
      case 'single': return `<div class="atlas-layout-icon atlas-layout-icon-single">${box}</div>`;
      case '2up': return `<div class="atlas-layout-icon atlas-layout-icon-2up">${box}${box}</div>`;
      case '2stack': return `<div class="atlas-layout-icon atlas-layout-icon-2stack">${box}${box}</div>`;
      case '3up': return `<div class="atlas-layout-icon atlas-layout-icon-3up">${box}${box}${box}</div>`;
      case '3stack': return `<div class="atlas-layout-icon atlas-layout-icon-3stack">${box}${box}${box}</div>`;
      case '1plus2': return `<div class="atlas-layout-icon atlas-layout-icon-1plus2"><span class="atlas-layout-icon-box atlas-layout-icon-wide"></span><div class="atlas-layout-icon-row">${box}${box}</div></div>`;
      case '1pipe2': return `<div class="atlas-layout-icon atlas-layout-icon-1pipe2"><span class="atlas-layout-icon-box atlas-layout-icon-tall"></span><div class="atlas-layout-icon-col">${box}${box}</div></div>`;
      case '4grid': return `<div class="atlas-layout-icon atlas-layout-icon-4up">${box}${box}${box}${box}</div>`;
      case '4up': return `<div class="atlas-layout-icon atlas-layout-icon-4upwide">${box}${box}${box}${box}</div>`;
      case '4stack': return `<div class="atlas-layout-icon atlas-layout-icon-4stack">${box}${box}${box}${box}</div>`;
      default: return box;
    }
  }

  function createAtlasLayoutManager(gridEl, toolbarEl, opts) {
    const tickerOptions = opts.tickerOptions && opts.tickerOptions.length
      ? opts.tickerOptions : [opts.defaultTicker || 'SPY'];
    const defaultTicker = opts.defaultTicker || tickerOptions[0];

    // ONE global state object for every cross-pane setting — this is the
    // single source of truth the bug report asked for.
    const g = {
      interval: '5m',
      // Expiry Data window selection (drives Orbs): any set of DTEs 0-6 and
      // any set of Greeks. Sent to the backend as expiration="dte:0,1" and
      // exposure="GEX,VEX".
      dteSet: [0],
      greeks: ['GEX'],
      nodeLimit: 10,
      showOrbs: true,
      orbSize: ORB_DEFAULTS.size,
      orbMinClamp: ORB_DEFAULTS.minClamp,
      orbMaxClamp: ORB_DEFAULTS.maxClamp,
      orbMinOpacity: ORB_DEFAULTS.minOpacity,
      orbMaxOpacity: ORB_DEFAULTS.maxOpacity,
      orbKingOpacity: ORB_DEFAULTS.kingOpacity,
      orbPosColor: ORB_DEFAULTS.posColor,
      orbNegColor: ORB_DEFAULTS.negColor,
      orbShowLabels: ORB_DEFAULTS.showLabels,
      // Atlas Projections: one EXACT DTE (0-6) projected from the
      // selected Greeks (Projections window; independent of Expiry Data).
      showProjection: false,
      projectionDte: 0,
      projectionGreeks: ['GEX'],
      layoutId: 'single',
      paneConfigs: [{ ticker: defaultTicker }],
      panes: [],
    };

    function forEachPane(fn) { g.panes.forEach((p) => fn(p.controller)); }
    const exposureString = () => GREEKS.filter((k) => g.greeks.includes(k.key)).map((k) => k.key).join(',');
    const expirationSelector = () => 'dte:' + [...g.dteSet].sort((a, b) => a - b).join(',');
    const projectionExposureString = () => GREEKS.filter((k) => g.projectionGreeks.includes(k.key)).map((k) => k.key).join(',');

    // --- Chart Layouts (this feature): named, savable/switchable full
    // workspace presets — distinct from the pane-ARRANGEMENT picker above
    // (Single/2-Up/etc, which is only ONE piece of what a saved layout
    // captures). Persisted to localStorage; no Save button anywhere —
    // every mutation below schedules a debounced autosave of whichever
    // named layout is currently active, per the explicit "no Save button
    // ... saved automatically a moment after" spec.
    const LAYOUTS_STORAGE_KEY = 'skylit:chart-layouts';
    const AUTOSAVE_DEBOUNCE_MS = 800;
    let autosaveTimer = null;
    let activeChartLayoutId = null;
    let restoringSnapshot = false; // guards against autosave firing while we're IN THE MIDDLE of applying a snapshot

    function loadChartLayouts() {
      try {
        const raw = localStorage.getItem(LAYOUTS_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    }
    function saveChartLayouts(layouts) {
      try { localStorage.setItem(LAYOUTS_STORAGE_KEY, JSON.stringify(layouts)); } catch (e) { /* non-fatal */ }
    }

    function captureSnapshot() {
      return {
        layoutId: g.layoutId,
        paneConfigs: g.paneConfigs.map((c) => ({ ticker: c.ticker })),
        interval: g.interval,
        dteSet: [...g.dteSet],
        greeks: [...g.greeks],
        nodeLimit: g.nodeLimit,
        showOrbs: g.showOrbs,
        orbPosColor: g.orbPosColor, orbNegColor: g.orbNegColor, orbShowLabels: g.orbShowLabels,
        projectionGreeks: [...g.projectionGreeks],
        orbSize: g.orbSize, orbMinClamp: g.orbMinClamp, orbMaxClamp: g.orbMaxClamp,
        orbMinOpacity: g.orbMinOpacity, orbMaxOpacity: g.orbMaxOpacity, orbKingOpacity: g.orbKingOpacity,
        // Projections persist with the named layout like every other Atlas
        // layer (Part IV.6): enabled state, window length (exposure type is
        // already captured above).
        showProjection: g.showProjection,
        projectionDte: g.projectionDte,
      };
    }

    function scheduleAutosave() {
      if (restoringSnapshot || !activeChartLayoutId) return;
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        const layouts = loadChartLayouts();
        const idx = layouts.findIndex((l) => l.id === activeChartLayoutId);
        if (idx === -1) return;
        layouts[idx].snapshot = captureSnapshot();
        saveChartLayouts(layouts);
        renderLayoutsPanel();
      }, AUTOSAVE_DEBOUNCE_MS);
    }

    function applySnapshot(snapshot) {
      restoringSnapshot = true;
      Object.assign(g, {
        interval: snapshot.interval,
        // Older saved layouts predate the Expiry Data window: default them.
        dteSet: Array.isArray(snapshot.dteSet) && snapshot.dteSet.length ? snapshot.dteSet : [0],
        greeks: Array.isArray(snapshot.greeks) && snapshot.greeks.length ? snapshot.greeks : ['GEX'],
        projectionGreeks: Array.isArray(snapshot.projectionGreeks) && snapshot.projectionGreeks.length ? snapshot.projectionGreeks : ['GEX'],
        orbPosColor: snapshot.orbPosColor || ORB_DEFAULTS.posColor,
        orbNegColor: snapshot.orbNegColor || ORB_DEFAULTS.negColor,
        orbShowLabels: snapshot.orbShowLabels !== false,
        nodeLimit: snapshot.nodeLimit, showOrbs: snapshot.showOrbs,
        orbSize: snapshot.orbSize, orbMinClamp: snapshot.orbMinClamp, orbMaxClamp: snapshot.orbMaxClamp,
        orbMinOpacity: snapshot.orbMinOpacity, orbMaxOpacity: snapshot.orbMaxOpacity,
        orbKingOpacity: snapshot.orbKingOpacity,
        showProjection: !!snapshot.showProjection,
        projectionDte: snapshot.projectionDte || 0,
        paneConfigs: snapshot.paneConfigs.map((c) => ({ ticker: c.ticker })),
      });
      syncToolbarFromState();
      applyLayout(snapshot.layoutId); // rebuilds panes with the restored g values (each pane reads current g on creation)
      restoringSnapshot = false;
    }

    function syncToolbarFromState() {
      el.intervalBtns.forEach((b) => b.classList.toggle('active', b.dataset.interval === g.interval));
      el.orbsToggle.checked = g.showOrbs;
      el.projectionToggle.checked = g.showProjection;
      if (windows) windows.syncFromState();
      updateStatuses();
    }

    // --- Top toolbar: workspace-level controls only ---------------------------
    toolbarEl.innerHTML = `
      <button class="atlas-layout-btn" title="Pane layout">&#9638; Layout</button>
      <button class="atlas-window-settings-btn" title="Window settings">&#9881; Windows</button>
      <button class="atlas-layouts-btn" title="Chart layouts">&#9776; <span class="atlas-layouts-btn-name">Default</span></button>
      <button class="atlas-live-btn">&#9679; Live</button>
      <button class="atlas-reset-view-btn" title="Reset view: fit all history and return the price axis to automatic scaling">&#10226; Reset view</button>
    `;

    // --- Left rail: every charting-feature control, stacked vertically -------
    const railEl = opts.railEl || toolbarEl;
    railEl.innerHTML = `
      <div class="rail-section">
        <div class="rail-header">Chart timeframe</div>
        <div class="atlas-interval-group">
          ${INTERVALS.map((i) => `<button class="atlas-interval-btn ${i === g.interval ? 'active' : ''}" data-interval="${i}">${i}</button>`).join('')}
        </div>
      </div>
      <div class="rail-section">
        <div class="rail-header">Orbs</div>
        <div class="rail-row">
          <label class="rail-switch"><input type="checkbox" class="atlas-orbs-toggle" checked><span class="rail-switch-track"></span><span>Orbs</span></label>
          <button class="rail-btn atlas-orbs-open" title="Orb settings">&#9881; Settings</button>
        </div>
        <div class="rail-status atlas-orbs-status"></div>
      </div>
      <div class="rail-section">
        <div class="rail-header">Expiry data</div>
        <button class="rail-btn rail-btn-wide atlas-expiry-open" title="Choose expirations and Greeks">&#9881; Expiry Data</button>
        <div class="rail-status rail-status-live atlas-expiry-status"></div>
      </div>
      <div class="rail-section">
        <div class="rail-header">Projections</div>
        <div class="rail-row">
          <label class="rail-switch"><input type="checkbox" class="atlas-projection-toggle"><span class="rail-switch-track"></span><span>Projections</span></label>
          <button class="rail-btn atlas-projection-open" title="Projection settings">&#9881; Settings</button>
        </div>
        <div class="rail-status rail-status-live atlas-projection-status"></div>
      </div>
    `;

    const el = {
      layoutBtn: toolbarEl.querySelector('.atlas-layout-btn'),
      settingsBtn: toolbarEl.querySelector('.atlas-window-settings-btn'),
      layoutsBtn: toolbarEl.querySelector('.atlas-layouts-btn'),
      layoutsBtnName: toolbarEl.querySelector('.atlas-layouts-btn-name'),
      liveBtn: toolbarEl.querySelector('.atlas-live-btn'),
      resetViewBtn: toolbarEl.querySelector('.atlas-reset-view-btn'),
      intervalBtns: [...railEl.querySelectorAll('.atlas-interval-btn')],
      orbsToggle: railEl.querySelector('.atlas-orbs-toggle'),
      orbsOpen: railEl.querySelector('.atlas-orbs-open'),
      orbsStatus: railEl.querySelector('.atlas-orbs-status'),
      expiryOpen: railEl.querySelector('.atlas-expiry-open'),
      expiryStatus: railEl.querySelector('.atlas-expiry-status'),
      projectionToggle: railEl.querySelector('.atlas-projection-toggle'),
      projectionOpen: railEl.querySelector('.atlas-projection-open'),
      projectionStatus: railEl.querySelector('.atlas-projection-status'),
    };

    // The "what am I looking at" lines under each control — so the user can
    // always see, outside the windows, exactly which data is live.
    function liveLine(text) {
      return `<span class="rail-live-dot"></span><span class="rail-status-text">${text}</span><span class="rail-live-tag">Displaying LIVE</span>`;
    }
    function updateStatuses() {
      el.orbsStatus.innerHTML = g.showOrbs
        ? `<span class="rail-status-text">${g.nodeLimit ? g.nodeLimit : 'All'} nodes &middot; size ${g.orbSize}%</span>`
        : '<span class="rail-status-text rail-status-off">Off</span>';
      el.expiryStatus.innerHTML = liveLine(`${dteLabel(g.dteSet)} ${greekLabel(g.greeks)}`);
      el.projectionStatus.innerHTML = g.showProjection
        ? liveLine(`${g.projectionDte}DTE ${greekLabel(g.projectionGreeks)}`)
        : '<span class="rail-status-text rail-status-off">Off</span>';
    }

    // --- Timeframe -----------------------------------------------------------
    el.intervalBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        g.interval = btn.dataset.interval;
        el.intervalBtns.forEach((b) => b.classList.toggle('active', b === btn));
        forEachPane((c) => c.setInterval(g.interval));
        scheduleAutosave();
      });
    });
    el.liveBtn.addEventListener('click', () => { forEachPane((c) => c.resumeLive()); });
    // Explicit view reset (the only non-gesture way back to auto price scale + fitted time axis).
    el.resetViewBtn.addEventListener('click', () => { forEachPane((c) => c.resetView()); });

    // --- Expiry Data window: DTEs 0-6 + Greeks, applied as you click ----------
    const expiryWin = createWindow({
      kicker: 'ORBS &amp; NODES DATA', title: 'Expiry Data',
      sub: 'Choose which expirations and which Greek exposures the chart displays. Every selection applies live.',
      width: 600,
    });
    expiryWin.body.innerHTML = `
      <div class="atlas-window-label">Expirations</div>
      <div class="atlas-chip-row atlas-expiry-dte"></div>
      <div class="atlas-window-label">Greek exposure</div>
      <div class="atlas-chip-row atlas-chip-row-greeks atlas-expiry-greeks"></div>
      <div class="atlas-chip-row atlas-combo-row"><button class="atlas-chip atlas-combo-chip atlas-expiry-combo" title="Gamma and vanna combined"><span class="atlas-chip-main">GEX+VEX</span><span class="atlas-chip-sub">Gamma + Vanna combined</span></button></div>
      <div class="atlas-window-preview atlas-expiry-preview"></div>
      <div class="atlas-window-note">Vanna, charm, color and speed use simulated series until your live Greek feed is connected.</div>
    `;
    const expiryPreview = expiryWin.body.querySelector('.atlas-expiry-preview');
    function applyExpiry() {
      expiryPreview.innerHTML = liveLine(`${dteLabel(g.dteSet)} ${greekLabel(g.greeks)}`);
      forEachPane((c) => c.setDataSelection({ exposure: exposureString(), expiration: expirationSelector() }));
      updateStatuses();
      scheduleAutosave();
    }
    const expiryDteChips = createChips(expiryWin.body.querySelector('.atlas-expiry-dte'),
      DTE_OPTIONS.map((d) => ({ key: String(d), text: `${d}DTE` })), g.dteSet.map(String),
      { multi: true, min: 1, onChange: (keys) => { g.dteSet = keys.map(Number); applyExpiry(); } });
    const expiryGreekChips = createChips(expiryWin.body.querySelector('.atlas-expiry-greeks'),
      GREEKS.map((k) => ({ key: k.key, text: k.short, sub: k.label, label: k.label })), g.greeks,
      { multi: true, min: 1, onChange: (keys) => { g.greeks = keys; applyExpiry(); } });
    const isCombo = (keys) => keys.length === 2 && keys.includes('GEX') && keys.includes('VEX');
    const expiryCombo = expiryWin.body.querySelector('.atlas-expiry-combo');
    const paintExpiryCombo = () => expiryCombo.classList.toggle('active', isCombo(g.greeks));
    expiryCombo.addEventListener('click', () => { g.greeks = ['GEX', 'VEX']; expiryGreekChips.set(g.greeks); paintExpiryCombo(); applyExpiry(); });
    expiryGreekChips.onAfterChange = paintExpiryCombo;
    paintExpiryCombo();
    el.expiryOpen.addEventListener('click', () => { paintExpiryCombo(); expiryPreview.innerHTML = liveLine(`${dteLabel(g.dteSet)} ${greekLabel(g.greeks)}`); expiryWin.open(); });

    // --- Projections window: one DTE + Greeks (forward dealer-positioning) ----
    const projWin = createWindow({
      kicker: 'FORWARD POSITIONING', title: 'Projections',
      sub: 'Forward projections drawn from dealer positioning for one expiration. A positioning scenario, not a price forecast.',
      width: 600,
    });
    projWin.body.innerHTML = `
      <div class="atlas-window-label">Expiration to project</div>
      <div class="atlas-chip-row atlas-proj-dte"></div>
      <div class="atlas-window-label">Greek exposure</div>
      <div class="atlas-chip-row atlas-chip-row-greeks atlas-proj-greeks"></div>
      <div class="atlas-chip-row atlas-combo-row"><button class="atlas-chip atlas-combo-chip atlas-proj-combo" title="Gamma and vanna combined"><span class="atlas-chip-main">GEX+VEX</span><span class="atlas-chip-sub">Gamma + Vanna combined</span></button></div>
      <div class="atlas-window-preview atlas-proj-preview"></div>
      <div class="atlas-window-note">Vanna, charm, color and speed use simulated series until your live Greek feed is connected.</div>
    `;
    const projPreview = projWin.body.querySelector('.atlas-proj-preview');
    function applyProjection() {
      projPreview.innerHTML = liveLine(`${g.projectionDte}DTE ${greekLabel(g.projectionGreeks)}`);
      forEachPane((c) => { c.setProjectionExposure(projectionExposureString()); c.setProjectionDte(g.projectionDte); });
      updateStatuses();
      scheduleAutosave();
    }
    const projDteChips = createChips(projWin.body.querySelector('.atlas-proj-dte'),
      DTE_OPTIONS.map((d) => ({ key: String(d), text: `${d}DTE` })), [String(g.projectionDte)],
      { multi: false, onChange: (keys) => { g.projectionDte = parseInt(keys[0], 10); applyProjection(); } });
    const projGreekChips = createChips(projWin.body.querySelector('.atlas-proj-greeks'),
      GREEKS.map((k) => ({ key: k.key, text: k.short, sub: k.label, label: k.label })), g.projectionGreeks,
      { multi: true, min: 1, onChange: (keys) => { g.projectionGreeks = keys; applyProjection(); } });
    const projCombo = projWin.body.querySelector('.atlas-proj-combo');
    const paintProjCombo = () => projCombo.classList.toggle('active', isCombo(g.projectionGreeks));
    projCombo.addEventListener('click', () => { g.projectionGreeks = ['GEX', 'VEX']; projGreekChips.set(g.projectionGreeks); paintProjCombo(); applyProjection(); });
    projGreekChips.onAfterChange = paintProjCombo;
    paintProjCombo();
    el.projectionOpen.addEventListener('click', () => { paintProjCombo(); projPreview.innerHTML = liveLine(`${g.projectionDte}DTE ${greekLabel(g.projectionGreeks)}`); projWin.open(); });
    el.projectionToggle.addEventListener('change', () => {
      g.showProjection = el.projectionToggle.checked;
      forEachPane((c) => c.setShowProjection(g.showProjection));
      updateStatuses();
      scheduleAutosave();
      if (g.showProjection) { projPreview.innerHTML = liveLine(`${g.projectionDte}DTE ${greekLabel(g.projectionGreeks)}`); projWin.open(); }
    });

    // --- Orbs window: node count, size, colors, opacity ------------------------
    // Edits adjust a DRAFT; Save applies to every pane, Reset restores the
    // defaults (the original "save to apply / reset to go back" behavior).
    const orbWin = createWindow({
      kicker: 'CHART OVERLAY', title: 'Orbs',
      sub: 'Orbs are the strikes where dealer positioning is concentrated. Choose how many nodes appear and how they look.',
      width: 560,
    });
    const ORB_SLIDER_DEFS = [
      { key: 'orbSize', label: 'Orb size', min: 10, max: 100, step: 1, suffix: '%' },
      { key: 'orbMinOpacity', label: 'Min opacity', min: 0, max: 100, step: 1, suffix: '%' },
      { key: 'orbMaxOpacity', label: 'Max opacity', min: 0, max: 100, step: 1, suffix: '%' },
      { key: 'orbKingOpacity', label: 'King opacity', min: 0, max: 100, step: 1, suffix: '%' },
    ];
    orbWin.body.innerHTML = `
      <div class="atlas-window-label">Nodes displayed</div>
      <div class="atlas-orb-nodes">
        <input type="number" class="atlas-orb-nodes-input" min="1" max="999" step="1" placeholder="All">
        <div class="atlas-chip-row atlas-orb-nodes-presets"></div>
      </div>
      <div class="atlas-window-hint">The N strikes with the largest exposure are drawn as orbs. Leave empty (or choose All) to draw every strike.</div>
      <div class="atlas-window-label">Labels</div>
      <label class="atlas-color-field atlas-orb-labels-field"><input type="checkbox" class="atlas-orb-labels-toggle"><span>Show exposure labels beside orbs</span></label>
      <div class="atlas-window-hint">Turns the strike / exposure / percent text on the right of every orb band on or off.</div>
      <div class="atlas-window-label">Colors</div>
      <div class="atlas-orb-colors">
        <label class="atlas-color-field"><input type="color" class="atlas-orb-color" data-key="orbPosColor"><span>Positive exposure</span></label>
        <label class="atlas-color-field"><input type="color" class="atlas-orb-color" data-key="orbNegColor"><span>Negative exposure</span></label>
      </div>
      <div class="atlas-window-label">Size &amp; opacity</div>
      ${ORB_SLIDER_DEFS.map((d) => `
        <label class="atlas-orb-slider-row">${d.label} <span class="atlas-orb-val" data-key="${d.key}"></span>
          <input type="range" class="atlas-orb-slider" data-key="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}">
        </label>`).join('')}
      <div class="atlas-window-actions">
        <button class="atlas-orbs-reset-btn">Reset</button>
        <button class="atlas-orbs-save-btn">Save</button>
      </div>
    `;
    const orbInput = orbWin.body.querySelector('.atlas-orb-nodes-input');
    const orbSliders = [...orbWin.body.querySelectorAll('.atlas-orb-slider')];
    const orbVals = {};
    orbWin.body.querySelectorAll('.atlas-orb-val').forEach((v) => { orbVals[v.dataset.key] = v; });
    const orbColorInputs = [...orbWin.body.querySelectorAll('.atlas-orb-color')];
    const orbLabelsToggle = orbWin.body.querySelector('.atlas-orb-labels-toggle');
    const draft = {};
    const NODE_PRESETS = [5, 10, 20, 30, 50, 0];
    const presetChips = createChips(orbWin.body.querySelector('.atlas-orb-nodes-presets'),
      NODE_PRESETS.map((n) => ({ key: String(n), text: n ? String(n) : 'All' })), [],
      { multi: false, onChange: (keys) => {
        draft.nodeLimit = parseInt(keys[0], 10);
        orbInput.value = draft.nodeLimit ? String(draft.nodeLimit) : '';
      } });
    function loadDraftFromState() {
      Object.assign(draft, {
        nodeLimit: g.nodeLimit, orbSize: g.orbSize, orbMinOpacity: g.orbMinOpacity,
        orbMaxOpacity: g.orbMaxOpacity, orbKingOpacity: g.orbKingOpacity,
        orbPosColor: g.orbPosColor, orbNegColor: g.orbNegColor, orbShowLabels: g.orbShowLabels,
      });
      orbLabelsToggle.checked = draft.orbShowLabels;
      orbInput.value = draft.nodeLimit ? String(draft.nodeLimit) : '';
      presetChips.set(NODE_PRESETS.includes(draft.nodeLimit) ? [String(draft.nodeLimit)] : []);
      orbSliders.forEach((sl) => {
        const def = ORB_SLIDER_DEFS.find((d) => d.key === sl.dataset.key);
        sl.value = String(draft[sl.dataset.key]);
        orbVals[sl.dataset.key].textContent = `${draft[sl.dataset.key]}${def.suffix}`;
      });
      orbColorInputs.forEach((ci) => { ci.value = draft[ci.dataset.key]; });
    }
    orbInput.addEventListener('input', () => {
      const n = parseInt(orbInput.value, 10);
      draft.nodeLimit = Number.isFinite(n) && n > 0 ? n : 0;
      presetChips.set(NODE_PRESETS.includes(draft.nodeLimit) ? [String(draft.nodeLimit)] : []);
    });
    orbSliders.forEach((sl) => sl.addEventListener('input', () => {
      const def = ORB_SLIDER_DEFS.find((d) => d.key === sl.dataset.key);
      draft[sl.dataset.key] = parseFloat(sl.value);
      orbVals[sl.dataset.key].textContent = `${draft[sl.dataset.key]}${def.suffix}`;
    }));
    orbColorInputs.forEach((ci) => ci.addEventListener('input', () => { draft[ci.dataset.key] = ci.value; }));
    orbLabelsToggle.addEventListener('change', () => { draft.orbShowLabels = orbLabelsToggle.checked; });
    function applyOrbSettingsToPanes() {
      forEachPane((c) => {
        c.setNodeLimit(g.nodeLimit);
        c.setOrbSettings({
          size: g.orbSize, minClamp: g.orbMinClamp, maxClamp: g.orbMaxClamp,
          minOpacity: g.orbMinOpacity, maxOpacity: g.orbMaxOpacity, kingOpacity: g.orbKingOpacity,
          posColor: g.orbPosColor, negColor: g.orbNegColor, showLabels: g.orbShowLabels,
        });
      });
      updateStatuses();
    }
    orbWin.body.querySelector('.atlas-orbs-save-btn').addEventListener('click', () => {
      Object.assign(g, draft);
      applyOrbSettingsToPanes();
      scheduleAutosave();
      orbWin.close();
    });
    orbWin.body.querySelector('.atlas-orbs-reset-btn').addEventListener('click', () => {
      Object.assign(g, {
        nodeLimit: 10, orbSize: ORB_DEFAULTS.size, orbMinOpacity: ORB_DEFAULTS.minOpacity,
        orbMaxOpacity: ORB_DEFAULTS.maxOpacity, orbKingOpacity: ORB_DEFAULTS.kingOpacity,
        orbPosColor: ORB_DEFAULTS.posColor, orbNegColor: ORB_DEFAULTS.negColor, orbShowLabels: ORB_DEFAULTS.showLabels,
      });
      loadDraftFromState();
      applyOrbSettingsToPanes();
      scheduleAutosave();
    });
    el.orbsOpen.addEventListener('click', () => { loadDraftFromState(); orbWin.open(); });
    el.orbsToggle.addEventListener('change', () => {
      g.showOrbs = el.orbsToggle.checked;
      forEachPane((c) => c.setShowOrbs(g.showOrbs));
      updateStatuses();
      scheduleAutosave();
      if (g.showOrbs) { loadDraftFromState(); orbWin.open(); }   // enabling Orbs opens its window
    });

    // Lets syncToolbarFromState() refresh the window widgets after a saved
    // layout is restored.
    const windows = {
      syncFromState() {
        expiryDteChips.set(g.dteSet.map(String));
        expiryGreekChips.set(g.greeks);
        projDteChips.set([String(g.projectionDte)]);
        projGreekChips.set(g.projectionGreeks);
      },
      removeAll() { expiryWin.remove(); projWin.remove(); orbWin.remove(); },
    };
    updateStatuses();

    // --- Layout picker modal ---------------------------------------------
    const modal = document.createElement('div');
    modal.className = 'atlas-layout-modal-backdrop';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="atlas-layout-modal">
        <div class="atlas-layout-modal-header">
          <div>
            <div class="atlas-layout-modal-kicker">WORKSPACE</div>
            <div class="atlas-layout-modal-title">Pane layout</div>
          </div>
          <button class="atlas-layout-modal-close">&times;</button>
        </div>
        <div class="atlas-layout-modal-sub">
          Pick a workspace first, then set the extra panes with search or the quick-pick row.
        </div>
        <div class="atlas-layout-modal-grid">
          ${LAYOUTS.map((l) => `
            <div class="atlas-layout-option" data-layout="${l.id}">
              ${iconSvg(l.icon)}
              <div class="atlas-layout-option-title">${l.title}</div>
              <div class="atlas-layout-option-desc">${l.description}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    function closeModal() { modal.style.display = 'none'; }
    modal.querySelector('.atlas-layout-modal-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    modal.querySelectorAll('.atlas-layout-option').forEach((optEl) => {
      optEl.addEventListener('click', () => {
        modal.querySelectorAll('.atlas-layout-option').forEach((o) => o.classList.toggle('active', o === optEl));
        applyLayout(optEl.dataset.layout);
        scheduleAutosave();
        closeModal();
      });
    });
    el.layoutBtn.addEventListener('click', () => {
      modal.querySelectorAll('.atlas-layout-option').forEach((o) => o.classList.toggle('active', o.dataset.layout === g.layoutId));
      modal.style.display = 'flex';
    });

    // --- Window Settings panel: per-pane ticker selection ---------------
    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'atlas-window-settings-panel';
    settingsPanel.style.display = 'none';
    document.body.appendChild(settingsPanel);

    function renderSettingsPanel() {
      const layout = LAYOUTS.find((l) => l.id === g.layoutId);
      settingsPanel.innerHTML = `
        <div class="atlas-window-settings-title">Windows (${layout.panes})</div>
        ${g.paneConfigs.map((cfg, i) => `
          <div class="atlas-window-settings-row">
            <span>Window ${i + 1}</span>
            <select class="atlas-window-settings-ticker" data-pane="${i}">
              ${tickerOptions.map((t) => `<option value="${t}" ${t === cfg.ticker ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
        `).join('')}
      `;
      settingsPanel.querySelectorAll('.atlas-window-settings-ticker').forEach((sel) => {
        sel.addEventListener('change', () => {
          const idx = parseInt(sel.dataset.pane, 10);
          g.paneConfigs[idx].ticker = sel.value;
          if (g.panes[idx]) g.panes[idx].controller.setTicker(sel.value);
          scheduleAutosave();
        });
      });
    }
    el.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      renderSettingsPanel();
      settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => {
      if (!settingsPanel.contains(e.target) && e.target !== el.settingsBtn) settingsPanel.style.display = 'none';
    });

    // --- Grid construction ----------------------------------------------

    function destroyPanes() {
      g.panes.forEach((p) => p.controller.destroy());
      g.panes = [];
    }

    function applyLayout(layoutId) {
      const layout = LAYOUTS.find((l) => l.id === layoutId) || LAYOUTS[0];
      g.layoutId = layout.id;

      while (g.paneConfigs.length < layout.panes) {
        const used = g.paneConfigs.map((c) => c.ticker);
        const next = tickerOptions.find((t) => !used.includes(t)) || tickerOptions[0];
        g.paneConfigs.push({ ticker: next });
      }
      g.paneConfigs = g.paneConfigs.slice(0, layout.panes);

      destroyPanes();
      gridEl.className = 'atlas-multi-grid ' + layout.gridClass;
      gridEl.innerHTML = '';

      g.paneConfigs.forEach((cfg, idx) => {
        const paneWrapper = document.createElement('div');
        paneWrapper.className = 'atlas-multi-pane';
        // The two asymmetric layouts place pane 0 in a larger named grid
        // area (see the .atlas-grid-1plus2 / .atlas-grid-1pipe2 CSS) rather
        // than relying on template-column/row repetition like every other
        // layout here.
        if (layout.id === '1plus2') paneWrapper.style.gridArea = idx === 0 ? 'main' : `side${idx}`;
        if (layout.id === '1pipe2') paneWrapper.style.gridArea = idx === 0 ? 'main' : `side${idx}`;
        const headerEl = document.createElement('div');
        headerEl.className = 'atlas-pane-header';
        const chartWrapper = document.createElement('div');
        chartWrapper.className = 'atlas-pane-chart-wrapper';
        const chartEl = document.createElement('div');
        chartEl.className = 'atlas-pane-chart';
        chartWrapper.appendChild(chartEl);
        paneWrapper.appendChild(headerEl);
        paneWrapper.appendChild(chartWrapper);
        gridEl.appendChild(paneWrapper);

        // Every pane is created with the CURRENT global settings — this
        // is what keeps a newly-added pane in sync with whatever Nodes/
        // Exposure/Expiration/Orbs settings are already active, rather
        // than reverting to hardcoded defaults.
        const controller = createAtlasController(chartEl, headerEl, {
          ticker: cfg.ticker,
          tickerOptions,
          interval: g.interval,
          exposureType: exposureString(),
          expiration: expirationSelector(),
          projectionExposure: projectionExposureString(),
          nodeLimit: g.nodeLimit,
          showOrbs: g.showOrbs,
          orbSettings: {
            size: g.orbSize, minClamp: g.orbMinClamp, maxClamp: g.orbMaxClamp,
            minOpacity: g.orbMinOpacity, maxOpacity: g.orbMaxOpacity, kingOpacity: g.orbKingOpacity,
            posColor: g.orbPosColor, negColor: g.orbNegColor, showLabels: g.orbShowLabels,
          },
          showProjection: g.showProjection,
          projectionDte: g.projectionDte,
          onTickerChange: (newTicker) => {
            const idx = g.panes.findIndex((p) => p.controller === controllerRef);
            if (idx !== -1) g.paneConfigs[idx].ticker = newTicker;
            scheduleAutosave();
          },
        });
        const controllerRef = controller;

        g.panes.push({ chartEl, headerEl, controller });
      });
    }

    // --- Chart Layouts panel (this feature) -------------------------------
    const layoutsPanel = document.createElement('div');
    layoutsPanel.className = 'atlas-layouts-panel';
    layoutsPanel.style.display = 'none';
    document.body.appendChild(layoutsPanel);

    function renderLayoutsPanel() {
      const layouts = loadChartLayouts();
      layoutsPanel.innerHTML = `
        ${layouts.map((l) => `
          <div class="atlas-layouts-row ${l.id === activeChartLayoutId ? 'active' : ''}" data-id="${l.id}">
            <span class="atlas-layouts-row-name" data-id="${l.id}">${l.name}</span>
            <span class="atlas-layouts-row-actions">
              <button class="atlas-layouts-rename-btn" data-id="${l.id}" title="Rename">&#9998;</button>
              <button class="atlas-layouts-delete-btn" data-id="${l.id}" title="Delete">&times;</button>
            </span>
          </div>
        `).join('')}
        <button class="atlas-layouts-new-btn">+ New layout from current</button>
      `;

      layoutsPanel.querySelectorAll('.atlas-layouts-row-name').forEach((nameEl) => {
        nameEl.addEventListener('click', () => switchToLayout(nameEl.dataset.id));
      });
      layoutsPanel.querySelectorAll('.atlas-layouts-rename-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const row = layoutsPanel.querySelector(`.atlas-layouts-row[data-id="${btn.dataset.id}"]`);
          const nameSpan = row.querySelector('.atlas-layouts-row-name');
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'atlas-layouts-rename-input';
          input.value = nameSpan.textContent;
          nameSpan.replaceWith(input);
          input.focus();
          input.select();
          function commit() {
            const newName = input.value.trim() || 'Untitled';
            const all = loadChartLayouts();
            const entry = all.find((l) => l.id === btn.dataset.id);
            if (entry) {
              entry.name = newName;
              saveChartLayouts(all);
              if (entry.id === activeChartLayoutId) el.layoutsBtnName.textContent = newName;
            }
            renderLayoutsPanel();
          }
          input.addEventListener('blur', commit);
          input.addEventListener('keydown', (ke) => { if (ke.key === 'Enter') input.blur(); });
        });
      });
      // Delete is a two-step confirm (per spec: "prevent accidents") — a
      // first click arms a "confirm delete?" state on that button, a
      // second click (or clicking elsewhere clears it) actually deletes.
      layoutsPanel.querySelectorAll('.atlas-layouts-delete-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (btn.dataset.confirming === 'true') {
            let all = loadChartLayouts();
            all = all.filter((l) => l.id !== btn.dataset.id);
            saveChartLayouts(all);
            if (activeChartLayoutId === btn.dataset.id) {
              // Never leave zero layouts / no active layout — fall back to
              // whatever remains, or create a fresh Default if none do.
              if (all.length) switchToLayout(all[0].id);
              else createNewLayout('Default', true);
            }
            renderLayoutsPanel();
          } else {
            btn.dataset.confirming = 'true';
            btn.textContent = 'Confirm';
            btn.classList.add('confirming');
          }
        });
      });
      layoutsPanel.querySelector('.atlas-layouts-new-btn').addEventListener('click', () => {
        createNewLayout(`Layout ${loadChartLayouts().length + 1}`, false);
      });
    }

    function switchToLayout(id) {
      const layouts = loadChartLayouts();
      const entry = layouts.find((l) => l.id === id);
      if (!entry) return;
      activeChartLayoutId = id;
      el.layoutsBtnName.textContent = entry.name;
      applySnapshot(entry.snapshot);
      renderLayoutsPanel();
      layoutsPanel.style.display = 'none';
    }

    // useCurrentStateAsSnapshot: true when bootstrapping the very first
    // "Default" layout from whatever g already is; false for "+ New
    // layout from current", which (per spec) captures the CURRENT
    // workspace as a new named entry.
    function createNewLayout(name, useCurrentStateAsSnapshot) {
      const layouts = loadChartLayouts();
      const id = 'layout-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      layouts.push({ id, name, snapshot: useCurrentStateAsSnapshot ? captureSnapshot() : captureSnapshot() });
      saveChartLayouts(layouts);
      activeChartLayoutId = id;
      el.layoutsBtnName.textContent = name;
      renderLayoutsPanel();
      layoutsPanel.style.display = 'none';
    }

    el.layoutsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      renderLayoutsPanel();
      layoutsPanel.style.display = layoutsPanel.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => {
      if (!layoutsPanel.contains(e.target) && e.target !== el.layoutsBtn) {
        // Clear any armed delete-confirm state and close.
        layoutsPanel.querySelectorAll('.atlas-layouts-delete-btn').forEach((b) => {
          b.dataset.confirming = 'false'; b.textContent = '\u00d7'; b.classList.remove('confirming');
        });
        layoutsPanel.style.display = 'none';
      }
    });

    // --- Startup: load the most-recently-active saved layout, or create
    // a "Default" one from the initial state if none exist yet.
    (function initChartLayouts() {
      const layouts = loadChartLayouts();
      if (layouts.length === 0) {
        applyLayout('single'); // build the initial pane(s) so captureSnapshot() has something real
        createNewLayout('Default', true);
      } else {
        switchToLayout(layouts[0].id);
      }
    })();

    return {
      destroy() {
        destroyPanes();
        modal.remove();
        settingsPanel.remove();
        windows.removeAll();
        layoutsPanel.remove();
      },
      getLayoutId() { return g.layoutId; },
    };
  }

  global.createAtlasLayoutManager = createAtlasLayoutManager;
})(window);
