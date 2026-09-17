'use strict';
window.createEngineSettingsUI = ({ api, status, navigate }) => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const drafts = new Map();
  let downloadDirty = false;
  let engine = 'claude', documentId = 'settings', nativePending = false, activePage = false, nativeStarted = false, nativeNeedsRuntime = false;
  let nativeReady = false, nativeReadyTimer;
  const current = () => drafts.get(engine);
  function changed() { current().dirty = true; $('saveEngine').disabled = false; $('reloadEngine').textContent = "Discard and reload"; $('engineSaveHint').textContent = "You have unsaved changes"; if (['codex', 'kimi', 'antigravity'].includes(engine)) renderConnection(); }
  let googleAccount = null, accountBusy = false;
  let codexAccount = null, codexBusy = false;
  let kimiAccount = null, kimiBusy = false;
  function renderKimiAccount() {
    $('kimiConnectionPanel').hidden = engine !== 'kimi';
    if (engine !== 'kimi') return;
    const state = current(), pending = Boolean(kimiAccount?.loginPending), busy = kimiBusy || kimiAccount?.refreshing || kimiAccount?.signingOut;
    $('kimiConnection').value = state.desktop.connection || 'api';
    $('kimiLoginRegion').value = state.desktop.region || 'mainland-cn';
    $('kimiAccountPanel').hidden = state.desktop.connection !== 'subscription';
    $('kimiConnectionHint').textContent = state.desktop.connection === 'subscription'
      ? 'Sign in with your Kimi account to use its eligible models and subscription quota. No API key is needed.'
      : 'Use the providers, API keys and models configured in Providers & Keys.';
    $('kimiSaveConnection').hidden = !state.dirty;
    $('kimiSignIn').disabled = Boolean(busy || state.dirty || pending);
    $('kimiRefresh').disabled = Boolean(busy || state.dirty || pending || !kimiAccount?.installed);
    $('kimiSignOut').disabled = Boolean(busy || state.dirty || pending);
    $('kimiSignOut').hidden = !kimiAccount?.account;
    $('kimiUsage').hidden = !kimiAccount?.account;
    $('kimiCancelLogin').hidden = !pending;
    $('kimiCancelLogin').disabled = kimiBusy === 'kimiCancelLogin';
    $('kimiLoginRegion').disabled = Boolean(busy || pending);
    $('kimiAccountStatus').textContent = state.dirty ? 'Save settings before connecting the account.' : kimiAccount?.signingOut ? 'Signing out of Kimi…' : busy ? 'Checking Kimi account…'
      : pending ? 'Complete Kimi sign-in in your browser. This page updates automatically.'
      : kimiAccount?.error || (kimiAccount?.account ? `Signed in · ${kimiAccount.models.length} account models available` : 'Sign in with Kimi to load your account models.');
    $('kimiDeviceLogin').hidden = !pending || !kimiAccount?.login?.userCode;
    $('kimiUserCode').textContent = kimiAccount?.login?.userCode || '';
    $('kimiLoginExpiry').textContent = kimiAccount?.login?.expiresAt ? 'Code expires at ' + new Date(kimiAccount.login.expiresAt).toLocaleTimeString() : '';
    $('kimiOpenLogin').disabled = !kimiAccount?.login?.verificationUrl;
    $('kimiModelDetails').hidden = !kimiAccount?.models?.length;
    $('kimiModelList').innerHTML = (kimiAccount?.models || []).map(model => `<li title="${esc(model.id)}">${esc(model.name)}</li>`).join('');
  }
  async function loadKimiAccount() {
    const result = await api.kimiAccountState(); if (!result.ok) throw new Error(result.error);
    kimiAccount = result; renderKimiAccount();
  }
  function renderCodexAccount() {
    $('codexConnectionPanel').hidden = engine !== 'codex';
    if (engine !== 'codex') return;
    const state = current();
    $('codexConnection').value = state.desktop.connection;
    $('codexProxyUrl').value = state.desktop.proxyUrl || '';
    $('codexAccountPanel').hidden = state.desktop.connection !== 'subscription';
    $('codexConnectionHint').textContent = state.desktop.connection === 'api'
      ? 'Use models from Providers & Keys, including supported third-party APIs. No ChatGPT sign-in is required. The API provider bills this usage.'
      : 'Use the models and quota included with your ChatGPT account. You can choose API key / third-party API above without signing in.';
    $('codexSaveConnection').hidden = !state.dirty;
    for (const id of ['codexSignIn', 'codexRefresh', 'codexSignOut', 'codexCancelLogin']) $(id).disabled = codexBusy || state.dirty;
    $('codexCancelLogin').hidden = !codexAccount?.loginPending;
    $('codexSignOut').hidden = !codexAccount?.account;
    const account = codexAccount?.account;
    $('codexAccountStatus').textContent = state.dirty ? 'Save settings before connecting the account.' : codexBusy ? 'Connecting to Codex…'
      : codexAccount?.loginPending ? 'Complete ChatGPT sign-in in your browser.' : codexAccount?.error || (account ? (account.email || 'Signed in') + ' · ' + (account.planType || 'ChatGPT') : 'Sign in with ChatGPT to load your models and quota.');
    $('codexModelDetails').hidden = !codexAccount?.models?.length;
    $('codexModelList').innerHTML = (codexAccount?.models || []).map(model => '<li>' + esc(model.name) + '</li>').join('');
    $('codexQuotas').replaceChildren();
    const limits = codexAccount?.rateLimits;
    const buckets = limits?.primary || limits?.secondary ? { codex: limits } : limits || {};
    for (const [name, limit] of Object.entries(buckets)) for (const window of [limit.primary, limit.secondary]) {
      if (!window) continue;
      const row = document.createElement('div'), label = document.createElement('p'), progress = document.createElement('progress');
      const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
      label.dataset.i18n = ''; label.textContent = name + ' · ' + (window.windowDurationMins >= 1440 ? Math.round(window.windowDurationMins / 1440) + ' days' : window.windowDurationMins + ' min') + ' · ' + remaining + '% remaining' + (window.resetsAt ? ' · Resets ' + new Date(window.resetsAt * 1000).toLocaleString() : '');
      progress.max = 100; progress.value = remaining; progress.setAttribute('aria-label', label.textContent);
      row.append(label, progress); $('codexQuotas').append(row);
    }
    if (account && !Object.keys(buckets).length) { const hint = document.createElement('p'); hint.className = 'hint'; hint.dataset.i18n = ''; hint.textContent = codexAccount.quotaError || 'Quota information is currently unavailable.'; $('codexQuotas').append(hint); }
  }
  async function loadCodexAccount() {
    const result = await api.codexAccountState(); if (!result.ok) throw new Error(result.error);
    codexAccount = result; renderCodexAccount();
  }
  function renderConnection() {
    renderCodexAccount();
    renderKimiAccount();
    $('antigravityConnectionPanel').hidden = engine !== 'antigravity';
    if (engine !== 'antigravity') return;
    const state = current(), subscription = state.desktop.connection === 'subscription';
    $('antigravityConnection').value = state.desktop.connection;
    $('googleProxyUrl').value = state.desktop.proxyUrl || '';
    $('googleAccountPanel').hidden = !subscription;
    $('antigravityConnectionHint').textContent = subscription
      ? 'Use the models and quota included with your Google account. Google credentials stay in the official CLI. Existing API sessions keep using their original connection.'
      : 'Use providers and API keys configured in Providers & Keys. Existing Google sessions keep using the Google account.';
    $('googleSignIn').disabled = state.dirty || accountBusy;
    $('googleSaveConnection').hidden = !state.dirty;
    $('googleRefresh').disabled = state.dirty || accountBusy || !googleAccount?.installed;
    $('googleAccountStatus').textContent = state.dirty ? 'Save engine settings before connecting or refreshing the account.'
      : accountBusy ? 'Connecting to Google…' : googleAccount?.error || (googleAccount?.models?.length
        ? `${googleAccount.models.length} models available · Last checked ${new Date(googleAccount.verifiedAt).toLocaleString()}`
        : 'Sign in or refresh an existing CLI sign-in. The required runtime is downloaded on demand.');
    $('googleModelDetails').hidden = !googleAccount?.models?.length;
    $('googleModelSummary').textContent = 'Available account models';
    $('googleModelList').innerHTML = (googleAccount?.models || []).map(model => `<li title="${esc(model.id)}">${esc(model.name)}</li>`).join('');
  }
  async function loadAccount() {
    const result = await api.antigravityAccountState();
    if (!result.ok) throw new Error(result.error);
    googleAccount = result; renderConnection();
  }
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
    const appScope = state.scope === 'app';
    renderConnection();
    $('engineScopeTitle').textContent = appScope ? (engine === 'codex' ? 'Codex in Camellia' : 'Antigravity in Camellia') : 'These settings also apply to the CLI';
    $('engineScopeDescription').textContent = appScope
      ? (engine === 'codex' ? 'Codex configuration, credentials and history are stored inside Camellia. Saving here does not change your personal ~/.codex directory.' : 'These settings apply to the Antigravity engine in Camellia. Choose models and manage API keys in Providers & Keys.')
      : "Saving overwrites the CLI's global settings and affects other CLI sessions. Before the first overwrite, an original .workbench.bak backup is kept.";
    $('engineRouteHint').textContent = engine === 'antigravity'
      ? appScope ? 'API mode uses the shared key pool. Switch the connection to Google subscription to use your Google plan.'
        : 'Subscription mode uses the official Google account provider. Headless tools that require interactive approval are declined by the CLI; configure its permission rules here. AI credits are used only if you enable them.'
      : "Camellia manages API routes centrally. CLI sessions using its router require the app to remain running. Project settings follow each engine's precedence rules.";
    $('engineAdvancedHint').textContent = engine === 'codex' ? 'Edit native TOML, including [mcp_servers] and skills. Connection settings and credentials are managed by Camellia.' : appScope
      ? 'Add MCP servers under mcpServers and local skill directories under skillsPaths. Common options above are applied when you save.'
      : 'Edit full native configuration, including tools, hooks, plugins, and permission rules. Camellia manages API connections. Common options above are applied when you save.';
    $('nativeDocuments').querySelector('summary').textContent = engine === 'dsh' ? "Advanced configuration · Full YAML" : "Advanced configuration · MCP · " + (engine === 'kimi' ? "Terminal" : engine === 'antigravity' ? "Skills" : "Global instructions");
    $('engineCommon').innerHTML = state.fields.map((field, i) => {
      const value = field.key in state.common ? state.common[field.key] : field.value;
      const id = 'nativeField' + i;
      const input = field.type === 'select' ? `<select id="${id}" data-field="${field.key}">${field.options.map(([id, name]) => `<option data-i18n value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>`
        : field.type === 'textarea' ? `<textarea id="${id}" data-field="${field.key}" rows="4" placeholder="${esc(field.placeholder || '')}" data-i18n-attrs="placeholder">${esc(value)}</textarea>`
        : `<input id="${id}" data-field="${field.key}" type="${field.type}" ${field.type === 'checkbox' ? value ? 'checked' : '' : `value="${esc(value)}" placeholder="${esc(field.placeholder || '')}"`} ${field.type === 'number' ? `min="${field.min}" max="${field.max}"` : ''} data-i18n-attrs="placeholder">`;
      return `<div class="engine-field"><label for="${id}" data-i18n>${esc(field.label)}</label>${input}</div>`;
    }).join('') + (engine === 'dsh' ? '' : `<h2 class="engine-common-title" data-i18n>Workbench sessions</h2><div class="engine-field"><label for="engineCwd" data-i18n>Default directory for standalone sessions<small class="hint" style="display:block" data-i18n>Leave blank to use the application directory. Workspace sessions use their own folders.</small></label><input id="engineCwd" data-desktop="cwd" value="${esc(state.desktop.cwd || '')}" placeholder="Application session directory" data-i18n-attrs="placeholder"></div>`)
      + (engine === 'kimi' ? `<div class="engine-field"><label for="engineContext" data-i18n>API model context window (tokens)<small class="hint" data-i18n>Subscription models use the context limit reported by Kimi.</small></label><input id="engineContext" data-desktop="contextWindow" type="number" min="4096" max="2000000" value="${state.desktop.contextWindow || 131072}"></div>` : '');
    $('engineDocument').innerHTML = state.files.map(file => `<option data-i18n value="${file.id}">${esc(file.label)}</option>`).join('');
    renderDocument(); $('saveEngine').disabled = !state.dirty;
    $('reloadEngine').textContent = state.dirty ? "Discard and reload" : "Reload";
    $('engineSaveHint').textContent = state.dirty ? "You have unsaved changes" : "Applies to the next message";
  }
  async function nativePanel(force = false) {
    if (api.nativeSettingsView !== true) { $('nativeLoading').textContent = "The native panel is available in the desktop application."; return; }
    if (nativePending) return;
    nativePending = true; $('retryNative').hidden = true; $('nativeLoading').textContent = "Preparing DSH settings…";
    if (force) nativeReady = false;
    clearTimeout(nativeReadyTimer);
    $('dshNative').classList.remove('runtime-unavailable');
    try {
      const result = await placeNative(force);
      nativeNeedsRuntime = Boolean(result.needsRuntime);
      $('dshNative').classList.toggle('runtime-unavailable', nativeNeedsRuntime);
      $('retryNative').textContent = nativeNeedsRuntime ? 'Manage downloads' : 'Reload panel';
      if (!result.ok) throw new Error(result.error);
      nativeStarted = true;
      if (nativeReady) $('nativeLoading').textContent = '';
      else nativeReadyTimer = setTimeout(() => {
        if (nativeReady) return;
        $('nativeLoading').textContent = 'The DSH panel did not finish loading. Reload the panel or edit Advanced configuration below.';
        $('retryNative').hidden = false;
      }, 30000);
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
    if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity'].includes(next)) next = 'claude';
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
      render(); if (next === 'antigravity') await loadAccount(); if (next === 'codex') await loadCodexAccount(); if (next === 'kimi') await loadKimiAccount();
      if (next === 'dsh') { if (nativeStarted) void placeNative(); else void nativePanel(); }
    } catch (e) { if (engine === next) $('engineLoading').textContent = e.message; }
  }
  async function openAccount(next) {
    if (!['kimi', 'antigravity', 'codex'].includes(next)) return;
    await select(next);
    if (engine !== next || !current() || !activePage) return;
    // Opening a login shortcut selects a draft only. Saving and authorizing
    // remain explicit, and existing API/provider edits remain intact.
    if (current().desktop.connection !== 'subscription') {
      current().desktop.connection = 'subscription'; changed(); render();
    }
    const prefix = next === 'antigravity' ? 'google' : next;
    const target = $(prefix + (current().dirty ? 'SaveConnection' : 'SignIn'));
    target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true });
  }
  let runtimeRows = [], runtimeUpdateInfo = {}, runtimeUpdatesBusy = false;
  function updateInfoLine(id) {
    const info = runtimeUpdateInfo[id];
    if (!info) return '';
    if (!info.checkable) return `<p class="hint" data-i18n>Updates ship with the app</p>`;
    if (info.error) return `<p class="hint"><span data-i18n>Update check failed</span> · ${esc(info.error)}</p>`;
    if (!info.installed) return '';
    if (info.updateAvailable) return `<p class="hint"><span data-i18n>v${esc(info.latest)} is available</span> <button data-update="${id}" data-i18n ${runtimeUpdatesBusy ? 'disabled' : ''}>Update</button></p>`;
    return `<p class="hint" data-i18n>Up to date</p>`;
  }
  function renderRuntimes(rows) {
    runtimeRows = rows;
    $('runtimeCards').innerHTML = rows.map(row => `<article class="runtime-card"><div><h2>${esc(row.name)}${row.id === 'antigravity' ? ` · ${row.mode === 'subscription' ? 'Google subscription' : 'API'}` : ''}</h2><span data-i18n class="badge ${row.status === 'ready' ? 'good' : row.status === 'error' ? 'bad' : ''}">${({ready:"Ready",installing:"Downloading",missing:"Not downloaded",error:"Download failed"})[row.status]}</span><button data-i18n data-install="${row.id}" ${row.status === 'ready' || row.status === 'installing' ? 'disabled' : ''}>${row.status === 'error' ? "Retry download" : row.status === 'ready' ? "Installed" : row.status === 'installing' ? "Downloading…" : "Download"}</button></div><p class="hint" data-i18n>${esc(row.status === 'ready' ? `v${row.version} · ${row.source}` : row.message || (row.id === 'antigravity' ? row.mode === 'subscription' ? 'Downloads the official CLI for Google sign-in. No Python environment is needed.' : 'Downloads the official SDK and its own Python environment. Other engines stay uninstalled.' : 'Download this engine when you need it. Other engines stay uninstalled.'))}</p>${updateInfoLine(row.id)}${row.file ? `<details><summary data-i18n>Installation path</summary><code>${esc(row.file)}</code></details>` : ''}</article>`).join('');
  }
  async function checkRuntimeUpdates() {
    if (runtimeUpdatesBusy) return;
    runtimeUpdatesBusy = true;
    $('checkRuntimeUpdates').disabled = true;
    status('Checking for updates…');
    try {
      const result = await api.runtimeCheckUpdates();
      if (!result.ok) throw new Error(result.error);
      runtimeUpdateInfo = Object.fromEntries(result.engines.map(row => [row.id, row]));
      status('');
    } catch (error) { status(error.message, true); }
    finally { runtimeUpdatesBusy = false; $('checkRuntimeUpdates').disabled = false; renderRuntimes(runtimeRows); }
  }
  $('checkRuntimeUpdates').onclick = checkRuntimeUpdates;
  async function runtimePage(focus) {
    try {
      const [result, settings] = await Promise.all([api.runtimeState(), api.downloadSettings()]);
      if (!result.ok) throw new Error(result.error);
      if (!settings.ok) throw new Error(settings.error);
      renderRuntimes(result.engines);
      if (!downloadDirty) {
        $('downloadMode').value = settings.mode;
        $('downloadProxyUrl').value = settings.url;
        $('downloadProxyUrl').required = settings.mode === 'proxy';
      }
      if (focus === 'downloadProxyUrl') $('downloadProxyUrl').focus();
    } catch (e) { status(e.message, true); }
  }
  $('downloadPreferences').oninput = () => {
    downloadDirty = true;
    $('downloadProxyUrl').required = $('downloadMode').value === 'proxy';
    $('saveDownload').disabled = false;
  };
  $('downloadPreferences').onsubmit = async e => {
    e.preventDefault();
    $('downloadPreferences').inert = true;
    try {
      const settings = await api.downloadSaveSettings({ mode: $('downloadMode').value, url: $('downloadProxyUrl').value });
      if (!settings.ok) throw new Error(settings.error);
      $('downloadProxyUrl').value = settings.url;
      downloadDirty = false;
      $('saveDownload').disabled = true;
      status('Download connection saved');
    } catch (error) { status(error.message, true); }
    finally { $('downloadPreferences').inert = false; }
  };
  $('engineCommon').oninput = e => {
    const input = e.target, value = input.type === 'checkbox' ? input.checked : input.type === 'number' && input.value !== '' ? Number(input.value) : input.value;
    if (input.dataset.field) current().common[input.dataset.field] = value;
    else if (input.dataset.desktop) current().desktop[input.dataset.desktop] = value;
    else return;
    changed();
  };
  $('codexConnection').onchange = e => { current().desktop.connection = e.target.value; changed(); };
  $('codexProxyUrl').oninput = e => { current().desktop.proxyUrl = e.target.value; changed(); };
  $('codexSaveConnection').onclick = () => $('saveEngine').click();
  $('codexProviders').onclick = () => navigate('providers');
  for (const [id, action] of [['codexSignIn', 'codexSignIn'], ['codexRefresh', 'codexAccountRefresh'], ['codexSignOut', 'codexSignOut'], ['codexCancelLogin', 'codexCancelLogin']]) $(id).onclick = async () => {
    codexBusy = true; renderCodexAccount();
    try {
      const result = await api[action](); if (!result.ok) throw new Error(result.error);
      if (!result.canceled) codexAccount = result;
    } catch (error) { status(error.message, true); }
    finally { codexBusy = false; renderCodexAccount(); }
  };
  api.onCodexAccount(account => { codexAccount = account; renderCodexAccount(); });
  $('kimiConnection').onchange = e => { current().desktop.connection = e.target.value; changed(); };
  $('kimiLoginRegion').onchange = e => { current().desktop.region = e.target.value; changed(); };
  $('kimiSaveConnection').onclick = () => $('saveEngine').click();
  $('kimiProviders').onclick = () => navigate('providers');
  for (const [id, action] of [['kimiSignIn', 'kimiSignIn'], ['kimiRefresh', 'kimiAccountRefresh'], ['kimiSignOut', 'kimiSignOut'], ['kimiCancelLogin', 'kimiCancelLogin'], ['kimiOpenLogin', 'kimiOpenLogin']]) $(id).onclick = async () => {
    kimiBusy = action; renderKimiAccount();
    try {
      const result = await api[action](); if (!result.ok) throw new Error(result.error);
      if (!result.canceled) kimiAccount = result;
    } catch (error) { status(error.message, true); }
    finally { kimiBusy = false; renderKimiAccount(); }
  };
  api.onKimiAccount(account => { kimiAccount = account; renderKimiAccount(); });
  $('antigravityConnection').onchange = e => { current().desktop.connection = e.target.value; changed(); };
  $('googleProxyUrl').oninput = e => { current().desktop.proxyUrl = e.target.value; changed(); };
  async function googleAction(action) {
    accountBusy = true; renderConnection();
    try {
      const result = await api[action === 'signIn' ? 'antigravitySignIn' : 'antigravityAccountRefresh']();
      if (!result.ok) throw new Error(result.error);
      if (!result.canceled) {
        await select('antigravity', true);
        status(action === 'signIn' ? 'Complete Google sign-in in the terminal, then refresh the account here.' : 'Google account models refreshed');
      }
    } catch (error) { status(error.message, true); await loadAccount(); }
    finally { accountBusy = false; renderConnection(); }
  }
  $('googleSignIn').onclick = () => void googleAction('signIn');
  $('googleSaveConnection').onclick = () => $('saveEngine').click();
  $('googleRefresh').onclick = () => void googleAction('refresh');
  $('engineSource').oninput = e => { current().files.find(file => file.id === documentId).text = e.target.value; changed(); };
  $('engineDocument').onchange = e => { documentId = e.target.value; renderDocument(); };
  $('reloadEngine').onclick = () => select(engine, true);
  $('retryNative').onclick = () => nativeNeedsRuntime ? navigate({ page: 'runtimes' }) : nativePanel(true);
  document.querySelectorAll('[data-engine]').forEach(button => { button.onclick = () => select(button.dataset.engine); });
  $('saveEngine').onclick = async () => {
    const savingEngine = engine, state = current();
    $('saveEngine').disabled = true; $('engineContent').inert = true;
    try {
      const desktop = Object.fromEntries(['cwd', 'contextWindow', 'connection', 'proxyUrl', 'region'].filter(key => key in state.desktop).map(key => [key, state.desktop[key]]));
      const result = await api.engineSettingsSave({ engine: savingEngine, files: state.files, common: state.common, desktop });
      if (!result.ok) throw new Error(result.error);
      drafts.set(savingEngine, { ...result, common: {}, dirty: false });
      if (engine === savingEngine) render();
      status(savingEngine === 'codex' ? 'Codex settings saved in Camellia. Applies to the next message.' : savingEngine === 'antigravity' ? "Antigravity settings saved. Applies to the next message." : "Global settings saved. Original files were backed up on first overwrite.");
      if (savingEngine === 'dsh') void nativePanel(true);
    } catch (e) { status(e.message, true); $('saveEngine').disabled = false; }
    finally { $('engineContent').inert = false; }
  };
  $('runtimeCards').onclick = async e => {
    const updateButton = e.target.closest('[data-update]');
    if (updateButton) {
      updateButton.disabled = true;
      status('Updating…');
      try {
        const result = await api.runtimeUpdate({ engine: updateButton.dataset.update });
        if (!result.ok) throw new Error(result.error);
        if (result.restarting) return;
        await checkRuntimeUpdates();
        if (result.changed) {
          const name = (runtimeRows.find(row => row.id === result.engine) || {}).name || result.engine;
          status(`Updated ${name} to v${result.to}`);
        } else status('Up to date');
      } catch (error) { status(error.message, true); }
      finally { void runtimePage(); }
      return;
    }
    const button = e.target.closest('[data-install]'); if (!button) return;
    button.disabled = true;
    try { const result = await api.runtimeEnsure({ engine: button.dataset.install }); if (!result.ok) throw new Error(result.error); status(result.canceled ? '' : "Runtime ready"); delete runtimeUpdateInfo[button.dataset.install]; }
    catch (e) { status(e.message, true); } finally { void runtimePage(); }
  };
  api.onRuntimeState(renderRuntimes);
  api.onNativeSettingsReady(() => { nativeReady = true; clearTimeout(nativeReadyTimer); $('nativeLoading').textContent = ''; $('retryNative').hidden = true; });
  let layoutFrame;
  const layout = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(() => { void placeNative(); }); };
  window.addEventListener('resize', layout);
  document.querySelector('.scroll-content').addEventListener('scroll', layout);
  new ResizeObserver(layout).observe($('engineContent'));
  return { select, openAccount, runtimePage, selected: () => engine, setVisible };
};
