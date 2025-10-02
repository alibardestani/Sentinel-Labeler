// // ===============================
// // mask.js  –  Canvas mask editor
// // ===============================

// // ---------- Canvas refs ----------
// const backdrop = document.getElementById('backdrop');
// const mask = document.getElementById('mask');
// const cursorCanvas = document.getElementById('cursorCanvas'); // لایه‌ی نشانگر

// if (!backdrop || !mask || !cursorCanvas) {
//   console.error('[mask] required canvas elements not found.');
// }

// // کانتکست‌ها (وقتی عنصر هست)
// const ctxB = backdrop?.getContext('2d');
// const ctxM = mask?.getContext('2d');
// const ctxCursor = cursorCanvas?.getContext('2d');

// // لایه‌ی کرسر نباید رویداد بگیرد (کلیک‌ها بروند به mask)
// if (cursorCanvas) cursorCanvas.style.pointerEvents = 'none';

// // ---------- State ----------
// let tool = 'brush';
// let zoom = 1;
// let panX = 0, panY = 0;      // در واحد CSS px
// let W = 0, H = 0;            // ابعاد تصویر پس‌زمینه (پیکسل تصویر)
// let baseScale = 1;           // fit-to-view scale (CSS px per image px)

// // نمایش ماسک روی offscreen
// let maskImageData = null;    // RGBA نمایش اوورلی
// let maskOffscreen = null, maskOffCtx = null;

// // کلاس واقعی پیکسل‌ها (0=پس‌زمینه، 1=Vegetation، 2=Other)
// let classMap = null;

// // آخرین موقعیت موس روی canvas (CSS px) برای بازکشیدن کرسر
// let lastCursorCss = { x: null, y: null };

// // پالت رنگ برای نمایش (صرفاً ویژوال)
// const PALETTE = {
//   0: [0, 0, 0, 0],           // شفاف
//   1: [0, 255, 0, 180],       // سبز نیمه‌شفاف
//   2: [139, 69, 19, 180]      // قهوه‌ای نیمه‌شفاف
// };

// // رنگ حاشیه‌ی نشانگر قلم بر اساس کلاس انتخابی
// function cursorStrokeColorForClass(cid){
//   if (cid === 1) return 'rgba(0, 255, 0, 0.95)';
//   if (cid === 2) return 'rgba(139, 69, 19, 0.95)';
//   return 'rgba(255,255,255,0.95)'; // برای 0 یا نامشخص
// }

// // ---------- Backdrop (با cache-busting) ----------
// const imgB = new Image();
// imgB.src = '/api/output/rgb_quicklook.png?t=' + Date.now();

// // ---------- Layout / Resize ----------
// function getWrapRect() {
//   const wrap = document.querySelector('.canvas-wrap');
//   return wrap ? wrap.getBoundingClientRect() : null;
// }

// function resizeCursorCanvas() {
//   const rect = getWrapRect(); if (!rect || !cursorCanvas) return;
//   const dpr = window.devicePixelRatio || 1;
//   cursorCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
//   cursorCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
//   cursorCanvas.style.width = rect.width + "px";
//   cursorCanvas.style.height = rect.height + "px";
//   clearCursor();
//   if (tool === 'brush' && lastCursorCss.x !== null) {
//     drawCursor(lastCursorCss.x, lastCursorCss.y);
//   }
// }

// function resizeCanvas(){
//   const rect = getWrapRect(); if (!rect || !backdrop || !mask) return;
//   const dpr = window.devicePixelRatio || 1;
//   const cw = rect.width, ch = rect.height;

//   // اندازه‌ی بافر کانواس‌ها به پیکسل دستگاه
//   backdrop.width = Math.max(1, Math.floor(cw * dpr));
//   backdrop.height = Math.max(1, Math.floor(ch * dpr));
//   backdrop.style.width = cw + 'px'; backdrop.style.height = ch + 'px';

//   mask.width = Math.max(1, Math.floor(cw * dpr));
//   mask.height = Math.max(1, Math.floor(ch * dpr));
//   mask.style.width = cw + 'px'; mask.style.height = ch + 'px';

