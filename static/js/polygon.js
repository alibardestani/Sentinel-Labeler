// static/js/polygon.js
// ==================================
// Polygon labeling – clean + robust
// ==================================

// ---- Base map + Esri imagery ----
const map = L.map('map', {
  zoomSnap: 1,      
  zoomDelta: 1,
  keyboard: false, 
});

function zoomBy(levels) {
  const z = map.getZoom();
  map.setZoom(z + levels, { animate: true });
}

const BASE_STEP   = 1; 
const MULT_FAST   = 5;  
const MULT_ULTRA  = 10;

L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Esri' }
).addTo(map);

// ---- Overlay opacity controls ----
let overlay = null;
const slider = document.getElementById('overlayOpacity');
const lbl    = document.getElementById('opacityValue');

function applyOpacityFromSlider() {
  if (!overlay || !slider) return;
  const v = (parseInt(slider.value, 10) || 0) / 100;
  overlay.setOpacity(v);
  if (lbl) lbl.textContent = v.toFixed(2);
}
if (slider) slider.addEventListener('input', applyOpacityFromSlider);

/* --------------------------------------------
   Label UI helpers (matches template dropdown)
---------------------------------------------*/
function getSelectedLabelLocal() {
  if (typeof window.getSelectedLabel === 'function') {
    return window.getSelectedLabel();
  }
  const sel    = document.getElementById('polyLabelSelect');
  const custom = document.getElementById('polyLabelCustom');
  if (!sel) return '';
  const val = sel.value;
  if (val === '__custom__') return (custom?.value || '').trim();
  return val || '';
}

function setLabelUIFromValue(val) {
  const sel        = document.getElementById('polyLabelSelect');
  const customWrap = document.getElementById('customLabelWrap');
  const inp        = document.getElementById('polyLabelCustom');
  if (!sel || !customWrap || !inp) return;

  const opts = Array.from(sel.options).map(o => o.value);
  if (val && opts.includes(val)) {
    sel.value = val;
    customWrap.style.display = 'none';
    inp.value = '';
  } else if (val && val !== '') {
    sel.value = '__custom__';
    customWrap.style.display = 'block';
    inp.value = val;
  } else {
    sel.value = '';
    customWrap.style.display = 'none';
    inp.value = '';
  }
}

