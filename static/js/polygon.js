// static/js/polygon.js
// ==================================
// Polygon labeling + mask editor
// ==================================

const DBG = true;
const dlog = (...a) => DBG && console.debug('[BRUSH]', ...a);
const derr = (...a) => DBG && console.error('[BRUSH]', ...a);

// ========== Diagnostics ==========
window.addEventListener('error', (e) => console.error('JS error:', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('Promise rejection:', e.reason));

// ========== Config ==========
const BASE_STEP = 1;
const MULT_FAST = 5;
const MULT_ULTRA = 10;
let BRUSH_ACTIVE = false;


// ========== Map + ESRI base ==========
const map = L.map('map', { zoomSnap: 1, zoomDelta: 1, keyboard: false });

function zoomBy(levels) {
  map.setZoom(map.getZoom() + levels, { animate: true });
}

L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Esri' }
).addTo(map);

// ========== Overlay (Sentinel quicklook) ==========
let overlay = null;
const slider = document.getElementById('overlayOpacity');
const lbl = document.getElementById('opacityValue');

function applyOpacityFromSlider() {
  if (!overlay || !slider) return;
  const v = (parseInt(slider.value, 10) || 0) / 100;
  overlay.setOpacity(v);
  lbl && (lbl.textContent = v.toFixed(2));
}
slider?.addEventListener('input', applyOpacityFromSlider);

// ========== Label UI helpers ==========
function getSelectedLabelLocal() {
  if (typeof window.getSelectedLabel === 'function') return window.getSelectedLabel();
  const sel = document.getElementById('polyLabelSelect');
  const custom = document.getElementById('polyLabelCustom');
  if (!sel) return '';
  const val = sel.value;
  return (val === '__custom__') ? (custom?.value || '').trim() : val;
}
function setLabelUIFromValue(val) {
  const sel = document.getElementById('polyLabelSelect');
  const customWrap = document.getElementById('customLabelWrap');
  const inp = document.getElementById('polyLabelCustom');
  if (!sel || !customWrap || !inp) return;
  const opts = Array.from(sel.options).map(o => o.value);
  if (val && opts.includes(val)) { sel.value = val; customWrap.style.display = 'none'; inp.value = ''; }
  else if (val && val !== '') { sel.value = '__custom__'; customWrap.style.display = 'block'; inp.value = val; }
  else { sel.value = ''; customWrap.style.display = 'none'; inp.value = ''; }
}

// ========== Scene meta (bounds + backdrop size) ==========
let SCENE_BOUNDS = null;   // {lat_min, lat_max, lon_min, lon_max}
let BACKDROP_SIZE = null;  // [W, H]

async function fetchSceneMetaIfNeeded() {
  if (!SCENE_BOUNDS) {
    const r = await fetch('/api/s2_bounds_wgs84', { cache: 'no-store' });
    if (r.ok) SCENE_BOUNDS = await r.json();
  }
  if (!BACKDROP_SIZE) {
    const im = new Image();
    await new Promise(res => { im.onload = res; im.src = '/api/output/rgb_quicklook.png?t=' + Date.now(); });
    BACKDROP_SIZE = [im.naturalWidth, im.naturalHeight];
  }
}
function latlngToImgPx(lat, lon) {
  if (!SCENE_BOUNDS || !BACKDROP_SIZE) return null;
  const [W, H] = BACKDROP_SIZE;
  const { lat_min, lat_max, lon_min, lon_max } = SCENE_BOUNDS;
  const x = ((lon - lon_min) / (lon_max - lon_min)) * W;
  const y = (1 - (lat - lat_min) / (lat_max - lat_min)) * H;
  return [x, y];
}

const backdropCanvas = document.getElementById('backdrop');
// ========== Mask editor (canvases) ==========
const maskCanvas = document.getElementById('maskCanvas');
const cursorCanvas = document.getElementById('cursorCanvas');
const maskCtx = maskCanvas.getContext('2d');
const cursorCtx = cursorCanvas.getContext('2d');
const DPR = Math.max(1, window.devicePixelRatio || 1);

L.DomEvent.disableClickPropagation(maskCanvas);
L.DomEvent.disableScrollPropagation(maskCanvas);

