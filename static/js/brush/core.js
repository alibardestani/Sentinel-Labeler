// static/js/brush/core.js
console.log("[BRUSH:core] loaded");

;(() => {
  // جلوگیری از دوبار لود
  if (window.BrushApp && window.BrushApp.__coreLoaded) {
    console.warn("[BRUSH:core] already loaded; skipping duplicate load");
    return;
  }

  let DBG = true;
  const log  = (...a) => DBG && console.debug("[BRUSH:core]", ...a);
  const warn = (...a) => DBG && console.warn ("[BRUSH:core]", ...a);
  const err  = (...a) => DBG && console.error("[BRUSH:core]", ...a);
  const $    = (id) => document.getElementById(id);

  // --- throttling helpers (rAF) ---
  const makeRafThrottle = (fn) => {
    let pend = false;
    return (...args) => {
      if (pend) return;
      pend = true;
      requestAnimationFrame(() => { pend = false; try { fn(...args); } catch (e) { err("raf:", e); } });
    };
  };

  window.addEventListener("error", (e) => err("window.error", e?.message, e?.error));
  window.addEventListener("unhandledrejection", (e) => err("unhandledrejection", e?.reason));

  // ---- App state ----
  const App = window.BrushApp || {};
  window.BrushApp = App;
  App.__coreLoaded = true;

  Object.assign(App, {
    // leaflet & layers
    map: null, overlay: null, sceneBounds: null, boundsRaw: null,
    drawnFG: null, layers: [], selectedLayer: null,

    // canvases (screen)
    maskCanvas: null, maskCtx: null,
    cursorCanvas: null, cursorCtx: null,

    // whole image meta
    imgW: 0, imgH: 0,

    // per-tile masks: tileMasks[r][c] = { cnv, ctx, w, h, classBuf }
    tileMasks: [],

    DPR: Math.max(1, window.devicePixelRatio || 1),
    MODE: "pan",
    ERASE: false,
    Brush: { size: 24, classId: 1 },

    grid: { rows: 3, cols: 3, tiles: [], active: { r: -1, c: -1 }, overlay: null, autoFollow: false },

    sceneId: null,
    _lastCursor: null,
    ready: false,
  });

  // ---- Palette ----
  const DEFAULT_PALETTE = {
    0: { name: "Background", color: "#00000000" },
    1: { name: "گردو",      color: "#00ff00ff" },
    2: { name: "پسته",      color: "#ffa500ff" },
    3: { name: "نخیلات",    color: "#ffff00ff" },
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

  // ---- Tiny tile-loading HUD ----
  function ensureTileLoader() {
    const host = $('#map') || document.body;
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
      host.appendChild(el);
    }
    return el;
  }
  App.setTileLoading = function (on) {
    const el = ensureTileLoader();
    el.style.display = on ? 'block' : 'none';
  };

  // ---- Map ----
  const _redrawOnMoveZoom = makeRafThrottle(() => {
    App.redrawMaskToScreen();
    if (App._lastCursor) drawCursor(App._lastCursor.x, App._lastCursor.y);
  });

  function createMap(mapId) {
    if (App.map && App.map._loaded) { log("createMap:reuse"); return App.map; }
    const el = document.getElementById(mapId);
    if (!el) throw new Error("map container not found: " + mapId);
    if (el._leaflet_id) { warn("createMap:container already initialized"); return App.map; }

    const map = L.map(mapId, { zoomControl: true, preferCanvas: true, maxZoom: 19 });
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri", maxNativeZoom: 19, maxZoom: 19, detectRetina: true }
    ).addTo(map);

    const drawn = new L.FeatureGroup();
    map.addLayer(drawn);

    App.map = map;
    App.drawnFG = drawn;

    map.on("resize", makeRafThrottle(sizeCanvases));
    map.on("move",  _redrawOnMoveZoom);
    map.on("zoom",  _redrawOnMoveZoom);

    map.whenReady(() => { try { App.redrawMaskToScreen(); } catch {} });

    return map;
  }

  // ---- Grid (geo bounds + pixel rect) ----
  App.buildGrid = function (rows = 3, cols = 3) {
    rows = rows|0; cols = cols|0;
    if (!App.sceneBounds) { warn('buildGrid: no sceneBounds'); return; }

    App.grid.rows = rows;
    App.grid.cols = cols;
    App.grid.tiles = [];

    const latMin = App.sceneBounds.getSouth();
    const latMax = App.sceneBounds.getNorth();
    const lonMin = App.sceneBounds.getWest();
    const lonMax = App.sceneBounds.getEast();
    const dLat = (latMax - latMin) / rows;
    const dLon = (lonMax - lonMin) / cols;

    const imgW = App.imgW|0, imgH = App.imgH|0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // دقت جهت‌ها: ردیف 0 در شمال، با کاهش عرض به جنوب می‌رویم
        const north = latMax - r * dLat;
        const south = latMax - (r + 1) * dLat;
        const west  = lonMin + c * dLon;
        const east  = lonMin + (c + 1) * dLon;

        const bounds = L.latLngBounds([south, west], [north, east]);

        // پیکسل رکت داخل تصویر
        const x0 = Math.floor((c / cols) * imgW);
        const x1 = Math.floor(((c + 1) / cols) * imgW);
        const y0 = Math.floor((r / rows) * imgH);
        const y1 = Math.floor(((r + 1) / rows) * imgH);
        const w  = Math.max(0, x1 - x0);
        const h  = Math.max(0, y1 - y0);

        App.grid.tiles.push({ r, c, bounds, px: { x0, y0, w, h } });
      }
    }
    log('buildGrid: done', { rows, cols });
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
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    if (!App.sceneId || !App.sceneBounds) return;

    const same = (App.grid.active.r === r && App.grid.active.c === c);
    const t = App.grid.tiles[r * cols + c];
    if (!t) return;

    // اگر همون تایل است و overlay داریم، فقط ری‌دروا
    if (same && App.grid.overlay) {
      App.redrawMaskToScreen();
      return;
    }

    App.grid.active = { r, c };

    const url = `/api/grid/tile?scene_id=${encodeURIComponent(App.sceneId)}&r=${r}&c=${c}&t=${Date.now()}`;

    // reuse overlay: setUrl + setBounds (کمترین هزینه)
    if (App.grid.overlay) {
      App.setTileLoading?.(true);
      try { App.grid.overlay.setBounds(t.bounds); } catch {}
      try {
        App.grid.overlay.setUrl(url);
        const img = App.grid.overlay.getElement && App.grid.overlay.getElement();
        if (img && img.complete) App.setTileLoading?.(false);
        else {
          App.grid.overlay.once?.('load',  () => App.setTileLoading?.(false));
          App.grid.overlay.once?.('error', () => { App.setTileLoading?.(false); alert('Failed to load tile'); });
        }
      } catch {
        App.setTileLoading?.(false);
      }
    } else {
      App.setTileLoading?.(true);
      const ov = L.imageOverlay(url, t.bounds, { opacity: 0.7, crossOrigin: true });
      App.grid.overlay = ov.addTo(App.map);
      ov.once?.('load',  () => App.setTileLoading?.(false));
      ov.once?.('error', () => { App.setTileLoading?.(false); alert('Failed to load tile'); });
      const img = ov.getElement && ov.getElement();
      if (img && img.complete) App.setTileLoading?.(false);
    }

    document.dispatchEvent(new CustomEvent('brush:tilechange', { detail: { r, c } }));

    if (fit) { try { App.map.fitBounds(t.bounds.pad(0.02), { maxZoom: 19 }); } catch {} }

    try {
      const el1 = $('hudTileRC'), el2 = $('hudTileRC2');
      if (el1) el1.textContent = `r${r + 1}×c${c + 1}`;
      if (el2) el2.textContent = `r${r + 1}×c${c + 1}`;
    } catch {}

    App.redrawMaskToScreen();
  };

  App.moveTile = function (dr, dc, { wrap = true, fit = false } = {}) {
    const rows = App.grid.rows, cols = App.grid.cols;
    let r = (App.grid.active.r >= 0) ? App.grid.active.r : 0;
    let c = (App.grid.active.c >= 0) ? App.grid.active.c : 0;
    r += dr; c += dc;
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

  const updateActiveTileOverlay = makeRafThrottle(() => {
    if (!App.grid.tiles.length) return;
    const best = pickVisibleTile();
    if (!best) return;
    App.setActiveTile(best.r, best.c, { fit: false });
  });

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

  // ---- Scene / tiles bootstrap ----
  async function ensureSceneId(providedId) {
    if (providedId) { App.sceneId = providedId; return providedId; }
    // اگر SceneStore هست، از کش استفاده کن
    try {
      if (window.SceneStore?.current) {
        const j = await window.SceneStore.current();
        App.sceneId = j?.scene?.id || null;
        return App.sceneId;
      }
    } catch (e) { /* fallthrough */ }

    try {
      const r = await fetch("/api/scenes/current", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      App.sceneId = j?.scene?.id || null;
    } catch (e) { warn("sceneId:auto:failed", e); App.sceneId = null; }
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
      let j = {}; try { j = await r.json(); } catch {}
      throw new Error("scenes/select http " + r.status + " " + (j?.error || ""));
    }
    return await r.json();
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
    } catch {}

    // overlay بک‌دراپ (اختیاری), اینجا کنترل نمی‌کنیم تا فقط تایل فعال نمایش داده شود
    if (App.overlay) { try { App.map.removeLayer(App.overlay); } catch {} }
    App.overlay = null;
  }

  // ---- Allocate per-tile canvases (full resolution per tile) ----
  async function allocTileMasks() {
    const r = await fetch("/api/backdrop_meta", { cache: "no-store" });
    if (!r.ok) throw new Error("backdrop_meta http " + r.status);
    const j = await r.json();

    const w = +j.width, h = +j.height;
    const newW = Number.isFinite(w) ? w : 0;
    const newH = Number.isFinite(h) ? h : 0;
    if (!newW || !newH) throw new Error("invalid backdrop size");

    // اگر ابعاد تغییری نکرده، از ماسک‌های موجود استفاده کن
    const sameDims = (App.imgW === newW && App.imgH === newH && App.tileMasks?.length === App.grid.rows);
    App.imgW = newW; App.imgH = newH;

    // ساخت گرید با ابعاد پیکسلی
    App.buildGrid(App.grid.rows, App.grid.cols);

    if (sameDims) {
      log("allocTileMasks: reuse existing canvases");
      return;
    }

    // ایجاد بوم برای هر گرید (فراخوانی حداقلی)
    App.tileMasks = [];
    for (let rIdx = 0; rIdx < App.grid.rows; rIdx++) {
      const row = [];
      for (let cIdx = 0; cIdx < App.grid.cols; cIdx++) {
        const t = App.grid.tiles[rIdx * App.grid.cols + cIdx];
        const { w: tw, h: th } = t.px;
        const cnv = document.createElement("canvas");
        cnv.width = tw; cnv.height = th;
        const ctx = cnv.getContext("2d", { willReadFrequently: true });
        ctx.clearRect(0, 0, tw, th);
        const classBuf = new Uint8Array(tw * th);
        row.push({ cnv, ctx, w: tw, h: th, classBuf });
      }
      App.tileMasks.push(row);
    }
    log("allocTileMasks:new", { imgW: App.imgW, imgH: App.imgH, rows: App.grid.rows, cols: App.grid.cols });
  }

  // ---- Canvases ----
  const _sizeCanvasesRaf = makeRafThrottle(() => {
    if (!App.map) return;
    const sz = App.map.getSize();
    [App.maskCanvas, App.cursorCanvas].forEach(cnv => {
      if (!cnv) return;
      const ctx = cnv.getContext("2d");
      const w = Math.round(sz.x * App.DPR);
      const h = Math.round(sz.y * App.DPR);
      if (cnv.width !== w)   cnv.width  = w;
      if (cnv.height !== h)  cnv.height = h;
      cnv.style.width  = sz.x + "px";
      cnv.style.height = sz.y + "px";
      ctx.setTransform(App.DPR, 0, 0, App.DPR, 0, 0);
    });
    clearCursor();
    if (App.map && App.map._loaded) App.redrawMaskToScreen();
  });

  function attachCanvases(maskId, cursorId) {
    App.maskCanvas   = $(maskId);
    App.cursorCanvas = $(cursorId);
    if (!App.maskCanvas || !App.cursorCanvas) throw new Error("maskCanvas / cursorCanvas missing");
    App.maskCtx   = App.maskCanvas.getContext("2d");
    App.cursorCtx = App.cursorCanvas.getContext("2d");
    App.cursorCanvas.style.pointerEvents = "none";
    _sizeCanvasesRaf();
    bindPainting();
    bindCursor();
    if (App.map && App.map._loaded) App.redrawMaskToScreen();
  }

  function sizeCanvases() { _sizeCanvasesRaf(); }

  // ---- helpers (screen <-> active tile pixel) ----
  function activeTile() {
    const { r, c } = App.grid.active || { r: 0, c: 0 };
    return App.grid.tiles[r * App.grid.cols + c];
  }

  function containerToTileXY(cx, cy) {
    const t = activeTile();
    if (!t) return null;

    const lt = L.latLng(t.bounds.getNorth(), t.bounds.getWest());
    const rb = L.latLng(t.bounds.getSouth(), t.bounds.getEast());
    const ptLT = App.map.latLngToContainerPoint(lt);
    const ptRB = App.map.latLngToContainerPoint(rb);

    const left   = ptLT.x, top = ptLT.y;
    const right  = ptRB.x,  bottom = ptRB.y;
    const wScr   = right - left, hScr = bottom - top;
    if (wScr <= 0 || hScr <= 0) return null;
    if (cx < left || cx > right || cy < top || cy > bottom) return null;

    const fx = (cx - left) / wScr;
    const fy = (cy - top)  / hScr;

    const tm = App.tileMasks?.[App.grid.active.r]?.[App.grid.active.c];
    if (!tm) return null;

    const ix = Math.round(fx * (tm.w - 1));
    const iy = Math.round(fy * (tm.h - 1));
    const latlng = App.map.containerPointToLatLng([cx, cy]);
    return { ix, iy, fx, fy, lat: latlng?.lat, lng: latlng?.lng, scr: { left, top, right, bottom, wScr, hScr } };
  }

  function screenRadiusToTileRadius(cx, cy, rScreen) {
    const p0 = containerToTileXY(cx, cy);
    const p1 = containerToTileXY(cx + rScreen, cy);
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
    const onMove = makeRafThrottle((e) => {
      const pt = App.map.latLngToContainerPoint(e.latlng);
      drawCursor(pt.x, pt.y);
    });
    App.map.on("mousemove", onMove);
    App.map.on("mouseout", clearCursor);
  }

  // ---- Painting only on active tile ----
  let painting = false;
  function getXY(e, cnv) {
    const r = cnv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function paintCircleOnActive(ix, iy, rI, erase, classId) {
    const tm = App.tileMasks?.[App.grid.active.r]?.[App.grid.active.c];
    if (!tm) return;

    // draw color overlay
    tm.ctx.save();
    if (erase || classId === 0) {
      tm.ctx.globalCompositeOperation = "destination-out";
      tm.ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      tm.ctx.globalCompositeOperation = "source-over";
      tm.ctx.fillStyle = App.colorForClass(classId);
    }
    tm.ctx.beginPath();
    tm.ctx.arc(ix, iy, rI, 0, Math.PI * 2);
    tm.ctx.fill();
    tm.ctx.restore();

    // class buffer
    const w = tm.w, h = tm.h;
    const r2 = rI * rI;
    const x0 = Math.max(0, ix - rI), x1 = Math.min(w - 1, ix + rI);
    const y0 = Math.max(0, iy - rI), y1 = Math.min(h - 1, iy + rI);
    const cls = (erase ? 0 : (classId | 0)) & 0xff;

    for (let y = y0; y <= y1; y++) {
      const dy = y - iy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - ix;
        if (dx * dx + dy * dy <= r2) {
          tm.classBuf[y * w + x] = cls;
        }
      }
    }
  }

  const _dabRaf = makeRafThrottle((cx, cy) => {
    const p = containerToTileXY(cx, cy);
    if (!p) return;
    const rScreen = Math.max(1, App.Brush.size * 0.5);
    const rI = screenRadiusToTileRadius(cx, cy, rScreen);
    paintCircleOnActive(p.ix, p.iy, rI, App.ERASE, App.Brush.classId);
    App.redrawMaskToScreen();
    if (typeof App.onAfterStroke === "function") App.onAfterStroke();
  });

  function dabAtScreenAndTile(cx, cy) { _dabRaf(cx, cy); }

  function bindPainting() {
    const CNV = App.maskCanvas;
    if (!CNV) { err("paint:no-canvas"); return; }
    CNV.style.pointerEvents = "none";

    CNV.addEventListener("mousedown", (e) => {
      if (App.MODE !== "brush") return;
      if (CNV.style.pointerEvents !== "auto") return;
      e.preventDefault(); e.stopPropagation();
      painting = true;
      try { App.map.dragging.disable(); } catch {}
      const [cx, cy] = getXY(e, CNV);
      dabAtScreenAndTile(cx, cy);
    });

    CNV.addEventListener("mousemove", (e) => {
      if (App.MODE !== "brush" || !painting) return;
      const [cx, cy] = getXY(e, CNV);
      dabAtScreenAndTile(cx, cy);
    });

    window.addEventListener("mouseup", () => {
      if (!painting) return;
      painting = false;
      try { App.map.dragging.enable(); } catch {}
    }, { passive: true });
  }

  // ---- Layers / polygons (کمینه) ----
  App.addGeoJSONLayer = function (feat, layer) {
    layer._props = { ...(feat?.properties || {}) };
    try { layer.setStyle?.({ color: "#22c55e", weight: 2 }); } catch {}
    layer.on?.("click", () => {
      App.selectLayer(layer);
      try { App.map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 19 }); } catch {}
    });
    try { App.drawnFG.addLayer(layer); } catch {}
    App.layers.push(layer);
  };
  App.layerUid = (layer) =>
    layer?._props?.uid || layer?.feature?.properties?.uid || String(layer?._leaflet_id || "");
  App.selectLayer = function (layer) {
    if (!layer) return;
    if (App.selectedLayer && App.selectedLayer !== layer) {
      try { App.selectedLayer.setStyle({ weight: 2, color: "#22c55e" }); } catch {}
    }
    App.selectedLayer = layer;
    try { App.selectedLayer.setStyle({ weight: 3, color: "#4f46e5" }); } catch {}
    try { App.onLayerSelected?.(layer); } catch (e) { warn("onLayerSelected:error", e); }
  };

  // ---- Public helpers for IO.js ----
  App.localMaskToBlob = async function (mime = "image/png") {
    const tm = App.tileMasks?.[App.grid.active.r]?.[App.grid.active.c];
    if (!tm) return null;
    return await new Promise(res => tm.cnv.toBlob(res, mime, 1));
  };
  App.getLocalMaskBBox = function () {
    const t = activeTile();
    if (!t) return null;
    const { x0, y0, w, h } = t.px;
    return { x: x0, y: y0, w, h, r: App.grid.active.r, c: App.grid.active.c };
  };
  App.drawMaskImageToLocal = async function (blob) {
    const tm = App.tileMasks?.[App.grid.active.r]?.[App.grid.active.c];
    if (!tm) return;
    const bmp = await createImageBitmap(blob);
    const w = Math.min(tm.w, bmp.width), h = Math.min(tm.h, bmp.height);
    tm.ctx.drawImage(bmp, 0, 0, w, h, 0, 0, w, h);
    App.redrawMaskToScreen();
  };

  App.clearMask = function () {
    const tm = App.tileMasks?.[App.grid.active.r]?.[App.grid.active.c];
    if (tm) {
      tm.ctx.clearRect(0, 0, tm.w, tm.h);
      tm.classBuf.fill(0);
    }
    App.redrawMaskToScreen();
  };

  // (اختیاری) ذخیرهٔ باینری کلاس‌ماسک تایل
  App.saveMaskTileBinary = async function () {
    const tm = App.tileMasks?.[App.grid.active.r]?.[App.grid.active.c];
    if (!tm) { alert("Mask not ready"); return; }
    try {
      const params = new URLSearchParams({
        scene_id: App.sceneId || '',
        r: App.grid.active.r,
        c: App.grid.active.c
      });
      const r = await fetch(`/api/save_mask_tile?${params}`, { method: "POST", body: tm.classBuf });
      if (!r.ok) throw new Error("HTTP " + r.status);
      alert("Mask saved.");
    } catch (e) {
      alert("Save failed: " + e);
    }
  };

  // ---- Mask redraw (screen): only active tile ----
  App.redrawMaskToScreen = makeRafThrottle(() => {
    if (!App.map || !App.maskCtx || !App.sceneBounds) return;
    if (!App.map._loaded) return;

    const t  = activeTile();
    if (!t) return;
    const tm = App.tileMasks?.[App.grid.active.r]?.[App.grid.active.c];
    if (!tm) return;

    const lt = L.latLng(t.bounds.getNorth(), t.bounds.getWest());
    const rb = L.latLng(t.bounds.getSouth(), t.bounds.getEast());
    const ptLT = App.map.latLngToContainerPoint(lt);
    const ptRB = App.map.latLngToContainerPoint(rb);

    const left  = ptLT.x, top = ptLT.y, right = ptRB.x, bottom = ptRB.y;
    const wScr  = right - left, hScr = bottom - top;

    const w = App.maskCanvas.width / App.DPR;
    const h = App.maskCanvas.height / App.DPR;

    const ctx = App.maskCtx;
    ctx.save();
    ctx.clearRect(0, 0, w, h);

    if (wScr > 0 && hScr > 0) {
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 1.0;
      ctx.drawImage(tm.cnv, left, top, wScr, hScr);
    }
    ctx.restore();
  });

  // ---- Scene set (optional external call) ----
  App.setScene = function ({ sceneId, bounds }) {
    App.sceneId = sceneId || App.sceneId;
    if (bounds) {
      const b = L.latLngBounds([bounds.lat_min, bounds.lon_min], [bounds.lat_max, bounds.lon_max]);
      App.sceneBounds = b;
      try {
        App.map.fitBounds(b.pad(0.05));
        App.map.setMaxBounds(b.pad(0.10));
        App.map.options.maxBoundsViscosity = 1.0;
      } catch {}
    }
  };

  // ---- Init ----
  App.init = async function ({
    mapId = "map",
    maskId = "maskCanvas",
    cursorId = "cursorCanvas",
    overlayBoundsURL = "/api/s2_bounds_wgs84",
    gridRows = 3,
    gridCols = 3,
    sceneId = null,
    autoPickVisibleTile = false, // (فعلاً استفاده نمی‌کنیم)
    autoFollowTiles = false
  } = {}) {
    App.grid.rows = gridRows|0;
    App.grid.cols = gridCols|0;

    createMap(mapId);

    await ensureSceneId(sceneId);
    if (!App.sceneId) throw new Error("no scene selected yet");

    let ok = await tilesExist(App.sceneId);
    if (!ok) {
      log("init: tiles missing -> buildTiles");
      await buildTiles(App.sceneId);
      ok = await tilesExist(App.sceneId);
      if (!ok) throw new Error("tiles still missing after build");
    }

    await loadSceneOverlay(overlayBoundsURL);
    await allocTileMasks(); // ← بوم‌های فول‌رز تایل
    attachCanvases(maskId, cursorId);

    App.grid.autoFollow = !!autoFollowTiles;
    if (App.grid.autoFollow) {
      App.map.on("moveend", updateActiveTileOverlay);
      App.map.on("zoomend", updateActiveTileOverlay);
      updateActiveTileOverlay();
    } else {
      App.setActiveTile(0, 0, { fit: true });
    }

    App.setMode("pan");
    App.ready = true;
    window.dispatchEvent(new Event('brush:ready'));
  };

  App.setMode = function (mode) {
    const isBrush = (mode === "brush");
    App.MODE = isBrush ? "brush" : "pan";
    if (App.maskCanvas) App.maskCanvas.style.pointerEvents = isBrush ? "auto" : "none";
    try { isBrush ? App.map.dragging.disable() : App.map.dragging.enable(); } catch {}
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
    const have = { mask: !!App.maskCanvas, cursor: !!App.cursorCanvas, tiles: !!App.tileMasks?.length };
    const meta = { imgW: App.imgW, imgH: App.imgH, grid: { rows: App.grid.rows, cols: App.grid.cols, active: App.grid.active } };
    console.table({ MODE: App.MODE, ERASE: App.ERASE, pointerEvents: pe, dragging: drag, ...have, ...meta });
    return { MODE: App.MODE, ERASE: App.ERASE, pointerEvents: pe, dragging: drag, have, meta };
  };
  App._setDebug = (on) => { DBG = !!on; console.log("[BRUSH:core] debug =", DBG); };

  // ---- Keyboard ----
  window.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (!e.altKey && /^[0-9]$/.test(e.key)) {
      const cid = (e.key === "0") ? 0 : parseInt(e.key, 10);
      App.setBrushClass(cid); return;
    }
    if (e.key === "b" || e.key === "B") App.setMode("brush");
    else if (e.key === "v" || e.key === "V") App.setMode("pan");
    else if (e.key === "e" || e.key === "E") App.setErase(!App.ERASE);
    else if (e.key === "[") App.setBrushSize(App.Brush.size - 1);
    else if (e.key === "]") App.setBrushSize(App.Brush.size + 1);
    else if (e.key === "ArrowLeft")  App.moveTile(0, -1, { wrap: true, fit: false });
    else if (e.key === "ArrowRight") App.moveTile(0, +1, { wrap: true, fit: false });
    else if (e.key === "ArrowUp")    App.moveTile(-1, 0, { wrap: true, fit: false });
    else if (e.key === "ArrowDown")  App.moveTile(+1, 0, { wrap: true, fit: false });
    else if (e.altKey && /^[1-9]$/.test(e.key)) App.setTileByNumber(parseInt(e.key, 10), { fit: false });
  }, { passive: true });
})();