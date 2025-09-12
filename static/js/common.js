// static/js/common.js
(function () {
  const DBG = true;
  const log  = (...a) => DBG && console.debug('[COMMON]', ...a);
  const warn = (...a) => DBG && console.warn('[COMMON]', ...a);
  const err  = (...a) => DBG && console.error('[COMMON]', ...a);

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function showEl(el, display = 'flex') {
    if (!el) return;
    el.classList.remove('hidden');
    el.style.display = display;
  }
  function hideEl(el) {
    if (!el) return;
    el.classList.add('hidden');
    el.style.display = 'none';
  }

  function _setProgressTitle(text) {
    const t1 = $('#progressTitle');
    const t2 = $('#progressModal .modal-title');
    if (t1) t1.textContent = text;
    if (t2 && t2 !== t1) t2.textContent = text;
    log('progress:title', text);
  }

  let pollTimer = null;
  let indetTimer = null;

  function openProgress(initialText = 'در حال پردازش… (0%)') {
    const modal = $('#progressModal');
    const bar   = $('#progressModal .progress .bar');
    if (!modal) { warn('#progressModal not found'); return; }
    showEl(modal, 'flex');
    _setProgressTitle(initialText);
    if (bar) { bar.style.transition = 'width .2s'; bar.style.width = '0%'; }
    log('progress:open');
  }

  function closeProgress() {
    const modal = $('#progressModal');
    if (!modal) return;
    if (pollTimer)  { clearInterval(pollTimer);  pollTimer  = null; }
    if (indetTimer) { clearInterval(indetTimer); indetTimer = null; }
    hideEl(modal);
    log('progress:close');
  }

  function startPollingProgress() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/progress', { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        const percent = Math.max(0, Math.min(100, Number(data.percent) || 0));
        const note = (data.note ?? data.detail ?? '');
        const bar = document.querySelector('#progressModal .progress .bar');
        if (bar) bar.style.width = percent + '%';
        _setProgressTitle(`در حال پردازش… (${Math.round(percent)}%)${note ? ' - ' + note : ''}`);
        if (percent >= 100) {
          clearInterval(pollTimer);
          pollTimer = null;
          setTimeout(closeProgress, 500);
        }
      } catch (e) {
        warn('progress:poll:error', e);
      }
    }, 500);
    log('progress:poll:start');
  }

  function setIndeterminate(note = 'در حال استخراج و ساخت Quicklook…') {
    _setProgressTitle(note);
    const bar = $('#progressModal .progress .bar');
    if (!bar) return;
    bar.style.transition = 'width .6s';
    let w = 15, dir = +1;
    if (indetTimer) clearInterval(indetTimer);
    indetTimer = setInterval(() => {
      w += dir * 15;
      if (w >= 88) dir = -1;
      if (w <= 18) dir = +1;
      bar.style.width = w + '%';
    }, 600);
    log('progress:indeterminate');
  }

  function openPrelabel() {
    const m = $('#modal');
    if (!m) { warn('[prelabel] #modal not found'); return; }
    showEl(m, 'flex');
    m.style.zIndex = 9999;
    const sel  = $('#prelabelMethod');
    const wrap = $('#ndviThreshWrap');
    if (sel && wrap) {
      const toggle = () => { wrap.style.display = (sel.value === 'ndvi_thresh') ? 'flex' : 'none'; };
      sel.onchange = toggle;
      toggle();
    }
    log('prelabel:open');
  }
  function closePrelabel() {
    hideEl($('#modal'));
    log('prelabel:close');
  }

  let prelabelRunning = false;
  async function runPrelabel() {
    if (prelabelRunning) return;
    prelabelRunning = true;
    const btn = $('#prelabelRunBtn');
    if (btn) btn.disabled = true;
    closePrelabel();
    await new Promise(requestAnimationFrame);
    openProgress('در حال پیش‌برچسب‌گذاری… (0%)');
    startPollingProgress();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    try {
      const methodEl = $('#prelabelMethod');
      if (!methodEl) throw new Error('Prelabel control missing');
      const method = methodEl.value;
      const payload = { method };
      if (method === 'ndvi_thresh') {
        const v = parseFloat($('#ndviThreshold')?.value || '0.2');
        payload.ndvi_threshold = Number.isFinite(v) ? v : 0.2;
      }
      const r = await fetch('/api/prelabel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      log('prelabel:POST', payload, 'status=', r.status);
      if (r.ok) {
        setTimeout(() => { window.location.href = '/mask'; }, 600);
      } else {
        const j = await r.json().catch(() => ({ error: 'Pre-label failed' }));
        alert(j.error || 'Pre-label failed');
        closeProgress();
      }
    } catch (e) {
      alert(e?.name === 'AbortError' ? 'Request timed out' : ('Network error: ' + (e?.message || e)));
      closeProgress();
      err('prelabel:error', e);
    } finally {
      clearTimeout(timer);
      prelabelRunning = false;
      if (btn) btn.disabled = false;
    }
  }

  async function refreshModelInfo() {
    const box = $('#modelInfo');
    if (!box) return;
    try {
      const r = await fetch('/api/model_info', { cache: 'no-store' });
      const info = await r.json();
      if (!info.loaded) {
        box.textContent = 'No model loaded';
      } else {
        const providers = (info.providers || []).join(', ');
        const bands = (info.bands || []).join(', ');
        box.textContent = `Loaded • providers: ${providers} • tile=${info.tile_size} • bands=${bands}`;
      }
      log('model:info', info);
    } catch (e) {
      box.textContent = 'Model info error';
      warn('model:info:error', e);
    }
  }

  function wireModelButtons() {
    $('#uploadModelBtn')?.addEventListener('click', async () => {
      const inp = $('#modelFile');
      const f = inp?.files?.[0];
      if (!f) { alert('فایل مدل را انتخاب کنید.'); return; }
      const fd = new FormData();
      fd.append('file', f);
      try {
        const r = await fetch('/api/model_upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        log('model:upload:resp', r.status, j);
        if (r.ok) {
          alert('مدل بارگذاری شد.');
          refreshModelInfo();
        } else {
          alert('خطا: ' + (j.error || 'upload failed'));
        }
      } catch (e) {
        alert('Network error: ' + (e?.message || e));
        err('model:upload:error', e);
      }
    });

    $('#runModelBtn')?.addEventListener('click', async () => {
      openProgress('اجرای مدل… (0%)');
      startPollingProgress();
      try {
        const r = await fetch('/api/run_model', { method: 'POST' });
        log('model:run:status', r.status);
        if (r.ok) {
          setTimeout(() => location.href = '/mask', 450);
        } else {
          const j = await r.json().catch(() => ({}));
          alert('خطا: ' + (j.error || 'run failed'));
          closeProgress();
        }
      } catch (e) {
        alert('Network error: ' + (e?.message || e));
        closeProgress();
        err('model:run:error', e);
      }
    });
  }

  function updateProgressModal(percent, note) {
    const p = Math.max(0, Math.min(100, percent || 0));
    const bar = $('#progressModal .progress .bar');
    if (bar) bar.style.width = p + '%';
    _setProgressTitle(`در حال بارگذاری… (${Math.round(p)}%)${note ? ' - ' + note : ''}`);
    log('upload:progress', { p, note });
  }

  async function uploadS2ZipWithProgress(fileInput) {
    const file = fileInput?.files?.[0];
    if (!file) { alert('یک فایل ZIP انتخاب کنید.'); return; }

    const fd = new FormData();
    fd.append('file', file);

    openProgress('در حال بارگذاری… (0%)');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload_safe_zip', true);

    xhr.upload.onprogress = (e) => {
      if (!$('#progressModal')) return;
      if (e.lengthComputable) {
        updateProgressModal((e.loaded / e.total) * 100, 'آپلود');
      } else {
        updateProgressModal(10, 'آپلود');
      }
    };

    xhr.upload.onload = () => {
      setIndeterminate('در حال استخراج و ساخت Quicklook…');
    };

    xhr.onerror = () => {
      closeProgress();
      alert('خطا در شبکه هنگام آپلود');
      err('upload:xhr:error');
    };

    xhr.onload = async () => {
      closeProgress();
      let j = {};
      try { j = JSON.parse(xhr.responseText || '{}'); } catch {}
      log('upload:xhr:done', xhr.status, j);
      if (xhr.status >= 200 && xhr.status < 300 && j.ok) {
        window.dispatchEvent(new CustomEvent('s2:scene-updated', { detail: j }));
        if (window.reloadBackdropAndMaskAfterUpload) {
          try { await window.reloadBackdropAndMaskAfterUpload(); } catch (e) { warn('reloadBackdrop error', e); }
        }
        alert('صحنه با موفقیت بارگذاری و پردازش شد ✅');
      } else {
        alert('خطا در آپلود/پردازش: ' + (j.error || xhr.statusText || 'UNKNOWN'));
      }
    };

    xhr.send(fd);
    log('upload:xhr:send', { name: file.name, size: file.size });
  }

  function attachZipUploader(inputId, buttonId) {
    const inp = document.getElementById(inputId);
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.addEventListener('click', () => uploadS2ZipWithProgress(inp));
    log('uploader:wired', { inputId, buttonId });
  }

  function wireOverlayOpacity() {
    const overlayRange = $('#overlayOpacity');
    const overlayVal   = $('#opacityValue');
    if (!overlayRange) return;
    const apply = () => {
      const v = (overlayRange.valueAsNumber || 60) / 100;
      if (overlayVal) overlayVal.textContent = v.toFixed(2);
      log('overlay:ui:value', v);
    };
    overlayRange.addEventListener('input', apply);
    apply();
  }

  window.openPrelabel  = openPrelabel;
  window.closePrelabel = closePrelabel;
  window.runPrelabel   = runPrelabel;
  window.closeProgress = closeProgress;

  window.addEventListener('DOMContentLoaded', () => {
    attachZipUploader('s2Zip', 'uploadS2ZipBtn');
    attachZipUploader('s2ZipMask', 'uploadS2ZipBtnMask');
    wireModelButtons();
    wireOverlayOpacity();
    refreshModelInfo();
    log('DOM ready');
    if (!$('#progressModal')) {
      warn('[progress] #progressModal missing — add modal HTML to page');
    }
  });

  window.addEventListener('beforeunload', closeProgress);
})();