function resizeCanvasToMap() {
  const size = map.getSize();               // {x, y} in CSS px
  [maskCanvas, cursorCanvas].forEach(cnv => {
    // سایز رندر (پیکسلی واقعی)
    cnv.width = Math.round(size.x * DPR);
    cnv.height = Math.round(size.y * DPR);
    // سایز CSS
    cnv.style.width = size.x + 'px';
    cnv.style.height = size.y + 'px';
    // اصلاح ماتریس برای قلم sharp
    const ctx = cnv.getContext('2d');
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, cnv.width, cnv.height);
  });
  dlog('resizeCanvasToMap()', {
    mapSize: map.getSize(),
    maskSize: { w: maskCanvas.width, h: maskCanvas.height, cssW: maskCanvas.style.width, cssH: maskCanvas.style.height },
    cursorSize: { w: cursorCanvas.width, h: cursorCanvas.height }
  });
}

map.on('load zoom move resize', () => {
  resizeCanvasToMap();
  const sel = window.POLYCTX?.selectedLayer;
  dlog('map event', { BRUSH_ACTIVE, hasSel: !!sel });

  if (sel && BRUSH_ACTIVE) {
    maskCanvas.style.pointerEvents = 'auto';
    Brush.clipPath = buildClipPathFromLayer(sel);
    redrawClipOverlay();
  } else {
    maskCanvas.style.pointerEvents = 'none';
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  }
});
setTimeout(resizeCanvasToMap, 0);

function sizeCanvasToParent(cnv) {
  if (!cnv) return;
  const rect = cnv.parentElement.getBoundingClientRect();
  const cssW = Math.max(1, Math.floor(rect.width));
  const cssH = Math.max(1, Math.floor(rect.height));
  cnv.width = Math.floor(cssW * DPR);
  cnv.height = Math.floor(cssH * DPR);
  cnv.style.width = cssW + 'px';
  cnv.style.height = cssH + 'px';
  cnv.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0);
}
function resizeAll() {
  [backdropCanvas, maskCanvas, cursorCanvas].forEach(sizeCanvasToParent);
  drawBackdrop();
  try { map.invalidateSize(false); } catch { }
}
window.addEventListener('resize', resizeAll);

// بک‌دراپ
const backdropImg = new Image();
backdropImg.onload = drawBackdrop;
backdropImg.onerror = (e) => console.warn('Backdrop load failed', e);
backdropImg.src = '/api/output/rgb_quicklook.png?t=' + Date.now();

function drawBackdrop() {
  if (!backdropCanvas) return;
  const ctx = backdropCanvas.getContext('2d');
  const w = backdropCanvas.width / DPR, h = backdropCanvas.height / DPR;
  ctx.clearRect(0, 0, w, h);
  if (backdropImg.naturalWidth && w > 0 && h > 0) {
    ctx.drawImage(backdropImg, 0, 0, w, h);
  }
}

// ========== Brush state ==========
const Brush = { size: 16, hard: 1, mode: 'veg', clipPath: null };

function setBrushMode(m) {
  Brush.mode = m;
  // اگر دکمه‌ها داری، همین‌جا کلاس‌هاشون رو toggle کن
}

function getCanvasXYFromMouse(ev) {
  const r = maskCanvas.getBoundingClientRect();
  return [(ev.clientX - r.left), (ev.clientY - r.top)];
}

