// static/js/brush/core.js
console.log("[BRUSH:core] loaded");

; (function () {
  // ---- avoid double-load of core.js
  if (window.BrushApp && window.BrushApp.__coreLoaded) {
    console.warn("[BRUSH:core] already loaded; skipping duplicate load");
    return;
  }

  let DBG = true;
  const log = (...a) => DBG && console.debug("[BRUSH:core]", ...a);
  const warn = (...a) => DBG && console.warn("[BRUSH:core]", ...a);
  const err = (...a) => DBG && console.error("[BRUSH:core]", ...a);
  const $ = (id) => document.getElementById(id);

  window.addEventListener("error", (e) => err("window.error", e?.message, e?.error));
  window.addEventListener("unhandledrejection", (e) => err("unhandledrejection", e?.reason));

  // ---- App state ----
  const App = window.BrushApp || {};
  window.BrushApp = App;           // ensure global
  App.__coreLoaded = true;         // guard flag

  Object.assign(App, {
    map: null, overlay: null, sceneBounds: null, boundsRaw: null,
    drawnFG: null, layers: [], selectedLayer: null,

    maskCanvas: null, maskCtx: null,
    cursorCanvas: null, cursorCtx: null,

    fullMaskCanvas: null, fullMaskCtx: null, imgW: 0, imgH: 0,
    fullMaskClass: null,

    DPR: Math.max(1, window.devicePixelRatio || 1),
    MODE: "pan",
    ERASE: false,
    Brush: { size: 24, classId: 1 },

    grid: { rows: 3, cols: 3, tiles: [], active: { r: -1, c: -1 }, overlay: null, autoFollow: false },

    sceneId: null,
    _lastCursor: null,
  });

  // ---- Palette ----
  const DEFAULT_PALETTE = {
    0: { name: "Background", color: "#00000000" },
    1: { name: "گردو", color: "#00ff00ff" },
    2: { name: "پسته", color: "#ffa500ff" },
    3: { name: "نخیلات", color: "#ffff00ff" },
  };
  App.PALETTE = (window.BRUSH_PALETTE || DEFAULT_PALETTE);

  function hex8ToRgba(hex8) {
    const h = (hex8 || "").replace("#", "");
    if (h.length !== 8) return "rgba(0,255,0,1)";
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = parseInt(h.slice(6, 8), 16) / 255;
    return `rgba(${r},${g},${b},${a})`;
  }
  App.colorForClass = (cid) => {
    const ent = App.PALETTE[cid] || { color: "#00ff00ff" };
    return hex8ToRgba(ent.color);
  };

  // ---- Tiny loader HUD for tile switching ----
  function ensureTileLoader() {
    const mapEl = $('#map') || document.body;
    let el = document.getElementById('tileLoading');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tileLoading';
      el.style.position = 'absolute';
      el.style.inset = '12px auto auto 12px';
      el.style.zIndex = '1401';
      el.style.padding = '6px 10px';
      el.style.borderRadius = '10px';
      el.style.border = '1px solid #1f2840';
      el.style.background = 'rgba(15,21,36,.85)';
      el.style.color = '#e7ecf3';
      el.style.font = '12px/1.4 ui-sans-serif,system-ui,Segoe UI,Roboto';
      el.style.display = 'none';
      el.textContent = 'Loading tile…';
      mapEl.appendChild(el);
    }
    return el;
  }
  App.setTileLoading = function (on) {
    const el = ensureTileLoader();
    el.style.display = on ? 'block' : 'none';
  };

  // ---- Map creation (with guards) ----
  function createMap(mapId) {
    // reuse existing instance if present
    if (App.map && App.map._loaded) {
      log("createMap:reuse-existing");
      return App.map;
    }
    const el = document.getElementById(mapId);
    if (!el) throw new Error("map container not found: " + mapId);
    if (el._leaflet_id) {
      warn("createMap:container already initialized by Leaflet; reusing");
      return App.map;
    }

    const map = L.map(mapId, { zoomControl: true, preferCanvas: true, maxZoom: 19 });
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri", maxNativeZoom: 19, maxZoom: 19, detectRetina: true }
    ).addTo(map);

    const drawn = new L.FeatureGroup();
    map.addLayer(drawn);

    App.map = map;
    App.drawnFG = drawn;

    map.on("resize", () => { sizeCanvases(); });
    map.on("move zoom", () => {
      App.redrawMaskToScreen();
      if (App._lastCursor) drawCursor(App._lastCursor.x, App._lastCursor.y);
    });
    map.whenReady(() => {
      try { App.redrawMaskToScreen(); } catch { }
    });

    return map;
  }

  // ---- Grid helpers ----
  App.buildGrid = function (rows = 3, cols = 3) {
    App.grid.rows = rows | 0; App.grid.cols = cols | 0;
    App.grid.tiles = [];
    if (!App.sceneBounds) { console.warn('[BRUSH:core] buildGrid: no sceneBounds yet'); return; }

    const latMin = App.sceneBounds.getSouth();
    const latMax = App.sceneBounds.getNorth();
    const lonMin = App.sceneBounds.getWest();
    const lonMax = App.sceneBounds.getEast();
    const dLat = (latMax - latMin) / rows;
    const dLon = (lonMax - lonMin) / cols;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = L.latLngBounds(
          [latMin + r * dLat, lonMin + c * dLon],
          [latMin + (r + 1) * dLat, lonMin + (c + 1) * dLon]
        );
        App.grid.tiles.push({ r, c, bounds: b });
      }
    }
    console.debug('[BRUSH:core] buildGrid: built', { rows, cols, tiles: App.grid.tiles.length });
  };

  function pickVisibleTile() {
    const vp = App.map.getBounds();
    const ctr = vp.getCenter();
    let best = null, bestDist = 1e9;
    for (const t of App.grid.tiles) {
      const c = t.bounds.getCenter();
      const d = Math.hypot(c.lat - ctr.lat, c.lng - ctr.lng);
      if (d < bestDist) { bestDist = d; best = t; }
    }
    return best;
  }

  App.setActiveTile = function (r, c, { fit = false } = {}) {
    const rows = App.grid.rows, cols = App.grid.cols;
    if (r < 0 || r >= rows || c < 0 || c >= cols) { console.warn('[BRUSH:core] setActiveTile: out of range', r, c); return; }
    if (!App.sceneId || !App.sceneBounds) { console.warn('[BRUSH:core] setActiveTile: no scene yet'); return; }

    const same = (App.grid.active.r === r && App.grid.active.c === c);

    // فقط اگر همون تایل قبلی است و overlay موجود است، بی‌کار برگرد
    if (same && App.grid.overlay) {
      console.debug('[BRUSH:core] setActiveTile: same tile & overlay exists -> skip');
      return;
    }

    console.debug('[BRUSH:core] setActiveTile:', { r, c, sceneId: App.sceneId });

    // (اختیاری) هوک UI برای لودینگ
    try { App.setTileLoading?.(true); } catch { }

    // اوورلی قبلی را بردار
    try { App.grid.overlay && App.map.removeLayer(App.grid.overlay); } catch { }
    App.grid.overlay = null;
    App.grid.active = { r, c };

    // باندز این تایل
    const idx = r * cols + c;
    const t = App.grid.tiles[idx];
    if (!t) { console.warn('[BRUSH:core] setActiveTile: tile not built yet', { r, c }); App.setTileLoading?.(false); return; }

    // URL سرویس تایل
    const url = `/api/grid/tile?scene_id=${encodeURIComponent(App.sceneId)}&r=${r}&c=${c}&t=${Date.now()}`;
    console.debug('[BRUSH:core] tile URL =', url);

    // اوورلی بساز
    const ov = L.imageOverlay(url, t.bounds, { opacity: 0.7, crossOrigin: true });
    App.grid.overlay = ov.addTo(App.map);

    // پایان لود را هندل کن
    if (typeof ov.once === 'function') {
      ov.once('load', () => App.setTileLoading?.(false));
      ov.once('error', () => { App.setTileLoading?.(false); alert('Failed to load tile'); });
      const img = ov.getElement && ov.getElement();
      if (img && img.complete) App.setTileLoading?.(false);
    } else {
      App.setTileLoading?.(false);
    }

    // رویداد اطلاع‌رسانی
    document.dispatchEvent(new CustomEvent('brush:tilechange', { detail: { r, c } }));

    // زوم/فیت اختیاری
    if (fit) {
      try { App.map.fitBounds(t.bounds.pad(0.02), { maxZoom: 19 }); } catch { }
    }

    // HUD
    try {
      const el1 = document.getElementById('hudTileRC');
      const el2 = document.getElementById('hudTileRC2');
      if (el1) el1.textContent = `r${r + 1}×c${c + 1}`;
      if (el2) el2.textContent = `r${r + 1}×c${c + 1}`;
    } catch { }
  };

  App.moveTile = function (dr, dc, { wrap = true, fit = false } = {}) {
    const rows = App.grid.rows, cols = App.grid.cols;
    let r = App.grid.active.r + dr;
    let c = App.grid.active.c + dc;

    if (wrap) {
      r = (r + rows) % rows;
      c = (c + cols) % cols;
    } else {
      if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    }
    App.setActiveTile(r, c, { fit });
  };

  App.setTileByNumber = function (n, { fit = false } = {}) {
    const rows = App.grid.rows, cols = App.grid.cols;
    const i = (n | 0) - 1;
    if (i < 0 || i >= rows * cols) return;
    const r = Math.floor(i / cols);
    const c = i % cols;
    App.setActiveTile(r, c, { fit });
  };

  App.nextTile = function () { App.moveTile(0, +1, { wrap: true, fit: false }); };
  App.prevTile = function () { App.moveTile(0, -1, { wrap: true, fit: false }); };

  function updateActiveTileOverlay() {
    if (!App.grid.tiles.length) return;
    const best = pickVisibleTile();
    if (!best) return;
    App.setActiveTile(best.r, best.c, { fit: false });
  }

  App.setAutoFollowTiles = function (on) {
    App.grid.autoFollow = !!on;
    App.map?.off("moveend", updateActiveTileOverlay);
    App.map?.off("zoomend", updateActiveTileOverlay);
    if (App.grid.autoFollow) {
      App.map?.on("moveend", updateActiveTileOverlay);
      App.map?.on("zoomend", updateActiveTileOverlay);
      updateActiveTileOverlay();
    }
  };

  // ---- Scene / tiles bootstrap helpers ----
  async function ensureSceneId(providedId) {
    if (providedId) { App.sceneId = providedId; return providedId; }
    try {
      const r = await fetch("/api/scenes/current", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      App.sceneId = j?.scene?.id || null;
    } catch (e) {
      warn("sceneId:auto:failed", e);
      App.sceneId = null;
    }
    return App.sceneId;
  }

  async function tilesExist(sceneId) {
    const u = `/api/grid/list?scene_id=${encodeURIComponent(sceneId)}&t=${Date.now()}`;
    const r = await fetch(u, { cache: "no-store" });
    if (r.status === 200) return true;
    if (r.status === 404) return false;
    throw new Error("grid/list http " + r.status);
  }

  async function buildTiles(sceneId) {
    const r = await fetch("/api/scenes/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene_id: sceneId })
    });
    if (!r.ok) {
      let j = {};
      try { j = await r.json(); } catch { }
      throw new Error("scenes/select http " + r.status + " " + (j?.error || ""));
    }
    const j = await r.json();
    return j?.meta;
  }

  async function loadSceneOverlay(boundsURL) {
    const rb = await fetch(boundsURL, { cache: "no-store" });
    if (!rb.ok) throw new Error("s2 bounds http " + rb.status);
    const b = await rb.json(); App.boundsRaw = b;
    App.sceneBounds = L.latLngBounds([b.lat_min, b.lon_min], [b.lat_max, b.lon_max]);

    try {
      App.map.fitBounds(App.sceneBounds.pad(0.05), { maxZoom: 19 });
      App.map.setMaxBounds(App.sceneBounds.pad(0.10));
      App.map.options.maxBoundsViscosity = 1.0;
    } catch { }

    if (App.overlay) { try { App.map.removeLayer(App.overlay); } catch { } }
    App.overlay = null;

    App.buildGrid(App.grid.rows, App.grid.cols);

    // فقط اگر autoFollow روشن است، تعقیب خودکار را فعال کن
    App.map.off("moveend", updateActiveTileOverlay);
    App.map.off("zoomend", updateActiveTileOverlay);
    if (App.grid.autoFollow) {
      App.map.on("moveend", updateActiveTileOverlay);
      App.map.on("zoomend", updateActiveTileOverlay);
      updateActiveTileOverlay(); // یک‌بار هم‌گام‌سازی اولیه
    }
  }

  // ---- Full-res mask alloc ----
  async function allocFullResMask() {
    const r = await fetch("/api/backdrop_meta", { cache: "no-store" });
    if (!r.ok) throw new Error("backdrop_meta http " + r.status);
    const j = await r.json();

    const w = +j.width, h = +j.height;
    App.imgW = Number.isFinite(w) ? w : 0;
    App.imgH = Number.isFinite(h) ? h : 0;
    if (!App.imgW || !App.imgH) throw new Error("invalid backdrop size");

    const cnv = document.createElement("canvas");
    cnv.width = App.imgW; cnv.height = App.imgH;
    const ctx = cnv.getContext("2d", { willReadFrequently: true });

    ctx.clearRect(0, 0, App.imgW, App.imgH);
    App.fullMaskCanvas = cnv;
    App.fullMaskCtx = ctx;
    App.fullMaskClass = new Uint8Array(App.imgW * App.imgH);
  }

  // ---- Canvases ----
  function attachCanvases(maskId, cursorId) {
    App.maskCanvas = $(maskId);
    App.cursorCanvas = $(cursorId);
    if (!App.maskCanvas || !App.cursorCanvas) throw new Error("maskCanvas / cursorCanvas missing");
    App.maskCtx = App.maskCanvas.getContext("2d");
    App.cursorCtx = App.cursorCanvas.getContext("2d");
    App.cursorCanvas.style.pointerEvents = "none";
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
      cnv.style.width = sz.x + "px";
      cnv.style.height = sz.y + "px";
      cnv.getContext("2d").setTransform(App.DPR, 0, 0, App.DPR, 0, 0);
    });
    clearCursor();
    if (App.map && App.map._loaded) App.redrawMaskToScreen();
  }

  // ---- Coords ----
  function containerToImageXY(cx, cy) {
    if (!App.sceneBounds || !App.imgW || !App.imgH) { return null; }

    const lt = L.latLng(App.sceneBounds.getNorth(), App.sceneBounds.getWest());
    const rb = L.latLng(App.sceneBounds.getSouth(), App.sceneBounds.getEast());
    const ptLT = App.map.latLngToContainerPoint(lt);
    const ptRB = App.map.latLngToContainerPoint(rb);

    const left = ptLT.x, top = ptLT.y, right = ptRB.x, bottom = ptRB.y;
    const wScr = right - left, hScr = bottom - top;
    if (wScr <= 0 || hScr <= 0) return null;

    const fx = (cx - left) / wScr;
    const fy = (cy - top) / hScr;

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

  // ---- Cursor ----
  function clearCursor() {
    if (!App.cursorCtx || !App.cursorCanvas) return;
    const w = App.cursorCanvas.width / App.DPR, h = App.cursorCanvas.height / App.DPR;
    App.cursorCtx.clearRect(0, 0, w, h);
  }
  function drawCursor(x, y) {
    App._lastCursor = { x, y };
    clearCursor();
    if (App.MODE !== "brush") return;
    const r = Math.max(1, App.Brush.size * 0.5);
    App.cursorCtx.save();
    const col = App.ERASE ? "rgba(255,70,70,.95)" : App.colorForClass(App.Brush.classId);
    App.cursorCtx.strokeStyle = col;
    App.cursorCtx.beginPath();
    App.cursorCtx.arc(x, y, r, 0, Math.PI * 2);
    App.cursorCtx.stroke();
    App.cursorCtx.restore();
  }
  function bindCursor() {
    App.map.on("mousemove", (e) => {
      const pt = App.map.latLngToContainerPoint(e.latlng);
      drawCursor(pt.x, pt.y);
    });
    App.map.on("mouseout", clearCursor);
  }

  // ---- Painting ----
  let painting = false;

  function getXY(e, cnv) {
    const r = cnv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function paintCircleFull(ix, iy, rI, erase, classId) {
    App.fullMaskCtx.save();
    if (erase || classId === 0) {
      App.fullMaskCtx.globalCompositeOperation = "destination-out";
      App.fullMaskCtx.fillStyle = "rgba(0,0,0,1)";
    } else {
      App.fullMaskCtx.globalCompositeOperation = "source-over";
      App.fullMaskCtx.fillStyle = App.colorForClass(classId);
    }
    App.fullMaskCtx.beginPath();
    App.fullMaskCtx.arc(ix, iy, rI, 0, Math.PI * 2);
    App.fullMaskCtx.fill();
    App.fullMaskCtx.restore();

    const w = App.imgW, h = App.imgH;
    const r2 = rI * rI;
    const x0 = Math.max(0, ix - rI), x1 = Math.min(w - 1, ix + rI);
    const y0 = Math.max(0, iy - rI), y1 = Math.min(h - 1, iy + rI);
    const cls = (erase ? 0 : (classId | 0)) & 0xff;

    for (let y = y0; y <= y1; y++) {
      const dy = y - iy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - ix;
        if (dx * dx + dy * dy <= r2) {
          App.fullMaskClass[y * w + x] = cls;
        }
      }
    }
  }

  function dabAtScreenAndFull(cx, cy) {
    if (!App.fullMaskCtx) return;
    const p = containerToImageXY(cx, cy);
    if (!p) return;
    const rScreen = Math.max(1, App.Brush.size * 0.5);
    const rI = screenRadiusToImageRadius(cx, cy, rScreen);
    paintCircleFull(p.ix, p.iy, rI, App.ERASE, App.Brush.classId);
    App.redrawMaskToScreen();
    if (typeof App.onAfterStroke === "function") App.onAfterStroke();
  }

  function bindPainting() {
    const CNV = App.maskCanvas;
    if (!CNV) { err("paint:no-canvas"); return; }

    CNV.style.pointerEvents = "none";

    CNV.addEventListener("mousedown", (e) => {
      if (App.MODE !== "brush") return;
      if (CNV.style.pointerEvents !== "auto") { return; }
      e.preventDefault(); e.stopPropagation();
      painting = true;
      try { App.map.dragging.disable(); } catch { }
      const [cx, cy] = getXY(e, CNV);
      dabAtScreenAndFull(cx, cy);
    });

    CNV.addEventListener("mousemove", (e) => {
      if (App.MODE !== "brush" || !painting) return;
      const [cx, cy] = getXY(e, CNV);
      dabAtScreenAndFull(cx, cy);
    });

    window.addEventListener("mouseup", () => {
      if (!painting) return;
      painting = false;
      try { App.map.dragging.enable(); } catch { }
    });
  }

  // ---- Layers / polygons (helpers kept) ----
  App.addGeoJSONLayer = function (feat, layer) {
    layer._props = { ...(feat?.properties || {}) };
    try { layer.setStyle?.({ color: "#22c55e", weight: 2 }); } catch { }
    layer.on?.("click", () => {
      App.selectLayer(layer);
      try { App.map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 19 }); } catch { }
    });
    try { App.drawnFG.addLayer(layer); } catch { }
    App.layers.push(layer);
  };

  App.layerUid = function (layer) {
    return layer?._props?.uid || layer?.feature?.properties?.uid || String(layer?._leaflet_id || "");
  };

  App.selectLayer = function (layer) {
    if (!layer) return;
    if (App.selectedLayer && App.selectedLayer !== layer) {
      try { App.selectedLayer.setStyle({ weight: 2, color: "#22c55e" }); } catch { }
    }
    App.selectedLayer = layer;
    try { App.selectedLayer.setStyle({ weight: 3, color: "#4f46e5" }); } catch { }
    try { if (typeof App.onLayerSelected === "function") App.onLayerSelected(layer); } catch (e) { warn("onLayerSelected:error", e); }
  };

  function buildClassMaskBuffer() {
    return App.fullMaskClass ? App.fullMaskClass : new Uint8Array(App.imgW * App.imgH);
  }

  App.saveMask = async function () {
    if (!App.fullMaskClass || !App.imgW || !App.imgH) {
      alert("Mask not ready");
      return;
    }
    try {
      const buf = buildClassMaskBuffer();
      const r = await fetch("/api/save_mask", { method: "POST", body: buf });
      if (!r.ok) throw new Error("HTTP " + r.status);
      alert("Mask saved.");
    } catch (e) {
      alert("Save failed: " + e);
    }
  };

  App.clearMask = function () {
    if (App.fullMaskCtx && App.imgW && App.imgH) {
      App.fullMaskCtx.clearRect(0, 0, App.imgW, App.imgH);
    }
    if (App.fullMaskClass) App.fullMaskClass.fill(0);
    App.redrawMaskToScreen();
  };

  App.setScene = function ({ sceneId, bounds }) {
    App.sceneId = sceneId || App.sceneId;
    if (bounds) {
      const b = L.latLngBounds([bounds.lat_min, bounds.lon_min], [bounds.lat_max, bounds.lon_max]);
      App.sceneBounds = b;
      try {
        App.map.fitBounds(b.pad(0.05));
        App.map.setMaxBounds(b.pad(0.10));
        App.map.options.maxBoundsViscosity = 1.0;
      } catch { }
    }
    App.buildGrid(App.grid.rows, App.grid.cols);
    App.setActiveTile(0, 0, { fit: true });
  };

  // ---- Init (does tiles bootstrap if needed) ----
  App.init = async function ({
    mapId = "map",
    maskId = "maskCanvas",
    cursorId = "cursorCanvas",
    overlayBoundsURL = "/api/s2_bounds_wgs84",
    gridRows = 3,
    gridCols = 3,
    sceneId = null,
    autoPickVisibleTile = false, // ثابت نگه داشتن تایل پیش‌فرض
    autoFollowTiles = false      // با پن/زوم تایل عوض نشود
  } = {}) {
    App.grid.rows = gridRows | 0;
    App.grid.cols = gridCols | 0;

    createMap(mapId);

    // ensure we have a scene id and built tiles for it
    await ensureSceneId(sceneId);
    if (!App.sceneId) throw new Error("no scene selected yet");

    let ok = await tilesExist(App.sceneId);
    if (!ok) {
      log("init:tiles missing; building via /api/scenes/select");
      await buildTiles(App.sceneId);
      ok = await tilesExist(App.sceneId);
      if (!ok) throw new Error("tiles still missing after build");
    }

    App.grid.autoFollow = !!autoFollowTiles;

    // now load bounds (for grid bounds on map), alloc mask, attach canvases
    await loadSceneOverlay(overlayBoundsURL);
    await allocFullResMask();
    attachCanvases(maskId, cursorId);

    if (autoPickVisibleTile) { try { updateActiveTileOverlay(); } catch { } }
    else { App.setActiveTile(0, 0, { fit: true }); }

    App.setMode("pan");
  };

  App.setMode = function (mode) {
    const isBrush = (mode === "brush");
    App.MODE = isBrush ? "brush" : "pan";
    if (App.maskCanvas) App.maskCanvas.style.pointerEvents = isBrush ? "auto" : "none";
    try { isBrush ? App.map.dragging.disable() : App.map.dragging.enable(); } catch { }
  };

  App.setBrushSize = (px) => {
    App.Brush.size = Math.max(2, Math.min(256, parseInt(px || 24, 10)));
    if (App._lastCursor) drawCursor(App._lastCursor.x, App._lastCursor.y);
  };

  App.setErase = (on) => { App.ERASE = !!on; };

  App.setBrushClass = (cid) => {
    const n = parseInt(cid, 10);
    if (!Number.isFinite(n)) return;
    App.Brush.classId = n;
  };

  App._diag = () => {
    const pe = App.maskCanvas?.style.pointerEvents;
    const drag = App.map?.dragging?.enabled?.();
    const have = { mask: !!App.maskCanvas, cursor: !!App.cursorCanvas, full: !!App.fullMaskCanvas, classBuf: !!App.fullMaskClass };
    const meta = { imgW: App.imgW, imgH: App.imgH, bounds: App.boundsRaw, grid: { rows: App.grid.rows, cols: App.grid.cols, active: App.grid.active } };
    console.table({ MODE: App.MODE, ERASE: App.ERASE, pointerEvents: pe, dragging: drag, ...have, ...meta });
    return { MODE: App.MODE, ERASE: App.ERASE, pointerEvents: pe, dragging: drag, have, meta };
  };
  App._setDebug = (on) => { DBG = !!on; console.log("[BRUSH:core] debug =", DBG); };

  // ---- Keyboard shortcuts ----
  window.addEventListener("keydown", (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target?.tagName || '').toUpperCase())) return;

    if (!e.altKey && /^[0-9]$/.test(e.key)) {
      const cid = (e.key === "0") ? 0 : parseInt(e.key, 10);
      App.setBrushClass(cid);
      return;
    }

    if (e.key === "b" || e.key === "B") {
      App.setMode("brush");
    } else if (e.key === "v" || e.key === "V") {
      App.setMode("pan");
    } else if (e.key === "e" || e.key === "E") {
      App.setErase(!App.ERASE);
    } else if (e.key === "[") {
      App.setBrushSize(App.Brush.size - 1);
    } else if (e.key === "]") {
      App.setBrushSize(App.Brush.size + 1);
    } else if (e.key === "ArrowLeft") {
      App.moveTile(0, -1, { wrap: true, fit: false });
    } else if (e.key === "ArrowRight") {
      App.moveTile(0, +1, { wrap: true, fit: false });
    } else if (e.key === "ArrowUp") {
      App.moveTile(-1, 0, { wrap: true, fit: false });
    } else if (e.key === "ArrowDown") {
      App.moveTile(+1, 0, { wrap: true, fit: false });
    } else if (e.altKey && /^[1-9]$/.test(e.key)) {
      App.setTileByNumber(parseInt(e.key, 10), { fit: false });
    }
  });

  // ---- Mask redraw to screen ----
  App.redrawMaskToScreen = function () {
    if (!App.map || !App.maskCtx || !App.fullMaskCanvas || !App.sceneBounds) return;
    if (!App.map._loaded) return;

    const w = App.maskCanvas.width / App.DPR;
    const h = App.maskCanvas.height / App.DPR;

    const lt = L.latLng(App.sceneBounds.getNorth(), App.sceneBounds.getWest());
    const rb = L.latLng(App.sceneBounds.getSouth(), App.sceneBounds.getEast());
    const ptLT = App.map.latLngToContainerPoint(lt);
    const ptRB = App.map.latLngToContainerPoint(rb);
    const left = ptLT.x, top = ptLT.y, right = ptRB.x, bottom = ptRB.y;

    const dx0 = Math.max(0, Math.min(w, left));
    const dy0 = Math.max(0, Math.min(h, top));
    const dx1 = Math.max(0, Math.min(w, right));
    const dy1 = Math.max(0, Math.min(h, bottom));
    const dw = dx1 - dx0;
    const dh = dy1 - dy0;

    const ctx = App.maskCtx;
    ctx.save();
    ctx.clearRect(0, 0, w, h);

    if (dw > 0 && dh > 0) {
      const overlayW = (right - left);
      const overlayH = (bottom - top);

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
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 1.0;
        ctx.drawImage(App.fullMaskCanvas, sx, sy, sw, sh, dx0, dy0, dw, dh);
      }
    }

    ctx.restore();
  };

})();