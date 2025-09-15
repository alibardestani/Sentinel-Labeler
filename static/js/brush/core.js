// static/js/brush/core.js (با لاگ‌های تشخیصی)
console.log("[BRUSH:core] loaded");

; (() => {
  let DBG = true; // می‌تونی در کنسول بگی: BrushApp._setDebug(false)
  const log = (...a) => DBG && console.debug('[BRUSH:core]', ...a);
  const warn = (...a) => DBG && console.warn('[BRUSH:core]', ...a);
  const err = (...a) => DBG && console.error('[BRUSH:core]', ...a);
  const $ = (id) => document.getElementById(id);

  // خطاهای سراسری هم لاگ می‌شن
  window.addEventListener('error', (e) => err('window.error', e?.message, e?.error));
  window.addEventListener('unhandledrejection', (e) => err('unhandledrejection', e?.reason));

  const App = {

    // Leaflet + Overlay
    map: null, overlay: null, sceneBounds: null, boundsRaw: null,
    drawnFG: null, layers: [], selectedLayer: null,

    // Screen canvases
    maskCanvas: null, maskCtx: null,
    cursorCanvas: null, cursorCtx: null,

    // Full-res offscreen mask
    fullMaskCanvas: null, fullMaskCtx: null, imgW: 0, imgH: 0,

    // Brush state
    DPR: Math.max(1, window.devicePixelRatio || 1),
    MODE: 'pan', ERASE: false, Brush: { size: 24 },

    // cache
    _lastCursor: null,
  };

  App.redrawMaskToScreen = function () {
    if (!App.map || !App.maskCtx || !App.fullMaskCanvas || !App.sceneBounds) return;
    if (!App.map._loaded) { log('redraw:skip:not-loaded'); return; }

    const w = App.maskCanvas.width / App.DPR;
    const h = App.maskCanvas.height / App.DPR;

    // مستطیل overlay روی صفحه
    const lt = L.latLng(App.sceneBounds.getNorth(), App.sceneBounds.getWest());
    const rb = L.latLng(App.sceneBounds.getSouth(), App.sceneBounds.getEast());
    const ptLT = App.map.latLngToContainerPoint(lt);
    const ptRB = App.map.latLngToContainerPoint(rb);
    const left = ptLT.x, top = ptLT.y;
    const right = ptRB.x, bottom = ptRB.y;

    // تقاطع مستطیلِ overlay با بومِ صفحه (0..w, 0..h)
    const dx0 = Math.max(0, Math.min(w, left));
    const dy0 = Math.max(0, Math.min(h, top));
    const dx1 = Math.max(0, Math.min(w, right));
    const dy1 = Math.max(0, Math.min(h, bottom));
    const dw = dx1 - dx0;
    const dh = dy1 - dy0;

    App.maskCtx.save();
    App.maskCtx.clearRect(0, 0, w, h);

    if (dw > 0 && dh > 0) {
      const overlayW = (right - left);
      const overlayH = (bottom - top);
      // نسبت‌های مبدأ داخل تصویر (0..1)
      const fx0 = (dx0 - left) / overlayW;
      const fy0 = (dy0 - top) / overlayH;
      const fx1 = (dx1 - left) / overlayW;
      const fy1 = (dy1 - top) / overlayH;

      const sx = Math.max(0, Math.floor(fx0 * App.imgW));
      const sy = Math.max(0, Math.floor(fy0 * App.imgH));
      const sx1 = Math.min(App.imgW, Math.ceil(fx1 * App.imgW));
      const sy1 = Math.min(App.imgH, Math.ceil(fy1 * App.imgH));
      const sw = Math.max(0, sx1 - sx);
      const sh = Math.max(0, sy1 - sy);

      if (sw > 0 && sh > 0) {
        App.maskCtx.imageSmoothingEnabled = false;
        App.maskCtx.globalAlpha = 1.0;
        App.maskCtx.drawImage(App.fullMaskCanvas, sx, sy, sw, sh, dx0, dy0, dw, dh);
      }
    }

    App.maskCtx.restore();
  };

  // ---------- MAP & OVERLAY ----------
  function createMap(mapId) {
    log('createMap:start', { mapId });
    const map = L.map(mapId, { zoomControl: true, preferCanvas: true, maxZoom: 19 });
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Esri', maxNativeZoom: 19, maxZoom: 19, detectRetina: true }
    ).addTo(map);

    const drawn = new L.FeatureGroup(); map.addLayer(drawn);
    App.map = map; App.drawnFG = drawn;

    map.on('resize', () => { log('map:resize'); sizeCanvases(); });
    map.on('move zoom', () => {
      log('map:move/zoom', { mode: App.MODE, draggingEnabled: !!App.map.dragging.enabled() });
      App.redrawMaskToScreen();       // 👈 اضافه شود
      if (App._lastCursor) drawCursor(App._lastCursor.x, App._lastCursor.y);
    });
    map.whenReady(() => {
      log('map:ready');
      try { App.redrawMaskToScreen(); } catch { }
    });

    log('createMap:done');
  }

  async function loadSceneOverlay(urlBounds, urlImage) {
    log('overlay:load:start', { urlBounds, urlImage });
    const rb = await fetch(urlBounds, { cache: 'no-store' });
    if (!rb.ok) { err('overlay:bounds:http', rb.status); throw new Error('s2 bounds http'); }
    const b = await rb.json(); App.boundsRaw = b;
    App.sceneBounds = L.latLngBounds([b.lat_min, b.lon_min], [b.lat_max, b.lon_max]);
    try { App.map.fitBounds(App.sceneBounds.pad(0.05), { maxZoom: 19 }); } catch { }
    if (App.overlay) App.map.removeLayer(App.overlay);
    const url = urlImage + '?t=' + Date.now();
    App.overlay = L.imageOverlay(url, App.sceneBounds, { opacity: 0.6, crossOrigin: true }).addTo(App.map);

    App.overlay.once('load', () => {
      log('overlay:image:load', { url });
      try {
        App.map.fitBounds(App.sceneBounds.pad(0.05), { maxZoom: 19 });
        App.map.setMaxBounds(App.sceneBounds.pad(0.10));
        App.map.options.maxBoundsViscosity = 1.0;
      } catch (e) { warn('overlay:fitBounds:error', e); }
    });
    App.overlay.once('error', (e) => warn('overlay:image:error', e));
  }

  // ---------- FULL-RES MASK ----------
  async function allocFullResMask() {
    log('fullMask:alloc:start');
    const r = await fetch('/api/backdrop_meta', { cache: 'no-store' });
    if (!r.ok) { err('backdrop_meta:http', r.status); throw new Error('backdrop_meta'); }
    const j = await r.json();
    const asArr = Array.isArray(j) && j.length >= 2 ? j : null;
    const w = asArr ? +asArr[0] : +j.width;
    const h = asArr ? +asArr[1] : +j.height;
    App.imgW = Number.isFinite(w) ? w : 0;
    App.imgH = Number.isFinite(h) ? h : 0;
    log('fullMask:meta', { imgW: App.imgW, imgH: App.imgH });
    if (!App.imgW || !App.imgH) { throw new Error('invalid backdrop size'); }

    const cnv = document.createElement('canvas');
    cnv.width = App.imgW; cnv.height = App.imgH;
    const ctx = cnv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, App.imgW, App.imgH);

    App.fullMaskCanvas = cnv; App.fullMaskCtx = ctx;
    log('fullMask:alloc:done');
  }

  // ---------- SCREEN CANVASES ----------
  function attachCanvases(maskId, cursorId) {
    App.maskCanvas = $(maskId);
    App.cursorCanvas = $(cursorId);
    if (!App.maskCanvas || !App.cursorCanvas) {
      err('canvas:not-found', { maskFound: !!App.maskCanvas, cursorFound: !!App.cursorCanvas });
      throw new Error('maskCanvas / cursorCanvas missing');
    }
    App.maskCtx = App.maskCanvas.getContext('2d');
    App.cursorCtx = App.cursorCanvas.getContext('2d');
    App.cursorCanvas.style.pointerEvents = 'none';
    sizeCanvases();
    if (App.map && App.map._loaded) App.redrawMaskToScreen();
    bindPainting();
    bindCursor();
  }

  function sizeCanvases() {
    if (!App.map) return;
    const sz = App.map.getSize();
    [App.maskCanvas, App.cursorCanvas].forEach(cnv => {
      if (!cnv) return;
      cnv.width = Math.round(sz.x * App.DPR);
      cnv.height = Math.round(sz.y * App.DPR);
      cnv.style.width = sz.x + 'px';
      cnv.style.height = sz.y + 'px';
      cnv.getContext('2d').setTransform(App.DPR, 0, 0, App.DPR, 0, 0);
    });
    clearCursor();
    log('canvas:sized', { w: sz.x, h: sz.y, DPR: App.DPR, pointerEvents: App.maskCanvas?.style.pointerEvents });
    if (App.map && App.map._loaded) App.redrawMaskToScreen();
  }

  // ---------- COORD CONVERSIONS ----------
  function containerToImageXY(cx, cy) {
    if (!App.sceneBounds || !App.imgW || !App.imgH) { warn('toImage:no-bounds-or-size'); return null; }

    // مستطیل overlay در مختصات container (CSS px)
    const lt = L.latLng(App.sceneBounds.getNorth(), App.sceneBounds.getWest());
    const rb = L.latLng(App.sceneBounds.getSouth(), App.sceneBounds.getEast());
    const ptLT = App.map.latLngToContainerPoint(lt);
    const ptRB = App.map.latLngToContainerPoint(rb);

    const left = ptLT.x;
    const top = ptLT.y;
    const right = ptRB.x;
    const bottom = ptRB.y;
    const wScr = right - left;
    const hScr = bottom - top;
    if (wScr <= 0 || hScr <= 0) { warn('toImage:invalid overlay rect'); return null; }

    const fx = (cx - left) / wScr;
    const fy = (cy - top) / hScr;
    // کِلمپ داخل تصویر
    const fxC = Math.max(0, Math.min(1, fx));
    const fyC = Math.max(0, Math.min(1, fy));

    const ix = Math.round(fxC * (App.imgW - 1));
    const iy = Math.round(fyC * (App.imgH - 1));
    const latlng = App.map.containerPointToLatLng([cx, cy]);
    return { ix, iy, fx: fxC, fy: fyC, lat: latlng?.lat, lng: latlng?.lng };
  }

  function screenRadiusToImageRadius(cx, cy, rScreen) {
    const p0 = containerToImageXY(cx, cy);
    const p1 = containerToImageXY(cx + rScreen, cy);
    if (!p0 || !p1) return Math.max(1, Math.round(rScreen));
    return Math.max(1, Math.round(Math.hypot(p1.ix - p0.ix, p1.iy - p0.iy)));
  }

  // ---------- CURSOR ----------
  function clearCursor() {
    if (!App.cursorCtx || !App.cursorCanvas) return;
    const w = App.cursorCanvas.width / App.DPR, h = App.cursorCanvas.height / App.DPR;
    App.cursorCtx.clearRect(0, 0, w, h);
  }
  function drawCursor(x, y) {
    App._lastCursor = { x, y };
    clearCursor();
    if (App.MODE !== 'brush') return;
    const r = Math.max(1, App.Brush.size * 0.5);
    App.cursorCtx.save();
    App.cursorCtx.strokeStyle = App.ERASE ? 'rgba(255,70,70,.95)' : 'rgba(0,255,0,.95)';
    App.cursorCtx.beginPath(); App.cursorCtx.arc(x, y, r, 0, Math.PI * 2); App.cursorCtx.stroke();
    App.cursorCtx.restore();
  }
  function bindCursor() {
    App.map.on('mousemove', (e) => {
      const pt = App.map.latLngToContainerPoint(e.latlng);
      drawCursor(pt.x, pt.y);
    });
    App.map.on('mouseout', clearCursor);
  }

  // ---------- PAINTING ----------
  let painting = false;

  function getXY(e, cnv) {
    const r = cnv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function dabAtScreenAndFull(cx, cy) {
    if (!App.fullMaskCtx) { warn('dab:no-full'); return; }

    // تبدیل مختصات اسکرین به پیکسل تصویر
    const p = containerToImageXY(cx, cy);
    if (!p) { warn('dab:no-image-pt'); return; }

    // شعاع قلم: ورودی به پیکسلِ اسکرین است؛ به پیکسلِ تصویر تبدیلش کن
    const rScreen = Math.max(1, App.Brush.size * 0.5);
    const rI = screenRadiusToImageRadius(cx, cy, rScreen);

    // نقاشی روی فول‌رز (ماسک دودویی؛ ما از پرِ RGBA استفاده می‌کنیم و بعداً آلفا را دودویی می‌کنیم)
    App.fullMaskCtx.save();
    App.fullMaskCtx.globalCompositeOperation = App.ERASE ? 'destination-out' : 'source-over';
    App.fullMaskCtx.beginPath();
    App.fullMaskCtx.arc(p.ix, p.iy, rI, 0, Math.PI * 2);
    App.fullMaskCtx.fillStyle = App.ERASE ? 'rgba(0,0,0,1)' : 'rgba(255,255,255,1)';
    App.fullMaskCtx.fill();
    App.fullMaskCtx.restore();

    // بعد از هر ضربه، ویو را دوباره از فول‌رز رندر کن
    App.redrawMaskToScreen();

    log('dab', { screen: { x: cx, y: cy, r: rScreen }, image: { ix: p.ix, iy: p.iy, r: rI }, erase: App.ERASE });
  }

  function bindPainting() {
    const CNV = App.maskCanvas;
    if (!CNV) { err('paint:no-canvas'); return; }

    // ابتدا غیرکلیک‌پذیر؛ فقط در حالت براش فعال می‌شود
    CNV.style.pointerEvents = 'none';
    log('paint:bind', { pointerEvents: CNV.style.pointerEvents });

    CNV.addEventListener('mousedown', (e) => {
      log('paint:mousedown', { mode: App.MODE, pointerEvents: CNV.style.pointerEvents });
      if (App.MODE !== 'brush') { log('paint:skip:not-brush'); return; }
      if (CNV.style.pointerEvents !== 'auto') { warn('paint:block:pointer-events', CNV.style.pointerEvents); return; }
      e.preventDefault(); e.stopPropagation();
      painting = true;
      try { App.map.dragging.disable(); } catch { }
      const [cx, cy] = getXY(e, CNV);
      log('paint:start', { cx, cy, size: App.Brush.size, erase: App.ERASE });
      dabAtScreenAndFull(cx, cy);
    });

    CNV.addEventListener('mousemove', (e) => {
      if (App.MODE !== 'brush' || !painting) return;
      const [cx, cy] = getXY(e, CNV);
      dabAtScreenAndFull(cx, cy);
    });

    window.addEventListener('mouseup', () => {
      if (!painting) return;
      painting = false;
      try { App.map.dragging.enable(); } catch { }
      log('paint:end');
    });
  }

  // ---------- POLYGONS ----------
  App.addGeoJSONLayer = function (feat, layer) {
    layer._props = { ...(feat.properties || {}) };
    try { layer.setStyle?.({ color: '#22c55e', weight: 2 }); } catch { }
    layer.on('click', () => {
      App.selectLayer(layer);
      try { App.map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 19 }); } catch { }
    });
    App.drawnFG.addLayer(layer);
    App.layers.push(layer);
  };

  App.selectLayer = function (layer) {
    if (!layer) return;
    if (App.selectedLayer && App.selectedLayer !== layer) {
      try { App.selectedLayer.setStyle({ weight: 2, color: '#22c55e' }); } catch { }
    }
    App.selectedLayer = layer;
    try { App.selectedLayer.setStyle({ weight: 3, color: '#4f46e5' }); } catch { }
    log('poly:selected', { uid: App.layerUid?.(layer) });

    try {
      if (typeof App.onLayerSelected === 'function') App.onLayerSelected(layer);
    } catch (e) { warn('onLayerSelected:error', e); }
  };

  // ---------- SAVE / CLEAR ----------
  function buildBinaryMaskBuffer() {
    const w = App.imgW, h = App.imgH;
    const id = App.fullMaskCtx.getImageData(0, 0, w, h);
    const src = id.data, out = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < src.length; i += 4, j++) {
      out[j] = (src[i + 3] > 0) ? 255 : 0;
    }
    return out;
  }

  App.saveMask = async function () {
    if (!App.fullMaskCtx || !App.imgW || !App.imgH) {
      warn('saveMask:not-ready', { hasFull: !!App.fullMaskCtx, w: App.imgW, h: App.imgH });
      alert('Mask not ready'); return;
    }
    try {
      const buf = buildBinaryMaskBuffer();
      log('saveMask:post', { bytes: buf.byteLength });
      const r = await fetch('/api/save_mask', { method: 'POST', body: buf });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      alert('Mask saved.');
    } catch (e) { err('saveMask:error', e); alert('Save failed: ' + e); }
  };

  App.clearMask = function () {
    log('mask:clear');
    if (App.fullMaskCtx && App.imgW && App.imgH) {
      App.fullMaskCtx.clearRect(0, 0, App.imgW, App.imgH);
    }
    App.redrawMaskToScreen();
  };

  // ---------- PUBLIC API ----------
  App.init = async function ({
    mapId = 'map',
    maskId = 'maskCanvas',
    cursorId = 'cursorCanvas',
    overlayBoundsURL = '/api/s2_bounds_wgs84',
    overlayImageURL = '/api/output/rgb_quicklook.png',
  } = {}) {
    log('init:start');
    createMap(mapId);
    await loadSceneOverlay(overlayBoundsURL, overlayImageURL);
    await allocFullResMask();
    attachCanvases(maskId, cursorId);
    App.setMode('pan'); // پیش‌فرض
    log('init:done');
  };

  App.setMode = function (mode) {
    const isBrush = (mode === 'brush');
    App.MODE = isBrush ? 'brush' : 'pan';
    if (App.maskCanvas) App.maskCanvas.style.pointerEvents = isBrush ? 'auto' : 'none';
    try { isBrush ? App.map.dragging.disable() : App.map.dragging.enable(); } catch { }
    log('mode:set', { mode: App.MODE, pointerEvents: App.maskCanvas?.style.pointerEvents, dragging: App.map?.dragging?.enabled?.() });
  };

  App.setBrushSize = (px) => { App.Brush.size = Math.max(2, Math.min(256, parseInt(px || 24, 10))); log('brush:size', App.Brush.size); };
  App.setErase = (on) => { App.ERASE = !!on; log('brush:erase', App.ERASE); };

  // Helpers برای تشخیص
  App._diag = () => {
    const pe = App.maskCanvas?.style.pointerEvents;
    const drag = App.map?.dragging?.enabled?.();
    const have = { mask: !!App.maskCanvas, cursor: !!App.cursorCanvas, full: !!App.fullMaskCanvas };
    const meta = { imgW: App.imgW, imgH: App.imgH, bounds: App.boundsRaw };
    console.table({ MODE: App.MODE, ERASE: App.ERASE, pointerEvents: pe, dragging: drag, ...have, ...meta });
    return { MODE: App.MODE, ERASE: App.ERASE, pointerEvents: pe, dragging: drag, have, meta };
  };
  App._setDebug = (on) => { DBG = !!on; console.log('[BRUSH:core] debug =', DBG); };

  window.BrushApp = App;
})();

