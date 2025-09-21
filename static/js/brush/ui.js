// static/js/brush/ui.js
console.log("[BRUSH:ui] loaded");
;(() => {
  const DBG  = true;
  const log  = (...a) => DBG && console.debug("[BRUSH:ui]", ...a);
  const warn = (...a) => DBG && console.warn ("[BRUSH:ui]", ...a);
  const err  = (...a) => DBG && console.error("[BRUSH:ui]", ...a);
  const $    = (id) => document.getElementById(id);

  // ---------- small utils ----------
  const pad2 = (n) => String(n).padStart(2, "0");
  function nowStamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }

  // سِیو فایل سمت کلاینت
  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  // ---------- HUD updater ----------
  function makeHudUpdater(App, IO) {
    const hudTile   = $("hudTileRC");   // روی راست
    const hudTile2  = $("hudTileRC2");  // در پنل Grid
    const hudIndex  = $("hudIndex");
    const hudTotal  = $("hudTotal");
    const hudDone   = $("hudDone");
    return function updateHud() {
      try {
        const r = App?.grid?.active?.r ?? -1;
        const c = App?.grid?.active?.c ?? -1;
        const tileStr = (r>=0 && c>=0) ? `r${r+1}×c${c+1}` : "-";
        if (hudTile)  hudTile.textContent  = tileStr;
        if (hudTile2) hudTile2.textContent = tileStr;

        if (hudTotal) hudTotal.textContent = String(App.layers ? App.layers.length : 0);
        const cur = IO.current ? IO.current() : null;
        const i = cur && App.layers ? App.layers.indexOf(cur) : -1;
        if (hudIndex) hudIndex.textContent = i >= 0 ? String(i + 1) : "-";

        let cnt = 0;
        if (App.layers && IO.isDone) for (const ly of App.layers) if (IO.isDone(ly)) cnt++;
        if (hudDone) hudDone.textContent = String(cnt);
      } catch (e) { err("hud:update", e); }
    };
  }

  // ---------- TILE LOADER overlay ----------
  const tileLoader = () => $("tileLoader");
  function showTileLoader(msg = "Loading tile…") {
    const el = tileLoader(); if (!el) return;
    el.style.display = "grid";
    const box = el.querySelector(".box"); if (box) box.textContent = msg;
  }
  function hideTileLoader() {
    const el = tileLoader(); if (!el) return;
    el.style.display = "none";
  }

  // ---------- Export tile-cropped PNG from the full mask ----------
  /**
   * برش ماسک کل-صحنه به اندازه تایل فعال و خروجی گرفتن PNG
   * بدون نیاز به تغییر core: با دانستن imgW/imgH و rows/cols مستقیماً برش می‌زنیم
   */
  async function exportActiveTileMaskBlob(App, { mime = "image/png" } = {}) {
    if (!App?.fullMaskCanvas || !App?.imgW || !App?.imgH) {
      warn("exportTile: full mask not ready");
      return null;
    }
    const rows = App?.grid?.rows|0, cols = App?.grid?.cols|0;
    const r = App?.grid?.active?.r ?? -1, c = App?.grid?.active?.c ?? -1;
    if (r < 0 || c < 0 || rows <= 0 || cols <= 0) {
      warn("exportTile: invalid grid/active", { r, c, rows, cols });
      return null;
    }
    const imgW = App.imgW|0, imgH = App.imgH|0;

    // تقسیم یکنواخت: پیکسل‌بوکسی که متناظر با ردیف/ستون فعال است
    const x0 = Math.floor((c / cols) * imgW);
    const x1 = Math.floor(((c + 1) / cols) * imgW);
    const y0 = Math.floor((r / rows) * imgH);
    const y1 = Math.floor(((r + 1) / rows) * imgH);
    const w  = Math.max(0, x1 - x0);
    const h  = Math.max(0, y1 - y0);
    if (!w || !h) { warn("exportTile: zero size", { x0, x1, y0, y1, w, h }); return null; }

    const src = App.fullMaskCanvas; // شامل رنگ‌های RGBA کلاس‌ها
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, x0, y0, w, h, 0, 0, w, h);
    const blob = await new Promise(res => off.toBlob(res, mime, 1));
    return blob;
  }

  // ---------- Wire Brush UI / Grid UI ----------
  function wireUI() {
    const App = window.BrushApp;
    const IO  = window.BrushIO || {};
    if (!App) { err("wireUI: BrushApp missing"); return; }

    // یک‌بار نصب: setTileLoading در core استفاده می‌شود
    App.setTileLoading = (on) => on ? showTileLoader() : hideTileLoader();

    // HUD updater
    const updateHud = makeHudUpdater(App, IO);

    // --- Brush controls ---
    const sizeEl   = $("brushSize2");
    const sizeVal  = $("brushSizeVal2");
    const eraseChk = $("eraseChk2");
    const modePanBtn   = $("modePanBtn2");
    const modeBrushBtn = $("modeBrushBtn2");
    const btnClear = $("clearMask2");
    const btnSave  = $("savePng2");
    const btnDone  = $("btnMarkDone");

    const redrawCursor = () => {
      // اگر core اکستنشن پیش‌نمایش دارد:
      if (typeof App._redrawCursorPreview === "function") App._redrawCursorPreview();
    };

    if (sizeEl) {
      sizeEl.addEventListener("input", () => {
        const v = parseInt(sizeEl.value || "24", 10);
        App.setBrushSize?.(v);
        if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
        log("brush:size", { size: App.Brush.size });
        redrawCursor();
      });
      // مقدار اولیه
      if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
    }

    if (eraseChk) {
      eraseChk.addEventListener("change", () => {
        App.setErase?.(!!eraseChk.checked);
        log("erase", { on: eraseChk.checked });
        redrawCursor();
      });
    }

    modePanBtn?.addEventListener("click", () => {
      App.setMode?.("pan");
      modePanBtn.classList.add("primary");
      modeBrushBtn?.classList.remove("primary");
      log("mode:pan");
    });
    modeBrushBtn?.addEventListener("click", () => {
      App.setMode?.("brush");
      modeBrushBtn.classList.add("primary");
      modePanBtn?.classList.remove("primary");
      // اطمینان از فعال‌بودن نقاشی روی بوم
      if (App.maskCanvas?.style.pointerEvents !== "auto") App.maskCanvas.style.pointerEvents = "auto";
      log("mode:brush");
      redrawCursor();
    });

    btnClear?.addEventListener("click", () => {
      App.clearMask?.();
      // اگر بخواهی بعد از پاک کردن فوراً ذخیره هم بکند:
      // IO.saveMaskForSelected?.();
      log("mask:clear");
    });

    // ⭐️ Save PNG: فقط محدوده تایل فعال را خروجی می‌گیریم
    btnSave?.addEventListener("click", async () => {
      try {
        const blob = await exportActiveTileMaskBlob(App);
        if (!blob) { alert("Mask not ready for this tile"); return; }
        const r = App.grid.active.r|0, c = App.grid.active.c|0;
        const sid = App.sceneId || "unknown";
        const fname = `scene-${sid}_r${r}_c${c}_${nowStamp()}.png`;

        // 1) دانلود لوکال
        downloadBlob(blob, fname);

        // 2) آپلود سمت سرور (اختیاری - اگه API نباشه، سایلنت‌فیل)
        try {
          const fd = new FormData();
          fd.append("scene_id", sid);
          fd.append("r", String(r));
          fd.append("c", String(c));
          fd.append("file", blob, fname);
          const resp = await fetch("/api/masks/save_tile_png", { method: "POST", body: fd });
          if (!resp.ok) warn("save_tile_png: http", resp.status);
          else log("save_tile_png:ok", await resp.json().catch(() => ({})));
        } catch (e) {
          warn("save_tile_png: no endpoint or failed", e);
        }
      } catch (e) {
        err("save-png:error", e);
        alert("Save PNG failed");
      }
    });

    // مارک‌دن + ناوبری پلی‌گون (اگر IO باشد)
    btnDone?.addEventListener("click", async () => {
      try { IO.markDoneSelected?.(); await IO.saveMaskForSelected?.(); } catch (e) { warn("done:save", e); }
      try { App.clearMask?.(); } catch {}
      IO.nextIndex?.();
      updateHud();
      log("work:done");
    });

    const btnPrev  = $("btnPrev");
    const btnNext  = $("btnNext");
    btnPrev?.addEventListener("click", () => { IO.prevIndex?.(); updateHud(); log("nav:prev:poly"); });
    btnNext?.addEventListener("click", () => { IO.nextIndex?.(); updateHud(); log("nav:next:poly"); });

    // --- overlay opacity: هم سنّتینل، هم گرید
    const opacitySlider = $("overlayOpacity");
    const opacityVal    = $("opacityValue");
    if (opacitySlider) {
      const apply = () => {
        const v = (parseInt(opacitySlider.value, 10) || 60) / 100;
        // base overlay (اگر داشتی)
        App.overlay?.setOpacity?.(v);
        // grid overlay
        App.grid?.overlay?.setOpacity?.(v);
        if (opacityVal) opacityVal.textContent = v.toFixed(2);
        log("overlay:opacity", { value: v });
      };
      opacitySlider.addEventListener("input", apply);
      apply();
    }

    // --- Grid controls ---
    const gridPrev = $("tilePrev");
    const gridNext = $("tileNext");
    const gridGo   = $("tileGo");
    const tileSel  = $("tileSelect");

    document.addEventListener("brush:tilechange", (ev) => {
      const { r, c } = ev.detail || { r: 0, c: 0 };
      const huds = [$("hudTileRC"), $("hudTileRC2")];
      huds.forEach(h => h && (h.textContent = `r${r + 1}×c${c + 1}`));
      if (tileSel) tileSel.value = `${r},${c}`;
      updateHud();
    });

    gridPrev?.addEventListener("click", () => {
      showTileLoader();
      App.moveTile?.(0, -1, { wrap: true, fit: false });
    });
    gridNext?.addEventListener("click", () => {
      showTileLoader();
      App.moveTile?.(0, +1, { wrap: true, fit: false });
    });
    gridGo?.addEventListener("click", () => {
      const v = tileSel?.value || "0,0";
      const [r, c] = v.split(",").map(n => parseInt(n, 10));
      showTileLoader();
      App.setActiveTile?.(r, c, { fit: false });
    });

    // --- Keyboard shortcuts (tile nav + brush) ---
    window.addEventListener("keydown", (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.isComposing) return;
      switch (e.key) {
        case "b": case "B": App.setMode?.("brush"); redrawCursor(); log("kbd:mode:brush"); break;
        case "v": case "V": App.setMode?.("pan"); log("kbd:mode:pan"); break;
        case "[": App.setBrushSize?.(Math.max(2, (App.Brush.size || 24) - 1));
                  if (sizeEl) sizeEl.value = String(App.Brush.size);
                  if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
                  redrawCursor(); log("kbd:brush:size--", { size: App.Brush.size }); break;
        case "]": App.setBrushSize?.(Math.min(128, (App.Brush.size || 24) + 1));
                  if (sizeEl) sizeEl.value = String(App.Brush.size);
                  if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
                  redrawCursor(); log("kbd:brush:size++", { size: App.Brush.size }); break;
        case "e": case "E":
          if (eraseChk) { eraseChk.checked = !eraseChk.checked; App.setErase?.(eraseChk.checked); redrawCursor(); log("kbd:erase", { on: eraseChk.checked }); }
          break;
        case "n": case "N": // پلی‌گون بعدی (در صورت وجود IO)
          window.BrushIO?.nextIndex?.(); updateHud(); log("kbd:nav:next-poly"); break;
        case "p": case "P": // پلی‌گون قبلی
          window.BrushIO?.prevIndex?.(); updateHud(); log("kbd:nav:prev-poly"); break;
        case "s": case "S":
          e.preventDefault();
          btnSave?.click();
          break;
        case "l": case "L":
          btnDone?.click();
          break;
        // Arrow keys برای جابجایی گرید را core خودش هندل می‌کند، اینجا چیزی اضافه نمی‌کنیم
      }
    });

    // --- Polygon upload panel (اختیاری) ---
    const uploadInp = $("polyUpload2");
    const uploadBtn = $("loadPolygonsBtn2");
    uploadInp?.addEventListener("change", () => {
      const f = uploadInp.files?.[0];
      if (f) log("polygons:upload:selected", { name: f.name, size: f.size, type: f.type });
    });
    uploadBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      const f = uploadInp?.files?.[0];
      if (!f) { alert("Choose a .geojson/.json or .zip shapefile first."); return; }
      const t0 = performance.now();
      const fd = new FormData(); fd.append("file", f);
      log("polygons:upload:start", { name: f.name, bytes: f.size });
      const resp = await fetch("/api/polygons/upload", { method: "POST", body: fd });
      const dt = Math.round(performance.now() - t0);
      let body = {};
      try { body = await resp.json(); } catch {}
      log("polygons:upload:response", { ok: resp.ok, status: resp.status, body, ms: dt });
      if (!resp.ok || body?.error) { alert("Upload failed: " + (body.error || resp.status)); return; }
      if (window.BrushIO?.reloadPolygonsForScene) {
        log("polygons:reload:start");
        await window.BrushIO.reloadPolygonsForScene();
        log("polygons:reload:done", { count: window.BrushApp?.layers?.length || 0 });
        updateHud();
      }
    });

    // نهایی
    updateHud();
    log("UI wired");
  }

  // ---------- Scene selection modal on base.html ----------
  (async function wireSceneSelect() {
    const sel   = $("sceneSelect");
    const btn   = $("sceneApplyBtn");
    const modal = $("sceneProgress");
    const title = $("sceneProgressTitle");
    const bar   = $("sceneProgressBar");
    const note  = $("sceneProgressNote");
    if (!sel || !btn) return;

    function showProgress(show) { if (modal) modal.style.display = show ? "flex" : "none"; }

    async function refreshList() {
      try {
        const r = await fetch("/api/scenes/list", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.items) return;
        sel.innerHTML = "";
        j.items.forEach(it => {
          const opt = document.createElement("option");
          opt.value = it.id;
          opt.textContent = `${it.tile || "—"} | ${it.date || "—"} | ${it.name}`;
          sel.appendChild(opt);
        });
        const curR = await fetch("/api/scenes/current");
        const curJ = await curR.json().catch(() => ({}));
        const cur = curJ?.scene?.id;
        if (cur) sel.value = cur;
      } catch (e) { warn("scenes:list", e); }
    }

    async function pollProgressUntilDone(signal) {
      while (!signal.aborted) {
        try {
          const r = await fetch("/api/progress?ts=" + Date.now(), { cache: "no-store" });
          const j = await r.json().catch(() => ({}));
          const pct = Math.max(0, Math.min(100, Number(j.percent || 0)));
          const phase = j.phase || "working";
          const nn = j.note || "";
          if (title) title.textContent = `Loading scene… (${pct|0}%)`;
          if (bar)   bar.style.width = `${pct}%`;
          if (note)  note.textContent = nn || phase;
          if (pct >= 100 || phase === "done") break;
        } catch {}
        await new Promise(res => setTimeout(res, 400));
      }
    }

    btn.addEventListener("click", async () => {
      const id = sel.value;
      if (!id) return;

      btn.disabled = true;
      const ctrl = new AbortController();
      showProgress(true);

      try {
        const poller = pollProgressUntilDone(ctrl.signal);
        const r = await fetch("/api/scenes/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scene_id: id })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) warn("scenes:select http", r.status, j);

        await poller;
        showProgress(false);
        location.reload();
      } catch (e) {
        console.error("scenes:select:error", e);
        alert("Select failed");
      } finally {
        ctrl.abort();
        btn.disabled = false;
      }
    });

    await refreshList();
  })();

  // ---------- bootstrap wireUI only once BrushApp is ready ----------
  function tryWireOrWait() {
    const ready = !!(window.BrushApp?.ready && window.BrushApp.map);
    if (ready) { wireUI(); }
    else {
      log("waiting brush:ready");
      window.addEventListener("brush:ready", () => { log("brush:ready"); wireUI(); }, { once: true });
    }
  }
  window.addEventListener("DOMContentLoaded", tryWireOrWait);

  // ---------- safety logs ----------
  window.addEventListener("error", (e) => { err("window.error", e?.error || e?.message || e); });
})();