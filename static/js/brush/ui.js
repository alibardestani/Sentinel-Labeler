// static/js/brush/ui.js
(() => {
  if (window.__BRUSH_UI_WIRED__) return;
  window.__BRUSH_UI_WIRED__ = true;

  const DBG = true;
  const log  = (...a) => DBG && console.debug("[BRUSH:ui]", ...a);
  const warn = (...a) => DBG && console.warn ("[BRUSH:ui]", ...a);
  const err  = (...a) => DBG && console.error("[BRUSH:ui]", ...a);
  const $    = (id) => document.getElementById(id);

  const pad2 = (n) => String(n).padStart(2, "0");
  const nowStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  };

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

  function makeHudUpdater(App, IO) {
    const hudTile  = $("hudTileRC");
    const hudTile2 = $("hudTileRC2");
    const hudIndex = $("hudIndex");
    const hudTotal = $("hudTotal");
    const hudDone  = $("hudDone");

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

  function ensureTileLoaderEl() {
    let el = $("tileLoader");
    if (!el) {
      const host = $('#map') || document.body;
      el = document.createElement("div");
      el.id = "tileLoader";
      el.style.position = "absolute";
      el.style.inset = "12px auto auto 12px";
      el.style.zIndex = "1401";
      el.style.padding = "6px 10px";
      el.style.borderRadius = "10px";
      el.style.border = "1px solid #1f2840";
      el.style.background = "rgba(15,21,36,.85)";
      el.style.color = "#e7ecf3";
      el.style.font = "12px/1.4 ui-sans-serif,system-ui,Segoe UI,Roboto";
      el.style.display = "none";
      const box = document.createElement("div");
      box.className = "box";
      box.textContent = "Loading tile…";
      el.appendChild(box);
      host.appendChild(el);
    }
    return el;
  }
  const showTileLoader = (msg = "Loading tile…") => {
    const el = ensureTileLoaderEl();
    el.style.display = "grid";
    const box = el.querySelector(".box");
    if (box) box.textContent = msg;
  };
  const hideTileLoader = () => {
    const el = ensureTileLoaderEl();
    el.style.display = "none";
  };

  async function exportActiveTileMaskBlob(App, { mime = "image/png" } = {}) {
    const r = App?.grid?.active?.r ?? -1, c = App?.grid?.active?.c ?? -1;
    const tm = App?.tileMasks?.[r]?.[c];
    if (!tm || !tm.cnv) { warn("exportActiveTileMaskBlob: no tile canvas"); return null; }
    return await new Promise(res => tm.cnv.toBlob(res, mime, 1));
  }

  function wireUI() {
    const App = window.BrushApp;
    const IO  = window.BrushIO || {};
    if (!App) { err("wireUI: BrushApp missing"); return; }

    App.setTileLoading = (on) => on ? showTileLoader() : hideTileLoader();

    const updateHud = makeHudUpdater(App, IO);

    const sizeEl   = $("brushSize2");
    const sizeVal  = $("brushSizeVal2");
    const eraseChk = $("eraseChk2");
    const modePanBtn   = $("modePanBtn2");
    const modeBrushBtn = $("modeBrushBtn2");
    const btnClear = $("clearMask2");
    const btnSave  = $("savePng2");
    const btnDone  = $("btnMarkDone");
    const btnPrev  = $("btnPrev");
    const btnNext  = $("btnNext");

    const redrawCursor = () => {
      if (typeof App._redrawCursorPreview === "function") App._redrawCursorPreview();
    };

    if (sizeEl) {
      sizeEl.addEventListener("input", () => {
        const v = parseInt(sizeEl.value || "24", 10);
        App.setBrushSize?.(v);
        if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
        redrawCursor();
      }, { passive: true });
      if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
    }

    if (eraseChk) {
      eraseChk.addEventListener("change", () => {
        App.setErase?.(!!eraseChk.checked);
        redrawCursor();
      });
    }

    modePanBtn?.addEventListener("click", () => {
      App.setMode?.("pan");
      modePanBtn.classList.add("primary");
      modeBrushBtn?.classList.remove("primary");
    });
    modeBrushBtn?.addEventListener("click", () => {
      App.setMode?.("brush");
      modeBrushBtn.classList.add("primary");
      modePanBtn?.classList.remove("primary");
      if (App.maskCanvas?.style.pointerEvents !== "auto") App.maskCanvas.style.pointerEvents = "auto";
      redrawCursor();
    });

    btnClear?.addEventListener("click", () => {
      App.clearMask?.();
    });

    btnSave?.addEventListener("click", async () => {
      try {
        const blob = await exportActiveTileMaskBlob(App);
        if (!blob) { alert("Mask not ready for this tile"); return; }
        const r = App.grid.active.r|0, c = App.grid.active.c|0;
        const sid = App.sceneId || "unknown";
        const fname = `scene-${sid}_r${r}_c${c}_${nowStamp()}.png`;
        downloadBlob(blob, fname);

        try {
          const fd = new FormData();
          fd.append("scene_id", sid);
          fd.append("r", String(r));
          fd.append("c", String(c));
          fd.append("file", blob, fname);
          const resp = await fetch("/api/masks/save_tile_png", { method: "POST", body: fd });
          if (!resp.ok) warn("save_tile_png: http", resp.status);
        } catch (e) {
          warn("save_tile_png: no endpoint or failed", e);
        }
      } catch (e) {
        err("save-png:error", e);
        alert("Save PNG failed");
      }
    });

    btnDone?.addEventListener("click", async () => {
      try { IO.markDoneSelected?.(); await IO.saveMaskForSelected?.(); } catch {}
      try { App.clearMask?.(); } catch {}
      IO.nextIndex?.();
      updateHud();
    });

    btnPrev?.addEventListener("click", () => { IO.prevIndex?.(); updateHud(); });
    btnNext?.addEventListener("click", () => { IO.nextIndex?.(); updateHud(); });

    const opacitySlider = $("overlayOpacity");
    const opacityVal    = $("opacityValue");
    if (opacitySlider) {
      const apply = () => {
        const v = (parseInt(opacitySlider.value, 10) || 60) / 100;
        App.overlay?.setOpacity?.(v);
        App.grid?.overlay?.setOpacity?.(v);
        if (opacityVal) opacityVal.textContent = v.toFixed(2);
      };
      opacitySlider.addEventListener("input", apply, { passive: true });
      apply();
    }

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

    window.addEventListener("keydown", (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.isComposing) return;
      switch (e.key) {
        case "b": case "B": App.setMode?.("brush"); redrawCursor(); break;
        case "v": case "V": App.setMode?.("pan"); break;
        case "[": App.setBrushSize?.(Math.max(2, (App.Brush.size || 24) - 1));
                  if (sizeEl) sizeEl.value = String(App.Brush.size);
                  if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
                  redrawCursor(); break;
        case "]": App.setBrushSize?.(Math.min(128, (App.Brush.size || 24) + 1));
                  if (sizeEl) sizeEl.value = String(App.Brush.size);
                  if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
                  redrawCursor(); break;
        case "e": case "E":
          if (eraseChk) { eraseChk.checked = !eraseChk.checked; App.setErase?.(eraseChk.checked); redrawCursor(); }
          break;
        case "n": case "N": window.BrushIO?.nextIndex?.(); updateHud(); break;
        case "p": case "P": window.BrushIO?.prevIndex?.(); updateHud(); break;
        case "s": case "S": e.preventDefault(); btnSave?.click(); break;
        case "l": case "L": btnDone?.click(); break;
      }
    });

    updateHud();
    log("UI wired");
  }

  function tryWireOrWait() {
    const ready = !!(window.BrushApp?.ready && window.BrushApp.map);
    if (ready) wireUI();
    else {
      log("waiting brush:ready");
      window.addEventListener("brush:ready", () => { log("brush:ready"); wireUI(); }, { once: true });
    }
  }

  window.addEventListener("DOMContentLoaded", tryWireOrWait, { once: true });
  window.addEventListener("error", (e) => { err("window.error", e?.error || e?.message || e); });
  console.log("[BRUSH:ui] loaded");
})();