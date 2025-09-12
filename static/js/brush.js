// static/js/brush.js
// Minimal brush: load polygons, select one, brush only inside it, erase, clear, save PNG
(() => {
  const DBG = true;
  const log  = (...a) => DBG && console.debug('[BRUSH]', ...a);
  const warn = (...a) => DBG && console.warn('[BRUSH]', ...a);

  // Map
  const map = L.map('map', { zoomSnap: 1, zoomDelta: 1, keyboard: false });
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Esri' }
  ).addTo(map);
  map.setView([30.0, 52.0], 12);

  // Draw layer + control
  const drawn = new L.FeatureGroup();
  map.addLayer(drawn);
  const drawControl = new L.Control.Draw({
    draw: {
      polygon: { shapeOptions: { color: '#22c55e', weight: 2 } },
      marker:false, circle:false, polyline:false, rectangle:false, circlemarker:false
    },
    edit: { featureGroup: drawn }
  });
  map.addControl(drawControl);

  // State
  let selectedLayer = null;
  let MODE = 'pan';       // 'pan' | 'brush'
  let ERASE = false;
  const Brush = { size: 24, clipPath: null };

  // Canvases (بدون DPR)
  const maskCanvas   = document.getElementById('maskCanvas');
  const cursorCanvas = document.getElementById('cursorCanvas');
  const maskCtx   = maskCanvas.getContext('2d');
  const cursorCtx = cursorCanvas.getContext('2d');

  // UI
  const modePanBtn   = document.getElementById('modePanBtn');
  const modeBrushBtn = document.getElementById('modeBrushBtn');
  const sizeEl       = document.getElementById('brushSize');
  const sizeVal      = document.getElementById('brushSizeVal');
  const eraseChk     = document.getElementById('eraseChk');      // اگر داری
  const btnClear     = document.getElementById('clearMask');
  const btnSave      = document.getElementById('savePng');
  const uploadInp    = document.getElementById('polyUpload');
  const uploadBtn    = document.getElementById('loadPolygonsBtn');

  // ---------- Helpers ----------
  function setMode(m) {
    MODE = m;
    document.body.classList.toggle('tool-brush', MODE === 'brush');
    if (MODE === 'brush') {
      map.dragging.disable();
      modeBrushBtn?.classList.add('primary');
      modePanBtn?.classList.remove('primary');
      if (!selectedLayer) warn('Brush on but no polygon selected.');
      rebuildClipPath();
      redrawCursorPreview();
    } else {
      map.dragging.enable();
      modePanBtn?.classList.add('primary');
      modeBrushBtn?.classList.remove('primary');
      clearCursor();
    }
  }

  function sizeCanvasToMap() {
    const sz = map.getSize(); // CSS pixels
    [maskCanvas, cursorCanvas].forEach(cnv => {
      // مهم: بدون setTransform و بدون DPR
      cnv.width  = sz.x;
      cnv.height = sz.y;
      cnv.style.width  = sz.x + 'px';
      cnv.style.height = sz.y + 'px';
      cnv.getContext('2d').clearRect(0, 0, cnv.width, cnv.height);
    });
    rebuildClipPath();
  }

  function selectLayer(layer) {
    try {
      if (selectedLayer && selectedLayer !== layer) {
        selectedLayer.setStyle?.({ weight: 2, color: '#22c55e' });
      }
      selectedLayer = layer;
      selectedLayer.setStyle?.({ weight: 3, color: '#4f46e5' });
    } catch {}
    rebuildClipPath();
  }

  function clearCursor() {
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  }

  function redrawCursorPreview(x = lastMouse.x, y = lastMouse.y) {
    clearCursor();
    if (MODE !== 'brush' || x == null || y == null) return;
    cursorCtx.save();
    cursorCtx.strokeStyle = ERASE ? 'rgba(255,70,70,0.9)' : 'rgba(0,255,0,0.9)';
    cursorCtx.lineWidth = 1;
    cursorCtx.beginPath();
    cursorCtx.arc(x, y, Math.max(1, Brush.size * 0.5), 0, Math.PI * 2);
    cursorCtx.stroke();
    cursorCtx.restore();
  }

  function rebuildClipPath() {
    Brush.clipPath = null;
    if (!selectedLayer) return;

    const gj = selectedLayer.toGeoJSON();
    const geom = gj?.geometry;
    if (!geom) return;

    const mapRect    = map.getContainer().getBoundingClientRect();
    const canvasRect = maskCanvas.getBoundingClientRect();
    const offX = canvasRect.left - mapRect.left;
    const offY = canvasRect.top  - mapRect.top;

    const p = new Path2D();
    const addRing = (ring) => {
      for (let i = 0; i < ring.length; i++) {
        const lng = ring[i][0], lat = ring[i][1];
        const pt = map.latLngToContainerPoint([lat, lng]); // خروجی در مختصات CSS
        const cx = pt.x - offX;
        const cy = pt.y - offY;
        if (i === 0) p.moveTo(cx, cy); else p.lineTo(cx, cy);
      }
      p.closePath();
    };

    if (geom.type === 'Polygon') {
      geom.coordinates.forEach(addRing);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(poly => poly.forEach(addRing));
    } else {
      return;
    }

    Brush.clipPath = p;

    // dashed outline
    clearCursor();
    if (MODE === 'brush') {
      cursorCtx.save();
      cursorCtx.setLineDash([6, 4]);
      cursorCtx.strokeStyle = 'rgba(80,160,255,.95)';
      cursorCtx.lineWidth = 1.5;
      cursorCtx.stroke(p);  // بدون transform اضافه
      cursorCtx.restore();
    }
  }

  // ---------- Map events ----------
  map.on('load zoom move resize', sizeCanvasToMap);
  setTimeout(sizeCanvasToMap, 0);
  window.addEventListener('resize', sizeCanvasToMap);

  map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    drawn.addLayer(layer);
    layer.on('click', () => selectLayer(layer));
    selectLayer(layer);
    try { map.fitBounds(layer.getBounds().pad(0.1)); } catch {}
  });

  drawn.on('click', (e) => selectLayer(e.layer));
  map.on('move zoom', () => { if (selectedLayer) rebuildClipPath(); });

  // ---------- Load polygons from server ----------
  async function loadPolygonsFromServer() {
    try {
      const r = await fetch('/api/polygons', { cache: 'no-store' });
      if (!r.ok) return;
      const gj = await r.json();
      drawn.clearLayers();
      L.geoJSON(gj, {
        onEachFeature: (feat, layer) => {
          layer.setStyle?.({ color: feat.properties?.color || '#22c55e', weight: 2 });
          layer.on('click', () => selectLayer(layer));
          drawn.addLayer(layer);
        }
      });
      let first = null;
      drawn.eachLayer(l => { if (!first) first = l; });
      if (first) {
        selectLayer(first);
        try { map.fitBounds(first.getBounds().pad(0.1)); } catch {}
      }
      log('polygons loaded');
    } catch (e) {
      warn('loadPolygonsFromServer failed', e);
    }
  }
  loadPolygonsFromServer();

  // ---------- Upload polygons ----------
  uploadBtn?.addEventListener('click', async () => {
    const f = uploadInp?.files?.[0];
    if (!f) { alert('Choose a .geojson/.json or .zip shapefile first.'); return; }
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await fetch('/api/polygons/upload', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert('Upload failed: ' + (j.error || r.status)); return; }
      await loadPolygonsFromServer();
      alert('Polygons uploaded.');
    } catch (e) {
      alert('Upload error: ' + e);
    }
  });

  // ---------- Brush controls ----------
  if (sizeEl) {
    Brush.size = parseInt(sizeEl.value || '24', 10);
    sizeVal && (sizeVal.textContent = `${Brush.size} px`);
    sizeEl.addEventListener('input', () => {
      Brush.size = parseInt(sizeEl.value || '24', 10);
      sizeVal && (sizeVal.textContent = `${Brush.size} px`);
      redrawCursorPreview();
    });
  }

  if (eraseChk) {
    eraseChk.addEventListener('change', () => {
      ERASE = !!eraseChk.checked;
      redrawCursorPreview();
    });
  }

  modePanBtn?.addEventListener('click', () => setMode('pan'));
  modeBrushBtn?.addEventListener('click', () => setMode('brush'));
  setMode('pan'); // start with drag

  btnClear?.addEventListener('click', () => {
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    redrawCursorPreview();
  });

  btnSave?.addEventListener('click', () => {
    const tmp = document.createElement('canvas');
    tmp.width = maskCanvas.width;
    tmp.height = maskCanvas.height;
    tmp.getContext('2d').drawImage(maskCanvas, 0, 0, tmp.width, tmp.height);
    tmp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'mask.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, 'image/png', 1);
  });

  // ---------- Painting ----------
  let painting = false, lastPt = null;
  const lastMouse = { x: null, y: null };

  function getCanvasXY(e) {
    const r = maskCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // نکته مهم: چون transform=identity است، Path2D و نقاط هر دو در مختصات CSS هستند.
  function isInsideClip(x, y) {
    if (!Brush.clipPath) return false;
    // در این حالت لازم نیست transform را دست بزنیم
    return maskCtx.isPointInPath(Brush.clipPath, x, y);
  }

  function drawDot(x, y) {
    if (MODE !== 'brush') return;
    if (!isInsideClip(x, y)) return;
    const r = Math.max(1, Brush.size * 0.5);
    maskCtx.save();
    maskCtx.globalCompositeOperation = ERASE ? 'destination-out' : 'source-over';
    maskCtx.beginPath();
    maskCtx.arc(x, y, r, 0, Math.PI * 2);
    maskCtx.fillStyle = ERASE ? 'rgba(0,0,0,1)' : 'rgba(0,255,0,0.9)';
    maskCtx.fill();
    maskCtx.restore();
  }

  maskCanvas.addEventListener('mousedown', (e) => {
    if (MODE !== 'brush') return;
    if (!selectedLayer) { alert('Select a polygon first.'); return; }
    if (!Brush.clipPath) rebuildClipPath();
    if (!Brush.clipPath) return;

    e.preventDefault(); e.stopPropagation();
    painting = true;
    map.dragging.disable();

    const [x, y] = getCanvasXY(e);
    drawDot(x, y);
    lastPt = [x, y];
  });

  maskCanvas.addEventListener('mousemove', (e) => {
    const [x, y] = getCanvasXY(e);
    lastMouse.x = x; lastMouse.y = y;

    // preview
    redrawCursorPreview(x, y);

    if (MODE !== 'brush' || !painting) return;

    if (lastPt) {
      const dx = x - lastPt[0], dy = y - lastPt[1];
      const steps = Math.ceil(Math.hypot(dx, dy) / Math.max(2, Brush.size * 0.35));
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
    if (MODE === 'pan') map.dragging.enable();
  });

  // Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === '[') {
      Brush.size = Math.max(2, Brush.size - 2);
      if (sizeEl) sizeEl.value = String(Brush.size);
      if (sizeVal) sizeVal.textContent = `${Brush.size} px`;
      redrawCursorPreview();
    } else if (e.key === ']') {
      Brush.size = Math.min(128, Brush.size + 2);
      if (sizeEl) sizeEl.value = String(Brush.size);
      if (sizeVal) sizeVal.textContent = `${Brush.size} px`;
      redrawCursorPreview();
    } else if (e.key.toLowerCase() === 'e') {
      ERASE = !ERASE;
      if (eraseChk) eraseChk.checked = ERASE;
      redrawCursorPreview();
    } else if (e.key.toLowerCase() === 'b') {
      setMode(MODE === 'brush' ? 'pan' : 'brush');
    }
  });
})();