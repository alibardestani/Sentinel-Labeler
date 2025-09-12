// static/js/brush/core.js
console.log("[BRUSH:core] loaded");
; (() => {
  const DBG = true;
  const log = (...a) => DBG && console.debug('[BRUSH:core]', ...a);
  const warn = (...a) => DBG && console.warn('[BRUSH:core]', ...a);
  const err = (...a) => DBG && console.error('[BRUSH:core]', ...a);
  const info = (...a) => DBG && console.info('[BRUSH:core]', ...a);

  window.addEventListener('error', (e) => {
    err('window.error', e?.message, e?.error);
    try { Lx && Lx.err && Lx.err('window.error', e?.message, e?.error); } catch { }
  });
  window.addEventListener('unhandledrejection', (e) => {
    err('unhandledrejection', e?.reason);
    try { Lx && Lx.err && Lx.err('unhandledrejection', e?.reason); } catch { }
  });
  window.addEventListener('rejectionhandled', (e) => {
    warn('rejectionhandled', e?.reason);
    try { Lx && Lx.err && Lx.err('rejectionhandled', e?.reason); } catch { }
  });

  const App = {
    map: null,
    overlay: null,
    sceneBounds: null,
    drawnFG: null,
    maskCanvas: null,
    cursorCanvas: null,
    maskCtx: null,
    cursorCtx: null,
    DPR: Math.max(1, window.devicePixelRatio || 1),
    MODE: 'pan',
    ERASE: false,
    Brush: { size: 24, clipPath: null, enforceClip: true },
    layers: [],
    selectedLayer: null,
    onAfterStroke: null,
    onLayerSelected: null,
  };

  const $ = (id) => document.getElementById(id);
  function clearCursor() {
    if (!App.cursorCanvas) return;
    const w = App.cursorCanvas.width / App.DPR;
    const h = App.cursorCanvas.height / App.DPR;
    App.cursorCtx.clearRect(0, 0, w, h);
  }
  function redrawCursorPreview(x, y) {
    clearCursor();
    if (App.MODE !== 'brush') return;
    if (x == null || y == null) return;
    const r = Math.max(1, App.Brush.size * 0.5);
    App.cursorCtx.save();
    App.cursorCtx.strokeStyle = App.ERASE ? 'rgba(255,70,70,0.9)' : 'rgba(0,255,0,0.9)';
    App.cursorCtx.lineWidth = 1;
    App.cursorCtx.beginPath();
    App.cursorCtx.arc(x, y, r, 0, Math.PI * 2);
    App.cursorCtx.stroke();
    App.cursorCtx.restore();
  }

  function createMap(mapId, opts = {}) {
    log('createMap:start', { mapId, opts });
    const map = L.map(mapId, {
      zoomSnap: 0,
      zoomDelta: 0.5,
      maxZoom: 22,
      wheelDebounceTime: 30,
      wheelPxPerZoomLevel: 80,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      zoomControl: true,
      preferCanvas: true,
      ...opts.leaflet
    });
    const base = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Esri', maxNativeZoom: 19, maxZoom: 22, detectRetina: true }
    ).addTo(map);
    base.on('load', () => info('basemap:load'));
    base.on('tileerror', (e) => warn('basemap:tileerror', e));
    const drawn = new L.FeatureGroup();
    map.addLayer(drawn);
    App.map = map;
    App.drawnFG = drawn;
    map.on('move zoom', () => {
      log('map:move/zoom', { center: map.getCenter(), zoom: map.getZoom() });
      if (App.selectedLayer) rebuildClipPath();
    });
    map.on('resize', (e) => {
      log('map:resize', e?.newSize);
      sizeCanvases(true);
    });
    log('createMap:done');
    return map;
  }

  async function loadSceneOverlay(urlBounds = '/api/s2_bounds_wgs84', urlImage = '/api/output/rgb_quicklook.png') {
    log('overlay:fetch-bounds:start', { urlBounds });
    try {
      const r = await fetch(urlBounds, { cache: 'no-store' });
      if (!r.ok) throw new Error('s2 bounds fetch failed');
      const b = await r.json();
      App.sceneBounds = L.latLngBounds([b.lat_min, b.lon_min], [b.lat_max, b.lon_max]);
      log('overlay:bounds', { b, sceneBounds: App.sceneBounds?.toBBoxString?.() });
      if (App.overlay) {
        App.map.removeLayer(App.overlay);
        log('overlay:removed-previous');
      }
      const url = urlImage + '?t=' + Date.now();
      App.overlay = L.imageOverlay(url, App.sceneBounds, { opacity: 0.6 }).addTo(App.map);
      App.overlay.on('load', () => info('overlay:image:load', { url }));
      App.overlay.on('error', (e) => warn('overlay:image:error', e));
      App.map.fitBounds(App.sceneBounds);
      log('overlay:fitBounds');
    } catch (e) {
      err('overlay:error', e);
      try { Lx && Lx.err && Lx.err('overlay:error', String(e)); } catch { }
      throw e;
    }
  }

  function bindOverlayOpacity(sliderId, valueId) {
    const slider = $(sliderId);
    const lbl = $(valueId);
    if (!slider) {
      warn('bindOverlayOpacity:no-slider', { sliderId });
      return;
    }
    const apply = () => {
      if (!App.overlay) return;
      const v = (parseInt(slider.value, 10) || 60) / 100;
      App.overlay.setOpacity(v);
      if (lbl) lbl.textContent = v.toFixed(2);
      log('overlay:opacity', { v });
    };
    slider.addEventListener('input', apply);
    apply();
  }

  function attachCanvases(maskId = 'maskCanvas', cursorId = 'cursorCanvas') {
    App.maskCanvas = $(maskId);
    App.cursorCanvas = $(cursorId);
    if (!App.maskCanvas || !App.cursorCanvas) {
      err('canvas:not-found', { maskId, cursorId, mask: !!App.maskCanvas, cursor: !!App.cursorCanvas });
      throw new Error('maskCanvas / cursorCanvas not found in DOM');
    }
    App.maskCtx = App.maskCanvas.getContext('2d');
    App.cursorCtx = App.cursorCanvas.getContext('2d');
    log('canvas:contexts', { DPR: App.DPR });
    sizeCanvases(false);
  }

  function sizeCanvases(keepMask = true) {
    log('canvas:resize:start', { keepMask, DPR: App.DPR });
    let bak = null;
    if (keepMask && App.maskCanvas?.width) {
      bak = document.createElement('canvas');
      bak.width = App.maskCanvas.width;
      bak.height = App.maskCanvas.height;
      bak.getContext('2d').drawImage(App.maskCanvas, 0, 0);
    }
    const sz = App.map.getSize();
    [App.maskCanvas, App.cursorCanvas].forEach(cnv => {
      cnv.width = Math.round(sz.x * App.DPR);
      cnv.height = Math.round(sz.y * App.DPR);
      cnv.style.width = sz.x + 'px';
      cnv.style.height = sz.y + 'px';
      cnv.getContext('2d').setTransform(App.DPR, 0, 0, App.DPR, 0, 0);
    });
    if (bak) {
      App.maskCtx.clearRect(0, 0, App.maskCanvas.width, App.maskCanvas.height);
      App.maskCtx.drawImage(bak, 0, 0, bak.width, bak.height, 0, 0, App.maskCanvas.width, App.maskCanvas.height);
      log('canvas:resize:mask-restored', { prevW: bak.width, prevH: bak.height });
    }
    clearCursor();
    rebuildClipPath();
    log('canvas:resize:done', { w: App.maskCanvas.width, h: App.maskCanvas.height });
  }

  function selectLayer(layer) {
    if (!layer) return;
    if (App.selectedLayer && App.selectedLayer !== layer) {
      try { App.selectedLayer.setStyle({ weight: 2, color: '#22c55e' }); } catch { }
    }
    App.selectedLayer = layer;
    try { App.selectedLayer.setStyle({ weight: 3, color: '#4f46e5' }); } catch { }
    log('layer:selected', { uid: App.layerUid(layer), label: App.layerLabel(layer) });
    rebuildClipPath();
    if (App.onLayerSelected) App.onLayerSelected(layer);
  }

  function rebuildClipPath() {
    App.Brush.clipPath = null;
    const layer = App.selectedLayer;
    if (!layer) {
      return;
    }
    let gj, geom;
    try {
      gj = layer.toGeoJSON();
      geom = gj?.geometry;
    } catch (e) {
      err('clip:geojson-error', e);
      return;
    }
    if (!geom) {
      warn('clip:no-geometry');
      return;
    }
    const mapRect = App.map.getContainer().getBoundingClientRect();
    const canvasRect = App.maskCanvas.getBoundingClientRect();
    const offX = canvasRect.left - mapRect.left;
    const offY = canvasRect.top - mapRect.top;
    const p = new Path2D();
    const addRing = (ring) => {
      ring.forEach(([lng, lat], i) => {
        const pt = App.map.latLngToContainerPoint([lat, lng]);
        const cx = pt.x - offX, cy = pt.y - offY;
        if (i === 0) p.moveTo(cx, cy); else p.lineTo(cx, cy);
      });
      p.closePath();
    };
    if (geom.type === 'Polygon') geom.coordinates.forEach(addRing);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(poly => poly.forEach(addRing));
    else {
      warn('clip:unsupported-geom', { type: geom.type });
      return;
    }
    App.Brush.clipPath = p;
    const w = App.cursorCanvas.width / App.DPR, h = App.cursorCanvas.height / App.DPR;
    clearCursor();
    if (App.MODE === 'brush') {
      App.cursorCtx.save();
      App.cursorCtx.fillStyle = 'rgba(0,0,0,0.25)';
      App.cursorCtx.fillRect(0, 0, w, h);
      App.cursorCtx.globalCompositeOperation = 'destination-out';
      App.cursorCtx.fill(p, 'evenodd');
      App.cursorCtx.restore();
      App.cursorCtx.save();
      App.cursorCtx.setLineDash([6, 4]);
      App.cursorCtx.strokeStyle = 'rgba(80,160,255,.95)';
      App.cursorCtx.lineWidth = 1.5;
      App.cursorCtx.stroke(p);
      App.cursorCtx.restore();
    }
    log('clip:rebuilt', { mode: App.MODE, geomType: geom.type });
  }

  function isInsideClip(x, y) {
    if (!App.Brush.enforceClip) return true;
    if (!App.Brush.clipPath) return false;
    const inside = App.maskCtx.isPointInPath(App.Brush.clipPath, x, y, 'evenodd');
    if (!inside) log('clip:outside', { x, y });
    return inside;
  }

  let painting = false;
  let lastPt = null;
  let lastMouse = { x: null, y: null };

  function getCanvasXY(e) {
    const r = App.maskCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function drawDot(x, y) {
    if (App.MODE !== 'brush') return;
    if (!isInsideClip(x, y)) return;
    const r = Math.max(1, App.Brush.size * 0.5);
    App.maskCtx.save();
    App.maskCtx.globalCompositeOperation = App.ERASE ? 'destination-out' : 'source-over';
    App.maskCtx.beginPath();
    App.maskCtx.arc(x, y, r, 0, Math.PI * 2);
    App.maskCtx.fillStyle = App.ERASE ? 'rgba(0,0,0,1)' : 'rgba(0,255,0,0.9)';
    App.maskCtx.fill();
    App.maskCtx.restore();
  }

  function bindPaintingEvents() {
    function syncBodyClass() {
      document.body.classList.toggle('tool-brush', App.MODE === 'brush');
    }
    syncBodyClass();

    App.maskCanvas.addEventListener('mousedown', (e) => {
      if (App.MODE !== 'brush') return;
      if (!App.selectedLayer) { warn('paint:no-layer-selected'); alert('Select a polygon first.'); return; }
      if (!App.Brush.clipPath && App.Brush.enforceClip) { rebuildClipPath(); if (!App.Brush.clipPath) { warn('paint:no-clipPath'); return; } }
      e.preventDefault(); e.stopPropagation();
      painting = true;
      App.map.dragging.disable();
      const [x, y] = getCanvasXY(e);
      log('paint:start', { x, y, erase: App.ERASE, size: App.Brush.size });
      drawDot(x, y);
      lastPt = [x, y];
    });

    App.maskCanvas.addEventListener('mousemove', (e) => {
      const [x, y] = getCanvasXY(e);
      lastMouse.x = x; lastMouse.y = y;
      redrawCursorPreview(x, y);
      if (App.MODE !== 'brush' || !painting) return;
      if (lastPt) {
        const dx = x - lastPt[0], dy = y - lastPt[1];
        const steps = Math.ceil(Math.hypot(dx, dy) / Math.max(2, App.Brush.size * 0.35));
        for (let i = 1; i <= steps; i++) {
          const px = lastPt[0] + (dx * i) / steps;
          const py = lastPt[1] + (dy * i) / steps;
          drawDot(px, py);
        }
        lastPt = [x, y];
      } else {
        drawDot(x, y);
        lastPt = [x, y];
      }
    });

    window.addEventListener('mouseup', () => {
      if (!painting) return;
      painting = false;
      lastPt = null;
      if (App.MODE === 'pan') App.map.dragging.enable();
      log('paint:end');
      App.onAfterStroke && App.onAfterStroke();
    });

    App._redrawCursorPreview = () => {
      if (lastMouse.x != null) redrawCursorPreview(lastMouse.x, lastMouse.y);
    };

    App.map.on('move zoom', () => {
      if (App.selectedLayer) rebuildClipPath();
      if (lastMouse.x != null) redrawCursorPreview(lastMouse.x, lastMouse.y);
    });
  }

  App.init = async function init({
    mapId = 'map',
    maskId = 'maskCanvas',
    cursorId = 'cursorCanvas',
    enforceClip = true,
    overlayBoundsURL = '/api/s2_bounds_wgs84',
    overlayImageURL = '/api/output/rgb_quicklook.png',
  } = {}) {
    log('init:start', { mapId, maskId, cursorId, enforceClip, overlayBoundsURL, overlayImageURL });
    App.Brush.enforceClip = !!enforceClip;
    try {
      createMap(mapId);
      await loadSceneOverlay(overlayBoundsURL, overlayImageURL);
      attachCanvases(maskId, cursorId);
      sizeCanvases(false);
      bindPaintingEvents();
      log('init:done');
    } catch (e) {
      err('init:error', e);
      throw e;
    }
  };

  App.setMode = function setMode(mode) {
    if (!App.map || !App.map.dragging) { return; }

    const prev = App.MODE;
    App.MODE = mode === 'brush' ? 'brush' : 'pan';
    const isBrush = App.MODE === 'brush';

    document.body.classList.toggle('tool-brush', isBrush);

    if (isBrush) {
      App.map.dragging.disable();

      if (!App.selectedLayer) {
        console.warn('Brush ON but no polygon selected yet');
      }

      try {
        rebuildClipPath();
      } catch (e) {
        console.warn('rebuildClipPath failed', e);
      }

      try {
        App._redrawCursorPreview?.();
      } catch (e) { }
    } else {
      App.map.dragging.enable();
      clearCursor();
    }

    console.log('mode:change', { from: prev, to: App.MODE });
  };


  App.setBrushSize = function setBrushSize(px) {
    const prev = App.Brush.size;
    App.Brush.size = Math.max(2, Math.min(256, parseInt(px || 24, 10)));
    App._redrawCursorPreview && App._redrawCursorPreview();
    log('brush:size', { from: prev, to: App.Brush.size });
  };

  App.setErase = function setErase(on) {
    const prev = App.ERASE;
    App.ERASE = !!on;
    App._redrawCursorPreview && App._redrawCursorPreview();
    log('brush:erase', { from: prev, to: App.ERASE });
  };

  App.selectLayer = selectLayer;

  App.addGeoJSONLayer = function addGeoJSONLayer(feat, layer) {
    layer._props = { ...(feat.properties || {}) };
    layer.setStyle?.({ color: '#22c55e', weight: 2 });
    layer.on('click', () => selectLayer(layer));
    App.drawnFG.addLayer(layer);
    App.layers.push(layer);
    log('layer:added', { uid: App.layerUid(layer), props: layer._props });
  };

  App.clearMask = function clearMask() {
    const w = App.maskCanvas.width / App.DPR, h = App.maskCanvas.height / App.DPR;
    App.maskCtx.clearRect(0, 0, w, h);
    log('mask:cleared', { w, h });
  };

  App.polygonPixelBBox = function polygonPixelBBox() {
    const layer = App.selectedLayer;
    if (!layer) { warn('bbox:no-layer'); return null; }
    try {
      const b = layer.getBounds();
      const tl = App.map.latLngToContainerPoint([b.getNorth(), b.getWest()]);
      const br = App.map.latLngToContainerPoint([b.getSouth(), b.getEast()]);
      const x = Math.floor(tl.x), y = Math.floor(tl.y);
      const w = Math.ceil(br.x - tl.x), h = Math.ceil(br.y - tl.y);
      const out = { x, y, w, h };
      log('bbox', out);
      return out;
    } catch (e) {
      err('bbox:error', e);
      return null;
    }
  };

  App.buildLocalClip = function buildLocalClip(shiftX, shiftY) {
    const clip = new Path2D();
    const layer = App.selectedLayer;
    if (!layer) { warn('localClip:no-layer'); return clip; }
    const gj = layer.toGeoJSON();
    const geom = gj?.geometry;
    if (!geom) { warn('localClip:no-geom'); return clip; }
    const mapRect = App.map.getContainer().getBoundingClientRect();
    const canvasRect = App.maskCanvas.getBoundingClientRect();
    const offX = canvasRect.left - mapRect.left - shiftX;
    const offY = canvasRect.top - mapRect.top - shiftY;
    const addRing = (ring) => {
      ring.forEach(([lng, lat], i) => {
        const pt = App.map.latLngToContainerPoint([lat, lng]);
        const cx = pt.x - offX, cy = pt.y - offY;
        if (i === 0) clip.moveTo(cx, cy); else clip.lineTo(cx, cy);
      });
      clip.closePath();
    };
    if (geom.type === 'Polygon') geom.coordinates.forEach(addRing);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(poly => poly.forEach(addRing));
    log('localClip:built', { shiftX, shiftY, type: geom.type });
    return clip;
  };

  App.binarizeImageData = function binarizeImageData(id) {
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      const v = a > 0 ? 255 : 0;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    log('binarize:done', { len: d.length });
    return id;
  };

  App.layerUid = (layer) => layer?._props?.uid || layer?.feature?.properties?.uid || String(layer?._leaflet_id);
  App.layerLabel = (layer) => layer?._props?.uses_fruit || layer?._props?.label || 'label';
  App.layerCode = (layer) => layer?._props?.code || 'code';

  App.currentTileId = function currentTileId() {
    if (!App.sceneBounds) return '-';
    const ne = App.sceneBounds.getNorthEast(), sw = App.sceneBounds.getSouthWest();
    const r = v => Math.round(v * 1e5) / 1e5;
    const id = `b_${r(sw.lat)}_${r(sw.lng)}_${r(ne.lat)}_${r(ne.lng)}`;
    log('tile:id', { id });
    return id;
  };

  App.bindOverlayOpacity = bindOverlayOpacity;
  App.sizeCanvases = sizeCanvases;
  App.rebuildClipPath = rebuildClipPath;

  window.BrushApp = App;
})();