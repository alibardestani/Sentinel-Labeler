console.log("[BRUSH:ui] loaded");
;(() => {
  const DBG = true;
  const log  = (...a) => DBG && console.debug("[BRUSH:ui]", ...a);
  const warn = (...a) => DBG && console.warn("[BRUSH:ui]", ...a);
  const err  = (...a) => DBG && console.error("[BRUSH:ui]", ...a);
  const $ = (id) => document.getElementById(id);

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

  function wireUI() {
    const App = window.BrushApp;
    const IO  = window.BrushIO;
    if (!App || !IO) { err("wireUI: App/IO missing", { hasApp: !!App, hasIO: !!IO }); return; }

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
    const opacitySlider = $("overlayOpacity");
    const opacityVal    = $("opacityValue");
    const uploadInp = $("polyUpload2");
    const uploadBtn = $("loadPolygonsBtn2");

    const updateHud = makeHudUpdater(App, IO);
    const redraw = () => {
      if (typeof App._redrawCursorPreview === "function") { App._redrawCursorPreview(); return; }
      if (typeof App.redrawCursorPreview  === "function") { App.redrawCursorPreview();  return; }
    };

    if (sizeEl) {
      sizeEl.addEventListener("input", () => {
        const v = parseInt(sizeEl.value || "24", 10);
        App.Brush.size = Number.isFinite(v) ? v : 24;
        if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
        log("brush:size", { size: App.Brush.size });
        redraw();
      });
      if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
    }

    if (eraseChk) {
      eraseChk.addEventListener("change", () => {
        App.setErase?.(!!eraseChk.checked);
        log("erase", { on: eraseChk.checked });
        redraw();
      });
    }

    modePanBtn?.addEventListener("click", () => { App.setMode?.("pan"); log("mode:pan"); });
    modeBrushBtn?.addEventListener("click", () => { App.setMode?.("brush"); log("mode:brush"); redraw(); });

    btnClear?.addEventListener("click", () => {
      App.clearMask?.();
      IO.saveMaskForSelected?.();
      log("mask:clear+save");
    });

    btnSave?.addEventListener("click", () => { IO.downloadCurrentMask?.(); log("mask:download"); });

    btnDone?.addEventListener("click", async () => {
      try { IO.markDoneSelected?.(); await IO.saveMaskForSelected?.(); } catch (e) { warn("done:save", e); }
      try { App.clearMask?.(); } catch {}
      IO.nextIndex?.();
      updateHud();
      log("work:done");
    });

    btnPrev?.addEventListener("click", () => { IO.prevIndex?.(); updateHud(); log("nav:prev"); });
    btnNext?.addEventListener("click", () => { IO.nextIndex?.(); updateHud(); log("nav:next"); });

    if (opacitySlider) {
      const apply = () => {
        const v = (parseInt(opacitySlider.value, 10) || 60) / 100;
        App.overlay?.setOpacity?.(v);
        if (opacityVal) opacityVal.textContent = v.toFixed(2);
        log("overlay:opacity", { value: v });
      };
      opacitySlider.addEventListener("input", apply);
      apply();
    }

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

    window.addEventListener("keydown", (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.isComposing) return;
      switch (e.key) {
        case "b": case "B": App.setMode?.("brush"); redraw(); log("kbd:mode:brush"); break;
        case "v": case "V": App.setMode?.("pan"); log("kbd:mode:pan"); break;
        case "[": App.Brush.size = Math.max(2, (App.Brush.size || 24) - 1);
                  if (sizeEl) sizeEl.value = String(App.Brush.size);
                  if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
                  redraw(); log("kbd:brush:size--", { size: App.Brush.size }); break;
        case "]": App.Brush.size = Math.min(128, (App.Brush.size || 24) + 1);
                  if (sizeEl) sizeEl.value = String(App.Brush.size);
                  if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
                  redraw(); log("kbd:brush:size++", { size: App.Brush.size }); break;
        case "e": case "E":
          if (eraseChk) { eraseChk.checked = !eraseChk.checked; App.setErase?.(eraseChk.checked); redraw(); log("kbd:erase", { on: eraseChk.checked }); }
          break;
        case "n": case "N": IO.nextIndex?.(); updateHud(); log("kbd:nav:next"); break;
        case "p": case "P": IO.prevIndex?.(); updateHud(); log("kbd:nav:prev"); break;
        case "s": case "S": e.preventDefault(); IO.downloadCurrentMask?.(); log("kbd:download"); break;
        case "l": case "L": btnDone?.click(); log("kbd:done"); break;
      }
    });

    if (App.onLayerSelected) {
      const prev = App.onLayerSelected;
      App.onLayerSelected = (layer) => { try { prev(layer); } catch {} updateHud(); };
    } else {
      App.onLayerSelected = () => updateHud();
    }

    updateHud();
    log("UI wired");
  }

  function tryWireOrWait() {
    const ready = !!(window.BrushApp?.ready && window.BrushApp.map);
    if (ready) { wireUI(); }
    else {
      log("waiting brush:ready");
      window.addEventListener("brush:ready", () => { log("brush:ready"); wireUI(); }, { once: true });
    }
  }

  window.addEventListener("DOMContentLoaded", tryWireOrWait);
  window.addEventListener("error", (e) => { err("window.error", e?.error || e?.message || e); });
})();