/* ======================
   Draw / Edit / Snap ...
====================== */
function initDraw(map) {
  const drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  // --------- Tooltip HTML ----------
  function layerTooltipHtml(props) {
    const p = props || {};
    const toFixed = (v, n = 2) => (typeof v === 'number' ? v.toFixed(n) : (v ?? ''));
    return `
      <div style="font:12px/1.4 sans-serif">
        <div><b>Label:</b> ${p.label ?? ''}</div>
        <div><b>Class:</b> ${p.class_id ?? ''}</div>
        <div><b>Area (m²):</b> ${toFixed(p.area_m2, 2)}</div>
        <div><b>Perimeter (m):</b> ${toFixed(p.perimeter_m, 2)}</div>
        <div><b>Centroid:</b> ${toFixed(p.centroid_lat,6)}, ${toFixed(p.centroid_lon,6)}</div>
        <div><b>UID:</b> ${p.uid ?? ''}</div>
      </div>`;
  }

  // --------- Add layer with props ----------
  function addLayerWithProps(layer, props) {
    layer._props = { ...(props || {}) };
    const col = (layer._props.color || '#00ff00').toLowerCase();
    if (layer.setStyle) layer.setStyle({ color: col, weight: 2 });
    layer.bindTooltip(layerTooltipHtml(layer._props), { sticky: true });
    layer.on('click', () => selectLayer(layer));
    drawnItems.addLayer(layer);
  }

  // --------- Reload from server ----------
  async function reloadFromServer() {
    drawnItems.clearLayers();
    selectedLayer = null;
    fillFormFromLayer(null);

    const r = await fetch('/api/polygons', { cache: 'no-store' });
    const g = r.ok ? await r.json() : null;
    if (!g) return;

    L.geoJson(g, {
      onEachFeature: (feat, layer) => addLayerWithProps(layer, feat.properties || {}),
      style: f => ({ color: (f.properties && f.properties.color) ? f.properties.color : '#00ff00', weight: 2 })
    });
  }

  // --------- Selection & form ----------
  const defaultProps = { label: '', class_id: 1, color: '#00ff00' }; // Vegetation by default
  let selectedLayer = null, selectedStyleBackup = null;

  function selectLayer(layer) {
    if (selectedLayer && selectedStyleBackup) {
      try { selectedLayer.setStyle(selectedStyleBackup); } catch {}
    }
    selectedLayer = layer;
    if (layer && layer.setStyle) {
      selectedStyleBackup = { ...layer.options };
      layer.setStyle({ color: '#4f46e5', weight: 3 }); // highlight
    } else {
      selectedStyleBackup = null;
    }
    fillFormFromLayer(layer);
  }

  function fillFormFromLayer(layer) {
    const inpClass = document.getElementById('polyClass');
    const inpColor = document.getElementById('polyColor');
    if (!inpClass || !inpColor) return;

    if (!layer) {
      // defaults
      setLabelUIFromValue('');
      inpClass.value = String(defaultProps.class_id); // "1" Vegetation
      inpColor.value = defaultProps.color;
      return;
    }
    const props = layer._props || {};
    setLabelUIFromValue(props.label ?? '');
    inpClass.value = String(props.class_id ?? defaultProps.class_id);
    inpColor.value = props.color ?? defaultProps.color;
  }

  function applyFormToLayer(layer) {
    if (!layer) return;

    const label    = getSelectedLabelLocal();
    const class_id = parseInt(document.getElementById('polyClass')?.value || '1', 10);
    const color    = (document.getElementById('polyColor')?.value || '#00ff00').toLowerCase();

    layer._props = { ...(layer._props || {}), label, class_id, color };

    if (layer.setStyle) layer.setStyle({ color, weight: 2 });
    // update tooltip content, binding if needed
    if (typeof layer.setTooltipContent === 'function') {
      layer.setTooltipContent(layerTooltipHtml(layer._props));
    } else if (layer.getTooltip && layer.getTooltip()) {
      layer.getTooltip().setContent(layerTooltipHtml(layer._props));
    } else {
      layer.bindTooltip(layerTooltipHtml(layer._props), { sticky: true });
    }
  }

  // --------- Initial load ----------
  reloadFromServer().catch(()=>{});

  // --------- Draw control ----------
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
    selectLayer(layer);
  });

  drawnItems.on('click', (e) => { if (e.layer) selectLayer(e.layer); });

  // --------- Side form actions ----------
  document.getElementById('applyPropsBtn')?.addEventListener('click', () => {
    if (!selectedLayer) return alert('ابتدا یک پولیگان را انتخاب کنید.');
    applyFormToLayer(selectedLayer);
  });

  document.getElementById('setDefaultPropsBtn')?.addEventListener('click', () => {
    const LBL = getSelectedLabelLocal();
    const CLS = parseInt(document.getElementById('polyClass')?.value || '1', 10);
    const COL = (document.getElementById('polyColor')?.value || '#00ff00').toLowerCase();
    defaultProps.label = LBL; defaultProps.class_id = CLS; defaultProps.color = COL;
    alert('پیش‌فرض به‌روزرسانی شد.');
  });

  // --------- Save to server ----------
  document.getElementById('savePolygonsBtn')?.addEventListener('click', async () => {
    const fc = { type: 'FeatureCollection', features: [] };
    drawnItems.eachLayer(layer => {
      try {
        const gj = layer.toGeoJSON();
        gj.properties = { ...(gj.properties || {}), ...(layer._props || {}) };
        fc.features.push(gj);
      } catch (err) { console.warn(err); }
    });
    const r = await fetch('/api/save_polygons', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fc)
    });
    alert(r.ok ? 'ذخیره شد' : 'خطا در ذخیره');
    if (r.ok) reloadFromServer();
  });

  // --------- Upload GeoJSON / Shapefile.zip ----------
  document.getElementById('loadPolygonsBtn')?.addEventListener('click', async () => {
    const inp = document.getElementById('polyUpload');
    const file = inp?.files?.[0];
    if (!file) return alert('فایل .geojson/.json یا .zip را انتخاب کنید.');
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch('/api/polygons/upload', { method: 'POST', body: fd });
    const j = await r.json().catch(()=> ({}));
    if (!r.ok) return alert('خطا: ' + (j.error || 'upload failed'));
    await reloadFromServer();
    alert('پولیگان‌ها بارگذاری شدند.');
  });

  // --------- Snap (defensive) ----------
  const guideLayers = [drawnItems];

  map.on(L.Draw.Event.DRAWSTART, (e) => {
    try {
      const handler = e.handler;
      const poly = handler && (handler._poly || handler._polyline);
      if (poly && L?.Handler?.PolylineSnap) {
        const snap = new L.Handler.PolylineSnap(map, poly, { snapDistance: 12, snapVertices: true });
        guideLayers.forEach(gl => snap.addGuideLayer(gl));
      }
      if (handler?._markers && L?.Handler?.MarkerSnap) {
        handler._markers.forEach(m => {
          const ms = new L.Handler.MarkerSnap(map, m, { snapDistance: 12, snapVertices: true });
          guideLayers.forEach(gl => ms.addGuideLayer(gl));
        });
      }
    } catch {}
  });

  map.on(L.Draw.Event.EDITSTART, () => {
    drawnItems.eachLayer(layer => {
      try {
        if (layer.editing && layer.editing.enable) layer.editing.enable();
        if (L?.Handler?.PolylineSnap) {
          const snap = new L.Handler.PolylineSnap(map, layer, { snapDistance: 12, snapVertices: true });
          guideLayers.forEach(gl => snap.addGuideLayer(gl));
        }
      } catch {}
    });
  });

  // --------- Keyboard UX ----------
  window.POLYCTX = { map, drawnItems, drawControl };

  const PAN_STEP  = 100; // px
  const ZOOM_STEP = 2;

  function startPolygonDraw() {
    if (!window.L || !window.L.Draw?.Polygon) return;
    const handler = new L.Draw.Polygon(map, drawControl.options.draw.polygon || {});
    handler.enable();
  }
  function toggleEditMode() {
    try {
      drawControl._toolbars?.edit?._modes?.edit?.handler?.enable();
    } catch {}
  }
  function panBy(dx, dy) { map.panBy([dx, dy], { animate: false }); }
  function zoomDelta(dz) { if (dz > 0) map.zoomIn(dz); else map.zoomOut(-dz); }
  function save() { document.getElementById('savePolygonsBtn')?.click(); }
  function toggleHelp() {
    let el = document.getElementById('hotkeyHelp');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hotkeyHelp';
      el.style.cssText = 'position:fixed; right:12px; bottom:12px; z-index:99999; background:rgba(0,0,0,.75); color:#fff; padding:12px; border-radius:8px; max-width:460px; font:12px/1.6 ui-sans-serif,system-ui;';
      el.innerHTML = `
        <b>Shortcuts (Polygon)</b><br>
        Zoom: + / - &nbsp;|&nbsp; Pan: Arrows or WASD<br>
        Start polygon: P &nbsp;|&nbsp; Finish: Enter (double-click) &nbsp;|&nbsp; Cancel: Esc &nbsp;|&nbsp; Delete last vertex: Backspace<br>
        Edit nodes: E &nbsp;|&nbsp; Save: Ctrl/Cmd + S<br>
        Close: ?
      `;
      document.body.appendChild(el);
    } else {
      el.remove();
    }
  }


