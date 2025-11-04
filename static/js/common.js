// static/js/common.js
(() => {
  if (window.__COMMON_WIRED__) return;
  window.__COMMON_WIRED__ = true;

  const DBG = false;
  const log  = (...a) => DBG && console.debug('[COMMON]', ...a);
  const warn = (...a) => DBG && console.warn ('[COMMON]', ...a);
  const err  = (...a) => DBG && console.error('[COMMON]', ...a);

  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  // -------------------- Small DOM utils --------------------
  const show = (el, display='flex') => { if (!el) return; el.hidden = false; el.style.display = display; };
  const hide = (el) => { if (!el) return; el.hidden = true; el.style.display = 'none'; };

  // -------------------- One-shot fetch with memo + TTL + credentials --------------------
  const __memo = new Map(); // key -> { t:number, p:Promise<any> }
  const TTL_MS = 60_000;    // 60s cache for scenes endpoints

  function dropFromMemo(...keys) { keys.forEach(k => __memo.delete(k)); }

  async function fetchJSONOnce(key, url, opts = {}) {
    const now = Date.now();
    const hit = __memo.get(key);
    if (hit && now - hit.t < TTL_MS) return hit.p;

    const p = fetch(url, {
      credentials: 'same-origin',                    // keep session cookies
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
      cache: 'no-store',
      ...opts
    })
    .then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      let raw;
      try { raw = await res.json(); } catch { raw = {}; }

      // Normalize shapes for Scene APIs so UI code is simple everywhere.
      if (key === 'scenes.list') {
        const arr = Array.isArray(raw) ? raw : (raw && raw.items) || [];
        return arr.map(s => ({
          id: s.id,
          name: s.name || s.id,
          tile: s.tile,         // keep optional tags if server provides them
          date: s.date
        }));
      }
      if (key === 'scenes.current') {
        if (raw && typeof raw === 'object' && 'scene' in raw) return raw.scene;
        if (Array.isArray(raw)) return raw[0] || null;
        return raw ?? null;
      }
      return raw;
    })
    .catch((e) => { __memo.delete(key); throw e; });

    __memo.set(key, { t: now, p });
    return p;
  }

  // -------------------- SceneStore (single source of truth) --------------------
  const SceneStore = {
    async list()    { return await fetchJSONOnce('scenes.list',    '/api/scenes/list');    },
    async current() { return await fetchJSONOnce('scenes.current', '/api/scenes/current'); },
    invalidate()    { dropFromMemo('scenes.list', 'scenes.current'); }
  };
  window.SceneStore = SceneStore;

  // -------------------- Admin helper: populate scene <select> --------------------
  async function populateSceneSelect(selectEl, { withCurrent = false } = {}) {
    try {
      const scenes = await SceneStore.list(); // -> [{id,name,tile?,date?}]
      selectEl.innerHTML = '';

      if (!scenes.length) {
        selectEl.innerHTML = '<option value="">— no scenes —</option>';
        return;
      }

      for (const s of scenes) {
        const opt = document.createElement('option');
        opt.value = s.id;
        const tag = [s.tile || '', s.date || ''].filter(Boolean).join(' • ');
        opt.textContent = tag ? `${s.name} — ${tag}` : (s.name || s.id);
        opt.dataset.name = s.name || s.id;
        selectEl.appendChild(opt);
      }

      if (withCurrent) {
        const cur = await SceneStore.current();            // tolerant of old/new shapes
        const curId = cur && (cur.id || cur.scene_id);
        if (curId) {
          const found = [...selectEl.options].find(o => o.value === String(curId));
          if (found) found.selected = true;
        }
      }
    } catch (e) {
      console.error('[common] populateSceneSelect error:', e);
      selectEl.innerHTML = '<option value="">— error loading scenes —</option>';
    }
  }
  // expose for admin.html
  window.populateSceneSelect = populateSceneSelect;

  // -------------------- Progress modal (shared) --------------------
  const MOD = {
    el: $('#progressModal'),
    title: $('#progressModal .modal-title') || $('#progressTitle'),
    bar: $('#progressModal .progress .bar'),
    _pollCtrl: null,
    _indetTimer: null,

    setTitle(txt){ if (this.title) this.title.textContent = txt; },
    setPct(p){ if (this.bar) this.bar.style.width = `${Math.max(0,Math.min(100,p||0))}%`; },

    open(initial='Processing… (0%)'){
      if (!this.el) return;
      this.setTitle(initial);
      this.setPct(0);
      show(this.el);
    },

    close(){
      if (!this.el) return;
      this.stopPoll();
      if (this._indetTimer) { clearInterval(this._indetTimer); this._indetTimer = null; }
      hide(this.el);
    },

    startPoll(){
      this.stopPoll();
      const ctrl = new AbortController();
      this._pollCtrl = ctrl;

      const tick = async () => {
        if (ctrl.signal.aborted) return;
        try {
          const r = await fetch('/api/progress?ts='+Date.now(), {
            cache:'no-store',
            signal: ctrl.signal,
            credentials: 'same-origin'
          });
          const j = await r.json().catch(()=>({}));
          const p = Number(j.percent || 0);
          this.setPct(p);
          this.setTitle(`${j.phase || 'Processing'} (${Math.round(p)}%)${j.note ? ' — ' + j.note : ''}`);
          if ((j.phase||'') === 'done' || p >= 100) {
            this.stopPoll();
            setTimeout(()=> this.close(), 250);
            return;
          }
        } catch { /* ignore */ }
        if (!ctrl.signal.aborted) setTimeout(tick, 400);
      };
      tick();

      // pause/resume on tab hide
      const vis = () => {
        if (document.hidden) ctrl.abort();
        else if (!this._pollCtrl) this.startPoll();
      };
      document.addEventListener('visibilitychange', vis, { once: true });
    },

    stopPoll(){
      if (this._pollCtrl) { try { this._pollCtrl.abort(); } catch {} this._pollCtrl = null; }
    },

    indeterminate(note='Working…'){
      if (!this.bar) return;
      this.setTitle(note);
      if (this._indetTimer) clearInterval(this._indetTimer);
      let w=15, dir=1;
      this._indetTimer = setInterval(()=>{ w+=15*dir; if(w>=88)dir=-1; if(w<=18)dir=1; this.setPct(w); }, 500);
    },
  };
  window.closeProgress = () => MOD.close();

  // -------------------- Sentinel ZIP uploader (optional controls present) --------------------
  async function uploadZipWithProgress(fileInput) {
    const file = fileInput?.files?.[0];
    if (!file) { alert('ZIP را انتخاب کنید'); return; }

    MOD.open('Uploading… (0%)');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload_safe_zip', true);
    xhr.withCredentials = true; // include cookies for session-auth endpoints

    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) { MOD.setPct(10); MOD.setTitle('Uploading…'); return; }
      const pct = Math.round((e.loaded/e.total)*100);
      MOD.setTitle(`Uploading… (${pct}%)`);
      MOD.setPct(pct);
    };
    xhr.upload.onload = () => MOD.indeterminate('Extracting & Building Quicklook…');
    xhr.onerror = () => { MOD.close(); alert('Network error'); };

    xhr.onload = async () => {
      MOD.close();
      let j = {}; try { j = JSON.parse(xhr.responseText||'{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && j.ok) {
        SceneStore.invalidate();
        window.dispatchEvent(new CustomEvent('s2:scene-updated', { detail: j }));
        alert('Scene uploaded and processed ✅');
      } else {
        alert('Upload/Process failed: ' + (j.error || xhr.statusText || `HTTP ${xhr.status}`));
      }
    };

    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  }

  function wireUploader(inputId, btnId){
    const inp = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', ()=> uploadZipWithProgress(inp));
  }

  // -------------------- Model buttons (optional) --------------------
  function wireModelButtons(){
    const uploadBtn = $('#uploadModelBtn');
    const runBtn    = $('#runModelBtn');

    uploadBtn?.addEventListener('click', async () => {
      const f = $('#modelFile')?.files?.[0];
      if (!f) return alert('فایل مدل را انتخاب کنید');
      const fd = new FormData(); fd.append('file', f);
      try{
        const r = await fetch('/api/model_upload', { method:'POST', body:fd, credentials:'same-origin' });
        const j = await r.json().catch(()=>({}));
        if (!r.ok) throw new Error(j.error || 'upload failed');
        alert('مدل بارگذاری شد');
      }catch(e){ alert(e.message||e); }
    });

    runBtn?.addEventListener('click', async () => {
      MOD.open('Running model… (0%)'); MOD.startPoll();
      try{
        const r = await fetch('/api/run_model', { method:'POST', credentials:'same-origin' });
        if (!r.ok) throw new Error('run failed');
        setTimeout(()=> location.href = '/mask', 400);
      }catch(e){ MOD.close(); alert(e.message||e); }
    });
  }

  // -------------------- Overlay opacity (lightweight) --------------------
  function wireOverlayOpacity(){
    const range = $('#overlayOpacity'); if (!range) return;
    const val = $('#opacityValue');
    const apply = () => {
      const v = (range.valueAsNumber || 60) / 100;
      if (val) val.textContent = v.toFixed(2);
      const A = window.BrushApp;
      const layer = A?.grid?.overlay || A?.overlay;
      if (layer?.setOpacity) layer.setOpacity(v);
    };
    range.addEventListener('input', apply);
    apply();
  }

  // -------------------- Scene dropdown (single wiring, single fetch) --------------------
  function wireSceneSelectOnce(){
    if (window.__SCENE_SELECT_WIRED__) return;
    window.__SCENE_SELECT_WIRED__ = true;

    const sel = document.getElementById('sceneSelect');
    const btn = document.getElementById('sceneApplyBtn');
    if (!sel || !btn) return;

    const fill = async () => {
      try{
        const [items, cur] = await Promise.all([ SceneStore.list(), SceneStore.current() ]);
        sel.innerHTML = '';
        if (!items.length){
          sel.innerHTML = '<option value="">— no scenes found —</option>';
          btn.disabled = true; return;
        }
        for (const it of items){
          const op = document.createElement('option');
          op.value = it.id;
          const tag = [it.tile||'', it.date||''].filter(Boolean).join(' • ');
          op.textContent = tag ? `${it.name} — ${tag}` : (it.name || it.id);
          sel.appendChild(op);
        }
        const curId = cur && (cur.id || cur.scene_id);
        if (curId) sel.value = String(curId);
        btn.disabled = false;
      }catch(e){ warn('fill scenes failed', e); btn.disabled = true; }
    };

    btn.addEventListener('click', async () => {
      const id = sel.value;
      if (!id) return;
      btn.disabled = true;
      const prev = btn.textContent; btn.textContent = 'Loading…';

      MOD.open('Loading scene… (0%)'); MOD.startPoll();
      try{
        const r = await fetch('/api/scenes/select', {
          method:'POST',
          credentials:'same-origin',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ scene_id:id })
        });
        const j = await r.json().catch(()=>({}));
        if (!r.ok){ throw new Error(j.error || `HTTP ${r.status}`); }

        SceneStore.invalidate(); // refresh list/current

        // Hot-swap بدون ری‌لود صفحه:
        try{
          const b = await fetch('/api/s2_bounds_wgs84', { cache:'no-store', credentials:'same-origin' }).then(r=>r.json());
          console.log('[brush] /api/s2_bounds_wgs84 status =', b.status);
          if (b.status !== 200) {
            console.error('[brush] bounds failed, cannot init');
            return;
          }         
          const A = window.BrushApp;
          const url = '/api/output/rgb_quicklook.png?t=' + Date.now();
          if (A?.map){
            if (A.grid?.overlay){
              A.grid.overlay.setUrl(url);
              A.grid.overlay.setBounds([[b.lat_min,b.lon_min],[b.lat_max,b.lon_max]]);
            } else if (A.overlay){
              A.overlay.setUrl(url);
              A.overlay.setBounds([[b.lat_min,b.lon_min],[b.lat_max,b.lon_max]]);
            } else {
              A.overlay = L.imageOverlay(url, [[b.lat_min,b.lon_min],[b.lat_max,b.lon_max]], { opacity:0.6 }).addTo(A.map);
            }
            try { A.map.fitBounds([[b.lat_min,b.lon_min],[b.lat_max,b.lon_max]]); } catch {}
            if (A.rebuildClipPath) A.rebuildClipPath();
            if (window.BrushIO?.reloadPolygonsForScene) await window.BrushIO.reloadPolygonsForScene();
            MOD.close();
          } else {
            MOD.close();
            location.reload();
          }
        }catch{
          MOD.close();
          location.reload();
        }
      }catch(e){
        MOD.close();
        alert('Select failed: ' + (e.message || e));
      }finally{
        btn.textContent = prev;
        btn.disabled = false;
      }
    });

    // فقط یک بار پر کن
    fill();

    // اگر آپلود صحنه جدید شد، بازسازی لیست
    window.addEventListener('s2:scene-updated', () => fill());
  }

  // -------------------- Optional prelabel modal (if controls exist) --------------------
  function wirePrelabelIfPresent(){
    const openBtn = $('#openPrelabelBtn');
    const runBtn  = $('#prelabelRunBtn');
    const closeBtn= $('#prelabelCloseBtn');
    if (!openBtn && !runBtn && !closeBtn) return;

    const modal = $('#modal');
    const methodSel = $('#prelabelMethod');
    const threshWrap= $('#ndviThreshWrap');

    const open = () => { if (modal) show(modal); };
    const close= () => { if (modal) hide(modal);  };
    const toggle = () => { if (threshWrap && methodSel) threshWrap.style.display = (methodSel.value==='ndvi_thresh')?'flex':'none'; };

    openBtn?.addEventListener('click', open);
    closeBtn?.addEventListener('click', close);
    methodSel?.addEventListener('change', toggle);

    runBtn?.addEventListener('click', async () => {
      if (!methodSel) return;
      hide(modal);
      await new Promise(requestAnimationFrame);
      MOD.open('Pre-labeling… (0%)'); MOD.startPoll();
      try{
        const body = { method: methodSel.value };
        if (methodSel.value === 'ndvi_thresh'){
          const v = parseFloat($('#ndviThreshold')?.value || '0.2');
          body.ndvi_threshold = Number.isFinite(v) ? v : 0.2;
        }
        const r = await fetch('/api/prelabel', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          credentials:'same-origin',
          body: JSON.stringify(body)
        });
        if (!r.ok) throw new Error('prelabel failed');
        setTimeout(()=> location.href='/mask', 400);
      }catch(e){ MOD.close(); alert(e.message||e); }
    });

    toggle();
  }

  // -------------------- Boot on DOM ready --------------------
  window.addEventListener('DOMContentLoaded', () => {
    wireUploader('s2Zip', 'uploadS2ZipBtn');
    wireUploader('s2ZipMask', 'uploadS2ZipBtnMask');
    wireModelButtons();
    wireOverlayOpacity();
    wireSceneSelectOnce();
    wirePrelabelIfPresent();

    if (!$('#progressModal')) warn('progress modal (#progressModal) not found');
  });

  // ترک صفحه: polling را متوقف و مودال را ببند
  window.addEventListener('beforeunload', () => MOD.close());
})();