//   // محاسبه‌ی baseScale برای جای‌گذاری تصویر در قاب
//   if (W > 0 && H > 0) {
//     const sx = cw / W, sy = ch / H;
//     baseScale = Math.max(1e-9, Math.min(sx, sy));
//     const viewScale = baseScale * zoom;
//     panX = (cw - W * viewScale) / 2;
//     panY = (ch - H * viewScale) / 2;
//   }

//   // هم‌اندازه کردن لایه‌ی کرسر
//   resizeCursorCanvas();

//   draw();
// }

// window.addEventListener('resize', resizeCanvas);

// // ---------- Draw ----------
// function draw(){
//   const rect = getWrapRect(); if (!rect || !ctxB || !ctxM) return;
//   const cw = rect.width, ch = rect.height;
//   const dpr = window.devicePixelRatio || 1;
//   const viewScale = baseScale * zoom;

//   // --- بک‌دراپ ---
//   ctxB.setTransform(dpr, 0, 0, dpr, 0, 0); // کار در واحد CSS، نگاشت به پیکسل دستگاه
//   ctxB.clearRect(0, 0, cw, ch);
//   ctxB.save();
//   ctxB.translate(panX, panY);
//   ctxB.scale(viewScale, viewScale);
//   ctxB.imageSmoothingEnabled = false;
//   if (W && H) {
//     ctxB.drawImage(imgB, 0, 0, W, H, 0, 0, W, H);
//   }
//   ctxB.restore();

//   // --- ماسک ---
//   ctxM.setTransform(dpr, 0, 0, dpr, 0, 0);
//   ctxM.clearRect(0, 0, cw, ch);
//   ctxM.save();
//   ctxM.translate(panX, panY);
//   ctxM.scale(viewScale, viewScale);
//   ctxM.imageSmoothingEnabled = false;
//   ctxM.globalAlpha = 1.0; // آلفا داخل پالت
//   if (maskOffscreen) {
//     ctxM.drawImage(maskOffscreen, 0, 0, W, H, 0, 0, W, H);
//   }
//   ctxM.restore();

//   // --- کرسر ---
//   if (lastCursorCss.x !== null && lastCursorCss.y !== null && tool === 'brush') {
//     drawCursor(lastCursorCss.x, lastCursorCss.y);
//   } else {
//     clearCursor();
//   }
// }

// // ---------- Build RGBA from classMap ----------
// function rebuildOverlayFromClassMap(){
//   if (!classMap || !maskOffCtx) return;
//   const rgba = new Uint8ClampedArray(W * H * 4);
//   for (let i = 0; i < W * H; i++) {
//     const c = classMap[i] | 0;
//     const p = PALETTE[c] || PALETTE[0];
//     const o = i * 4;
//     rgba[o+0] = p[0];
//     rgba[o+1] = p[1];
//     rgba[o+2] = p[2];
//     rgba[o+3] = p[3];
//   }
//   maskImageData = new ImageData(rgba, W, H);
//   maskOffCtx.putImageData(maskImageData, 0, 0);
// }

// // ---------- Fetch mask (raw bytes) ----------
// async function fetchMask(){
//   try{
//     const r = await fetch('/api/mask_raw?t=' + Date.now(), { cache: 'no-store' });
//     if (!r.ok) throw new Error('mask_raw not ok');
//     const buf = await r.arrayBuffer();
//     const arr = new Uint8Array(buf);

//     // اندازه را با W,H چک کن
//     if (arr.length !== W*H) {
//       console.warn('mask size mismatch', arr.length, 'vs', W*H, '→ using empty classMap sized W×H');
//       classMap = new Uint8Array(W*H); // صفر
//     } else {
//       classMap = arr; // بدون کپی
//     }

//     rebuildOverlayFromClassMap();
//     draw();
//   }catch(err){
//     console.error('fetchMask failed', err);
//   }
// }

// // ---------- Image onload ----------
// imgB.onload = () => {
//   W = imgB.naturalWidth || 0;
//   H = imgB.naturalHeight || 0;

