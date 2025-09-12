console.log("[BRUSH:ui] loaded");
;(() => {
  const DBG = true;
  const log  = (...a) => DBG && console.debug('[BRUSH:ui]', ...a);
  const warn = (...a) => DBG && console.warn('[BRUSH:ui]', ...a);
  const err  = (...a) => DBG && console.error('[BRUSH:ui]', ...a);
  const $    = (id) => document.getElementById(id);

  function wireUI() {
    const App = window.BrushApp;
    const IO  = window.BrushIO;

    const hasApp = !!App, hasIO = !!IO, hasMap = !!App?.map;
    if (!hasApp || !hasIO) { warn('wireUI: App/IO not ready yet; wiring upload anyway'); }
    if (!hasMap)           { warn('wireUI: map not ready yet; deferring map-dependent wiring'); }

    const modePanBtn    = $('modePanBtn2');
    const modeBrushBtn  = $('modeBrushBtn2');
    const sizeEl        = $('brushSize2');
    const sizeVal       = $('brushSizeVal2');
    const eraseChk      = $('eraseChk2');
    const btnClear      = $('clearMask2');
    const btnSave       = $('savePng2');
    const btnDone       = $('btnMarkDone');
    const btnPrev       = $('btnPrev');
    const btnNext       = $('btnNext');
    const hudTile       = $('hudTile');
    const hudIndex      = $('hudIndex');
    const hudTotal      = $('hudTotal');
    const hudDone       = $('hudDone');
    const opacitySlider = $('overlayOpacity');
    const opacityVal    = $('opacityValue');
    const uploadInp     = $('polyUpload2');
    const uploadBtn     = $('loadPolygonsBtn2');

    const redraw = () => {
      if (typeof App._redrawCursorPreview === 'function') { App._redrawCursorPreview(); log('cursor:redraw'); return; }
      if (typeof App.redrawCursorPreview === 'function')   { App.redrawCursorPreview(); log('cursor:redraw:legacy'); return; }
      warn('cursor:redraw unavailable');
    };

    function updateHud() {
      try {
        if (hudTile)  hudTile.textContent  = App.currentTileId ? App.currentTileId() : '-';
        if (hudTotal) hudTotal.textContent = String(App.layers ? App.layers.length : 0);
        const cur = IO.current ? IO.current() : null;
        const i = cur && App.layers ? App.layers.indexOf(cur) : -1;
        if (hudIndex) hudIndex.textContent = i >= 0 ? String(i + 1) : '-';
        let cnt = 0;
        if (App.layers && IO.isDone) for (const ly of App.layers) if (IO.isDone(ly)) cnt++;
        if (hudDone) hudDone.textContent = String(cnt);
        log('hud', {
          tile: hudTile?.textContent,
          index: hudIndex?.textContent,
          total: hudTotal?.textContent,
          done: hudDone?.textContent
        });
      } catch (e) { err('hud:update:fail', e); }
    }

    if (sizeEl) {
      sizeEl.addEventListener('input', () => {
        const v = parseInt(sizeEl.value || '24', 10);
        App.Brush.size = Number.isFinite(v) ? v : 24;
        if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
        log('brush:size', { size: App.Brush.size });
        redraw();
      });
      if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
    } else {
      warn('input#brushSize2 missing');
    }

    eraseChk?.addEventListener('change', () => {
      const on = !!eraseChk.checked;
      App.setErase?.(on);
      log('erase:toggle', { on });
      redraw();
    });

    modePanBtn?.addEventListener('click', () => { App.setMode?.('pan'); log('mode:pan:click'); });
    modeBrushBtn?.addEventListener('click', () => { App.setMode?.('brush'); log('mode:brush:click'); redraw(); });

    btnClear?.addEventListener('click', () => {
      App.clearMask?.();
      IO.saveMaskForSelected?.();
      log('mask:clear+autosave');
    });

    btnSave?.addEventListener('click', () => { IO.downloadCurrentMask?.(); log('mask:download'); });

    btnDone?.addEventListener('click', () => {
      IO.markDoneSelected?.();
      IO.saveMaskForSelected?.();
      IO.nextIndex?.();
      updateHud();
      log('work:done');
    });

    btnPrev?.addEventListener('click', () => { IO.prevIndex?.(); updateHud(); log('nav:prev'); });
    btnNext?.addEventListener('click', () => { IO.nextIndex?.(); updateHud(); log('nav:next'); });

    if (opacitySlider) {
      const apply = () => {
        const v = (parseInt(opacitySlider.value, 10) || 60) / 100;
        App.overlay?.setOpacity?.(v);
        if (opacityVal) opacityVal.textContent = v.toFixed(2);
        log('overlay:opacity', { value: v });
      };
      opacitySlider.addEventListener('input', apply);
      apply();
    }

    // ---- Upload polygons with deep logging ----
    uploadInp?.addEventListener('change', () => {
      const f = uploadInp.files?.[0];
      if (!f) return;
      log('upload:file:selected', { name: f.name, size: f.size, type: f.type });
    });

    uploadBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const f = uploadInp?.files?.[0];
        if (!f) {
          warn('upload:no-file');
          alert('Choose a .geojson/.json or .zip shapefile first.');
          return;
        }
        log('upload:start', { name: f.name, size: f.size, type: f.type });

        const fd = new FormData();
        fd.append('file', f);

        const t0 = performance.now();
        const resp = await fetch('/api/polygons/upload', { method: 'POST', body: fd });
        const ms = Math.round(performance.now() - t0);
        const ctype = resp.headers.get('content-type') || '';
        let json = null, text = null;
        if (ctype.includes('application/json')) { try { json = await resp.json(); } catch {} }
        else { try { text = await resp.text(); } catch {} }

        log('upload:response', { ok: resp.ok, status: resp.status, ms, json, text });
        if (!resp.ok) {
          alert('Upload failed: ' + (json?.error || text || resp.status));
          return;
        }

        if (window.BrushIO?.reloadPolygonsForScene) {
          log('reloadPolygonsForScene:start');
          await window.BrushIO.reloadPolygonsForScene();
          const count = App.layers?.length || 0;
          log('reloadPolygonsForScene:done', { layers: count, first5: (App.layers || []).slice(0,5).map(L => ({
            uid: App.layerUid(L), label: App.layerLabel(L), code: App.layerCode(L)
          })) });
          updateHud();
          alert('Polygons uploaded and reloaded. Count: ' + count);
        } else {
          warn('reloadPolygonsForScene not available');
        }
      } catch (e) {
        err('upload:error', e);
        alert('Upload error: ' + e);
      }
    });

    if (!(hasApp && hasIO && hasMap)) {
      log('wireUI: deferring map-dependent controls until ready');
      return;
    }
    window.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing) return;
      switch (e.key) {
        case 'b': case 'B': App.setMode?.('brush'); redraw(); log('kbd:mode:brush'); break;
        case 'v': case 'V': App.setMode?.('pan'); log('kbd:mode:pan'); break;
        case '[':
          App.Brush.size = Math.max(2, (App.Brush.size || 24) - 1);
          if (sizeEl) sizeEl.value = String(App.Brush.size);
          if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
          redraw(); log('kbd:brush:size--', { size: App.Brush.size }); break;
        case ']':
          App.Brush.size = Math.min(128, (App.Brush.size || 24) + 1);
          if (sizeEl) sizeEl.value = String(App.Brush.size);
          if (sizeVal) sizeVal.textContent = `${App.Brush.size} px`;
          redraw(); log('kbd:brush:size++', { size: App.Brush.size }); break;
        case 'e': case 'E':
          if (eraseChk) {
            eraseChk.checked = !eraseChk.checked;
            App.setErase?.(eraseChk.checked);
            redraw(); log('kbd:erase', { on: eraseChk.checked });
          } else {
            warn('kbd:erase:checkbox-missing');
          }
          break;
        case 'n': case 'N': IO.nextIndex?.(); updateHud(); log('kbd:nav:next'); break;
        case 'p': case 'P': IO.prevIndex?.(); updateHud(); log('kbd:nav:prev'); break;
        case 's': case 'S': e.preventDefault(); IO.downloadCurrentMask?.(); log('kbd:download'); break;
        case 'l': case 'L': btnDone?.click(); log('kbd:done'); break;
      }
    });

    App.onLayerSelected = updateHud;
    updateHud();
    log('UI wired');
  }

  function tryWireOrWait() {
    const ready = !!(window.BrushApp?.ready && window.BrushApp.map);
    if (ready) { log('ready:true wiring now'); wireUI(); }
    else {
      log('ready:false waiting for brush:ready');
      window.addEventListener('brush:ready', () => { log('event brush:ready received'); wireUI(); }, { once: true });
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    tryWireOrWait();
    log('DOMContentLoaded');
  });

  window.addEventListener('error', (e) => { err('window.error', e?.error || e?.message || e); });
})();