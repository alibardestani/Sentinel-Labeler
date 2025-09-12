// static/js/brush_only.js
(() => {
  const DBG = true;
  const log = (...a)=> DBG && console.debug('[BRUSH]', ...a);
  const warn = (...a)=> DBG && console.warn('[BRUSH]', ...a);

  const $ = id => document.getElementById(id);

  // ---------- Map + ESRI ----------
  const map = L.map('map', {
    zoomSnap: 0,
    zoomDelta: 0.5,
    maxZoom: 22,
    wheelDebounceTime: 30,
    wheelPxPerZoomLevel: 80,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    zoomControl: true
  });
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Esri', maxNativeZoom: 19, maxZoom: 22, detectRetina: true }
  ).addTo(map);

  // Sentinel quicklook overlay
  let overlay = null;
  let sceneBounds = null; // Leaflet LatLngBounds
  const opacitySlider = $('overlayOpacity');
  const opacityVal = $('opacityValue');

  function connectOpacitySlider() {
    if (!opacitySlider) return;
    const apply = () => {
      if (!overlay) return;
      const v = (parseInt(opacitySlider.value, 10) || 60) / 100;
      overlay.setOpacity(v);
      if (opacityVal) opacityVal.textContent = v.toFixed(2);
    };
    opacitySlider.addEventListener('input', apply);
    apply();
  }

  async function loadSceneOverlay() {
    // /api/s2_bounds_wgs84 -> {lat_min, lat_max, lon_min, lon_max}
    const r = await fetch('/api/s2_bounds_wgs84', { cache: 'no-store' });
    if (!r.ok) throw new Error('s2 bounds fetch failed');
    const b = await r.json();
    sceneBounds = L.latLngBounds(
      [b.lat_min, b.lon_min], // SW
      [b.lat_max, b.lon_max]  // NE
    );
    if (overlay) map.removeLayer(overlay);
    overlay = L.imageOverlay(
      '/api/output/rgb_quicklook.png?t=' + Date.now(),
      sceneBounds,
      { opacity: 0.6 }
    ).addTo(map);
    map.fitBounds(sceneBounds);
    connectOpacitySlider();
  }

  // ---------- Canvases ----------
  const maskCanvas = $('maskCanvas');
  const cursorCanvas = $('cursorCanvas');
  const maskCtx = maskCanvas.getContext('2d');
  const cursorCtx = cursorCanvas.getContext('2d');
  const DPR = Math.max(1, window.devicePixelRatio || 1);

  function resizeCanvases() {
    const sz = map.getSize();
    [maskCanvas, cursorCanvas].forEach(cnv => {
      cnv.width = Math.round(sz.x * DPR);
      cnv.height = Math.round(sz.y * DPR);
      cnv.style.width = sz.x + 'px';
      cnv.style.height = sz.y + 'px';
      cnv.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0);
    });
    clearCursor();
    rebuildClipPath();
  }
  map.on('load zoom move resize', resizeCanvases);
  window.addEventListener('resize', resizeCanvases);

  // ---------- Draw + selection ----------
  const drawn = new L.FeatureGroup();
  map.addLayer(drawn);

  const drawControl = new L.Control.Draw({
    draw: { polygon: { shapeOptions: { color: '#22c55e', weight: 2 } },
            marker:false, circle:false, polyline:false, rectangle:false, circlemarker:false },
    edit: { featureGroup: drawn }
  });
  map.addControl(drawControl);

  // only polygons intersecting sceneBounds will be shown
  let layers = [];
  let idx = -1;
  let selectedLayer = null;

  function selectByIndex(i) {
    if (!layers.length) return;
    if (i < 0 || i >= layers.length) return;
    if (selectedLayer && selectedLayer !== layers[i]) {
      try { selectedLayer.setStyle({ weight: 2, color: '#22c55e' }); } catch {}
    }
    idx = i;
    selectedLayer = layers[idx];
    try { selectedLayer.setStyle({ weight: 3, color: '#4f46e5' }); } catch {}
    rebuildClipPath();
    try { map.fitBounds(selectedLayer.getBounds().pad(0.15), { maxZoom: 20 }); } catch {}
    // load previous mask (if any) for this polygon
    loadMaskForCurrentPoly().catch(()=>{});
    updateHud();
  }

  // ---------- HUD ----------
  const hudTile = $('hudTile');
  const hudIndex = $('hudIndex');
  const hudTotal = $('hudTotal');
  const hudDone = $('hudDone');
  const btnPrev = $('btnPrev');
  const btnNext = $('btnNext');

  const doneSet = new Set(); // (tileId+uid) keys

  function currentTileId() {
    // tile id = bounds rounded to 1e-4 for uniqueness (or from polygon props if دارید)
    if (!sceneBounds) return '-';
    const ne = sceneBounds.getNorthEast(), sw = sceneBounds.getSouthWest();
    const r = v => Math.round(v * 10000) / 10000;
    return `b_${r(sw.lat)}_${r(sw.lng)}_${r(ne.lat)}_${r(ne.lng)}`;
  }

  function updateHud() {
    hudTile && (hudTile.textContent = currentTileId());
    hudTotal && (hudTotal.textContent = String(layers.length));
    hudIndex && (hudIndex.textContent = String(idx + 1));
    // count done within current tile
    const tile = currentTileId();
    let cnt = 0;
    layers.forEach(ly => {
      const k = tile + '|' + layerUid(ly);
      if (doneSet.has(k)) cnt++;
    });
    hudDone && (hudDone.textContent = String(cnt));
  }

  // ---------- Brush state ----------
  let MODE = 'brush'; // start with brush
  let ERASE = false;
  const Brush = { size: parseInt(($('brushSize2')?.value || '24'), 10), clipPath: null };

  const modePanBtn = $('modePanBtn2');
  const modeBrushBtn = $('modeBrushBtn2');
  const sizeEl = $('brushSize2');
  const sizeVal = $('brushSizeVal2');
  const eraseChk = $('eraseChk2');
  const btnClear = $('clearMask2');
  const btnSave = $('savePng2');
  const btnDone = $('btnMarkDone');

  function setMode(m) {
    MODE = m;
    const isBrush = MODE === 'brush';
    document.body.classList.toggle('tool-brush', isBrush);
    if (isBrush) {
      map.dragging.disable();
      if (!selectedLayer) warn('Brush ON but no polygon selected.');
      rebuildClipPath();
      redrawCursorPreview();
    } else {
      map.dragging.enable();
      clearCursor();
    }
    modeBrushBtn?.classList.toggle('primary', isBrush);
    modePanBtn?.classList.toggle('primary', !isBrush);
  }

  // ---------- clip path ----------
  function rebuildClipPath() {
    Brush.clipPath = null;
    if (!selectedLayer) return;
    const gj = selectedLayer.toGeoJSON();
    const geom = gj?.geometry;
    if (!geom) return;

    const mapRect = map.getContainer().getBoundingClientRect();
    const canvasRect = maskCanvas.getBoundingClientRect();
    const offX = canvasRect.left - mapRect.left;
    const offY = canvasRect.top - mapRect.top;

    const p = new Path2D();
    const addRing = (ring) => {
      ring.forEach(([lng, lat], i) => {
        const pt = map.latLngToContainerPoint([lat, lng]);
        const cx = pt.x - offX, cy = pt.y - offY;
        if (i === 0) p.moveTo(cx, cy); else p.lineTo(cx, cy);
      });
      p.closePath();
    };

    if (geom.type === 'Polygon') geom.coordinates.forEach(addRing);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(poly => poly.forEach(addRing));
    else return;

    Brush.clipPath = p;

    // dim outside + outline
    const w = cursorCanvas.width / DPR, h = cursorCanvas.height / DPR;
    clearCursor();
    if (MODE === 'brush') {
      cursorCtx.save();
      cursorCtx.fillStyle = 'rgba(0,0,0,0.25)';
      cursorCtx.fillRect(0,0,w,h);
      cursorCtx.globalCompositeOperation = 'destination-out';
      cursorCtx.fill(p, 'evenodd');
      cursorCtx.restore();

      cursorCtx.save();
      cursorCtx.setLineDash([6,4]);
      cursorCtx.strokeStyle = 'rgba(80,160,255,.95)';
      cursorCtx.lineWidth = 1.5;
      cursorCtx.stroke(p);
      cursorCtx.restore();
    }
  }
  function isInsideClip(x,y){ return Brush.clipPath ? maskCtx.isPointInPath(Brush.clipPath, x, y, 'evenodd') : false; }

  // ---------- cursor preview ----------
  let lastMouse = { x: null, y: null };
  function clearCursor(){
    const w = cursorCanvas.width / DPR, h = cursorCanvas.height / DPR;
    cursorCtx.clearRect(0,0,w,h);
  }
  function redrawCursorPreview(){
    clearCursor();
    if (MODE !== 'brush' || lastMouse.x == null) return;
    const r = Math.max(1, Brush.size * 0.5);
    cursorCtx.save();
    cursorCtx.strokeStyle = ERASE ? 'rgba(255,70,70,0.9)' : 'rgba(0,255,0,0.9)';
    cursorCtx.lineWidth = 1;
    cursorCtx.beginPath();
    cursorCtx.arc(lastMouse.x, lastMouse.y, r, 0, Math.PI*2);
    cursorCtx.stroke();
    cursorCtx.restore();
  }

  // ---------- utils for layer props / ids ----------
  function layerUid(layer){ return layer._props?.uid || layer.feature?.properties?.uid || String(layer._leaflet_id); }
  function layerLabel(layer){ return layer._props?.uses_fruit || layer._props?.label || 'label'; }
  function layerCode(layer){ return layer._props?.code || 'code'; }

  function polygonPixelBBox(){
    if (!selectedLayer) return null;
    const gj = selectedLayer.toGeoJSON();
    const g = L.geoJSON(gj);
    try {
      const b = g.getBounds();
      const tl = map.latLngToContainerPoint([b.getNorth(), b.getWest()]);
      const br = map.latLngToContainerPoint([b.getSouth(), b.getEast()]);
      const x = Math.floor(tl.x), y = Math.floor(tl.y);
      const w = Math.ceil(br.x - tl.x), h = Math.ceil(br.y - tl.y);
      return { x, y, w, h };
    } catch { return null; }
  }

  // ---------- painting ----------
  let painting = false, lastPt = null;

  function getCanvasXY(e){
    const r = maskCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function drawDot(x,y){
    if (MODE !== 'brush') return;
    if (!isInsideClip(x,y)) return;
    const r = Math.max(1, Brush.size * 0.5);
    maskCtx.save();
    maskCtx.globalCompositeOperation = ERASE ? 'destination-out' : 'source-over';
    maskCtx.beginPath();
    maskCtx.arc(x, y, r, 0, Math.PI*2);
    maskCtx.fillStyle = ERASE ? 'rgba(0,0,0,1)' : 'rgba(0,255,0,0.9)';
    maskCtx.fill();
    maskCtx.restore();
  }

  maskCanvas.addEventListener('mousedown', (e)=>{
    if (MODE!=='brush' || !selectedLayer || !Brush.clipPath) return;
    e.preventDefault(); e.stopPropagation();
    painting = true;
    map.dragging.disable();
    const [x,y] = getCanvasXY(e);
    drawDot(x,y);
    lastPt = [x,y];
  });

  maskCanvas.addEventListener('mousemove', (e)=>{
    const [x,y] = getCanvasXY(e);
    lastMouse.x = x; lastMouse.y = y;
    redrawCursorPreview();

    if (MODE!=='brush' || !painting) return;
    if (lastPt){
      const dx = x - lastPt[0], dy = y - lastPt[1];
      const steps = Math.ceil(Math.hypot(dx,dy) / Math.max(2, Brush.size * 0.35));
      for (let i=1;i<=steps;i++){
        const px = lastPt[0] + (dx*i)/steps;
        const py = lastPt[1] + (dy*i)/steps;
        drawDot(px,py);
      }
      lastPt=[x,y];
    } else {
      drawDot(x,y);
      lastPt=[x,y];
    }
  });

  window.addEventListener('mouseup', ()=>{
    if (!painting) return;
    painting=false;
    lastPt=null;
    if (MODE==='pan') map.dragging.enable();
    debouncedAutoSave(); // <- بعد از هر استروک ذخیره‌ی خودکار
  });

  // ---------- size / erase controls ----------
  sizeEl?.addEventListener('input', ()=>{
    Brush.size = parseInt(sizeEl.value || '24', 10);
    sizeVal && (sizeVal.textContent = `${Brush.size} px`);
    redrawCursorPreview();
  });
  sizeVal && (sizeVal.textContent = `${Brush.size} px`);

  eraseChk?.addEventListener('change', ()=>{ ERASE = !!eraseChk.checked; redrawCursorPreview(); });

  modePanBtn?.addEventListener('click', ()=> setMode('pan'));
  modeBrushBtn?.addEventListener('click', ()=> setMode('brush'));
  setMode('brush');

  btnClear?.addEventListener('click', ()=>{
    const w = maskCanvas.width / DPR, h = maskCanvas.height / DPR;
    maskCtx.clearRect(0,0,w,h);
  });

  // ---------- save / load per polygon ----------
  let saveTimer = null;
  function debouncedAutoSave(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(()=> saveCurrentMaskToServer().catch(()=>{}), 500);
  }

  function buildLocalClip(xShift, yShift){
    // کلیپ همان پولیگان، ولی به مختصات بوم محلیِ کراپ‌شده
    const clip = new Path2D();
    const gj = selectedLayer?.toGeoJSON();
    const geom = gj?.geometry;
    if (!geom) return clip;
    const mapRect = map.getContainer().getBoundingClientRect();
    const canvasRect = maskCanvas.getBoundingClientRect();
    const offX = canvasRect.left - mapRect.left - xShift;
    const offY = canvasRect.top  - mapRect.top  - yShift;
    const addRing = (ring)=>{
      ring.forEach(([lng,lat],i)=>{
        const pt = map.latLngToContainerPoint([lat,lng]);
        const cx = pt.x - offX, cy = pt.y - offY;
        if (i===0) clip.moveTo(cx,cy); else clip.lineTo(cx,cy);
      });
      clip.closePath();
    };
    if (geom.type==='Polygon') geom.coordinates.forEach(addRing);
    else if (geom.type==='MultiPolygon') geom.coordinates.forEach(poly=>poly.forEach(addRing));
    return clip;
  }

  async function saveCurrentMaskToServer(){
    if (!selectedLayer || !Brush.clipPath) return;
    const bbox = polygonPixelBBox();
    if (!bbox) return;
    const {x,y,w,h} = bbox;

    // ماسک محلی: بُرشِ ناحیه‌ی bbox + کلیپ داخل پولیگان
    const tmp = document.createElement('canvas');
    tmp.width = w * DPR; tmp.height = h * DPR;
    const tctx = tmp.getContext('2d');
    tctx.setTransform(DPR,0,0,DPR,0,0);
    tctx.drawImage(maskCanvas, -x, -y);     // انتقال محتوا به سیستم محلی
    const localClip = buildLocalClip(x, y);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.fill(localClip, 'evenodd');

    const blob = await new Promise(res => tmp.toBlob(res, 'image/png', 1));
    if (!blob) return;

    const tileId = currentTileId();
    const uid = layerUid(selectedLayer);
    const fd = new FormData();
    fd.append('file', blob, 'mask.png');
    fd.append('tile_id', tileId);
    fd.append('uid', uid);

    await fetch(`/api/masks/save?tile_id=${encodeURIComponent(tileId)}&uid=${encodeURIComponent(uid)}`, {
      method: 'POST',
      body: fd
    });
  }

  async function loadMaskForCurrentPoly(){
    if (!selectedLayer) return;
    const bbox = polygonPixelBBox();
    if (!bbox) return;
    const {x,y,w,h} = bbox;

    const tileId = currentTileId();
    const uid = layerUid(selectedLayer);
    const url = `/api/masks/get?tile_id=${encodeURIComponent(tileId)}&uid=${encodeURIComponent(uid)}&t=${Date.now()}`;

    const im = new Image();
    return new Promise((resolve,reject)=>{
      im.onload = ()=>{
        // تصویر ماسک قبلی در مختصات محلی bbox به بوم جهانی برگردانده می‌شود
        maskCtx.save();
        maskCtx.drawImage(im, x, y, w, h);
        maskCtx.restore();
        resolve();
      };
      im.onerror = ()=> resolve(); // نبودِ ماسک، مشکلی نیست
      im.src = url;
    });
  }

  // Save as PNG (دانلود لوکال) – اختیاری
  btnSave?.addEventListener('click', async ()=>{
    if (!selectedLayer || !Brush.clipPath) return;
    const bbox = polygonPixelBBox();
    if (!bbox) return;
    const {x,y,w,h} = bbox;

    const tmp = document.createElement('canvas');
    tmp.width = w * DPR; tmp.height = h * DPR;
    const tctx = tmp.getContext('2d');
    tctx.setTransform(DPR,0,0,DPR,0,0);
    tctx.drawImage(maskCanvas, -x, -y);
    const localClip = buildLocalClip(x, y);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.fill(localClip, 'evenodd');

    tmp.toBlob((blob)=>{
      if (!blob) return;
      const ts = new Date(), pad = n => String(n).padStart(2,'0');
      const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
      const fname = `tile-${currentTileId()}_poly-${layerUid(selectedLayer)}_label-${layerLabel(selectedLayer)}_code-${layerCode(selectedLayer)}_${stamp}.png`.replace(/[^\w\-\.\.]+/g,'_');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }, 'image/png', 1);
  });

  btnDone?.addEventListener('click', ()=>{
    if (!selectedLayer) return;
    const k = currentTileId() + '|' + layerUid(selectedLayer);
    doneSet.add(k);
    try { selectedLayer.setStyle({ color:'#22c55e', weight:3 }); } catch {}
    updateHud();
    nextPoly();
  });

  function nextPoly(){
    if (!layers.length) return;
    const start = idx;
    let i = (idx + 1) % layers.length;
    while (i !== start) {
      const k = currentTileId() + '|' + layerUid(layers[i]);
      if (!doneSet.has(k)) break;
      i = (i + 1) % layers.length;
    }
    selectByIndex(i);
  }
  function prevPoly(){
    if (!layers.length) return;
    let i = (idx - 1 + layers.length) % layers.length;
    selectByIndex(i);
  }
  btnNext?.addEventListener('click', nextPoly);
  btnPrev?.addEventListener('click', prevPoly);

  // ---------- load polygons (filter by sceneBounds) ----------
  async function loadPolygonsForScene(){
    if (!sceneBounds) return;
    const r = await fetch('/api/polygons', { cache:'no-store' });
    if (!r.ok) return;

    const gj = await r.json();
    drawn.clearLayers();
    layers = [];

    // فقط آن‌هایی که با sceneBounds هم‌پوشانی دارند را اضافه کن
    L.geoJSON(gj, {
      onEachFeature: (feat, layer) => {
        const b = layer.getBounds?.();
        if (!b || !b.intersects(sceneBounds)) return; // خارج از این تایل
        layer._props = { ...(feat.properties || {}) };
        layer.setStyle?.({ color:'#22c55e', weight:2 });
        layer.on('click', ()=>{
          const i = layers.indexOf(layer);
          if (i>=0) selectByIndex(i);
        });
        drawn.addLayer(layer);
        layers.push(layer);
      }
    });

    if (layers.length) {
      selectByIndex(0);
      try { map.fitBounds(L.featureGroup(layers).getBounds().pad(0.2)); } catch {}
    }
    updateHud();
  }

  // ---------- upload (اختیاری) ----------
  const uploadInp = $('polyUpload2');
  const uploadBtn = $('loadPolygonsBtn2');
  uploadBtn?.addEventListener('click', async ()=>{
    const f = uploadInp?.files?.[0];
    if (!f) return alert('Choose a .geojson/.json or .zip shapefile first.');
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch('/api/polygons/upload', { method:'POST', body: fd });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) return alert('Upload failed: '+(j.error||r.status));
    await loadPolygonsForScene();
    alert('Polygons uploaded.');
  });

  // ---------- shortcuts ----------
  window.addEventListener('keydown', (e)=>{
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (['input','textarea','select'].includes(tag) || e.isComposing) return;

    switch (e.key) {
      case 'b': case 'B': setMode('brush'); break;
      case 'v': case 'V': setMode('pan');   break;
      case '[': Brush.size=Math.max(2,Brush.size-1); if(sizeEl) sizeEl.value=String(Brush.size); if(sizeVal) sizeVal.textContent=`${Brush.size} px`; redrawCursorPreview(); break;
      case ']': Brush.size=Math.min(128,Brush.size+1); if(sizeEl) sizeEl.value=String(Brush.size); if(sizeVal) sizeVal.textContent=`${Brush.size} px`; redrawCursorPreview(); break;
      case 'e': case 'E': ERASE=!ERASE; if (eraseChk) eraseChk.checked=ERASE; redrawCursorPreview(); break;
      case 'n': case 'N': nextPoly(); break;
      case 'p': case 'P': prevPoly(); break;
      case 's': case 'S': e.preventDefault(); btnSave?.click(); break;
      case 'l': case 'L': btnDone?.click(); break;
    }
  });

  // ---------- bootstrap ----------
  (async function bootstrap(){
    await loadSceneOverlay();
    resizeCanvases();
    await loadPolygonsForScene();
  })();

})();