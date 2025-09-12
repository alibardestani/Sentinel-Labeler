// static/js/brush/io.js
console.log('[BRUSH:io] loaded');

; (() => {
  const DBG = true;
  const log = (...a) => DBG && console.debug('[BRUSH:io]', ...a);
  const warn = (...a) => DBG && console.warn('[BRUSH:io]', ...a);
  const err = (...a) => DBG && console.error('[BRUSH:io]', ...a);

  const App = window.BrushApp;
  if (!App) throw new Error('BrushApp (core.js) must be loaded before io.js');

  // ---------------- State ----------------
  const IO = {
    index: -1,                // selected layer index in App.layers
    doneSet: new Set(),       // keys: tileId|uid
  };

  // ---------------- Helpers ----------------
  function keyFor(layer) {
    const tile = App.currentTileId();
    const uid = App.layerUid(layer);
    return tile + '|' + uid;
  }

  function safeName(v, def = 'x') {
    return (String(v ?? def)).replace(/[^\w\-.]+/g, '_');
  }

  function buildDownloadName(layer) {
    const ts = new Date(), pad = n => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const tile = safeName(App.currentTileId());
    const uid = safeName(App.layerUid(layer));
    const label = safeName(App.layerLabel(layer));
    const code = safeName(App.layerCode(layer));
    return `tile-${tile}_poly-${uid}_label-${label}_code-${code}_${stamp}.png`;
  }

  // ---------------- Polygon loading ----------------
  async function reloadPolygonsForScene() {
    if (!App.sceneBounds) {
      warn('reloadPolygonsForScene: no sceneBounds yet; skip');
      return;
    }

    log('reloadPolygonsForScene:start');

    // clear previous
    try { App.drawnFG?.clearLayers(); } catch { }
    App.layers.length = 0;
    IO.index = -1;

    let gj;
    try {
      const r = await fetch('/api/polygons', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      gj = await r.json();
    } catch (e) {
      err('reloadPolygonsForScene:fetch-failed', e);
      return;
    }

    if (!gj || !Array.isArray(gj.features)) {
      warn('reloadPolygonsForScene: invalid geojson');
      return;
    }

    let added = 0, skipped = 0;

    // primary: only features intersecting sceneBounds
    L.geoJSON(gj, {
      onEachFeature: (feat, layer) => {
        let ok = false;
        try {
          const b = layer.getBounds?.();
          ok = !!(b && b.intersects(App.sceneBounds));
        } catch { }
        if (!ok) { skipped++; return; }
        App.addGeoJSONLayer(feat, layer);
        added++;
      }
    });

    log('polygons:filtered', { total: gj.features.length, added, skipped });

    // fallback: if nothing intersected, add all so the user at least sees data
    if (added === 0) {
      warn('no polygons intersect sceneBounds; fallback=add all');
      L.geoJSON(gj, {
        onEachFeature: (feat, layer) => {
          App.addGeoJSONLayer(feat, layer);
        }
      });
    }

    // select first & zoom
    if (App.layers.length > 0) {
      const n = App.layers.length;
      const notDoneIdx = [];
      for (let i = 0; i < n; i++) if (!isDone(App.layers[i])) notDoneIdx.push(i);
      const pool = notDoneIdx.length ? notDoneIdx : [...Array(n).keys()];
      const start = pool[Math.floor(Math.random() * pool.length)];
      setIndex(start); // zoom will be handled inside setIndex
    } else {
      warn('no layers after load');
    }
    log('reloadPolygonsForScene:done', { layers: App.layers.length });
  }

  // ---------------- Navigation ----------------
  function setIndex(i) {
    if (!App.layers.length) { warn('setIndex:no-layers'); return; }
    if (i < 0 || i >= App.layers.length) { warn('setIndex:out-of-range', { i }); return; }

    // ←←← ماسک فعلی را پاک کن
    try { App.clearMask(); } catch { }

    IO.index = i;
    const layer = App.layers[i];
    log('nav:setIndex', { i, uid: App.layerUid(layer) });
    App.selectLayer(layer);

    try {
      const b = layer.getBounds?.();
      if (b && b.isValid()) {
        const padded = b.pad(0.2);
        App.map.fitBounds(padded, { maxZoom: 19 });
        const z = App.map.getZoom();
        if (z < 14) App.map.fitBounds(padded, { maxZoom: 14 });
      }
    } catch (e) { warn('setIndex:fitBounds:fail', e); }

    // ❌ ماسک ذخیره‌شده را دیگر لود نکن تا سفید باشد:
    // loadMaskForSelected().catch(e => warn('loadMaskForSelected:catch', e));

    App.onLayerSelected && App.onLayerSelected(layer);
  }


  function current() {
    return (IO.index >= 0 ? App.layers[IO.index] : null);
  }

  function nextIndex() {
    if (!App.layers.length) return;
    try { App.clearMask(); } catch { }          // ← پاک‌سازی
    const n = App.layers.length;
    for (let step = 1; step <= n; step++) {
      const j = (IO.index + step) % n;
      if (!isDone(App.layers[j])) { setIndex(j); return; }
    }
    setIndex((IO.index + 1) % n);
  }

  function prevIndex() {
    if (!App.layers.length) return;
    try { App.clearMask(); } catch { }          // ← پاک‌سازی
    const j = (IO.index - 1 + App.layers.length) % App.layers.length;
    setIndex(j);
  }

  // ---------------- Done/Status ----------------
  async function markDoneSelected() {
    const layer = current();
    if (!layer) { warn('markDone:no-current'); return; }
    const k = keyFor(layer);
    IO.doneSet.add(k);
    log('markDone', { key: k });

    // ← به‌صورت امن ذخیره کن (اگه چیزی نباشه خودش برمی‌گرده)
    try { await saveMaskForSelected(); } catch (e) { warn('markDone:save:fail', e); }

    // ← بعد از ذخیره پاک کن
    try { App.clearMask(); } catch { }
  }

  function isDone(layer = current()) {
    if (!layer) return false;
    const ok = IO.doneSet.has(keyFor(layer));
    log('isDone', { uid: App.layerUid(layer), done: ok });
    return ok;
  }

  // ---------------- Save/Load Mask ----------------
  // ---------------- Save local mask (per-polygon) ----------------
  async function saveMaskForSelected() {
    try {
      const layer = current();          // ← قبلاً IO.current?.() بود
      if (!layer) { warn('saveMask:no-current-layer'); return false; }

      if (typeof App.localMaskToBlob !== 'function') {
        warn('saveMask:no-localMaskToBlob');
        return false;
      }

      const tile = App.currentTileId();
      const uid = App.layerUid(layer);

      const blob = await App.localMaskToBlob('image/png');
      if (!blob) { warn('saveMask:no-blob'); return false; }

      const fd = new FormData();
      fd.append('file', blob, `${uid}.png`);

      const q = new URLSearchParams({ tile_id: tile, uid }).toString();
      const url = `/api/masks/save?${q}`;
      log('saveMask:POST', { url, tile, uid });

      const r = await fetch(url, { method: 'POST', body: fd });
      if (!r.ok) { warn('saveMask:http-fail', { status: r.status }); return false; }

      log('saveMask:ok', { tile, uid });
      return true;
    } catch (e) {
      err('saveMask:error', e);
      return false;
    }
  }

  // ---------------- Load local mask (per-polygon) ----------------
  async function loadMaskForSelected() {
    try {
      const layer = current();          // ← قبلاً IO.current?.() بود
      if (!layer) { warn('loadMask:no-current'); return; }

      const tile = App.currentTileId();
      const uid = App.layerUid(layer);
      const url = `/api/masks/get?tile_id=${encodeURIComponent(tile)}&uid=${encodeURIComponent(uid)}&t=${Date.now()}`;
      log('loadMask:GET', { url, tile, uid });

      const r = await fetch(url, { cache: 'no-store' });
      if (r.status === 404) { log('loadMask:none', { tile, uid }); return; }
      if (!r.ok) { warn('loadMask:http-fail', { status: r.status }); return; }

      const blob = await r.blob();

      if (!App.getLocalMaskBBox || !App.getLocalMaskBBox()) {
        try { App.selectLayer(App.selectedLayer); } catch { }
      }

      if (typeof App.drawMaskImageToLocal === 'function') {
        await App.drawMaskImageToLocal(blob);
        log('loadMask:done', { tile, uid });
      } else {
        warn('loadMask:no-drawMaskImageToLocal');
      }
    } catch (e) {
      warn('loadMask:exception', e);
    }
  }

  // autosave after each stroke (core.js calls onAfterStroke)
  let saveTimer = null;
  function debounceSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      log('autosave:tick');
      saveMaskForSelected().catch(e => warn('autosave:catch', e));
    }, 450);
  }
  App.onAfterStroke = debounceSave;

  // ---------------- Download (local) ----------------
  // ---------------- Download local mask (per-polygon) ----------------
  // دانلود ماسکِ فعلی که روی maskCanvas کشیده شده
  async function downloadCurrentMask() {
    try {
      const cnv = window.BrushApp?.maskCanvas;
      if (!cnv) { console.warn('[BRUSH:io] download:no-canvas'); return; }

      // ساخت Blob از بوم (با رزولوشن واقعی؛ اسکیل DPR قبلاً در core.js ست شده)
      const blob = await new Promise(res => cnv.toBlob(res, 'image/png', 1));
      if (!blob) { console.warn('[BRUSH:io] download:no-blob'); return; }

      // اسم فایل
      const App = window.BrushApp;
      const layer = (typeof current === 'function') ? current() : null;
      const uid = layer ? App.layerUid(layer) : 'mask';
      const fname = `${uid}.png`;

      // دانلود
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 0);

      console.debug('[BRUSH:io] download:ok', { fname, bytes: blob.size });
    } catch (e) {
      console.error('[BRUSH:io] download:error', e);
    }
  }

  // ---------------- Exports ----------------
  window.BrushIO = {
    // loading
    reloadPolygonsForScene,

    // nav
    setIndex,
    nextIndex,
    prevIndex,
    current,

    // state
    markDoneSelected,
    isDone,

    // masks
    saveMaskForSelected,
    loadMaskForSelected,
    downloadCurrentMask,
  };

  log('ready');
})();
