// static/js/brush/ui.js
console.log("[BRUSH:ui] loaded");
;(() => {
  const DBG = true;
  const log  = (...a) => DBG && console.debug("[BRUSH:ui]", ...a);
  const warn = (...a) => DBG && console.warn("[BRUSH:ui]", ...a);
  const err  = (...a) => DBG && console.error("[BRUSH:ui]", ...a);
  const $ = (id) => document.getElementById(id);

  // -------------------- HUD --------------------
  function makeHudUpdater(App, IO) {
    const hudTile  = $("hudTile");
    const hudIndex = $("hudIndex");
    const hudTotal = $("hudTotal");
    const hudDone  = $("hudDone");
    return function updateHud() {
      try {
        if (hudTile)  hudTile.textContent  = App.currentTileId ? App.currentTileId() : "-";
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

  // -------------------- Metadata form --------------------
  function makeMetaForm(App, IO) {
    const elUid   = $("polyUid");
    const elUses  = $("polyUsesFruit");
    const elCode  = $("polyCode");
    const elArea  = $("polyAreaM2");
    const elLat   = $("polyLat");
    const elLon   = $("polyLon");

    const elLabelSel    = $("polyLabelSelect");
    const elCustomWrap  = $("customLabelWrap");
    const elLabelCustom = $("polyLabelCustom");

    const elClass = $("polyClass");
    const elColor = $("polyColor");

    const btnApply   = $("applyPropsBtn");
    const btnSaveAll = $("savePolygonsBtn");

    function showCustomIfNeeded() {
      if (!elLabelSel || !elCustomWrap) return;
      elCustomWrap.style.display = (elLabelSel.value === "__custom__") ? "block" : "none";
    }
    elLabelSel?.addEventListener("change", showCustomIfNeeded);

    function areaM2(layer) {
      try {
        if (!L?.GeometryUtil?.geodesicArea) return 0; // اگر leaflet.draw نیست
        const latlngs = layer.getLatLngs();
        // تلاش برای یافتن رینگ بیرونی
        const rings = (Array.isArray(latlngs[0]) && Array.isArray(latlngs[0][0])) ? latlngs[0] : latlngs;
        return Math.max(0, L.GeometryUtil.geodesicArea(rings));
      } catch {
        return 0;
      }
    }

    function populateFormFromLayer(layer) {
      if (!layer) return;
      const props = layer._props || layer.feature?.properties || {};

      const uid = props.uid || App.layerUid(layer);
      if (elUid)  elUid.value  = uid || "";
      if (elUses) elUses.value = props.uses_fruit || "";
      if (elCode) elCode.value = props.code || "";

      try {
        const c = layer.getBounds().getCenter();
        if (elLat) elLat.value = Number(c.lat.toFixed(6));
        if (elLon) elLon.value = Number(c.lng.toFixed(6));
      } catch {}

      if (elArea) elArea.value = Math.round(areaM2(layer) * 100) / 100;

      const label = props.label || "";
      if (elLabelSel) {
        if (["veg", "background", ""].includes(label)) {
          elLabelSel.value = label;
          if (elLabelCustom) elLabelCustom.value = "";
        } else {
          elLabelSel.value = "__custom__";
          if (elLabelCustom) elLabelCustom.value = label;
        }
      }
      showCustomIfNeeded();

      if (elClass) elClass.value = (props.class_id != null ? props.class_id : 1);
      if (elColor) elColor.value = props.color || "#00ff00";
    }

    function applyFormToLayer(layer) {
      if (!layer) return;
      layer._props ||= {};
      const p = layer._props;

      if (elUid)  p.uid         = elUid.value || p.uid;
      if (elUses) p.uses_fruit  = elUses.value || "";
      if (elCode) p.code        = elCode.value || "";

      const selVal = elLabelSel?.value || "";
      p.label = (selVal === "__custom__")
        ? (elLabelCustom?.value || "")
        : selVal;

      p.class_id = parseInt(elClass?.value || "1", 10) || 1;
      p.color    = elColor?.value || "#00ff00";

      try { layer.setStyle?.({ color: p.color, weight: 2 }); } catch {}
    }

    // اکسپورت توابع برای استفاده بیرون (در صورت نیاز)
    return { populateFormFromLayer, applyFormToLayer };
  }

  // -------------------- Wire UI --------------------
  function wireUI() {
    const App = window.BrushApp;
    const IO  = window.BrushIO;
    const hasApp = !!App, hasIO = !!IO, hasMap = !!App?.map;

    if (!hasApp || !hasIO) warn("wireUI: App/IO not ready; continuing with partial wiring");
    if (!hasMap)           warn("wireUI: map not ready; deferring map-dependent wiring");

    // Brush controls
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

    // Overlay opacity
    const opacitySlider = $("overlayOpacity");
    const opacityVal    = $("opacityValue");

    // Upload polygons
    const uploadInp = $("polyUpload2");
    const uploadBtn = $("loadPolygonsBtn2");

    const updateHud = makeHudUpdater(App, IO);
    const { populateFormFromLayer, applyFormToLayer } = makeMetaForm(App, IO);

    // redraw cursor helper
    const redraw = () => {
      if (typeof App._redrawCursorPreview === "function") { App._redrawCursorPreview(); return; }
      if (typeof App.redrawCursorPreview  === "function") { App.redrawCursorPreview();  return; }
    };

    // brush size
    if (sizeEl) {
      sizeEl.addEventListener("input", () => {
        const v = parseInt(sizeEl.value || "24", 10);
        App.Brush.size = Number.isFinite(v) ? v : 24;
        if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
        redraw();
      });
      if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
    }

    // erase toggle
    eraseChk?.addEventListener("change", () => {
      App.setErase?.(!!eraseChk.checked);
      redraw();
    });

    // mode buttons
    modePanBtn?.addEventListener("click", () => App.setMode?.("pan"));
    modeBrushBtn?.addEventListener("click", () => { App.setMode?.("brush"); redraw(); });

    // clear / save / done
    btnClear?.addEventListener("click", () => {
      App.clearMask?.();
      IO.saveMaskForSelected?.(); // autosave after clear
    });
    btnSave?.addEventListener("click", () => IO.downloadCurrentMask?.());

    btnDone?.addEventListener("click", async () => {
      try {
        IO.markDoneSelected?.();
        await IO.saveMaskForSelected?.();
      } catch (e) { warn("done:save", e); }
      try { App.clearMask?.(); } catch {}
      IO.nextIndex?.();
      updateHud();
    });

    // nav
    btnPrev?.addEventListener("click", () => { IO.prevIndex?.(); updateHud(); });
    btnNext?.addEventListener("click", () => { IO.nextIndex?.(); updateHud(); });

    // opacity
    if (opacitySlider) {
      const apply = () => {
        const v = (parseInt(opacitySlider.value, 10) || 60) / 100;
        App.overlay?.setOpacity?.(v);
        if (opacityVal) opacityVal.textContent = v.toFixed(2);
      };
      opacitySlider.addEventListener("input", apply);
      apply();
    }

    // upload polygons
    uploadInp?.addEventListener("change", () => {
      const f = uploadInp.files?.[0];
      if (f) log("upload:selected", { name: f.name, size: f.size, type: f.type });
    });

    uploadBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      const f = uploadInp?.files?.[0];
      if (!f) { alert("Choose a .geojson/.json or .zip shapefile first."); return; }
      const fd = new FormData(); fd.append("file", f);
      const resp = await fetch("/api/polygons/upload", { method: "POST", body: fd });
      if (!resp.ok) { alert("Upload failed: " + resp.status); return; }

      if (window.BrushIO?.reloadPolygonsForScene) {
        await window.BrushIO.reloadPolygonsForScene();
        updateHud();
        // انتخاب پلیگان جدید باعث populate فرم می‌شود (هوک پایین)
      }
    });

    // keyboard
    window.addEventListener("keydown", (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.isComposing) return;
      switch (e.key) {
        case "b": case "B": App.setMode?.("brush"); redraw(); break;
        case "v": case "V": App.setMode?.("pan"); break;
        case "[": App.Brush.size = Math.max(2, (App.Brush.size || 24) - 1);
                  if (sizeEl) sizeEl.value = String(App.Brush.size);
                  if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
                  redraw(); break;
        case "]": App.Brush.size = Math.min(128, (App.Brush.size || 24) + 1);
                  if (sizeEl) sizeEl.value = String(App.Brush.size);
                  if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
                  redraw(); break;
        case "e": case "E":
          if (eraseChk) { eraseChk.checked = !eraseChk.checked; App.setErase?.(eraseChk.checked); redraw(); }
          break;
        case "n": case "N": IO.nextIndex?.(); updateHud(); break;
        case "p": case "P": IO.prevIndex?.(); updateHud(); break;
        case "s": case "S": e.preventDefault(); IO.downloadCurrentMask?.(); break;
        case "l": case "L": btnDone?.click(); break;
      }
    });

    // ---- hook: وقتی پلیگان انتخاب شد، فرم را پر کن و HUD آپدیت شود
    const prevHook = App.onLayerSelected;
    App.onLayerSelected = (layer) => {
      try { prevHook && prevHook(layer); } catch {}
      populateFormFromLayer(layer);
      updateHud();
    };

    // اگر هنگام آماده‌شدن، لایه‌ای انتخاب بود
    if (App.selectedLayer) {
      populateFormFromLayer(App.selectedLayer);
      updateHud();
    }

    log("UI wired");
  }

  // ---- wait for BrushApp ready ----
  function tryWireOrWait() {
    const ready = !!(window.BrushApp?.ready && window.BrushApp.map);
    if (ready) wireUI();
    else {
      log("waiting brush:ready");
      window.addEventListener("brush:ready", () => { wireUI(); }, { once: true });
    }
  }

  window.addEventListener("DOMContentLoaded", tryWireOrWait);
  window.addEventListener("error", (e) => { err("window.error", e?.error || e?.message || e); });
})();