//   // offscreen
//   maskOffscreen = document.createElement('canvas');
//   maskOffscreen.width = Math.max(1, W);
//   maskOffscreen.height = Math.max(1, H);
//   maskOffCtx = maskOffscreen.getContext('2d');

//   // بعد از لود تصویر، یک بار resize برای محاسبه‌ی baseScale
//   resizeCanvas();
//   fetchMask();
// };

// // ---------- Screen ↔ Image coords ----------
// function cssToImage(xCss, yCss){
//   const viewScale = baseScale * zoom;
//   const ix = Math.floor((xCss - panX) / viewScale);
//   const iy = Math.floor((yCss - panY) / viewScale);
//   return [ix, iy];
// }

// // ---------- Painting ----------
// function paintAt(ix, iy){
//   if (!classMap || !maskImageData || !maskOffCtx) return;

//   const size = parseInt(document.getElementById('brushSize')?.value || 16, 10);
//   const shape = document.getElementById('brushShape')?.value || 'circle';
//   const cid   = parseInt(document.getElementById('classId')?.value || 1, 10); // پیش‌فرض 1

//   const half = Math.floor(size/2);
//   const data = maskImageData.data;
//   const p = PALETTE[cid] || PALETTE[0];

//   function setPx(x, y){
//     if (x < 0 || y < 0 || x >= W || y >= H) return;
//     const idx = y * W + x;
//     classMap[idx] = cid; // داده‌ی واقعی
//     const off = idx * 4; // داده‌ی نمایشی
//     data[off+0] = p[0]; data[off+1] = p[1];
//     data[off+2] = p[2]; data[off+3] = p[3];
//   }

//   for (let dy = -half; dy <= half; dy++) {
//     for (let dx = -half; dx <= half; dx++) {
//       const x = ix + dx, y = iy + dy;
//       if (shape === 'circle' && (dx*dx + dy*dy) > half*half) continue;
//       setPx(x, y);
//     }
//   }

//   maskOffCtx.putImageData(maskImageData, 0, 0);
//   draw();           // رندر مجدد
//   scheduleSnapshot();
// }

// // ---------- Cursor helpers ----------
// function clearCursor() {
//   if (!ctxCursor || !cursorCanvas) return;
//   ctxCursor.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
// }

// function drawCursor(xCss, yCss) {
//   if (!ctxCursor || !cursorCanvas) return;

//   const size = parseInt(document.getElementById('brushSize')?.value || 16, 10);
//   const shape = document.getElementById('brushShape')?.value || 'circle';
//   const cid   = parseInt(document.getElementById('classId')?.value || 1, 10);
//   const stroke = cursorStrokeColorForClass(cid);

//   const dpr = window.devicePixelRatio || 1;
//   ctxCursor.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
//   ctxCursor.save();
//   ctxCursor.scale(dpr, dpr);

//   // حاشیه‌ی واضح + سایه برای دیده شدن روی هر بک‌دراپ
//   ctxCursor.lineWidth = 2;
//   ctxCursor.strokeStyle = stroke;
//   ctxCursor.shadowColor = "rgba(0,0,0,0.6)";
//   ctxCursor.shadowBlur = 2;

//   const pxRadius = (size * baseScale * zoom) / 2; // اندازه در pxِ صفحه

//   if (shape === 'circle') {
//     ctxCursor.beginPath();
//     ctxCursor.arc(xCss, yCss, pxRadius, 0, Math.PI * 2);
//     ctxCursor.stroke();
//   } else {
//     ctxCursor.strokeRect(xCss - pxRadius, yCss - pxRadius, pxRadius * 2, pxRadius * 2);
//   }

//   // نقطه‌ی مرکزی کوچک (ثابت 2px روی صفحه)
//   ctxCursor.beginPath();
//   ctxCursor.arc(xCss, yCss, 2, 0, Math.PI * 2);
//   ctxCursor.stroke();

//   ctxCursor.restore();
// }

// // ---------- Events ----------
// let isDown = false;