function buildClipPathFromLayer(layer) {
  dlog('buildClipPathFromLayer() start', { hasLayer: !!layer });
  const gj = layer?.toGeoJSON();
  const geom = gj?.geometry;
  if (!geom) { dlog('no geometry'); return null; }

  // یکبار offset حساب کن
  const mapRect = map.getContainer().getBoundingClientRect();
  const canvasRect = maskCanvas.getBoundingClientRect();
  const offX = canvasRect.left - mapRect.left;
  const offY = canvasRect.top - mapRect.top;

  const p = new Path2D();

  const addRing = (ring) => {
    ring.forEach(([lng, lat], i) => {
      const pt = map.latLngToContainerPoint([lat, lng]);
      const cx = pt.x - offX;
      const cy = pt.y - offY;
      if (i === 0) p.moveTo(cx, cy); else p.lineTo(cx, cy);
    });
    p.closePath();
  };

  if (geom.type === 'Polygon') {
    geom.coordinates.forEach(addRing);
  } else if (geom.type === 'MultiPolygon') {
    geom.coordinates.forEach(poly => poly.forEach(addRing));
  } else {
    dlog('unsupported geometry', { type: geom.type });
    return null;
  }

  dlog('clip path built', { offX, offY });

  // تست دیداری: یکبار دور کلیپ را قرمز بکش
  try {
    const w = cursorCanvas.width / DPR;
    const h = cursorCanvas.height / DPR;
    cursorCtx.save();
    cursorCtx.clearRect(0, 0, w, h);
    cursorCtx.setLineDash([6, 4]);
    cursorCtx.strokeStyle = 'red';
    cursorCtx.lineWidth = 2;
    cursorCtx.stroke(p);
    cursorCtx.restore();
  } catch (err) {
    derr('failed to draw debug clip outline', err);
  }

  return p;
}

function redrawClipOverlay() {
  const w = cursorCanvas.width / DPR, h = cursorCanvas.height / DPR;
  cursorCtx.clearRect(0, 0, w, h);
  if (!Brush.clipPath) return;

  cursorCtx.save();
  // dim بیرون
  cursorCtx.fillStyle = 'rgba(0,0,0,0.35)';
  cursorCtx.fillRect(0, 0, w, h);
  cursorCtx.globalCompositeOperation = 'destination-out';
  cursorCtx.fill(Brush.clipPath);
  cursorCtx.restore();

  // خط‌چین دور کلیپ
  cursorCtx.save();
  cursorCtx.setLineDash([6, 4]);
  cursorCtx.strokeStyle = 'rgba(80,160,255,.95)';
  cursorCtx.lineWidth = 1.5;
  cursorCtx.stroke(Brush.clipPath);
  cursorCtx.restore();
}


async function onPolygonSelectedForBrush(layer) {
  dlog('onPolygonSelectedForBrush()', { layerExists: !!layer });
  resizeCanvasToMap(); // اطمینان از sync بودن
  Brush.clipPath = buildClipPathFromLayer(layer);
  redrawClipOverlay();
  dlog('buildClipPathFromLayer()', { hasClip: !!Brush.clipPath });
}

const sizeEl = document.getElementById('brushSize');
const sizeVal = document.getElementById('brushSizeVal');
const hardEl = document.getElementById('brushHard');
const hardVal = document.getElementById('brushHardVal');
const modeVeg = document.getElementById('modeVeg');
const modeBg = document.getElementById('modeBg');
const clipChk = document.getElementById('clipToPoly');
const clearBtn = document.getElementById('clearMask');
const saveBtn = document.getElementById('saveMaskBtn');
const saveStat = document.getElementById('maskSaveStatus');

function setMode(m) {
  Brush.mode = m;
  modeVeg?.classList.toggle('primary', m === 'veg');
  modeBg?.classList.toggle('primary', m === 'bg');
}
modeVeg?.addEventListener('click', () => setMode('veg'));
modeBg?.addEventListener('click', () => setMode('bg'));
setMode('veg');

sizeEl?.addEventListener('input', () => {
  Brush.size = parseInt(sizeEl.value || '16', 10);
  sizeVal && (sizeVal.textContent = `${Brush.size} px`);
});
hardEl?.addEventListener('input', () => {
  Brush.hard = Math.max(0, Math.min(1, parseFloat(hardEl.value || '1')));
  hardVal && (hardVal.textContent = Brush.hard.toFixed(2));
});
sizeVal && (sizeVal.textContent = `${sizeEl?.value || 16} px`);
hardVal && (hardVal.textContent = (hardEl?.value || 1).toString());



// ========== Painting ==========
let painting = false, lastPt = null;

function getCanvasXY(ev) {
  const r = maskCanvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}
