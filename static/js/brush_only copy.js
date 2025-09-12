// static/js/brush_only.js (safe guards everywhere)
(() => {
    const DBG = true;
    const log = (...a) => DBG && console.debug('[BRUSH]', ...a);
    const warn = (...a) => DBG && console.warn('[BRUSH]', ...a);

    // ---- Helpers to safely get elements
    const $ = (id) => {
        const el = document.getElementById(id);
        if (!el) warn('missing element #' + id);
        return el;
    };

    // ---- Map ----
    const map = L.map('map', { zoomSnap: 1, zoomDelta: 1, keyboard: false });
    L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Esri' }
    ).addTo(map);
    map.setView([30.0, 52.0], 12);

    // ---- Draw layer + control ----
    const drawn = new L.FeatureGroup();
    map.addLayer(drawn);
    const drawControl = new L.Control.Draw({
        draw: {
            polygon: { shapeOptions: { color: '#22c55e', weight: 2 } },
            marker: false, circle: false, polyline: false, rectangle: false, circlemarker: false
        },
        edit: { featureGroup: drawn }
    });
    map.addControl(drawControl);

    // ---- State ----
    let selectedLayer = null;
    let MODE = 'pan'; // 'pan' | 'brush'
    let ERASE = false;
    const DPR = Math.max(1, window.devicePixelRatio || 1);
    const Brush = { size: 24, clipPath: null };

    // ---- Canvases ----
    const maskCanvas = $('maskCanvas');
    const cursorCanvas = $('cursorCanvas');
    const maskCtx = maskCanvas?.getContext('2d');
    const cursorCtx = cursorCanvas?.getContext('2d');

    if (!maskCanvas || !cursorCanvas || !maskCtx || !cursorCtx) {
        warn('canvas missing; aborting brush logic');
        return;
    }

    // ---- UI (IDs must match brush.html) ----
    const modePanBtn = $('modePanBtn2');
    const modeBrushBtn = $('modeBrushBtn2');
    const sizeEl = $('brushSize2');
    const sizeVal = $('brushSizeVal2');
    const eraseChk = $('eraseChk2');
    const btnClear = $('clearMask2');
    const btnSave = $('savePng2');
    const uploadInp = $('polyUpload2');
    const uploadBtn = $('loadPolygonsBtn2');

    // ---- Mode, cursor, resize ----
    // اگر می‌خواهی موقع رفتن به حالت Pan نقاشی پاک شود تا جابجا دیده نشود:
    const CLEAR_ON_PAN = true;

    function clearCursor() {
        const w = cursorCanvas.width / DPR, h = cursorCanvas.height / DPR;
        cursorCtx.clearRect(0, 0, w, h);
    }

    function redrawCursorPreview() {
        clearCursor();
        if (MODE !== 'brush' || lastMouse == null) return;
        const { x, y } = lastMouse;
        cursorCtx.save();
        cursorCtx.strokeStyle = ERASE ? 'rgba(255,70,70,0.9)' : 'rgba(0,255,0,0.9)';
        cursorCtx.lineWidth = 1;
        cursorCtx.beginPath();
        cursorCtx.arc(x, y, Math.max(1, Brush.size * 0.5), 0, Math.PI * 2);
        cursorCtx.stroke();
        cursorCtx.restore();
    }

    function setMode(nextMode) {
        MODE = nextMode;                               // فقط یک بار مقدار بده
        const isBrush = MODE === 'brush';

        // کلاس بدنه برای pointer-events کانواس
        document.body.classList.toggle('tool-brush', isBrush);

        // درگ نقشه
        if (isBrush) {
            map.dragging.disable();
        } else {
            map.dragging.enable();
            if (CLEAR_ON_PAN) {
                // برای جلوگیری از جابجایی ظاهری نقاشی هنگام پن
                maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            }
        }

        // حالت دکمه‌ها
        if (modeBrushBtn) modeBrushBtn.classList.toggle('primary', isBrush);
        if (modePanBtn) modePanBtn.classList.toggle('primary', !isBrush);

        // کلیپ‌پث و نشانگر
        if (isBrush) {
            if (!selectedLayer) warn('Brush ON but no polygon selected.');
            rebuildClipPath();        // در صورت نیاز مجدد می‌سازد
            redrawCursorPreview();    // حلقه‌ی راهنمای قلم
        } else {
            clearCursor();
        }

        log('setMode', MODE);
    }

    function backupAndResizeCanvasKeepMask() {
        const sz = map.getSize(); // CSS px
        // backup mask
        const bak = document.createElement('canvas');
        bak.width = maskCanvas.width; bak.height = maskCanvas.height;
        bak.getContext('2d').drawImage(maskCanvas, 0, 0);

        [maskCanvas, cursorCanvas].forEach(cnv => {
            cnv.width = Math.round(sz.x * DPR);
            cnv.height = Math.round(sz.y * DPR);
            cnv.style.width = sz.x + 'px';
            cnv.style.height = sz.y + 'px';
            const ctx = cnv.getContext('2d');
            ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
            if (cnv === cursorCanvas) ctx.clearRect(0, 0, cnv.width, cnv.height);
        });

        // restore mask scaled
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCtx.drawImage(bak, 0, 0, maskCanvas.width, maskCanvas.height);
    }

    function selectLayer(layer) {
        try {
            if (selectedLayer && selectedLayer !== layer) {
                selectedLayer.setStyle?.({ weight: 2, color: '#22c55e' });
            }
            selectedLayer = layer;
            selectedLayer.setStyle?.({ weight: 3, color: '#4f46e5' });
        } catch { }
        rebuildClipPath();
    }

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
            for (let i = 0; i < ring.length; i++) {
                const lng = ring[i][0], lat = ring[i][1];
                const pt = map.latLngToContainerPoint([lat, lng]);
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
            cursorCtx.stroke(p);
            cursorCtx.restore();
        }
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

    // ---- Map events ----
    map.on('load zoom move', rebuildClipPath);
    map.on('resize', () => { backupAndResizeCanvasKeepMask(); rebuildClipPath(); });
    setTimeout(() => { backupAndResizeCanvasKeepMask(); }, 0);
    window.addEventListener('resize', () => { backupAndResizeCanvasKeepMask(); rebuildClipPath(); });

    map.on(L.Draw.Event.CREATED, (e) => {
        const layer = e.layer;
        drawn.addLayer(layer);
        layer.on('click', () => selectLayer(layer));
        selectLayer(layer);
        try { map.fitBounds(layer.getBounds().pad(0.1)); } catch { }
    });
    drawn.on('click', (e) => selectLayer(e.layer));

    // ---- Load polygons from /api/polygons ----
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
                try { map.fitBounds(first.getBounds().pad(0.1)); } catch { }
            }
            log('polygons loaded');
        } catch (e) {
            warn('loadPolygonsFromServer failed', e);
        }
    }
    loadPolygonsFromServer();

    // ---- Upload polygons ----
    if (uploadBtn) {
        uploadBtn.addEventListener('click', async () => {
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
    }

    // ---- Brush controls (with guards) ----
    if (sizeEl) {
        // مقدار اولیه امن
        Brush.size = parseInt(sizeEl.value || '24', 10);
        if (sizeVal) sizeVal.textContent = `${Brush.size} px`;
        sizeEl.addEventListener('input', () => {
            Brush.size = parseInt(sizeEl.value || '24', 10);
            if (sizeVal) sizeVal.textContent = `${Brush.size} px`;
            redrawCursorPreview();
        });
    } else {
        warn('brushSize2 not found; using default size', Brush.size);
    }

    if (eraseChk) {
        eraseChk.addEventListener('change', () => {
            ERASE = !!eraseChk.checked;
            redrawCursorPreview();
        });
    }

    modePanBtn && modePanBtn.addEventListener('click', () => setMode('pan'));
    modeBrushBtn && modeBrushBtn.addEventListener('click', () => setMode('brush'));
    setMode('pan'); // شروع با Drag

    btnClear && btnClear.addEventListener('click', () => {
        const w = maskCanvas.width / DPR, h = maskCanvas.height / DPR;
        maskCtx.clearRect(0, 0, w, h);
        redrawCursorPreview();
    });

    btnSave && btnSave.addEventListener('click', () => {
        const tmp = document.createElement('canvas');
        tmp.width = maskCanvas.width;
        tmp.height = maskCanvas.height;
        tmp.getContext('2d').drawImage(maskCanvas, 0, 0);

        tmp.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const uid = Date.now();  // یا مثلا uuidv4()
            a.href = url;
            a.download = `mask_${uid}.png`;  // اسم‌دار
            a.click();
            URL.revokeObjectURL(url);
        }, 'image/png');
    });

    // ---- Painting ----
    let painting = false, lastPt = null;
    const lastMouse = { x: null, y: null };

    function getCanvasXY(e) {
        const r = maskCanvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    function drawDot(x, y) {
        if (MODE !== 'brush') return;

        const r = Brush.size * 0.5;
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

        // preview circle
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

    // ---- Shortcuts ----
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