// mask?.addEventListener('mousedown', (e) => {
//   isDown = true;
//   const rect = mask.getBoundingClientRect();
//   const xCss = e.clientX - rect.left;
//   const yCss = e.clientY - rect.top;
//   lastCursorCss = { x: xCss, y: yCss };
//   mask.style.cursor = (tool === 'pan') ? 'grabbing' : 'crosshair';

//   if (tool === 'brush') {
//     drawCursor(xCss, yCss);
//     const [ix, iy] = cssToImage(xCss, yCss);
//     paintAt(ix, iy);
//   }
// });

// mask?.addEventListener('mousemove', (e) => {
//   const rect = mask.getBoundingClientRect();
//   const xCss = e.clientX - rect.left;
//   const yCss = e.clientY - rect.top;
//   lastCursorCss = { x: xCss, y: yCss };

//   if (tool === 'brush') {
//     drawCursor(xCss, yCss);
//     if (isDown) {
//       const [ix, iy] = cssToImage(xCss, yCss);
//       paintAt(ix, iy);
//     }
//   } else if (tool === 'pan') {
//     clearCursor();
//     if (isDown) {
//       panX += e.movementX;
//       panY += e.movementY;
//       draw();
//     }
//   } else {
//     // zoom یا ابزار دیگر
//     clearCursor();
//   }
// });

// mask?.addEventListener('mouseleave', () => {
//   lastCursorCss = { x: null, y: null };
//   clearCursor();
// });

// window.addEventListener('mouseup', () => {
//   isDown = false;
//   if (mask) mask.style.cursor = (tool === 'pan') ? 'grab' : 'crosshair';
// });

// // زوم حول محل موس
// mask?.addEventListener('wheel', (e) => {
//   if (tool !== 'zoom') return;
//   e.preventDefault();

//   const rect = mask.getBoundingClientRect();
//   const xCss = e.clientX - rect.left;
//   const yCss = e.clientY - rect.top;

//   const scaleBefore = baseScale * zoom;
//   const factor = e.deltaY < 0 ? 1.1 : 0.9;
//   const scaleAfter = scaleBefore * factor;

//   // حفظ نقطه‌ی موس روی همان نقطه‌ی تصویر
//   const ix = (xCss - panX) / scaleBefore;
//   const iy = (yCss - panY) / scaleBefore;

//   zoom *= factor;
//   panX = xCss - ix * scaleAfter;
//   panY = yCss - iy * scaleAfter;

//   draw();
// }, { passive: false });

// // ---------- Toolbar ----------
// document.getElementById('toolBrush')?.addEventListener('click', () => {
//   tool = 'brush'; if (mask) mask.style.cursor = 'crosshair';
//   if (lastCursorCss.x !== null) drawCursor(lastCursorCss.x, lastCursorCss.y);
// });
// document.getElementById('toolPan')?.addEventListener('click',   () => {
//   tool = 'pan';   if (mask) mask.style.cursor = 'grab'; clearCursor();
// });
// document.getElementById('toolZoom')?.addEventListener('click',  () => {
//   tool = 'zoom';  if (mask) mask.style.cursor = 'zoom-in'; clearCursor();
// });

// // ---------- Save (lossless) ----------
// document.getElementById('saveMaskBtn')?.addEventListener('click', async () => {
//   if (!classMap) return;
//   const r = await fetch('/api/save_mask', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
//     body: classMap      // 0/1/2/...
//   });
//   alert(r.ok ? 'ماسک ذخیره شد' : 'خطا در ذخیره ماسک');
// });

// // ---------- Keyboard UX (Zoom / Pan / Brush / Shortcuts) ----------
// (function(){
//   if (!document.getElementById('mask')) return;

//   const PAN_STEP = 80;       // px per key press
//   const ZOOM_FACTOR = 1.15;

//   // Space-pan
//   let prevTool = null;
//   window.addEventListener('keydown', (e) => {
//     const tag = (e.target && e.target.tagName || '').toLowerCase();
//     if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing) return;