function drawDot(cx, cy) {
  dlog('drawDot()', { cx, cy, BRUSH_ACTIVE, hasClip: !!Brush.clipPath, mode: Brush.mode, canvasW: maskCanvas.width, canvasH: maskCanvas.height });
  if (!maskCtx) { derr('maskCtx missing'); return; }

  if (BRUSH_ACTIVE) {
    if (!Brush.clipPath) { dlog('skip: no clipPath while brush active'); return; }
    const inside = maskCtx.isPointInPath(Brush.clipPath, cx, cy);
    if (!inside) { dlog('skip: outside clipPath', { cx, cy }); return; }
  }

  const r = Brush.size * 0.5;

  if (Brush.mode === 'veg') {
    maskCtx.save();
    maskCtx.globalCompositeOperation = 'source-over';
    const g = maskCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(0,255,0,0.95)');
    g.addColorStop(Math.max(0, 1 - Brush.hard), 'rgba(0,255,0,0.95)');
    g.addColorStop(1, 'rgba(0,255,0,0.05)');
    maskCtx.fillStyle = g;
    maskCtx.beginPath();
    maskCtx.arc(cx, cy, r, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();
  } else {
    maskCtx.save();
    maskCtx.globalCompositeOperation = 'destination-out';
    maskCtx.beginPath();
    maskCtx.arc(cx, cy, r, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();

    if (cursorCtx) {
      cursorCtx.save();
      cursorCtx.strokeStyle = 'rgba(255,70,70,0.9)';
      cursorCtx.lineWidth = 1;
      cursorCtx.beginPath();
      cursorCtx.arc(cx, cy, r, 0, Math.PI * 2);
      cursorCtx.stroke();
      cursorCtx.restore();
    }
  }
  dlog('dot applied');
}

maskCanvas?.addEventListener('mousedown', (e) => {
  dlog('mousedown', { BRUSH_ACTIVE, hasClip: !!Brush.clipPath });
  if (!BRUSH_ACTIVE) return;

  // اگر کلیپ‌پث نداریم، از پولیگان انتخاب‌شده بساز
  if (!Brush.clipPath) {
    const sel = window.POLYCTX?.selectedLayer || null;
    if (sel) Brush.clipPath = buildClipPathFromLayer(sel);
    if (!Brush.clipPath) {
      alert('ابتدا یک پولیگان را انتخاب کنید.');
      return;
    }
  }

  e.preventDefault();
  e.stopPropagation();
  map.dragging.disable();
  painting = true;

  const [x, y] = getCanvasXYFromMouse(e);

  const inside = maskCtx.isPointInPath(Brush.clipPath, x, y);
  dlog('mousedown coords', { x, y, inside });

  if (!inside) return;

  drawDot(x, y);
  lastPt = [x, y];
});

maskCanvas?.addEventListener('mousemove', (e) => {
  console.count('mousemove');
  dlog('mousemove', { BRUSH_ACTIVE, painting });
  if (!BRUSH_ACTIVE) return;
  const [x, y] = getCanvasXYFromMouse(e);

  cursorCtx.clearRect(0, 0, cursorCanvas.width / DPR, cursorCanvas.height / DPR);
  if (Brush.clipPath) redrawClipOverlay();

  if (!painting) {
    cursorCtx.save();
    cursorCtx.strokeStyle = (Brush.mode === 'veg') ? 'rgba(0,255,0,0.9)' : 'rgba(255,70,70,0.9)';
    cursorCtx.lineWidth = 1;
    cursorCtx.beginPath();
    cursorCtx.arc(x, y, Brush.size * 0.5, 0, Math.PI * 2);
    cursorCtx.stroke();
    cursorCtx.restore();
    return;
  }

  if (lastPt) {
    const dx = x - lastPt[0], dy = y - lastPt[1];
    const steps = Math.ceil(Math.hypot(dx, dy) / (Brush.size * 0.35));
    for (let i = 1; i <= steps; i++) {
      const px = lastPt[0] + (dx * i) / steps;
      const py = lastPt[1] + (dy * i) / steps;
      drawDot(px, py);
    }
  } else {
    drawDot(x, y);
  }
  lastPt = [x, y];
  dlog('mousemove coords', { x, y });
});

window.addEventListener('mouseup', () => {
  dlog('mouseup', { wasPainting: painting });
  if (painting) {
    painting = false;
    lastPt = null;
    debouncedAutoSave();
  }
  map.dragging.enable();
  dlog('dragging re-enabled');
  // پاک کردن حلقهٔ راهنما
  cursorCtx.clearRect(0, 0, cursorCanvas.width / DPR, cursorCanvas.height / DPR);

  // اگر کلیپ‌پث داری و قلم روشنه، دوباره ناحیه کلیپ رو بکش
  if (Brush.clipPath && BRUSH_ACTIVE) {
    redrawClipOverlay();
  }
});

maskCanvas.addEventListener('mouseleave', () => {
  painting = false; lastPt = null;
  map.dragging.enable();
});

// Clear / Save
clearBtn?.addEventListener('click', () => {
  if (!maskCtx || !maskCanvas) return;
  const w = maskCanvas.width / DPR, h = maskCanvas.height / DPR;
  maskCtx.clearRect(0, 0, w, h);
  debouncedAutoSave();
});
saveBtn?.addEventListener('click', () => doSaveMask());

let saveTimer = null;
function debouncedAutoSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => doSaveMask(), 800); }

