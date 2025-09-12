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
    index: -1,                // selected layer index in App.layers
    doneSet: new Set(),       // keys: tileId|uid
  };

  // ---------------- Helpers ----------------
  function keyFor(layer) {
    const tile = App.currentTileId();
    const uid  = App.layerUid(layer);
    return tile + '|' + uid;
  }

  function safeName(v, def='x') {
    return (String(v ?? def)).replace(/[^\w\-.]+/g, '_');
  }

  function buildDownloadName(layer) {
    const ts = new Date(), pad = n => String(n).padStart(2,'0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const tile  = safeName(App.currentTileId());
    const uid   = safeName(App.layerUid(layer));
    const label = safeName(App.layerLabel(layer));
    const code  = safeName(App.layerCode(layer));
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
    try { App.drawnFG?.clearLayers(); } catch {}
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
        } catch {}
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
      setIndex(0);
      try {
        const gb = L.featureGroup(App.layers).getBounds().pad(0.15);
        App.map.fitBounds(gb, { maxZoom: 20 });
      } catch {}
    } else {
      warn('no layers after load');
    }

    log('reloadPolygonsForScene:done', { layers: App.layers.length });
  }

  // ---------------- Navigation ----------------
  function setIndex(i) {
    if (!App.layers.length) { warn('setIndex:no-layers'); return; }
    if (i < 0 || i >= App.layers.length) { warn('setIndex:out-of-range', { i }); return; }
    IO.index = i;
    const layer = App.layers[i];
    log('nav:setIndex', { i, uid: App.layerUid(layer) });
    App.selectLayer(layer);
    // Load persisted mask (if any)
    loadMaskForSelected().catch(e => warn('loadMaskForSelected:catch', e));
    App.onLayerSelected && App.onLayerSelected(layer);
  }

  function current() {
    return (IO.index >= 0 ? App.layers[IO.index] : null);
  }

  function nextIndex() {
    if (!App.layers.length) return;
    const j = (IO.index + 1) % App.layers.length;
    log('nav:next', { from: IO.index, to: j });
    setIndex(j);
  }

  function prevIndex() {
    if (!App.layers.length) return;
    const j = (IO.index - 1 + App.layers.length) % App.layers.length;
    log('nav:prev', { from: IO.index, to: j });
    setIndex(j);
  }

  // ---------------- Done/Status ----------------
  function markDoneSelected() {
    const layer = current();
    if (!layer) { warn('markDone:no-current'); return; }
    const k = keyFor(layer);
    IO.doneSet.add(k);
    log('markDone', { key: k });
  }

  function isDone(layer = current()) {
    if (!layer) return false;
    const ok = IO.doneSet.has(keyFor(layer));
    log('isDone', { uid: App.layerUid(layer), done: ok });
    return ok;
  }

  // ---------------- Save/Load Mask ----------------
  async function saveMaskForSelected() {
    try {
      const layer = current();
      if (!layer)             { warn('saveMask:no-current-layer'); return false; }
      if (!App.Brush.clipPath && App.Brush.enforceClip) { warn('saveMask:no-clip'); return false; }
      const bbox = App.polygonPixelBBox();
      if (!bbox) { warn('saveMask:no-bbox'); return false; }
      const { x, y, w, h } = bbox;
      log('saveMask:bbox', { x, y, w, h, DPR: App.DPR });

      // crop from global canvas
      const tmp = document.createElement('canvas');
      tmp.width = w * App.DPR; tmp.height = h * App.DPR;
      const tctx = tmp.getContext('2d');
      tctx.setTransform(App.DPR, 0, 0, App.DPR, 0, 0);
      tctx.drawImage(App.maskCanvas, -x, -y);

      // keep only inside polygon
      const localClip = App.buildLocalClip(x, y);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.fill(localClip, 'evenodd');

      // binarize to {0,255}
      const id = tctx.getImageData(0, 0, w, h);
      const bin = App.binarizeImageData(id);
      tctx.clearRect(0, 0, w, h);
      tctx.putImageData(bin, 0, 0);

      const blob = await new Promise(res => tmp.toBlob(res, 'image/png', 1));
      if (!blob) { warn('saveMask:no-blob'); return false; }

      const ne = App.sceneBounds?.getNorthEast();
      const sw = App.sceneBounds?.getSouthWest();
      const meta = {
        tile_id: App.currentTileId(),
        uid: App.layerUid(layer),
        label: App.layerLabel(layer),
        code: App.layerCode(layer),
        bbox: { x, y, w, h, dpr: App.DPR },
        canvas_size: { w: App.maskCanvas.width, h: App.maskCanvas.height },
        scene_bounds: (ne && sw) ? { lat_min: sw.lat, lon_min: sw.lng, lat_max: ne.lat, lon_max: ne.lng } : null,
        ts: Date.now()
      };

      const fd = new FormData();
      fd.append('file', blob, 'mask.png');
      fd.append('meta', JSON.stringify(meta));

      const url = `/api/masks/save?tile_id=${encodeURIComponent(meta.tile_id)}&uid=${encodeURIComponent(meta.uid)}`;
      log('saveMask:POST', { url, meta });
      const r = await fetch(url, { method: 'POST', body: fd });
      if (!r.ok) { warn('saveMask:http-fail', r.status); return false; }
      log('saveMask:ok');
      return true;
    } catch (e) {
      err('saveMask:error', e);
      return false;
    }
  }

  async function loadMaskForSelected() {
    try {
      const layer = current();
      if (!layer) { warn('loadMask:no-current'); return; }
      const bbox = App.polygonPixelBBox();
      if (!bbox) { warn('loadMask:no-bbox'); return; }
      const { x, y, w, h } = bbox;

      const tileId = App.currentTileId();
      const uid    = App.layerUid(layer);
      const url    = `/api/masks/get?tile_id=${encodeURIComponent(tileId)}&uid=${encodeURIComponent(uid)}&t=${Date.now()}`;
      log('loadMask:GET', { url, x, y, w, h });

      const im = new Image();
      return new Promise((resolve) => {
        im.onload = () => {
          App.maskCtx.save();
          App.maskCtx.drawImage(im, x, y, w, h);
          App.maskCtx.restore();
          log('loadMask:drawn');
          resolve();
        };
        im.onerror = (e) => { warn('loadMask:image-error', e); resolve(); };
        im.src = url;
      });
    } catch (e) {
      err('loadMask:error', e);
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
  async function downloadCurrentMask() {
    const layer = current();
    if (!layer) { warn('download:no-current'); return; }
    const bbox = App.polygonPixelBBox();
    if (!bbox) { warn('download:no-bbox'); return; }
    const { x, y, w, h } = bbox;

    const tmp = document.createElement('canvas');
    tmp.width = w * App.DPR; tmp.height = h * App.DPR;
    const tctx = tmp.getContext('2d');
    tctx.setTransform(App.DPR, 0, 0, App.DPR, 0, 0);
    tctx.drawImage(App.maskCanvas, -x, -y);

    const localClip = App.buildLocalClip(x, y);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.fill(localClip, 'evenodd');

    const id = tctx.getImageData(0, 0, w, h);
    const bin = App.binarizeImageData(id);
    tctx.clearRect(0, 0, w, h);
    tctx.putImageData(bin, 0, 0);

    const blob = await new Promise(res => tmp.toBlob(res, 'image/png', 1));
    if (!blob) { warn('download:no-blob'); return; }

    const fname = buildDownloadName(layer);
    const url   = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log('download:ok', { fname, bytes: blob.size });
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