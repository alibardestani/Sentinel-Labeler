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

  // -------------------- One-shot fetch with in-flight + memo --------------------
  const inflight = new Map(); // key -> Promise
  const memo     = new Map(); // key -> { t, data }
  const TTL_MS   = 60_000;    // 60s cache for scene list/current

  async function fetchJSONOnce(key, url, opts={}) {
    const now = Date.now();
    const m = memo.get(key);
    if (m && now - m.t < TTL_MS) return m.data;
    if (inflight.has(key)) return inflight.get(key);

    const p = fetch(url, { cache: 'no-store', ...opts })
      .then(async r => {
        let j = {};
        try { j = await r.json(); } catch { j = {}; }
        memo.set(key, { t: Date.now(), data: j });
        inflight.delete(key);
        return j;
      })
      .catch(e => {
        inflight.delete(key);
        throw e;
      });

    inflight.set(key, p);
    return p;
  }

  function dropFromMemo(key){ try { memo.delete(key); } catch {} }

  // -------------------- SceneStore (single source of truth) --------------------
  const SceneStore = {
    async list()    { return await fetchJSONOnce('scenes.list',    '/api/scenes/list');    },
    async current() { return await fetchJSONOnce('scenes.current', '/api/scenes/current'); },
    invalidate()    { dropFromMemo('scenes.list'); dropFromMemo('scenes.current'); }
  };
  window.SceneStore = SceneStore;

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
          const r = await fetch('/api/progress?ts='+Date.now(), { cache:'no-store', signal: ctrl.signal });
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

    // درست کردن FormData
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
        const r = await fetch('/api/model_upload', { method:'POST', body:fd });
        const j = await r.json().catch(()=>({}));
        if (!r.ok) throw new Error(j.error || 'upload failed');
        alert('مدل بارگذاری شد');
      }catch(e){ alert(e.message||e); }
    });

    runBtn?.addEventListener('click', async () => {
      MOD.open('Running model… (0%)'); MOD.startPoll();
      try{
        const r = await fetch('/api/run_model', { method:'POST' });
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
        const [j, curObj] = await Promise.all([ SceneStore.list(), SceneStore.current() ]);
        const cur = curObj?.scene?.id || null;
        const items = j?.items || [];
        sel.innerHTML = '';
        if (!items.length){
          sel.innerHTML = '<option value="">— no scenes found —</option>';
          btn.disabled = true; return;
        }
        for (const it of items){
          const op = document.createElement('option');
          op.value = it.id;
          const tag = [it.tile||'', it.date||''].filter(Boolean).join(' • ');
          op.textContent = tag ? `${it.name} — ${tag}` : it.name;
          sel.appendChild(op);
        }
        if (cur) sel.value = cur;
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
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ scene_id:id })
        });
        const j = await r.json().catch(()=>({}));
        if (!r.ok /*|| !j.ok*/){ throw new Error(j.error || `HTTP ${r.status}`); }

        SceneStore.invalidate(); // refresh list/current

        // Hot-swap بدون ری‌لود صفحه:
        try{
          const b = await fetch('/api/s2_bounds_wgs84', { cache:'no-store' }).then(r=>r.json());
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
        const r = await fetch('/api/prelabel', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
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