async function doSaveMask() {
  // اختیاری: باینری‌سازی در کلاینت، فقط داخل کلیپ
  if (Brush.clipPath && BRUSH_ACTIVE) {
    const w = maskCanvas.width / DPR, h = maskCanvas.height / DPR;
    // کپیِ رنگیِ قلم
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    src.getContext('2d').drawImage(maskCanvas, 0, 0, w, h);

    // بوم باینری
    const bin = document.createElement('canvas'); bin.width = w; bin.height = h;
    const bctx = bin.getContext('2d');

    // فقط داخل پلیگان
    bctx.save();
    bctx.fillStyle = '#000';
    bctx.fillRect(0, 0, w, h);
    bctx.globalCompositeOperation = 'source-over';
    bctx.clip(Brush.clipPath);
    // آلفای پیکسل‌های قلم (هرچی >0 را 255 کن)
    const id = src.getContext('2d').getImageData(0, 0, w, h);
    const out = bctx.createImageData(w, h);
    for (let i = 0; i < id.data.length; i += 4) {
      const a = id.data[i + 3]; // آلفا
      const v = a > 0 ? 255 : 0;
      out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
    }
    bctx.putImageData(out, 0, 0);
    bctx.restore();

    // حالا به‌جای maskCanvas، همین bin را ذخیره می‌کنیم
    const blob = await new Promise(res => bin.toBlob(res, 'image/png', 1));
    const buf = await blob.arrayBuffer();
    await fetch('/api/save_mask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(buf)
    });
    saveStat && (saveStat.textContent = 'Saved', setTimeout(() => saveStat.textContent = '', 1200));
    return;
  }
  if (!maskCanvas) return;
  const w = maskCanvas.width / DPR, h = maskCanvas.height / DPR;

  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').drawImage(maskCanvas, 0, 0, w, h);

  const blob = await new Promise(res => tmp.toBlob(res, 'image/png', 1));
  const buf = await blob.arrayBuffer();

  const r = await fetch('/api/save_mask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(buf)
  });
  if (saveStat) {
    saveStat.textContent = r.ok ? 'Saved' : 'Save failed';
    setTimeout(() => saveStat.textContent = '', 1200);
  }
}

(function wireBrushButton(){
  const btn = document.getElementById('toggleBrushBtn');
  dlog('wireBrushButton()', { btnExists: !!btn });
  if (!btn) return;

  // از چندبار بایند شدن جلوگیری کن
  if (btn.__brushBound) { dlog('brush button already bound'); return; }
  btn.__brushBound = true;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dlog('toggleBrushBtn click');
    setBrushActive(!BRUSH_ACTIVE);
  });
})();

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && (t.id === 'toggleBrushBtn' || t.closest?.('#toggleBrushBtn'))) {
    dlog('document click → toggleBrushBtn');
    e.preventDefault();
    e.stopPropagation();
    setBrushActive(!BRUSH_ACTIVE);
  }
}, true); // useCapture=true تا قبل از canvas عمل کند

