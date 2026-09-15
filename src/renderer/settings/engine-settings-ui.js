'use strict';
window.createEngineSettingsUI = ({ api, status, navigate }) => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const drafts = new Map();
  let engine = 'dsh', documentId = 'settings', nativePending = false, activePage = false, nativeStarted = false;
  const current = () => drafts.get(engine);
  function changed() { current().dirty = true; $('saveEngine').disabled = false; $('reloadEngine').textContent = "Discard and reload"; $('engineSaveHint').textContent = "You have unsaved changes"; }
  function renderDocument() {
    const file = current().files.find(file => file.id === documentId) || current().files[0];
    documentId = file.id; $('engineDocument').value = file.id;
    $('engineSource').value = file.text; $('documentFormat').textContent = file.format.toUpperCase();
  }
  function render() {
    const state = current(); if (!state) return;
    $('engineLoading').hidden = true; $('engineContent').hidden = false;
    $('enginePaths').innerHTML = state.files.map(file => `<p><code>${esc(file.path)}</code>${file.backup ? " · Backed up" : ''}</p>`).join('');
    $('dshNative').hidden = engine !== 'dsh';
    $('nativeDocuments').querySelector('summary').textContent = engine === 'dsh' ? "Advanced configuration · Full YAML" : "Advanced configuration · MCP · " + (engine === 'kimi' ? "Terminal" : "Global instructions");
    $('engineCommon').innerHTML = state.fields.map((field, i) => {
      const value = field.key in state.common ? state.common[field.key] : field.value;
      const id = 'nativeField' + i;
      const input = field.type === 'select' ? `<select id="${id}" data-field="${field.key}">${field.options.map(([id, name]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>`
        : `<input id="${id}" data-field="${field.key}" type="${field.type}" ${field.type === 'checkbox' ? value ? 'checked' : '' : `value="${esc(value)}" placeholder="${esc(field.placeholder || '')}"`} ${field.type === 'number' ? `min="${field.min}" max="${field.max}"` : ''}>`;
      return `<div class="engine-field"><label for="${id}">${esc(field.label)}</label>${input}</div>`;
    }).join('') + (engine === 'dsh' ? '' : `<h2 class="engine-common-title">Workbench sessions</h2><div class="engine-field"><label for="engineCwd">Default directory for standalone sessions<small class="hint" style="display:block">Leave blank to use the application directory. Workspace sessions use their own folders.</small></label><input id="engineCwd" data-desktop="cwd" value="${esc(state.desktop.cwd || '')}" placeholder="Application session directory"></div>`)
      + (engine === 'kimi' ? `<div class="engine-field"><label for="engineContext">Model context window (tokens)</label><input id="engineContext" data-desktop="contextWindow" type="number" min="4096" max="2000000" value="${state.desktop.contextWindow || 131072}"></div>` : '');
    $('engineDocument').innerHTML = state.files.map(file => `<option value="${file.id}">${esc(file.label)}</option>`).join('');
    renderDocument(); $('saveEngine').disabled = !state.dirty;
    $('reloadEngine').textContent = state.dirty ? "Discard and reload" : "Reload";
    $('engineSaveHint').textContent = state.dirty ? "You have unsaved changes" : "Applies to the next message";
  }
  async function nativePanel(force = false) {
    if (api.nativeSettingsView !== true) { $('nativeLoading').textContent = "The native panel is available in the desktop application."; return; }
    if (nativePending) return;
    nativePending = true; $('retryNative').hidden = true; $('nativeLoading').textContent = "Preparing DSH settings…";
    try {
      const result = await placeNative(force); if (!result.ok) throw new Error(result.error);
      nativeStarted = true; $('nativeLoading').textContent = '';
    } catch (e) { $('nativeLoading').textContent = e.message; $('retryNative').hidden = false; }
    finally { nativePending = false; }
  }
  function placeNative(reload = false) {
    if (api.nativeSettingsView !== true) return Promise.resolve({ ok: true });
    const surface = $('dshSettingsSurface').getBoundingClientRect(), clip = document.querySelector('.scroll-content').getBoundingClientRect();
    const y = Math.max(surface.top, clip.top), height = Math.max(0, Math.min(surface.bottom, clip.bottom) - y);
    return api.showNativeSettings({ visible: activePage && engine === 'dsh' && ! $('engineContent').hidden && height > 0,
      bounds: { x: surface.left, y, width: surface.width, height }, reload });
  }
  function setVisible(visible) { activePage = visible; void placeNative(); }
  async function select(next, reload = false) {
    if (!['dsh', 'claude', 'kimi'].includes(next)) next = 'dsh';
    engine = next;
    void placeNative();
    document.querySelectorAll('[data-engine]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.engine === engine)));
    $('engineContent').hidden = true; $('engineLoading').hidden = false; $('engineLoading').textContent = "Loading settings…";
    try {
      if (!drafts.has(next) || reload) {
        const result = await api.engineSettingsGet({ engine: next }); if (!result.ok) throw new Error(result.error);
        drafts.set(next, { ...result, common: {}, dirty: false });
      }
      if (engine !== next) return;
      render(); if (next === 'dsh') { if (nativeStarted) void placeNative(); else void nativePanel(); }
    } catch (e) { if (engine === next) $('engineLoading').textContent = e.message; }
  }
  function renderRuntimes(rows) {
    $('runtimeCards').innerHTML = rows.map(row => `<article class="runtime-card"><div><h2>${esc(row.name)}</h2><span class="badge ${row.status === 'ready' ? 'good' : row.status === 'error' ? 'bad' : ''}">${({ready:"Ready",installing:"Preparing",missing:"Install on first use",error:"Preparation failed"})[row.status]}</span><button data-install="${row.id}" ${row.status === 'ready' || row.status === 'installing' ? 'disabled' : ''}>${row.status === 'error' ? "Retry" : row.status === 'ready' ? "Installed" : "Prepare now"}</button></div><p class="hint">${esc(row.status === 'ready' ? `v${row.version} · ${row.source}` : row.message || "Installed when you open the engine, or prepare it now.")}</p>${row.file ? `<details><summary>Installation path</summary><code>${esc(row.file)}</code></details>` : ''}</article>`).join('');
  }
  async function runtimePage() { try { const result = await api.runtimeState(); if (!result.ok) throw new Error(result.error); renderRuntimes(result.engines); } catch (e) { status(e.message, true); } }
  $('engineCommon').oninput = e => {
    const input = e.target, value = input.type === 'checkbox' ? input.checked : input.type === 'number' && input.value !== '' ? Number(input.value) : input.value;
    if (input.dataset.field) current().common[input.dataset.field] = value;
    else if (input.dataset.desktop) current().desktop[input.dataset.desktop] = value;
    else return;
    changed();
  };
  $('engineSource').oninput = e => { current().files.find(file => file.id === documentId).text = e.target.value; changed(); };
  $('engineDocument').onchange = e => { documentId = e.target.value; renderDocument(); };
  $('reloadEngine').onclick = () => select(engine, true);
  $('retryNative').onclick = () => nativePanel(true);
  document.querySelectorAll('[data-engine]').forEach(button => { button.onclick = () => select(button.dataset.engine); });
  $('saveEngine').onclick = async () => {
    const savingEngine = engine, state = current();
    $('saveEngine').disabled = true; $('engineContent').inert = true;
    try {
      const result = await api.engineSettingsSave({ engine: savingEngine, files: state.files, common: state.common, desktop: state.desktop });
      if (!result.ok) throw new Error(result.error);
      drafts.set(savingEngine, { ...result, common: {}, dirty: false });
      if (engine === savingEngine) render();
      status("Global settings saved. Original files were backed up on first overwrite.");
      if (savingEngine === 'dsh') void nativePanel(true);
    } catch (e) { status(e.message, true); $('saveEngine').disabled = false; }
    finally { $('engineContent').inert = false; }
  };
  $('runtimeCards').onclick = async e => {
    const button = e.target.closest('[data-install]'); if (!button) return;
    button.disabled = true;
    try { const result = await api.runtimeEnsure({ engine: button.dataset.install }); if (!result.ok) throw new Error(result.error); status("Runtime ready"); }
    catch (e) { status(e.message, true); } finally { void runtimePage(); }
  };
  api.onRuntimeState(renderRuntimes);
  api.onNativeSettingsReady(() => { $('nativeLoading').textContent = ''; });
  let layoutFrame;
  const layout = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(() => { void placeNative(); }); };
  window.addEventListener('resize', layout);
  document.querySelector('.scroll-content').addEventListener('scroll', layout);
  new ResizeObserver(layout).observe($('engineContent'));
  return { select, runtimePage, selected: () => engine, setVisible };
};