//     if (e.code === 'Space' && prevTool === null) {
//       prevTool = tool;
//       tool = 'pan';
//       if (mask) mask.style.cursor = 'grab';
//       clearCursor();
//     }
//   });
//   window.addEventListener('keyup', (e) => {
//     if (e.code === 'Space' && prevTool !== null) {
//       tool = prevTool;
//       prevTool = null;
//       if (mask) mask.style.cursor = (tool === 'pan') ? 'grab' : (tool === 'zoom' ? 'zoom-in' : 'crosshair');
//       if (tool === 'brush' && lastCursorCss.x !== null) drawCursor(lastCursorCss.x, lastCursorCss.y);
//     }
//   });

//   function clampBrushSize(v) {
//     const input = document.getElementById('brushSize');
//     const min = parseInt(input?.min || '1', 10);
//     const max = parseInt(input?.max || '256', 10);
//     v = Math.max(min, Math.min(max, v));
//     if (input) input.value = String(v);
//     return v;
//   }
//   function setBrushSize(delta, withShift) {
//     const input = document.getElementById('brushSize');
//     const cur = parseInt(input?.value || '16', 10);
//     const step = withShift ? 10 : 1;
//     clampBrushSize(cur + delta * step);
//     if (tool === 'brush' && lastCursorCss.x !== null) drawCursor(lastCursorCss.x, lastCursorCss.y);
//   }
//   function setClassId(n) {
//     const sel = document.getElementById('classId');
//     if (!sel) return;
//     for (let i=0;i<sel.options.length;i++){
//       if (sel.options[i].value === String(n)) { sel.selectedIndex = i; break; }
//     }
//     if (tool === 'brush' && lastCursorCss.x !== null) drawCursor(lastCursorCss.x, lastCursorCss.y);
//   }
//   function setToolKey(name){
//     tool = name;
//     if (mask) mask.style.cursor = (name==='pan'?'grab':name==='zoom'?'zoom-in':'crosshair');
//     if (tool === 'brush' && lastCursorCss.x !== null) drawCursor(lastCursorCss.x, lastCursorCss.y);
//     else clearCursor();
//   }
//   function panBy(dx, dy){ panX += dx; panY += dy; draw(); }
//   function zoomAtCenter(factor){
//     const rect = mask.getBoundingClientRect();
//     const xCss = rect.width / 2;
//     const yCss = rect.height / 2;

//     const scaleBefore = baseScale * zoom;
//     const scaleAfter  = scaleBefore * factor;
//     const ix = (xCss - panX) / scaleBefore;
//     const iy = (yCss - panY) / scaleBefore;

//     zoom *= factor;
//     panX = xCss - ix * scaleAfter;
//     panY = yCss - iy * scaleAfter;
//     draw();
//   }
//   function save(){ document.getElementById('saveMaskBtn')?.click(); }

//   // Undo/Redo سبک (پشته)
//   let undoStack = [], redoStack = [];
//   let snapshotTimer = null;
//   function snapshotMask() {
//     if (!classMap) return;
//     undoStack.push(new Uint8Array(classMap));
//     if (undoStack.length > 20) undoStack.shift();
//     redoStack.length = 0;
//   }
//   function scheduleSnapshot() {
//     clearTimeout(snapshotTimer);
//     snapshotTimer = setTimeout(snapshotMask, 500);
//   }
//   // در دسترس سراسری تا paintAt صدا بزند
//   window.scheduleSnapshot = scheduleSnapshot;

//   function applyClassMapCopy(copy){
//     if (!classMap) return;
//     classMap.set(copy);
//     rebuildOverlayFromClassMap();
//     draw();
//   }
//   function undo(){
//     if (!undoStack.length || !classMap) return;
//     redoStack.push(new Uint8Array(classMap));
//     const last = undoStack.pop();
//     applyClassMapCopy(last);
//   }
//   function redo(){
//     if (!redoStack.length || !classMap) return;
//     undoStack.push(new Uint8Array(classMap));
//     const nxt = redoStack.pop();
//     applyClassMapCopy(nxt);
//   }

