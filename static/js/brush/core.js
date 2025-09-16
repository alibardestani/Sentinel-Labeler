// static/js/brush/core.js
console.log("[BRUSH:core] loaded");

;(function () {
  let DBG = true;
  const log  = (...a) => DBG && console.debug("[BRUSH:core]", ...a);
  const warn = (...a) => DBG && console.warn ("[BRUSH:core]", ...a);
  const err  = (...a) => DBG && console.error("[BRUSH:core]", ...a);
  const $ = (id) => document.getElementById(id);

  // ---- global error logs ----
  window.addEventListener("error", (e) => err("window.error", e?.message, e?.error));
  window.addEventListener("unhandledrejection", (e) => err("unhandledrejection", e?.reason));

  // ---- App state ----
  const App = {
    // Leaflet
    map: null, overlay: null, sceneBounds: null, boundsRaw: null,
    drawnFG: null, layers: [], selectedLayer: null,

    // canvases
    maskCanvas: null, maskCtx: null,
    cursorCanvas: null, cursorCtx: null,

    // full-res mask (offscreen)
    fullMaskCanvas: null, fullMaskCtx: null, imgW: 0, imgH: 0,
    fullMaskClass: null, // Uint8Array(w*h) — class id per pixel

    // brush state
    DPR: Math.max(1, window.devicePixelRatio || 1),
    MODE: "pan",
    ERASE: false,
    Brush: { size: 24, classId: 1 },

    // cache
    _lastCursor: null,
  };

  // ---- Palette (can be overridden by window.BRUSH_PALETTE before this script) ----
  const DEFAULT_PALETTE = {
    0: { name: "Background", color: "#00000000" }, // transparent => erase
    1: { name: "گردو",       color: "#00ff00ff" }, // green
    2: { name: "پسته",       color: "#ffa500ff" }, // orange
    3: { name: "نخیلات",     color: "#ffff00ff" }, // yellow
  };
  App.PALETTE = (window.BRUSH_PALETTE || DEFAULT_PALETTE);

  function hex8ToRgba(hex8) {
    const h = (hex8 || "").replace("#", "");
    if (h.length !== 8) return "rgba(0,255,0,1)"; // fallback
    const r = parseInt(h.slice(0,2),16);
    const g = parseInt(h.slice(2,4),16);
    const b = parseInt(h.slice(4,6),16);
    const a = parseInt(h.slice(6,8),16) / 255;
    return `rgba(${r},${g},${b},${a})`;
  }
  App.colorForClass = (cid) => {
    const ent = App.PALETTE[cid] || { color: "#00ff00ff" };
    return hex8ToRgba(ent.color);
  };

  // ---- Drawing: screen refresh from full-res ----
  App.redrawMaskToScreen = function () {
    if (!App.map || !App.maskCtx || !App.fullMaskCanvas || !App.sceneBounds) return;
    if (!App.map._loaded) { log("redraw:skip:not-loaded"); return; }

    const w = App.maskCanvas.width / App.DPR;
    const h = App.maskCanvas.height / App.DPR;

    // overlay rect in container px
    const lt = L.latLng(App.sceneBounds.getNorth(), App.sceneBounds.getWest());
    const rb = L.latLng(App.sceneBounds.getSouth(), App.sceneBounds.getEast());
    const ptLT = App.map.latLngToContainerPoint(lt);
    const ptRB = App.map.latLngToContainerPoint(rb);
    const left = ptLT.x, top = ptLT.y, right = ptRB.x, bottom = ptRB.y;

    // intersect with canvas
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

      const sx  = Math.max(0, Math.floor(fx0 * App.imgW));
      const sy  = Math.max(0, Math.floor(fy0 * App.imgH));
      const sx1 = Math.min(App.imgW, Math.ceil(fx1 * App.imgW));
      const sy1 = Math.min(App.imgH, Math.ceil(fy1 * App.imgH));
      const sw  = Math.max(0, sx1 - sx);
      const sh  = Math.max(0, sy1 - sy);

      if (sw > 0 && sh > 0) {
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 1.0;
        ctx.drawImage(App.fullMaskCanvas, sx, sy, sw, sh, dx0, dy0, dw, dh);
      }
    }

    ctx.restore();
  };

  // ---- Map & overlay ----
  function createMap(mapId) {
    log("createMap:start", { mapId });
    const map = L.map(mapId, { zoomControl: true, preferCanvas: true, maxZoom: 19 });
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri", maxNativeZoom: 19, maxZoom: 19, detectRetina: true }
    ).addTo(map);

    const drawn = new L.FeatureGroup();
    map.addLayer(drawn);

    App.map = map;
    App.drawnFG = drawn;

    map.on("resize", () => { log("map:resize"); sizeCanvases(); });
    map.on("move zoom", () => {
      log("map:move/zoom", { mode: App.MODE, draggingEnabled: !!App.map.dragging.enabled() });
      App.redrawMaskToScreen();
      if (App._lastCursor) drawCursor(App._lastCursor.x, App._lastCursor.y);
    });
    map.whenReady(() => {
      log("map:ready");
      try { App.redrawMaskToScreen(); } catch {}
    });

    log("createMap:done");
  }

  async function loadSceneOverlay(urlBounds, urlImage) {
    log("overlay:load:start", { urlBounds, urlImage });
    const rb = await fetch(urlBounds, { cache: "no-store" });
    if (!rb.ok) { err("overlay:bounds:http", rb.status); throw new Error("s2 bounds http"); }
    const b = await rb.json(); App.boundsRaw = b;
    App.sceneBounds = L.latLngBounds([b.lat_min, b.lon_min], [b.lat_max, b.lon_max]);

    try { App.map.fitBounds(App.sceneBounds.pad(0.05), { maxZoom: 19 }); } catch {}

    if (App.overlay) App.map.removeLayer(App.overlay);
    const url = urlImage + "?t=" + Date.now();
    App.overlay = L.imageOverlay(url, App.sceneBounds, { opacity: 0.6, crossOrigin: true }).addTo(App.map);

    App.overlay.once("load", () => {
      log("overlay:image:load", { url });
      try {
        App.map.fitBounds(App.sceneBounds.pad(0.05), { maxZoom: 19 });
        App.map.setMaxBounds(App.sceneBounds.pad(0.10));
        App.map.options.maxBoundsViscosity = 1.0;
      } catch (e) { warn("overlay:fitBounds:error", e); }
    });
    App.overlay.once("error", (e) => warn("overlay:image:error", e));
  }

  // ---- Full-res alloc ----
  async function allocFullResMask() {
    log("fullMask:alloc:start");
    const r = await fetch("/api/backdrop_meta", { cache: "no-store" });
    if (!r.ok) { err("backdrop_meta:http", r.status); throw new Error("backdrop_meta"); }
    const j = await r.json();

    const w = +j.width, h = +j.height;
    App.imgW = Number.isFinite(w) ? w : 0;
    App.imgH = Number.isFinite(h) ? h : 0;
    log("fullMask:meta", { imgW: App.imgW, imgH: App.imgH });
    if (!App.imgW || !App.imgH) { throw new Error("invalid backdrop size"); }

    const cnv = document.createElement("canvas");
    cnv.width = App.imgW; cnv.height = App.imgH;
    const ctx = cnv.getContext("2d", { willReadFrequently: true });

    // initialize: clear & class buffer
    ctx.clearRect(0, 0, App.imgW, App.imgH);
    App.fullMaskCanvas = cnv;
    App.fullMaskCtx = ctx;
    App.fullMaskClass = new Uint8Array(App.imgW * App.imgH); // all zeros

    log("fullMask:alloc:done");
  }

  // ---- Screen canvases ----
  function attachCanvases(maskId, cursorId) {
    App.maskCanvas = $(maskId);
    App.cursorCanvas = $(cursorId);
    if (!App.maskCanvas || !App.cursorCanvas) {
      err("canvas:not-found", { maskFound: !!App.maskCanvas, cursorFound: !!App.cursorCanvas });
      throw new Error("maskCanvas / cursorCanvas missing");
    }
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
      cnv.width  = Math.round(sz.x * App.DPR);
      cnv.height = Math.round(sz.y * App.DPR);
      cnv.style.width  = sz.x + "px";
      cnv.style.height = sz.y + "px";
      cnv.getContext("2d").setTransform(App.DPR, 0, 0, App.DPR, 0, 0);
    });
    clearCursor();
    log("canvas:sized", { w: sz.x, h: sz.y, DPR: App.DPR, pointerEvents: App.maskCanvas?.style.pointerEvents });
    if (App.map && App.map._loaded) App.redrawMaskToScreen();
  }

  // ---- Coord conversions ----
  function containerToImageXY(cx, cy) {
    if (!App.sceneBounds || !App.imgW || !App.imgH) { warn("toImage:no-bounds-or-size"); return null; }

    const lt   = L.latLng(App.sceneBounds.getNorth(), App.sceneBounds.getWest());
    const rb   = L.latLng(App.sceneBounds.getSouth(), App.sceneBounds.getEast());
    const ptLT = App.map.latLngToContainerPoint(lt);
    const ptRB = App.map.latLngToContainerPoint(rb);

    const left = ptLT.x, top = ptLT.y, right = ptRB.x, bottom = ptRB.y;
    const wScr = right - left, hScr = bottom - top;
    if (wScr <= 0 || hScr <= 0) { warn("toImage:invalid overlay rect"); return null; }

    const fx = (cx - left) / wScr;
    const fy = (cy - top)  / hScr;

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
    // 1) draw to full-res canvas
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

    // 2) update class buffer
    const w = App.imgW, h = App.imgH;
    const r2 = rI * rI;
    const x0 = Math.max(0, ix - rI), x1 = Math.min(w - 1, ix + rI);
    const y0 = Math.max(0, iy - rI), y1 = Math.min(h - 1, iy + rI);
    const cls = (erase ? 0 : (classId | 0)) & 0xff;

    for (let y = y0; y <= y1; y++) {
      const dy = y - iy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - ix;
        if (dx*dx + dy*dy <= r2) {
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
    log("paint:bind", { pointerEvents: CNV.style.pointerEvents });

    CNV.addEventListener("mousedown", (e) => {
      if (App.MODE !== "brush") return;
      if (CNV.style.pointerEvents !== "auto") { warn("paint:block:pointer-events", CNV.style.pointerEvents); return; }
      e.preventDefault(); e.stopPropagation();
      painting = true;
      try { App.map.dragging.disable(); } catch {}
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
      try { App.map.dragging.enable(); } catch {}
    });
  }

  // ---- Polygons (minimal helpers; safe no-ops if unused) ----
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

  App.layerUid = function (layer) {
    return layer?._props?.uid || layer?.feature?.properties?.uid || String(layer?._leaflet_id || "");
  };

  App.selectLayer = function (layer) {
    if (!layer) return;
    if (App.selectedLayer && App.selectedLayer !== layer) {
      try { App.selectedLayer.setStyle({ weight: 2, color: "#22c55e" }); } catch {}
    }
    App.selectedLayer = layer;
    try { App.selectedLayer.setStyle({ weight: 3, color: "#4f46e5" }); } catch {}
    log("poly:selected", { uid: App.layerUid(layer) });

    try { if (typeof App.onLayerSelected === "function") App.onLayerSelected(layer); } catch (e) { warn("onLayerSelected:error", e); }
  };

  // ---- Save / Clear (class-aware) ----
  function buildClassMaskBuffer() {
    return App.fullMaskClass ? App.fullMaskClass : new Uint8Array(App.imgW * App.imgH);
  }

  App.saveMask = async function () {
    if (!App.fullMaskClass || !App.imgW || !App.imgH) {
      warn("saveMask:not-ready", { hasClassBuf: !!App.fullMaskClass, w: App.imgW, h: App.imgH });
      alert("Mask not ready");
      return;
    }
    try {
      const buf = buildClassMaskBuffer();
      const r = await fetch("/api/save_mask", { method: "POST", body: buf });
      if (!r.ok) throw new Error("HTTP " + r.status);
      alert("Mask saved.");
    } catch (e) {
      err("saveMask:error", e);
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

  // ---- Public API ----
  App.init = async function ({
    mapId = "map",
    maskId = "maskCanvas",
    cursorId = "cursorCanvas",
    overlayBoundsURL = "/api/s2_bounds_wgs84",
    overlayImageURL = "/api/output/rgb_quicklook.png",
  } = {}) {
    log("init:start");
    createMap(mapId);
    await loadSceneOverlay(overlayBoundsURL, overlayImageURL);
    await allocFullResMask();
    attachCanvases(maskId, cursorId);
    App.setMode("pan");
    log("init:done");
  };

  App.setMode = function (mode) {
    const isBrush = (mode === "brush");
    App.MODE = isBrush ? "brush" : "pan";
    if (App.maskCanvas) App.maskCanvas.style.pointerEvents = isBrush ? "auto" : "none";
    try { isBrush ? App.map.dragging.disable() : App.map.dragging.enable(); } catch {}
    log("mode:set", { mode: App.MODE, pointerEvents: App.maskCanvas?.style.pointerEvents, dragging: App.map?.dragging?.enabled?.() });
  };

  App.setBrushSize = (px) => {
    App.Brush.size = Math.max(2, Math.min(256, parseInt(px || 24, 10)));
    log("brush:size", App.Brush.size);
  };

  App.setErase = (on) => {
    App.ERASE = !!on;
    log("brush:erase", App.ERASE);
  };

  App.setBrushClass = (cid) => {
    const n = parseInt(cid, 10);
    if (!Number.isFinite(n)) return;
    App.Brush.classId = n;
    const name = App.PALETTE[n]?.name || "";
    log("brush:class", { id: n, name });
  };

  App._diag = () => {
    const pe = App.maskCanvas?.style.pointerEvents;
    const drag = App.map?.dragging?.enabled?.();
    const have = { mask: !!App.maskCanvas, cursor: !!App.cursorCanvas, full: !!App.fullMaskCanvas, classBuf: !!App.fullMaskClass };
    const meta = { imgW: App.imgW, imgH: App.imgH, bounds: App.boundsRaw };
    console.table({ MODE: App.MODE, ERASE: App.ERASE, pointerEvents: pe, dragging: drag, ...have, ...meta });
    return { MODE: App.MODE, ERASE: App.ERASE, pointerEvents: pe, dragging: drag, have, meta };
  };
  App._setDebug = (on) => { DBG = !!on; console.log("[BRUSH:core] debug =", DBG); };

  // ---- Keyboard shortcuts ----
  window.addEventListener("keydown", (e) => {
    // class switch 0..9
    if (/^[0-9]$/.test(e.key)) {
      const cid = (e.key === "0") ? 0 : parseInt(e.key, 10);
      App.setBrushClass(cid);
    } else if (e.key === "b" || e.key === "B") {
      App.setMode("brush");
    } else if (e.key === "v" || e.key === "V") {
      App.setMode("pan");
    } else if (e.key === "e" || e.key === "E") {
      App.setErase(!App.ERASE);
    } else if (e.key === "[") {
      App.setBrushSize(App.Brush.size - 1);
      if (App._lastCursor) drawCursor(App._lastCursor.x, App._lastCursor.y);
    } else if (e.key === "]") {
      App.setBrushSize(App.Brush.size + 1);
      if (App._lastCursor) drawCursor(App._lastCursor.x, App._lastCursor.y);
    }
  });

  window.BrushApp = App;
})();