window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing) return;

  // جلوگیری از رفتار پیش‌فرض و برگشت به هندلرهای دیگر
  const kill = () => { e.preventDefault(); e.stopPropagation(); };

  // ذخیره
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { kill(); save(); return; }

  // ضرایب: Shift=خیلی زیاد، Alt=زیاد، عادی=۱
  const mult = e.shiftKey ? MULT_ULTRA : (e.altKey ? MULT_FAST : 1);

  switch (e.key) {
    case '+':
    case '=': kill(); zoomBy(+BASE_STEP * mult); break;
    case '-': kill(); zoomBy(-BASE_STEP * mult); break;

    case 'ArrowUp':
    case 'w': case 'W': kill(); panBy(0, -100); break;
    case 'ArrowDown':
    case 's': case 'S': kill(); panBy(0, +100); break;
    case 'ArrowLeft':
    case 'a': case 'A': kill(); panBy(-100, 0); break;
    case 'ArrowRight':
    case 'd': case 'D': kill(); panBy(+100, 0); break;

    case 'p': case 'P': kill(); startPolygonDraw(); break;
    case 'e': case 'E': kill(); toggleEditMode(); break;
    case '?':
    case 'h': case 'H': kill(); toggleHelp(); break;
  }
});

  // --------- Mouse position (light Folium-like) ----------
  const MousePos = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd: function() {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      div.style.padding = '4px 8px'; div.style.background = 'rgba(0,0,0,.45)';
      div.style.color = '#fff'; div.style.font = '12px/1.4 sans-serif';
      div.textContent = 'Lat, Lon: –';
      map.on('mousemove', (ev) => {
        const f = (n) => L.Util.formatNum(n, 6);
        div.textContent = `Lat, Lon: ${f(ev.latlng.lat)} , ${f(ev.latlng.lng)}`;
      });
      return div;
    }
  });
  map.addControl(new MousePos());
}