//   function toggleHelp() {
//     let el = document.getElementById('hotkeyHelp');
//     if (!el) {
//       el = document.createElement('div');
//       el.id = 'hotkeyHelp';
//       el.style.cssText = 'position:fixed; inset:auto 12px 12px auto; z-index:99999; background:rgba(0,0,0,.75); color:#fff; padding:12px; border-radius:8px; max-width:460px; font:12px/1.6 ui-sans-serif,system-ui;';
//       el.innerHTML = `
//         <b>Shortcuts (Mask)</b><br>
//         Tools: B=Brush, V=Pan, Z=Zoom<br>
//         Class: 0 / 1 / 2 &nbsp;&nbsp; Brush size: [ and ] (hold Shift for ±10)<br>
//         Zoom: + / - &nbsp; Pan: Arrows/WASD &nbsp; Save: Ctrl/Cmd + S<br>
//         Undo/Redo: Ctrl/Cmd + Z / Ctrl/Cmd + Y<br>
//         Hold Space: temporary pan<br>
//         Close: ?
//       `;
//       document.body.appendChild(el);
//     } else {
//       el.remove();
//     }
//   }

//   // Keydown handler اصلی
//   window.addEventListener('keydown', (e) => {
//     const tag = (e.target && e.target.tagName || '').toLowerCase();
//     if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing) return;

//     // Save
//     if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
//     // Undo/Redo
//     if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
//     if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }

//     switch (e.key) {
//       // ابزارها
//       case 'b': case 'B': setToolKey('brush'); break;
//       case 'v': case 'V': setToolKey('pan');   break;
//       case 'z': case 'Z': setToolKey('zoom');  break;

//       // کلاس
//       case '0': setClassId(0); break;
//       case '1': setClassId(1); break;
//       case '2': setClassId(2); break;

//       // قلم
//       case '[': setBrushSize(-1, e.shiftKey); break;
//       case ']': setBrushSize(+1, e.shiftKey); break;

//       // زوم
//       case '+':
//       case '=': e.preventDefault(); zoomAtCenter(ZOOM_FACTOR); break;
//       case '-': e.preventDefault(); zoomAtCenter(1/ZOOM_FACTOR); break;

//       // پن
//       case 'ArrowUp':
//       case 'w': case 'W': e.preventDefault(); panBy(0, -PAN_STEP); break;
//       case 'ArrowDown':
//       case 's': case 'S': e.preventDefault(); panBy(0, +PAN_STEP); break;
//       case 'ArrowLeft':
//       case 'a': case 'A': e.preventDefault(); panBy(-PAN_STEP, 0); break;
//       case 'ArrowRight':
//       case 'd': case 'D': e.preventDefault(); panBy(+PAN_STEP, 0); break;

//       // راهنما
//       case '?':
//       case 'h': case 'H': e.preventDefault(); toggleHelp(); break;
//     }
//   });
// })();


// window.reloadBackdropAndMaskAfterUpload = async function reloadBackdropAndMaskAfterUpload() {
//   imgB.src = '/api/output/rgb_quicklook.png?t=' + Date.now();
// };

// window.addEventListener('s2:scene-updated', async () => {
//   try {
//     const r = await fetch('/api/s2_bounds_wgs84', { cache: 'no-store' });
//     if (!r.ok) return;
//     const b = await r.json();
//     const bounds = [[b.lat_min, b.lon_min], [b.lat_max, b.lon_max]];
//     const url = '/api/output/rgb_quicklook.png?t=' + Date.now();

//     if (overlay) {
//       overlay.setUrl(url);
//       overlay.setBounds(bounds);
//     } else {
//       overlay = L.imageOverlay(url, bounds, { opacity: 0.6 }).addTo(map);
//     }
//     map.fitBounds(bounds);
//   } catch (e) {
//     console.warn('post-upload refresh failed', e);
//   }
// });

// // ---------- Boot ----------
// window.addEventListener('DOMContentLoaded', () => {
//   if (imgB.complete && imgB.naturalWidth > 0) {
//     imgB.onload(); 
//   }
// });