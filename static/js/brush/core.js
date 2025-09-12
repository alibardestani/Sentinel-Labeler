// static/js/brush/core.js
console.log("[BRUSH:core] loaded");
; (() => {
  const DBG = true;
  const log = (...a) => DBG && console.debug('[BRUSH:core]', ...a);
  const warn = (...a) => DBG && console.warn('[BRUSH:core]', ...a);
  const err = (...a) => DBG && console.error('[BRUSH:core]', ...a);
  const info = (...a) => DBG && console.info('[BRUSH:core]', ...a);

  window.addEventListener('error', (e) => { err('window.error', e?.message, e?.error); });
  window.addEventListener('unhandledrejection', (e) => { err('unhandledrejection', e?.reason); });

  const App = {
    map: null,
    overlay: null,
    sceneBounds: null,
    drawnFG: null,

    maskCanvas: null,
    cursorCanvas: null,
    maskCtx: null,
    cursorCtx: null,

    // --- ماسک محلی (ویژه هر پلیگان انتخابی)
    localMaskCanvas: null,
    localMaskCtx: null,
    localClipPath: null,      // کلیپ‌پث هم‌اندازهٔ بوم محلی
    localBBox: null,          // {x,y,w,h} به پیکسل کانتینر

    DPR: Math.max(1, window.devicePixelRatio || 1),
    MODE: 'pan',
    ERASE: false,
    Brush: { size: 24, clipPath: null, enforceClip: true }, // clipPath قدیمی برای ماسک سراسری (در صورت نیاز)

    layers: [],
    selectedLayer: null,

    onAfterStroke: null,
    onLayerSelected: null,
  };

  const $ = (id) => document.getElementById(id);

  // --- کرسر براش
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

  // --- ساخت نقشه + بیس‌مپ
  function createMap(mapId, opts = {}) {
    log('createMap:start', { mapId, opts });
    const MAX_BASE_ZOOM = 19;

    const map = L.map(mapId, {
      zoomSnap: 0,
      zoomDelta: 0.5,
      maxZoom: MAX_BASE_ZOOM,
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
      { attribution: 'Esri', maxNativeZoom: 19, maxZoom: MAX_BASE_ZOOM, detectRetina: true }
    ).addTo(map);
    base.on('load', () => info('basemap:load'));
    base.on('tileerror', (e) => warn('basemap:tileerror', e));

    const drawn = new L.FeatureGroup();
    map.addLayer(drawn);

    App.map = map;
    App.drawnFG = drawn;

    map.on('move zoom', () => {
      log('map:move/zoom', { center: map.getCenter(), zoom: map.getZoom() });
      positionLocalMask();        // ← بوم محلی را هم‌گام کن
      if (App.selectedLayer) rebuildClipPath(); // کلیپ سراسری (درصورت نیاز)
    });
    map.on('resize', (e) => {
      log('map:resize', e?.newSize);
      sizeCanvases(true);
      positionLocalMask(true);
    });

    // گارد برای سقف زوم
    map.on('zoomend', () => {
      const z = map.getZoom();
      if (z > MAX_BASE_ZOOM) map.setZoom(MAX_BASE_ZOOM);
    });

    log('createMap:done');
    return map;
  }

  // --- اوورلی سنجش‌از‌دور
  async function loadSceneOverlay(urlBounds = '/api/s2_bounds_wgs84', urlImage = '/api/output/rgb_quicklook.png') {
    log('overlay:fetch-bounds:start', { urlBounds });
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
    App.overlay = L.imageOverlay(url, App.sceneBounds, { opacity: 0.6, crossOrigin: true }).addTo(App.map);

    let didFit = false;
    const fallbackTimer = setTimeout(() => {
      if (!didFit && App.sceneBounds) {
        try { App.map.fitBounds(App.sceneBounds); log('overlay:fitBounds:fallback'); } catch { }
      }
    }, 1200);

    App.overlay.once('load', () => {
      clearTimeout(fallbackTimer);
      didFit = true;
      info('overlay:image:load', { url });
      try {
        App.map.fitBounds(App.sceneBounds.pad(0.05), { maxZoom: 19 });
        App.map.setMaxBounds(App.sceneBounds.pad(0.10));
        App.map.options.maxBoundsViscosity = 1.0;
      } catch (e) { warn('overlay:fit/setMaxBounds:error', e); }
      log('overlay:fitBounds+lock');
    });
    App.overlay.once('error', (e) => {
      clearTimeout(fallbackTimer);
      warn('overlay:image:error', e);
    });
  }

  // --- کنترل شفافیت اوورلی
  function bindOverlayOpacity(sliderId, valueId) {
    const slider = $(sliderId);
    const lbl = $(valueId);
    if (!slider) { warn('bindOverlayOpacity:no-slider', { sliderId }); return; }
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

  // --- اتصال کانواس‌های سراسری
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

    // بوم محلی را هم بساز (در DOM اضافه می‌شود)
    ensureLocalMaskCanvas();
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

  // ========= ماسک محلی (پر-پلیگان) =========

  // 1) ساخت/اضافه کردن بوم محلی به DOM (اگر نبود)
  function ensureLocalMaskCanvas() {
    if (App.localMaskCanvas) return;
    const cnv = document.createElement('canvas');
    cnv.id = 'localMaskCanvas';
    Object.assign(cnv.style, {
      position: 'absolute',
      pointerEvents: 'auto',     // قابل نقاشی
      zIndex: 1303,              // بالاتر از وکتورها (1302) و کرسر (1301)
      left: '0px', top: '0px',
      width: '0px', height: '0px'
    });
    const mapEl = App.map.getContainer();
    mapEl.appendChild(cnv);
    App.localMaskCanvas = cnv;
    App.localMaskCtx = cnv.getContext('2d');
    log('localMaskCanvas:created');
  }

  // 2) محاسبه BBox پیکسلی پلیگان انتخابی
  function polygonPixelBBox() {
    const layer = App.selectedLayer;
    if (!layer) { warn('bbox:no-layer'); return null; }
    try {
      const b = layer.getBounds();
      const tl = App.map.latLngToContainerPoint([b.getNorth(), b.getWest()]);
      const br = App.map.latLngToContainerPoint([b.getSouth(), b.getEast()]);
      const x = Math.floor(tl.x), y = Math.floor(tl.y);
      const w = Math.max(1, Math.ceil(br.x - tl.x));
      const h = Math.max(1, Math.ceil(br.y - tl.y));
      const out = { x, y, w, h };
      log('bbox', out);
      return out;
    } catch (e) {
      err('bbox:error', e);
      return null;
    }
  }

  App.polygonPixelBBox = function () {
    // اگر بوم محلی داریم، همونو بده (io.js هم همینو لازم داره)
    if (App.localBBox) return { ...App.localBBox };
    return polygonPixelBBox(); // fallback
  };

  App.getLocalMaskBBox = () => (App.localBBox ? { ...App.localBBox } : null);

  App.drawMaskImageToLocal = async function drawMaskImageToLocal(imgOrBlob) {
    if (!App.localMaskCanvas || !App.localMaskCtx) return;
    // ورودی رو به HTMLImageElement تبدیل کن
    const img = await (async () => {
      if (imgOrBlob instanceof HTMLImageElement) return imgOrBlob;
      const blob = imgOrBlob instanceof Blob ? imgOrBlob : new Blob([imgOrBlob]);
      return new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = URL.createObjectURL(blob);
      });
    })();

    const w = App.localMaskCanvas.width / App.DPR;
    const h = App.localMaskCanvas.height / App.DPR;
    App.localMaskCtx.clearRect(0, 0, w, h);
    // اگر لازم داری باینری کنی، اینجا انجام بده؛ فعلاً همون تصویر رو می‌ریزیم
    App.localMaskCtx.drawImage(img, 0, 0, w, h);
    try { URL.revokeObjectURL(img.src); } catch { }
    log('localMask:drawn', { w, h });
  };

  App.localMaskToBlob = function localMaskToBlob(type = 'image/png', quality = 0.92) {
    return new Promise((resolve) => {
      if (!App.localMaskCanvas) return resolve(null);
      App.localMaskCanvas.toBlob((b) => resolve(b), type, quality);
    });
  };

  // 3) ساخت کلیپ‌پث «لوکال» برای بوم محلی (مختصات داخل بوم)
  function buildLocalClip(shiftX, shiftY) {
    const clip = new Path2D();
    const layer = App.selectedLayer;
    if (!layer) { warn('localClip:no-layer'); return clip; }
    const gj = layer.toGeoJSON();
    const geom = gj?.geometry;
    if (!geom) { warn('localClip:no-geom'); return clip; }
    const mapRect = App.map.getContainer().getBoundingClientRect();
    const canvasRect = App.localMaskCanvas.getBoundingClientRect();
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
  }

  // 4) هم‌تراز کردن/تغییر اندازه بوم محلی با پلیگان انتخابی
  function positionLocalMask(clear = false) {
    if (!App.localMaskCanvas || !App.selectedLayer) return;
    const bb = polygonPixelBBox();
    if (!bb) return;
    const { x, y, w, h } = bb;
    // اگر اندازه عوض شده، رزولوشن بوم را (با DPR) آپدیت کن
    const needResize = (App.localBBox?.w !== w) || (App.localBBox?.h !== h);
    if (needResize) {
      App.localMaskCanvas.width = Math.round(w * App.DPR);
      App.localMaskCanvas.height = Math.round(h * App.DPR);
      App.localMaskCanvas.style.width = w + 'px';
      App.localMaskCanvas.style.height = h + 'px';
      App.localMaskCtx.setTransform(App.DPR, 0, 0, App.DPR, 0, 0);
      if (clear) App.localMaskCtx.clearRect(0, 0, w, h);
    }
    // جایگذاری روی نقشه
    App.localMaskCanvas.style.left = x + 'px';
    App.localMaskCanvas.style.top = y + 'px';
    // کلیپ‌پث محلی را بساز/به‌روزرسانی کن
    App.localClipPath = buildLocalClip(x, y);
    App.localBBox = { x, y, w, h };
    log('localMask:positioned', { x, y, w, h, resized: needResize });
  }

  // --- انتخاب لایه
  function selectLayer(layer) {
    if (!layer) return;
    if (App.selectedLayer && App.selectedLayer !== layer) {
      try { App.selectedLayer.setStyle({ weight: 2, color: '#22c55e' }); } catch { }
    }
    App.selectedLayer = layer;
    try { App.selectedLayer.setStyle({ weight: 3, color: '#4f46e5' }); } catch { }
    log('layer:selected', { uid: App.layerUid(layer), label: App.layerLabel(layer) });

    ensureLocalMaskCanvas();
    positionLocalMask(true);           // ← بلافاصله سایز و موقعیت بده؛ اگر قبلی هست پاک کن
    if (App.onLayerSelected) App.onLayerSelected(layer);
  }

  // --- کلیپ‌پث سراسری (در صورت نیاز)
  function rebuildClipPath() {
    App.Brush.clipPath = null;
    const layer = App.selectedLayer;
    if (!layer) return;
    let geom;
    try { geom = layer.toGeoJSON()?.geometry; }
    catch (e) { err('clip:geojson-error', e); return; }
    if (!geom) { warn('clip:no-geometry'); return; }

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
    App.Brush.clipPath = p;

    // افکت سایه‌دار/ماسکِ UI روی کرسر (مثل قبل)
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

  // --- تست داخل کلیپ (حالتی که enforceClip روشن است)
  function isInsideClipLocal(x, y) {
    if (!App.Brush.enforceClip) return true;
    if (!App.localClipPath) return false;
    // x,y مختصات داخل بوم محلی است
    const ok = App.localMaskCtx.isPointInPath(App.localClipPath, x, y, 'evenodd');
    if (!ok) log('clipLocal:outside', { x, y });
    return ok;
  }

  // --- نقاشی
  let painting = false;
  let lastPt = null;
  let lastMouse = { x: null, y: null };

  function getCanvasXY_Global(e) {
    const r = App.maskCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function getCanvasXY_Local(e) {
    const r = App.localMaskCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function drawDotLocal(x, y) {
    if (App.MODE !== 'brush') return;
    if (!isInsideClipLocal(x, y)) return;
    const r = Math.max(1, App.Brush.size * 0.5);
    App.localMaskCtx.save();
    App.localMaskCtx.globalCompositeOperation = App.ERASE ? 'destination-out' : 'source-over';
    App.localMaskCtx.beginPath();
    App.localMaskCtx.arc(x, y, r, 0, Math.PI * 2);
    App.localMaskCtx.fillStyle = App.ERASE ? 'rgba(0,0,0,1)' : 'rgba(0,255,0,0.9)';
    App.localMaskCtx.fill();
    App.localMaskCtx.restore();
  }

  function bindPaintingEvents() {
    if (!App.localMaskCanvas) ensureLocalMaskCanvas();
    function syncBodyClass() {
      document.body.classList.toggle('tool-brush', App.MODE === 'brush');
    }
    syncBodyClass();

    // رو بوم محلی نقاشی کن
    App.localMaskCanvas.addEventListener('mousedown', (e) => {
      if (App.MODE !== 'brush') return;
      if (!App.selectedLayer) { warn('paint:no-layer-selected'); alert('Select a polygon first.'); return; }
      if (!App.localClipPath && App.Brush.enforceClip) { positionLocalMask(); if (!App.localClipPath) { warn('paint:no-local-clip'); return; } }
      e.preventDefault(); e.stopPropagation();
      painting = true;
      App.map.dragging.disable();
      const [x, y] = getCanvasXY_Local(e);
      log('paint:start', { x, y, erase: App.ERASE, size: App.Brush.size });
      drawDotLocal(x, y);
      lastPt = [x, y];
    });

    App.localMaskCanvas.addEventListener('mousemove', (e) => {
      const [gx, gy] = getCanvasXY_Global(e); // برای کرسر
      lastMouse.x = gx; lastMouse.y = gy;
      redrawCursorPreview(gx, gy);

      if (App.MODE !== 'brush' || !painting) return;
      const [x, y] = getCanvasXY_Local(e);
      if (lastPt) {
        const dx = x - lastPt[0], dy = y - lastPt[1];
        const steps = Math.ceil(Math.hypot(dx, dy) / Math.max(2, App.Brush.size * 0.35));
        for (let i = 1; i <= steps; i++) {
          const px = lastPt[0] + (dx * i) / steps;
          const py = lastPt[1] + (dy * i) / steps;
          drawDotLocal(px, py);
        }
        lastPt = [x, y];
      } else {
        drawDotLocal(x, y);
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
      positionLocalMask();
      if (lastMouse.x != null) redrawCursorPreview(lastMouse.x, lastMouse.y);
    });
  }

  // --- API عمومی
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
      // bindPaintingEvents();
      enableSimpleBrushMode();
      App.ready = true;
      log('init:done');
    } catch (e) {
      err('init:error', e);
      throw e;
    }
  };

  App.setMode = function setMode(mode) {
    if (!App.map || !App.map.dragging) return;

    const prev = App.MODE;
    App.MODE = (mode === 'brush') ? 'brush' : 'pan';
    const isBrush = (App.MODE === 'brush');

    // کلاس بدنه برای کنترل pointer-events روی ماسک سراسری
    document.body.classList.toggle('tool-brush', isBrush);

    // تضمین وضعیت pointer-events روی بوم محلی (اگر داری با localMaskCanvas می‌کشی)
    try {
      if (App.localMaskCanvas) {
        App.localMaskCanvas.style.pointerEvents = isBrush ? 'auto' : 'none';
      }
    } catch { }

    // توقف هرگونه استروک نیمه‌تمام
    try {
      // اگر متغیر painting در اسکوپ ماژول هست، خاموشش کن
      // (اگر بیرون از این تابع تعریف شده، این بلاک کمک می‌کند از حلقه‌ی کشیدن خارج بشی)
      window.__BRUSH_PAINTING__ = false;
    } catch { }

    // سوییچ رفتار نقشه
    if (isBrush) {
      App.map.dragging.disable();
      try { App._redrawCursorPreview?.(); } catch { }
    } else {
      App.map.dragging.enable();
      // اگر با wheel/boxZoom قبلاً دستکاری شده، برگردون
      try { App.map.scrollWheelZoom.enable(); } catch { }
      try { App.map.boxZoom.enable(); } catch { }
      // کرسر کمکی پاک شود
      try { (App.clearCursor || function () { }).call(null); } catch { }
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

  // متدهایی که قبلاً داشتی را نگه می‌داریم
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
    // پاک کردن ماسک محلی (پیش‌فرض)
    if (App.maskCanvas && App.maskCtx) {
      const w = App.maskCanvas.width / App.DPR, h = App.maskCanvas.height / App.DPR;
      App.maskCtx.clearRect(0, 0, w, h);
      log('mask:cleared', { w, h });
    }
    // جایگزین: ماسک سراسری (اگر لازم شد)
    const w = App.maskCanvas.width / App.DPR, h = App.maskCanvas.height / App.DPR;
    App.maskCtx.clearRect(0, 0, w, h);
    log('mask:cleared', { w, h });
  };

  // ابزارها/هِلپرها
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

  function bindSimplePaintingEvents() {
    // روی همون maskCanvas بکش (بدون هیچ کلیپ/لوکال‌باکس)
    const CANVAS = App.maskCanvas;
    const CTX = App.maskCtx;
    if (!CANVAS || !CTX) return;

    CANVAS.style.pointerEvents = 'auto'; // قابل کلیک/کشیدن

    let painting = false;

    function getXY(e) {
      const r = CANVAS.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    function draw(e) {
      const [x, y] = getXY(e);
      const r = Math.max(1, App.Brush.size * 0.5);
      CTX.save();
      CTX.globalCompositeOperation = App.ERASE ? 'destination-out' : 'source-over';
      CTX.beginPath();
      CTX.arc(x, y, r, 0, Math.PI * 2);
      CTX.fillStyle = App.ERASE ? 'rgba(0,0,0,1)' : 'rgba(0,255,0,0.9)';
      CTX.fill();
      CTX.restore();
    }

    CANVAS.addEventListener('mousedown', (e) => {
      if (App.MODE !== 'brush') return;
      painting = true;
      App.map?.dragging?.disable();
      draw(e);
    });

    CANVAS.addEventListener('mousemove', (e) => {
      if (App.MODE !== 'brush' || !painting) return;
      draw(e);
    });

    window.addEventListener('mouseup', () => {
      if (!painting) return;
      painting = false;
      App.map?.dragging?.enable();
      App.onAfterStroke && App.onAfterStroke();
    });

    // یک کرسر مینیمال (اختیاری)
    App._redrawCursorPreview = () => { };
    log('simpleBrush:bound');
  }

  function enableSimpleBrushMode() {
    // هرگونه محدودیت کلیپ رو بردار که قلم همیشه بکشه
    App.Brush.enforceClip = false;
    // body کلاس براش رو بزن تا pointer-events برای maskCanvas روشن باشه
    document.body.classList.add('tool-brush');
    App.MODE = 'brush';
    bindSimplePaintingEvents();
    log('simpleBrush:enabled');
  }

  window.BrushApp = App;
})();