/* ==========================
   Alignment Nudge (meters)
========================== */
let alignDx = 0, alignDy = 0; // آخرین آفست لود‌شده از سرور

async function loadOffset() {
  try {
    const r = await fetch('/api/align_offset', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      alignDx = +j.dx_m || 0; alignDy = +j.dy_m || 0;
    }
  } catch {/* ignore */}
}

async function nudge(dx_m, dy_m) {
  alignDx += dx_m;
  alignDy += dy_m;
  await fetch('/api/align_offset', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ dx_m: alignDx, dy_m: alignDy })
  });
  // سرور bounds را با آفست جدید برمی‌گرداند
  const r = await fetch('/api/s2_bounds_wgs84', { cache:'no-store' });
  if (r.ok) {
    const b = await r.json();
    const newBounds = [[b.lat_min, b.lon_min], [b.lat_max, b.lon_max]];
    if (overlay) overlay.setBounds(newBounds);
  }
}

// شورتکات‌ها: Alt + Arrow برای نودج (۵ متر؛ با Shift=۲۰ متر)
window.addEventListener('keydown', (e) => {
  if (!overlay || !e.altKey) return;
  const STEP = (e.shiftKey ? 20 : 5);
  switch (e.key) {
    case 'ArrowLeft':  e.preventDefault(); nudge(-STEP, 0); break;
    case 'ArrowRight': e.preventDefault(); nudge(+STEP, 0); break;
    case 'ArrowUp':    e.preventDefault(); nudge(0, +STEP); break; // شمال
    case 'ArrowDown':  e.preventDefault(); nudge(0, -STEP); break; // جنوب
  }
});

/* =========================================
   Single bootstrap flow (no top-level await)
========================================= */
(async function bootstrap() {
  try {
    await loadOffset();
    // سعی کن bounds صحنه را بگیری
    const r = await fetch('/api/s2_bounds_wgs84', { cache: 'no-store' });
    if (r.ok) {
      const b = await r.json();
      const bounds = [[b.lat_min, b.lon_min], [b.lat_max, b.lon_max]];
      const initialOpacity = slider ? (parseInt(slider.value, 10) || 60) / 100 : 0.6;
      overlay = L.imageOverlay('/api/output/rgb_quicklook.png?t=' + Date.now(), bounds, { opacity: initialOpacity }).addTo(map);
      if (lbl) lbl.textContent = initialOpacity.toFixed(2);
      map.fitBounds(bounds);
    } else {
      map.setView([29.0, 52.0], 12); // fallback
    }
  } catch {
    map.setView([29.0, 52.0], 12); // fallback
  } finally {
    initDraw(map); // همیشه یک‌بار
  }
})();