// ========== Draw / Edit polygons ==========
function initDraw() {
  dlog('initDraw()');
  const drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  const defaultProps = { label: '', class_id: 1, color: '#00ff00' };
  let selectedLayer = null, selectedStyleBackup = null;

  function layerTooltipHtml(props) {
    const p = props || {};
    const fx = (v, n = 2) => (typeof v === 'number' ? v.toFixed(n) : (v ?? ''));
    return `<div style="font:12px/1.4 sans-serif">
      <div><b>Label:</b> ${p.label ?? ''}</div>
      <div><b>Class:</b> ${p.class_id ?? ''}</div>
      <div><b>Area (m²):</b> ${fx(p.area_m2)}</div>
      <div><b>Perimeter (m):</b> ${fx(p.perimeter_m)}</div>
      <div><b>Centroid:</b> ${fx(p.centroid_lat, 6)}, ${fx(p.centroid_lon, 6)}</div>
      <div><b>UID:</b> ${p.uid ?? ''}</div>
    </div>`;
  }

  const enableEditFor = (layer) => { try { if (layer?.editing && !layer.editing.enabled()) layer.editing.enable(); } catch { } };
  const disableEditFor = (layer) => { try { if (layer?.editing && layer.editing.enabled()) layer.editing.disable(); } catch { } };

  function setBrushActive(on) {
    BRUSH_ACTIVE = !!on;
    dlog('setBrushActive()', { BRUSH_ACTIVE, pointer: maskCanvas?.style.pointerEvents });

    // selectedLayer را از window.POLYCTX بگیر تا همیشه یکسان باشد
    const sel = window.POLYCTX?.selectedLayer || null;
    dlog('current selectedLayer', { hasSel: !!sel });

    const btn = document.getElementById('toggleBrushBtn');
    btn?.classList.toggle('primary', BRUSH_ACTIVE);

    if (BRUSH_ACTIVE) {
      if (!sel) {
        dlog('brush ON but no selected polygon → abort');
        BRUSH_ACTIVE = false;
        btn?.classList.remove('primary');
        maskCanvas.style.pointerEvents = 'none';
        cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
        alert('ابتدا یک پولیگان را انتخاب کنید.');
        return;
      }
      maskCanvas.style.pointerEvents = 'auto';
      Brush.clipPath = buildClipPathFromLayer(sel);
      dlog('clipPath set (ON)', { hasClip: !!Brush.clipPath });
      redrawClipOverlay();
      try { if (sel.editing?.enabled?.()) sel.editing.disable(); } catch { }
    } else {
      maskCanvas.style.pointerEvents = 'none';
      cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
      if (sel) { try { if (sel.editing && !sel.editing.enabled()) sel.editing.enable(); } catch { } }
      dlog('brush OFF, canvas disabled');
    }
  }

  // حتماً سراسری کن تا از کنسول هم بتونی تست کنی
  window.setBrushActive = setBrushActive;
  document.getElementById('toggleBrushBtn')?.addEventListener('click', () => {
    dlog('toggleBrushBtn click');
    setBrushActive(!BRUSH_ACTIVE);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'b') { e.preventDefault(); setBrushActive(!BRUSH_ACTIVE); }
    if (e.key === 'Escape') { setBrushActive(false); }
  });

  async function onPolygonSelected(layer) {
    dlog('onPolygonSelected()', { id: layer?._leaflet_id });
    if (selectedLayer && selectedStyleBackup) { try { selectedLayer.setStyle(selectedStyleBackup); } catch { } }
    selectedLayer = layer;
    if (layer?.setStyle) { selectedStyleBackup = { ...layer.options }; layer.setStyle({ color: '#4f46e5', weight: 3 }); }

    setLabelUIFromValue(layer?._props?.label ?? '');
    const inpClass = document.getElementById('polyClass');
    const inpColor = document.getElementById('polyColor');
    if (inpClass) inpClass.value = String(layer?._props?.class_id ?? defaultProps.class_id);
    if (inpColor) inpColor.value = layer?._props?.color ?? defaultProps.color;

    try { map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 18, padding: [20, 20] }); } catch { }
    await onPolygonSelectedForBrush(layer); // این خودش drawClipOverlay را صدا می‌زند

    if (BRUSH_ACTIVE) {
      maskCanvas.style.pointerEvents = 'auto';
      disableEditFor(layer);
    } else {
      enableEditFor(layer);
    }
  }

  function addLayerWithProps(layer, props) {
    layer._props = { ...(props || {}) };
    const col = (layer._props.color || '#00ff00').toLowerCase();
    layer.setStyle?.({ color: col, weight: 2 });
    layer.bindTooltip(layerTooltipHtml(layer._props), { sticky: true });

    layer.on('click', () => onPolygonSelected(layer));
    layer.on('edit', () => { if (layer === selectedLayer) onPolygonSelectedForBrush(layer); });

    drawnItems.addLayer(layer);
  }

  async function reloadFromServer() {
    drawnItems.clearLayers();
    selectedLayer = null; selectedStyleBackup = null;
    setLabelUIFromValue('');
    const r = await fetch('/api/polygons', { cache: 'no-store' });
    const g = r.ok ? await r.json() : null;
    if (!g) return;
    L.geoJson(g, {
      onEachFeature: (feat, layer) => addLayerWithProps(layer, feat.properties || {}),
      style: f => ({ color: (f.properties?.color) || '#00ff00', weight: 2 })
    });
  }
  reloadFromServer().catch(() => { });

  const drawControl = new L.Control.Draw({
    draw: {
      polygon: { shapeOptions: { color: defaultProps.color, weight: 2 } },
      polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false
    },
    edit: { featureGroup: drawnItems }
  });
  map.addControl(drawControl);

  map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    addLayerWithProps(layer, defaultProps);
    onPolygonSelected(layer);
  });

  document.getElementById('applyPropsBtn')?.addEventListener('click', () => {
    if (!selectedLayer) return alert('ابتدا یک پولیگان را انتخاب کنید.');
    const label = getSelectedLabelLocal();
    const class_id = parseInt(document.getElementById('polyClass')?.value || '1', 10);
    const color = (document.getElementById('polyColor')?.value || '#00ff00').toLowerCase();
    selectedLayer._props = { ...(selectedLayer._props || {}), label, class_id, color };
    selectedLayer.setStyle?.({ color, weight: 2 });
    selectedLayer.getTooltip()?.setContent(layerTooltipHtml(selectedLayer._props));
  });

  document.getElementById('setDefaultPropsBtn')?.addEventListener('click', () => {
    defaultProps.label = getSelectedLabelLocal();
    defaultProps.class_id = parseInt(document.getElementById('polyClass')?.value || '1', 10);
    defaultProps.color = (document.getElementById('polyColor')?.value || '#00ff00').toLowerCase();
    alert('پیش‌فرض به‌روزرسانی شد.');
  });

  document.getElementById('savePolygonsBtn')?.addEventListener('click', async () => {
    const fc = { type: 'FeatureCollection', features: [] };
    drawnItems.eachLayer(layer => {
      try { const gj = layer.toGeoJSON(); gj.properties = { ...(gj.properties || {}), ...(layer._props || {}) }; fc.features.push(gj); } catch { }
    });
    const r = await fetch('/api/save_polygons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fc)
    });
    alert(r.ok ? 'ذخیره شد' : 'خطا در ذخیره');
    if (r.ok) reloadFromServer();
  });

  document.getElementById('loadPolygonsBtn')?.addEventListener('click', async () => {
    const inp = document.getElementById('polyUpload'); const file = inp?.files?.[0];
    if (!file) return alert('فایل .geojson/.json یا .zip را انتخاب کنید.');
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch('/api/polygons/upload', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return alert('خطا: ' + (j.error || 'upload failed'));
    await reloadFromServer(); alert('پولیگان‌ها بارگذاری شدند.');
  });

  function panBy(dx, dy) { map.panBy([dx, dy], { animate: false }); }
  function savePolys() { document.getElementById('savePolygonsBtn')?.click(); }
  function toggleHelp() {
    let el = document.getElementById('hotkeyHelp');
    if (!el) {
      el = document.createElement('div'); el.id = 'hotkeyHelp';
      el.style.cssText = 'position:fixed; right:12px; bottom:12px; z-index:99999; background:rgba(0,0,0,.75); color:#fff; padding:12px; border-radius:8px; max-width:460px; font:12px/1.6 ui-sans-serif,system-ui;';
      el.innerHTML = `<b>Shortcuts (Polygon)</b><br>Zoom: + / - | Pan: Arrows/WASD<br>P Start • Enter Finish • Esc Cancel • Backspace Del last • E Toggle edit • Ctrl/Cmd+S Save<br>Close: ?`;
      document.body.appendChild(el);
    } else el.remove();
  }

  window.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.isComposing) return;
    const kill = () => { e.preventDefault(); e.stopPropagation(); };
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { kill(); savePolys(); return; }
    const mult = e.shiftKey ? MULT_ULTRA : (e.altKey ? MULT_FAST : 1);
    switch (e.key) {
      case '+': case '=': kill(); zoomBy(+BASE_STEP * mult); break;
      case '-': kill(); zoomBy(-BASE_STEP * mult); break;
      case 'ArrowUp': case 'w': case 'W': kill(); panBy(0, -100); break;
      case 'ArrowDown': case 's': case 'S': kill(); panBy(0, +100); break;
      case 'ArrowLeft': case 'a': case 'A': kill(); panBy(-100, 0); break;
      case 'ArrowRight': case 'd': case 'D': kill(); panBy(+100, 0); break;
      case 'e': case 'E': kill(); if (selectedLayer) { const en = selectedLayer?.editing?.enabled?.(); en ? disableEditFor(selectedLayer) : enableEditFor(selectedLayer); } break;
      case '?': case 'h': case 'H': kill(); toggleHelp(); break;
    }
  });

  window.POLYCTX = { map, drawnItems, drawControl, get selectedLayer() { return selectedLayer; } };
}

