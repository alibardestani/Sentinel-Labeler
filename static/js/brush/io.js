// static/js/brush/io.js
console.log('[BRUSH:io] loaded');

;(() => {
  const DBG  = true;
  const log  = (...a) => DBG && console.debug('[BRUSH:io]', ...a);
  const warn = (...a) => DBG && console.warn('[BRUSH:io]', ...a);
  const err  = (...a) => DBG && console.error('[BRUSH:io]', ...a);

  const App = window.BrushApp;
  if (!App) throw new Error('BrushApp (core.js) must be loaded before io.js');

  // ---------------- State ----------------
  const IO = {
    index: -1,          // selected polygon index in App.layers
    doneSet: new Set(), // keys: tileId|uid
  };

  // ---------------- Helpers ----------------
  const pad2 = n => String(n).padStart(2, '0');
  function stamp() {
    const t = new Date();
    return `${t.getFullYear()}${pad2(t.getMonth()+1)}${pad2(t.getDate())}_${pad2(t.getHours())}${pad2(t.getMinutes())}${pad2(t.getSeconds())}`;
  }
  function safeName(v, def='x') {
    return String(v ?? def).replace(/[^\w\-.]+/g, '_');
  }
  function currentTileId() {
    // اگر بک‌اند tile id واقعی دارد، می‌توانی اینجا عوضش کنی
    const r = App.grid?.active?.r ?? 0;
    const c = App.grid?.active?.c ?? 0;
    return `r${r}_c${c}`;
  }
  function keyFor(layer) {
    const tile = App.currentTileId ? App.currentTileId() : currentTileId();
    const uid  = App.layerUid(layer);
    return tile + '|' + uid;
  }

  // ---------------- Polygons ----------------
  async function reloadPolygonsForScene() {
    if (!App.sceneBounds) { warn('reloadPolygonsForScene: no sceneBounds yet; skip'); return; }

    log('reloadPolygonsForScene:start');

    try { App.drawnFG?.clearLayers(); } catch {}
    App.layers.length = 0;
    IO.index = -1;

    let gj = null;
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
    L.geoJSON(gj, {
      onEachFeature: (feat, layer) => {
        let ok = false;
        try {
          const b = layer.getBounds?.();
          ok = !!(b && b.intersects(App.sceneBounds));
        } catch {}
        if (!ok) { skipped++; return; }
        App.addGeoJSONLayer(feat, layer);
        added++;
      }
    });

    log('polygons:filtered', { total: gj.features.length, added, skipped });

    if (added === 0) {
      warn('no polygons intersect sceneBounds; fallback=add all');
      L.geoJSON(gj, { onEachFeature: (feat, layer) => App.addGeoJSONLayer(feat, layer) });
    }

    if (App.layers.length > 0) setIndex(0);
    else warn('no layers after load');

    log('reloadPolygonsForScene:done', { layers: App.layers.length });
  }

  App.currentTileId = currentTileId;
  App.layerUid = function (layer) {
    return layer?._props?.uid || layer?.feature?.properties?.uid || String(layer?._leaflet_id || '');
  };

  // ---------------- Navigation (polygon list) ----------------
  function setIndex(i) {
    if (!App.layers.length) { warn('setIndex:no-layers'); return; }
    if (i < 0 || i >= App.layers.length) { warn('setIndex:out-of-range', { i }); return; }

    try { App.clearMask?.(); } catch {}

    IO.index = i;
    const layer = App.layers[i];
    log('nav:setIndex', { i, uid: App.layerUid(layer) });
    App.selectLayer?.(layer);

    try {
      const b = layer.getBounds?.();
      if (b && b.isValid()) {
        const padded = b.pad(0.2);
        App.map.fitBounds(padded, { maxZoom: 19 });
        const z = App.map.getZoom();
        if (z < 14) App.map.fitBounds(padded, { maxZoom: 14 });
      }
    } catch (e) { warn('setIndex:fitBounds:fail', e); }

    App.onLayerSelected && App.onLayerSelected(layer);
  }
  function current() {
    return (IO.index >= 0 ? App.layers[IO.index] : null);
  }
  function nextIndex() {
    if (!App.layers.length) return;
    try { App.clearMask?.(); } catch {}
    const n = App.layers.length;
    setIndex((IO.index + 1) % n);
  }
  function prevIndex() {
    if (!App.layers.length) return;
    try { App.clearMask?.(); } catch {}
    const n = App.layers.length;
    setIndex((IO.index - 1 + n) % n);
  }

  // ---------------- Done/Status (polygon) ----------------
  async function markDoneSelected() {
    const layer = current();
    if (!layer) { warn('markDone:no-current'); return; }
    const k = keyFor(layer);
    IO.doneSet.add(k);
    log('markDone', { key: k });

    try { await saveMaskForSelected(); } catch (e) { warn('markDone:save:fail', e); }
    try { App.clearMask?.(); } catch {}
  }
  function isDone(layer = current()) {
    if (!layer) return false;
    const ok = IO.doneSet.has(keyFor(layer));
    log('isDone', { uid: App.layerUid(layer), done: ok });
    return ok;
  }

  // ---------------- Tile-scoped PNG save/load ----------------
  /**
   * ذخیرهٔ PNG ماسکِ تایلِ فعال روی سرور
   * API پیشنهادی: POST /api/masks/save_tile_png
   * form-data: scene_id, r, c, x, y, w, h, file
   *   - x,y,w,h همان bbox بومِ لوکال (پیکسل‌های تصویرِ کامل)
   */
  async function saveCurrentTilePng({ alsoDownload = false } = {}) {
    try {
      const blob = await App.localMaskToBlob?.('image/png');
      if (!blob) { warn('save_tile: no blob'); return false; }

      const bbox = App.getLocalMaskBBox?.();
      if (!bbox) { warn('save_tile: no bbox'); return false; }

      const sid = App.sceneId || 'unknown';
      const { r, c, x, y, w, h } = bbox;

      const fd = new FormData();
      fd.append('scene_id', sid);
      fd.append('r', String(r));
      fd.append('c', String(c));
      fd.append('x', String(x));
      fd.append('y', String(y));
      fd.append('w', String(w));
      fd.append('h', String(h));
      fd.append('file', blob, `scene-${safeName(sid)}_r${r}_c${c}_${stamp()}.png`);

      const resp = await fetch('/api/masks/save_tile_png', { method: 'POST', body: fd });
      if (!resp.ok) { warn('save_tile_png:http', resp.status); }
      else {
        const j = await resp.json().catch(() => ({}));
        log('save_tile_png:ok', j);
      }

      if (alsoDownload) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `scene-${safeName(sid)}_r${r}_c${c}_${stamp()}.png`;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      }
      return true;
    } catch (e) {
      err('saveCurrentTilePng:error', e);
      return false;
    }
  }

  async function downloadActiveTilePNG() {
    try {
      const blob = await App.localMaskToBlob?.('image/png');
      if (!blob) { warn('downloadActiveTilePNG:no-blob'); return; }
      const bbox = App.getLocalMaskBBox?.();
      if (!bbox) { warn('downloadActiveTilePNG:no-bbox'); return; }
      const sid = App.sceneId || 'scene';
      const { r, c } = bbox;
      const fname = `scene-${safeName(sid)}_r${r}_c${c}_${stamp()}.png`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      log('downloadActiveTilePNG:ok', { fname, bytes: blob.size });
    } catch (e) {
      err('downloadActiveTilePNG:error', e);
    }
  }

  // ---------------- Polygon-scoped save/load (سازگاری عقب‌رو) ----------------
  async function saveMaskForSelected() {
    const layer = current?.();
    if (!layer) { /* سکوت */ return false; }
    try {
      const blob = await App.localMaskToBlob?.('image/png');
      if (!blob) { warn('saveMaskForSelected:no-blob'); return false; }

      const tile = currentTileId();
      const uid  = App.layerUid(layer);

      const fd = new FormData();
      fd.append('file', blob, `${safeName(uid)}.png`);

      const q = new URLSearchParams({
        tile_id: tile,
        uid,
        scene_id: App.sceneId || '',
        r: App.grid?.active?.r ?? 0,
        c: App.grid?.active?.c ?? 0
      }).toString();

      const url = `/api/masks/save?${q}`;
      log('saveMaskForSelected:POST', { url, tile, uid });

      const r = await fetch(url, { method: 'POST', body: fd });
      if (!r.ok) { warn('saveMaskForSelected:http', r.status); return false; }

      log('saveMaskForSelected:ok', { tile, uid });
      return true;
    } catch (e) {
      err('saveMaskForSelected:error', e);
      return false;
    }
  }

  async function loadMaskForSelected() {
    try {
      const layer = current();
      if (!layer) { warn('loadMaskForSelected:no-current'); return; }

      const tile = currentTileId();
      const uid  = App.layerUid(layer);
      const url  = `/api/masks/get?tile_id=${encodeURIComponent(tile)}&uid=${encodeURIComponent(uid)}&t=${Date.now()}`;
      log('loadMaskForSelected:GET', { url, tile, uid });

      const r = await fetch(url, { cache: 'no-store' });
      if (r.status === 404) { log('loadMaskForSelected:none', { tile, uid }); return; }
      if (!r.ok) { warn('loadMaskForSelected:http', r.status); return; }

      const blob = await r.blob();
      if (typeof App.drawMaskImageToLocal === 'function') {
        await App.drawMaskImageToLocal(blob); // روی تایل فعال کشیده می‌شود
        log('loadMaskForSelected:done', { tile, uid });
      } else {
        warn('loadMaskForSelected:no-drawMaskImageToLocal');
      }
    } catch (e) {
      warn('loadMaskForSelected:exception', e);
    }
  }

  // ---------------- Autosave (tile-first, then polygon fallback) ----------------
  let _saveTimer = null;
  function autosaveDebounced() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
      // ابتدا تایل‌محور
      const ok = await saveCurrentTilePng({ alsoDownload: false }).catch(() => false);
      if (!ok) {
        // اگر در مود پالیگون هستی و سرور قدیمی داری
        try { await saveMaskForSelected(); } catch {}
      }
      log('autosave:ok');
    }, 450);
  }
  App.onAfterStroke = autosaveDebounced;

  // ---------------- Public API ----------------
  const api = {
    // polygons
    reloadPolygonsForScene,

    // nav
    setIndex,
    nextIndex,
    prevIndex,
    current,

    // status
    markDoneSelected,
    isDone,

    // masks
    saveMaskForSelected,      // backward-compatible (polygon)
    loadMaskForSelected,
    saveCurrentTilePng,       // tile PNG -> server
    downloadActiveTilePNG     // tile PNG -> local download
  };

  // expose once
  window.BrushIO = Object.assign(window.BrushIO || {}, api);

  log('ready');
})();