(async function wireSceneSelect() {
  const sel = document.getElementById('sceneSelect');
  const btn = document.getElementById('sceneApplyBtn');
  const modal = document.getElementById('sceneProgress');
  const title = document.getElementById('sceneProgressTitle');
  const bar = document.getElementById('sceneProgressBar');
  const note = document.getElementById('sceneProgressNote');

  if (!sel || !btn) return;

  async function refreshList() {
    const r = await fetch('/api/scenes/list', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.items) return;
    sel.innerHTML = '';
    j.items.forEach(it => {
      const opt = document.createElement('option');
      opt.value = it.id;
      opt.textContent = `${it.tile || '—'} | ${it.date || '—'} | ${it.name}`;
      sel.appendChild(opt);
    });
    try {
      const curR = await fetch('/api/scenes/current');
      const curJ = await curR.json();
      const cur = curJ?.scene?.id;
      if (cur) sel.value = cur;
    } catch {}
  }

  function showProgress(show) {
    if (!modal) return;
    modal.style.display = show ? 'flex' : 'none';
  }

  async function pollProgressUntilDone(signal) {
    while (!signal.aborted) {
      const r = await fetch('/api/progress?ts=' + Date.now(), { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      const pct = Math.max(0, Math.min(100, Number(j.percent || 0)));
      const phase = j.phase || 'working';
      const nn = j.note || '';
      if (title) title.textContent = `Loading scene… (${pct|0}%)`;
      if (bar) bar.style.width = `${pct}%`;
      if (note) note.textContent = nn || phase;
      if (pct >= 100 || phase === 'done') break;
      await new Promise(res => setTimeout(res, 400));
    }
  }

  btn.addEventListener('click', async () => {
    const id = sel.value;
    if (!id) return;

    btn.disabled = true;
    const ctrl = new AbortController();
    showProgress(true);

    try {
      const poller = pollProgressUntilDone(ctrl.signal);

      const r = await fetch('/api/scenes/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene_id: id })
      });
      const j = await r.json().catch(() => ({}));

      if (!r.ok || !j.ok) {
        alert('Select failed: ' + (j.error || r.status));
        return;
      }

      await poller;
      showProgress(false);
      location.reload();
    } catch (e) {
      console.error('scenes:select:error', e);
      alert('Select failed');
    } finally {
      ctrl.abort();
      btn.disabled = false;
    }
  });

  await refreshList();
})();


if (!r.ok || !j.ok) {
  alert('Select failed: ' + (j.error || r.status));
  return;
}