// ========== Overlay nudge (meters) ==========
let alignDx = 0, alignDy = 0;
async function loadOffset() {
  try {
    const r = await fetch('/api/align_offset', { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); alignDx = +j.dx_m || 0; alignDy = +j.dy_m || 0; }
  } catch { }
}
async function nudge(dx_m, dy_m) {
  alignDx += dx_m; alignDy += dy_m;
  await fetch('/api/align_offset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dx_m: alignDx, dy_m: alignDy }) });
  const r = await fetch('/api/s2_bounds_wgs84', { cache: 'no-store' });
  if (r.ok) {
    const b = await r.json();
    const newB = [[b.lat_min, b.lon_min], [b.lat_max, b.lon_max]];
    overlay?.setBounds(newB);
  }
}
window.addEventListener('keydown', (e) => {
  if (!overlay || !e.altKey) return;
  const STEP = (e.shiftKey ? 20 : 5);
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); nudge(-STEP, 0); break;
    case 'ArrowRight': e.preventDefault(); nudge(+STEP, 0); break;
    case 'ArrowUp': e.preventDefault(); nudge(0, +STEP); break;
    case 'ArrowDown': e.preventDefault(); nudge(0, -STEP); break;
  }
});

// ========== Bootstrap ==========
(async function bootstrap() {
  try {
    await loadOffset();
    const r = await fetch('/api/s2_bounds_wgs84', { cache: 'no-store' });
    if (r.ok) {
      const b = await r.json();
      const bounds = [[b.lat_min, b.lon_min], [b.lat_max, b.lon_max]];
      const initialOpacity = slider ? (parseInt(slider.value, 10) || 60) / 100 : 0.6;
      overlay = L.imageOverlay('/api/output/rgb_quicklook.png?t=' + Date.now(), bounds, { opacity: initialOpacity }).addTo(map);
      lbl && (lbl.textContent = initialOpacity.toFixed(2));
      map.fitBounds(bounds);
    } else {
      map.setView([29, 52], 12);
    }
  } catch {
    map.setView([29, 52], 12);
  } finally {
    setTimeout(() => { try { map.invalidateSize(false); } catch { } }, 50);
    initDraw();
    setTimeout(resizeAll, 0);
  }
})();

// ========== Expose helper for post-upload refresh ==========
window.reloadBackdropAndMaskAfterUpload = () => {
  backdropImg.src = '/api/output/rgb_quicklook.png?t=' + Date.now();
};