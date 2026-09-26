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
  const t = text => window.CamelliaI18n.t(text);
  const loginPreferences = new Map(), loginDrafts = new Map();
  let accountsLoaded = false;
  for (const [id, prefix, title] of [['codex', 'codex', 'ChatGPT account · Codex'], ['kimi', 'kimi', 'Kimi account · Kimi Code'], ['antigravity', 'google', 'Google account · Antigravity']]) {
    const panel = $(prefix + 'AccountPanel');
    const heading = document.createElement('h3'); heading.textContent = title; heading.dataset.i18n = '';
    document.querySelector(`[data-account-engine="${id}"]`).textContent = title;
    panel.prepend(heading); panel.classList.add('subscription-account'); panel.hidden = false;
    $('subscriptionAccounts').append(panel);
    const preferences = id === 'kimi' ? $('kimiLoginRegion').closest('.engine-field') : $(prefix + 'ProxyUrl').closest('.engine-field');
    panel.insertBefore(preferences, heading.nextSibling);
    const connectionPanel = $(id + 'ConnectionPanel');
    const connection = $(id + 'Connection');
    panel.insertBefore(connection.closest('.engine-field'), preferences);
    panel.insertBefore($(id + 'ConnectionHint'), preferences);
    const save = $(prefix + 'SaveConnection');
    save.textContent = 'Save subscription settings'; save.hidden = true; panel.append(save);
    save.onclick = () => void saveLoginPreferences(id);
    const control = id === 'kimi' ? $('kimiLoginRegion') : $(prefix + 'ProxyUrl');
    control.oninput = control.onchange = () => {
      loginDrafts.set(id, { ...accountPreferences(id), ...(id === 'kimi' ? { region: control.value } : { proxyUrl: control.value }) });
      save.hidden = false;
      renderConnection();
    };
    connection.onchange = () => {
      loginDrafts.set(id, { ...accountPreferences(id), connection: connection.value });
      renderConnection();
    };
    const hint = document.createElement('p'); hint.className = 'hint'; hint.dataset.i18n = '';
    hint.textContent = id === 'antigravity' ? 'Official CLI sign-in is external. Model availability is verified here; account identity and quota are not reported.'
      : 'Account actions apply immediately. The selected account is preferred for new conversations; existing conversations keep their bound account.';
    panel.insertBefore(hint, heading.nextSibling);
    if (id === 'antigravity') {
      $('googleSignIn').textContent = 'Open official CLI sign-in';
      $('googleRefresh').textContent = 'Verify after sign-in';
      $('googleAccountList').removeAttribute('role');
      const credits = document.createElement('div'); credits.className = 'engine-field';
      credits.innerHTML = '<label for="googleUseCredits" data-i18n>Use AI credits after the plan quota is exhausted</label><input id="googleUseCredits" type="checkbox">';
      panel.insertBefore(credits, save);
      $('googleUseCredits').onchange = event => {
        loginDrafts.set(id, { ...accountPreferences(id), useG1Credits: event.target.checked });
        renderConnection();
      };
    }
    if (id !== 'antigravity') $(prefix + 'AccountList').setAttribute('aria-label', 'Preferred account for new conversations');
    const defaultHint = document.createElement('p'); defaultHint.className = 'hint'; defaultHint.dataset.i18n = '';
    defaultHint.textContent = 'Default connection for new conversations only. Account sign-in and the account used by an existing conversation are separate.';
    connection.closest('.engine-field').after(defaultHint);
    connectionPanel.remove();
  }
  function accountPreferences(id) { return loginDrafts.get(id) || loginPreferences.get(id) || {}; }
  async function saveLoginPreferences(id) {
    const prefix = id === 'antigravity' ? 'google' : id, button = $(prefix + 'SaveConnection');
    button.disabled = true;
    const submitted = accountPreferences(id);
    try {
      const result = await api.subscriptionPreferencesSave({ engine: id, preferences: submitted });
      if (!result.ok) throw new Error(result.error);
      loginPreferences.set(id, result.preferences);
      if (loginDrafts.get(id) === submitted) loginDrafts.delete(id);
      button.hidden = !loginDrafts.has(id);
      const draft = drafts.get(id);
      if (draft && id !== 'antigravity') Object.assign(draft.desktop, result.preferences);
      if (draft && id === 'antigravity' && !draft.dirty) drafts.delete(id);
      status('Subscription settings saved. Existing conversations keep their connection and account.');
      renderConnection();
    } catch (error) { status(error.message, true); }
    finally { button.disabled = false; }
  }
  async function accountsPage(focus) {
    if (!accountsLoaded) {
      try {
        const results = await Promise.all(['codex', 'kimi', 'antigravity'].map(async id => {
          const result = await api.subscriptionPreferencesGet({ engine: id });
          if (!result.ok) throw new Error(result.error);
          return [id, result.preferences];
        }));
        for (const [id, preferences] of results) loginPreferences.set(id, preferences);
        accountsLoaded = true;
      } catch (error) { status(error.message, true); }
    }
    await Promise.all([loadCodexAccount(), loadKimiAccount(), loadAccount()].map(task => task.catch(error => status(error.message, true))));
    if (!$('subscriptionsPage').hidden && ['codex', 'kimi', 'antigravity'].includes(focus)) {
      const panel = $((focus === 'antigravity' ? 'google' : focus) + 'AccountPanel');
      panel.scrollIntoView({ block: 'start' });
      const prefix = focus === 'antigravity' ? 'google' : focus;
      const target = $(prefix + (loginDrafts.has(focus) ? 'SaveConnection' : 'SignIn'));
      if (!target.disabled) target.focus({ preventScroll: true });
    }
  }
  // One row per signed-in account. Selecting a row makes it the account used
  // for new conversations; every engine keeps its own list.
  function renderAccountList({ containerId, state, onSelect, onRemove, onLabel, readonly = false, busy = false }) {
    const container = $(containerId);
    const accounts = state?.accounts || [];
    // A background quota refresh must not rebuild the list while a label is
    // being edited; the next render after the edit writes the saved value.
    if (container.contains(document.activeElement) && document.activeElement.dataset.accountLabel) return;
    container.innerHTML = accounts.map(account => {
      const identity = [account.email, account.plan, account.region ? t(account.region === 'global' ? 'Global · kimi.ai' : 'China · kimi.com') : '',
        account.signedIn ? t(account.exhausted ? 'Quota exhausted' : 'Signed in') : t('Not signed in'), account.active ? t('Preferred for new conversations') : ''].filter(Boolean).join(' · ');
      const action = readonly || account.id === 'default' ? '' :
        `<button type="button" data-account-remove="${esc(account.id)}" aria-label="${esc(t('Remove account'))}" data-i18n-attrs="aria-label">×</button>`;
      const choice = readonly ? '<span class="account-choice" aria-hidden="true"></span>'
        : `<button type="button" data-account-select="${esc(account.id)}" aria-label="${esc(t('Prefer this account for new conversations'))}" aria-pressed="${account.active}" class="account-choice"></button>`;
      const label = readonly ? `<strong>${esc(account.label || identity || t('Google account'))}</strong><small>${esc(identity)}</small>`
        : `<input data-account-label="${esc(account.id)}" value="${esc(account.label || '')}" placeholder="${esc(t('Account label'))}" aria-label="${esc(t('Account label'))}" data-i18n-attrs="placeholder aria-label"><small>${esc(identity)}</small>`;
      return `<div class="account-row${account.active ? ' active' : ''}${readonly ? ' readonly' : ''}">
        ${choice}
        <div class="account-body">${label}</div>
        ${action}</div>`;
    }).join('') || `<p class="hint">${esc(t('No accounts yet.'))}</p>`;
    if (readonly) return;
    for (const control of container.querySelectorAll('button, input')) control.disabled = busy || Boolean(state?.accounts?.some(account => account.loginPending));
    container.querySelectorAll('[data-account-select]').forEach(button => {
      button.onclick = () => onSelect(button.dataset.accountSelect);
    });
    container.querySelectorAll('[data-account-remove]').forEach(button => {
      button.onclick = () => onRemove(button.dataset.accountRemove);
    });
    container.querySelectorAll('[data-account-label]').forEach(input => {
      input.onchange = () => onLabel(input.dataset.accountLabel, input.value);
    });
  }
  async function accountAction(call, apply) {
    if (codexBusy || kimiBusy || accountBusy) return;
    codexBusy = true; kimiBusy = 'account'; renderConnection();
    try { const result = await call(); if (!result.ok) throw new Error(result.error); apply(result); }
    catch (error) { status(error.message, true); }
    finally { codexBusy = false; kimiBusy = false; renderConnection(); }
  }
  function renderKimiAccount() {
    const preferences = accountPreferences('kimi'), pending = Boolean(kimiAccount?.loginPending), busy = kimiBusy || kimiAccount?.refreshing || kimiAccount?.signingOut;
    const preferencesDirty = loginDrafts.has('kimi');
    $('kimiConnection').value = preferences.connection || 'api';
    $('kimiLoginRegion').value = accountPreferences('kimi').region || 'mainland-cn';
    $('kimiConnectionHint').textContent = preferences.connection === 'subscription'
      ? 'Sign in with your Kimi account to use its eligible models and subscription quota. No API key is needed.'
      : 'Use the providers, API keys and models configured in Providers & Keys.';
    $('kimiSaveConnection').hidden = !preferencesDirty;
    $('kimiSignIn').disabled = Boolean(busy || pending || preferencesDirty);
    $('kimiAddAccount').disabled = Boolean(busy || pending);
    $('kimiRefresh').disabled = Boolean(busy || pending || !kimiAccount?.installed);
    $('kimiSignOut').disabled = Boolean(busy || pending);
    $('kimiSignOut').hidden = !kimiAccount?.account;
    $('kimiUsage').hidden = !kimiAccount?.account;
    $('kimiCancelLogin').hidden = !pending;
    $('kimiCancelLogin').disabled = kimiBusy === 'kimiCancelLogin';
    $('kimiLoginRegion').disabled = Boolean(busy || pending);
    $('kimiAccountStatus').textContent = preferencesDirty ? 'Save login preferences before signing in.' : kimiAccount?.signingOut ? 'Signing out of Kimi…' : busy ? 'Checking Kimi account…'
      : pending ? 'Complete Kimi sign-in in your browser. This page updates automatically.'
      : kimiAccount?.error || (kimiAccount?.account ? `Signed in · ${kimiAccount.models.length} account models available` : 'Sign in with Kimi to load your account models.');
    $('kimiDeviceLogin').hidden = !pending || !kimiAccount?.login?.userCode;
    $('kimiUserCode').textContent = kimiAccount?.login?.userCode || '';
    $('kimiLoginExpiry').textContent = kimiAccount?.login?.expiresAt ? 'Code expires at ' + new Date(kimiAccount.login.expiresAt).toLocaleTimeString() : '';
    $('kimiOpenLogin').disabled = !kimiAccount?.login?.verificationUrl;
    $('kimiModelDetails').hidden = !kimiAccount?.models?.length;
    $('kimiModelList').innerHTML = (kimiAccount?.models || []).map(model => `<li title="${esc(model.id)}">${esc(model.name)}</li>`).join('');
    renderAccountList({ containerId: 'kimiAccountList', state: kimiAccount,
      busy: Boolean(busy),
      onSelect: id => accountAction(() => api.kimiAccountSelect(id), result => { kimiAccount = result; renderKimiAccount(); }),
      onRemove: id => accountAction(() => api.kimiAccountRemove(id), result => { kimiAccount = result; renderKimiAccount(); }),
      onLabel: (id, label) => accountAction(() => api.kimiAccountLabel(id, label), result => { kimiAccount = result; }) });
  }
  async function loadKimiAccount() {
    const result = await api.kimiAccountState(); if (!result.ok) throw new Error(result.error);
    kimiAccount = result; renderKimiAccount();
  }
  function renderCodexAccount() {
    const preferences = accountPreferences('codex');
    const preferencesDirty = loginDrafts.has('codex');
    $('codexConnection').value = preferences.connection || 'api';
    $('codexProxyUrl').value = accountPreferences('codex').proxyUrl || '';
    $('codexConnectionHint').textContent = preferences.connection !== 'subscription'
      ? 'Use models from Providers & Keys, including supported third-party APIs. No ChatGPT sign-in is required. The API provider bills this usage.'
      : 'Use the models and quota included with your ChatGPT account. You can choose API key / third-party API above without signing in.';
    $('codexSaveConnection').hidden = !preferencesDirty;
    for (const id of ['codexSignIn', 'codexAddAccount', 'codexRefresh', 'codexSignOut']) $(id).disabled = codexBusy || Boolean(codexAccount?.loginPending);
    $('codexSignIn').disabled ||= preferencesDirty;
    $('codexRefresh').disabled ||= preferencesDirty || !codexAccount?.installed;
    $('codexCancelLogin').disabled = codexBusy;
    $('codexCancelLogin').hidden = !codexAccount?.loginPending;
    $('codexSignOut').hidden = !codexAccount?.account;
    const account = codexAccount?.account;
    $('codexAccountStatus').textContent = preferencesDirty ? 'Save login preferences before signing in.' : codexBusy ? 'Connecting to Codex…'
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
    renderAccountList({ containerId: 'codexAccountList', state: codexAccount,
      busy: codexBusy,
      onSelect: id => accountAction(() => api.codexAccountSelect(id), result => { codexAccount = result; renderCodexAccount(); }),
      onRemove: id => accountAction(() => api.codexAccountRemove(id), result => { codexAccount = result; renderCodexAccount(); }),
      onLabel: (id, label) => accountAction(() => api.codexAccountLabel(id, label), result => { codexAccount = result; }) });
  }
  async function loadCodexAccount() {
    const result = await api.codexAccountState(); if (!result.ok) throw new Error(result.error);
    codexAccount = result; renderCodexAccount();
  }
  function renderConnection() {
    renderCodexAccount();
    renderKimiAccount();
    const preferences = accountPreferences('antigravity'), subscription = preferences.connection === 'subscription';
    const preferencesDirty = loginDrafts.has('antigravity');
    $('antigravityConnection').value = preferences.connection || 'api';
    $('googleUseCredits').checked = preferences.useG1Credits === true;
    $('googleProxyUrl').value = accountPreferences('antigravity').proxyUrl || '';
    $('antigravityConnectionHint').textContent = subscription
      ? 'Use the models and quota included with your Google account. Google credentials stay in the official CLI. Existing API sessions keep using their original connection.'
      : 'Use providers and API keys configured in Providers & Keys. Existing Google sessions keep using the Google account.';
    $('googleSignIn').disabled = preferencesDirty || accountBusy;
    $('googleSaveConnection').hidden = !preferencesDirty;
    $('googleRefresh').disabled = preferencesDirty || accountBusy || !googleAccount?.installed;
    $('googleAccountStatus').textContent = preferencesDirty ? 'Save login preferences before signing in.'
      : accountBusy ? 'Connecting to Google…' : googleAccount?.error || (googleAccount?.verification === 'pending' ? 'Waiting for external sign-in. Return here to verify.'
      : googleAccount?.verification === 'stale' ? 'Previous verification expired. Verify again.' : googleAccount?.models?.length
        ? `${googleAccount.models.length} models available · Last checked ${new Date(googleAccount.verifiedAt).toLocaleString()}`
        : 'Sign in or refresh an existing CLI sign-in. The required runtime is downloaded on demand.');
    $('googleModelDetails').hidden = !googleAccount?.models?.length;
    $('googleModelSummary').textContent = 'Available account models';
    $('googleModelList').innerHTML = (googleAccount?.models || []).map(model => `<li title="${esc(model.id)}">${esc(model.name)}</li>`).join('');
    // The official CLI owns one global Google credential, so the list is
    // informational rather than selectable.
    $('googleAccountList').textContent = t(({ verified: 'Model access verified', pending: 'Waiting for external sign-in. Return here to verify.', stale: 'Previous verification expired. Verify again.', error: 'Verification failed', unverified: 'Not verified' })[googleAccount?.verification] || 'Not verified');
  }
  async function loadAccount() {
    const result = await api.antigravityAccountState();
    if (!result.ok) throw new Error(result.error);
    googleAccount = result; renderConnection();
  }
  window.addEventListener('camellia:language', renderConnection);
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
      render();
      if (next === 'dsh') { if (nativeStarted) void placeNative(); else void nativePanel(); }
    } catch (e) { if (engine === next) $('engineLoading').textContent = e.message; }
  }
  async function openAccount(next) {
    if (!['kimi', 'antigravity', 'codex'].includes(next)) return;
    navigate({ page: 'subscriptions', focus: next });
  }
  let runtimeRows = [], runtimeUpdateInfo = {}, runtimeUpdatesBusy = false;
  const runtimePathDrafts = new Map();
  let pythonState = {};
  let runtimePathBusy = false;
  function runtimePathControls(row) {
    if (!api.runtimeSetPath) return '';
    // Python is a shared interpreter configured once above the engine cards.
    return (row.id === 'antigravity' ? ['subscription'] : ['api']).map(mode => {
      const key = row.id + ':' + mode;
      const saved = row.paths?.[mode] || (row.mode === mode ? row.customPath : '') || '';
      const label = row.id === 'antigravity' ? 'Antigravity CLI executable (Google subscription)' : ['dsh', 'kimi', 'pi'].includes(row.id) ? 'Local JavaScript entry file' : 'Local executable';
      return `<fieldset class="runtime-path" data-runtime="${row.id}" data-mode="${mode}" ${runtimePathBusy || row.status === 'installing' ? 'disabled' : ''}><label for="runtime-path-${row.id}-${mode}" data-i18n>${label}</label><div class="runtime-path-actions"><input id="runtime-path-${row.id}-${mode}" type="text" data-runtime-path="${key}" value="${esc(runtimePathDrafts.get(key) ?? saved)}" placeholder="${esc(t('Automatic detection'))}" spellcheck="false"><button type="button" data-path-action="browse" data-i18n>Browse…</button><button type="button" data-path-action="save" data-i18n>Save path</button><button type="button" data-path-action="reset" data-i18n>Use automatic detection</button></div><p class="hint" data-i18n>Choose a local executable or paste its full path. Saving runs it to check its version. Clear to use automatic detection.</p></fieldset>`;
    }).join('');
  }
  function renderPython(python) {
    if (!api.runtimeSetPython) return;
    pythonState = python || {};
    const field = $('pythonPath'), input = $('runtime-path-python');
    field.disabled = runtimePathBusy;
    // The field only ever shows an explicitly saved path; an automatically
    // detected interpreter is reported next to it instead of pretending to be
    // a saved choice the user never made.
    if (document.activeElement !== input) input.value = runtimePathDrafts.get('python') ?? (pythonState.configured ? pythonState.file : '') ?? '';
    const badge = $('pythonBadge');
    const saved = pythonState.configured && pythonState.file;
    badge.textContent = saved ? t(pythonState.antigravitySdk ? 'Python saved · Antigravity SDK found' : 'Python saved · Antigravity SDK not found')
      : pythonState.file ? t('Detected automatically: v{0}').replace('{0}', () => pythonState.version || '') : t('No Python found');
    badge.className = 'badge' + (saved && !pythonState.antigravitySdk ? ' bad' : pythonState.file ? ' good' : ' bad');
    $('pythonHint').textContent = saved && !pythonState.antigravitySdk
      ? t('This interpreter cannot import google.antigravity. Antigravity API mode needs the SDK; other engines and the benchmark verifier work without it.')
      : t('Choose any Python 3 installation. Camellia does not modify it or install packages into it.');
  }
  function updateInfoLine(id) {
    const info = runtimeUpdateInfo[id];
    if (!info) return '';
    if (!info.checkable) return `<p class="hint" data-i18n>${info.external ? 'Update this CLI using its original installer' : 'Updates ship with the app'}</p>`;
    if (info.error) return `<p class="hint"><span data-i18n>Update check failed</span> · ${esc(info.error)}</p>`;
    if (!info.installed) return '';
    if (info.updateAvailable) return `<p class="hint"><span data-i18n>v${esc(info.latest)} is available</span> <button data-update="${id}" data-i18n ${runtimeUpdatesBusy ? 'disabled' : ''}>Update</button></p>`;
    return `<p class="hint" data-i18n>Up to date</p>`;
  }
  function renderRuntimes(rows) {
    runtimeRows = rows;
    $('runtimeCards').innerHTML = rows.map(row => `<article class="runtime-card"><div><h2>${esc(row.name)}${row.id === 'antigravity' ? ` · ${row.mode === 'subscription' ? 'Google subscription' : 'API'}` : ''}</h2><span data-i18n class="badge ${row.status === 'ready' ? 'good' : row.status === 'error' ? 'bad' : ''}">${({ready:"Ready",installing:"Downloading",missing:"Not downloaded",error:"Download failed"})[row.status]}</span><button data-i18n data-install="${row.id}" ${row.status === 'ready' || row.status === 'installing' ? 'disabled' : ''}>${row.status === 'error' ? "Retry download" : row.status === 'ready' ? "Installed" : row.status === 'installing' ? "Downloading…" : "Download"}</button></div><p class="hint" data-i18n>${esc(row.status === 'ready' ? `v${row.version} · ${row.source}` : row.message || (row.id === 'antigravity' ? row.mode === 'subscription' ? 'Downloads the official CLI for Google sign-in. No Python environment is needed.' : 'Downloads the official SDK and its own Python environment. Other engines stay uninstalled.' : 'Download this engine when you need it. Other engines stay uninstalled.'))}</p>${updateInfoLine(row.id)}${row.file ? `<details><summary data-i18n>Installation path</summary><code>${esc(row.file)}</code></details>` : ''}</article>`).join('');
    renderRuntimePaths();
  }
  function renderRuntimePaths() {
    $('runtimeCards').querySelectorAll('.runtime-card').forEach((card, index) => {
      card.querySelectorAll('.runtime-path').forEach(control => control.remove());
      card.insertAdjacentHTML('beforeend', runtimePathControls(runtimeRows[index]));
    });
  }
  $('runtimesPage').oninput = event => {
    if (event.target.dataset.runtimePath) runtimePathDrafts.set(event.target.dataset.runtimePath, event.target.value);
  };
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
      const [result, settings, python] = await Promise.all([api.runtimeState(), api.downloadSettings(),
        api.runtimePythonState ? api.runtimePythonState() : Promise.resolve({ ok: true, python: {} })]);
      if (!result.ok) throw new Error(result.error);
      if (!settings.ok) throw new Error(settings.error);
      renderRuntimes(result.engines);
      renderPython(python.ok ? python.python : {});
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
  for (const [id, action] of [['codexSignIn', 'codexSignIn'], ['codexAddAccount', 'codexAccountAdd'], ['codexRefresh', 'codexAccountRefresh'],
    ['codexSignOut', 'codexSignOut'], ['codexCancelLogin', 'codexCancelLogin']]) $(id).onclick = async () => {
    codexBusy = true; renderCodexAccount();
    try {
      const result = await api[action](); if (!result.ok) throw new Error(result.error);
      if (!result.canceled) codexAccount = result;
      if (id === 'codexAddAccount') status('Account added. Sign in to finish connecting it.');
    } catch (error) { status(error.message, true); }
    finally { codexBusy = false; renderCodexAccount(); }
  };
  api.onCodexAccount(account => { codexAccount = account; renderCodexAccount(); });
  for (const [id, action] of [['kimiSignIn', 'kimiSignIn'], ['kimiAddAccount', 'kimiAccountAdd'], ['kimiRefresh', 'kimiAccountRefresh'],
    ['kimiSignOut', 'kimiSignOut'], ['kimiCancelLogin', 'kimiCancelLogin'], ['kimiOpenLogin', 'kimiOpenLogin']]) $(id).onclick = async () => {
    kimiBusy = action; renderKimiAccount();
    try {
      const result = await api[action](); if (!result.ok) throw new Error(result.error);
      if (!result.canceled) kimiAccount = result;
      if (id === 'kimiAddAccount') status('Account added. Sign in to finish connecting it.');
    } catch (error) { status(error.message, true); }
    finally { kimiBusy = false; renderKimiAccount(); }
  };
  api.onKimiAccount(account => { kimiAccount = account; renderKimiAccount(); });
  async function googleAction(action) {
    accountBusy = true; renderConnection();
    try {
      const result = await api[action === 'signIn' ? 'antigravitySignIn' : 'antigravityAccountRefresh']();
      if (!result.ok) throw new Error(result.error);
      if (!result.canceled) {
        await loadAccount();
        status(action === 'signIn' ? 'Complete Google sign-in in the terminal, then refresh the account here.' : 'Google account models refreshed');
      }
    } catch (error) { status(error.message, true); await loadAccount(); }
    finally { accountBusy = false; renderConnection(); }
  }
  $('googleSignIn').onclick = () => void googleAction('signIn');
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
      const desktop = Object.fromEntries(['cwd', 'contextWindow'].filter(key => key in state.desktop).map(key => [key, state.desktop[key]]));
      const result = await api.engineSettingsSave({ engine: savingEngine, files: state.files, common: state.common, desktop,
        ...(savingEngine === 'antigravity' ? { expectedConnection: state.desktop.connection } : {}) });
      if (!result.ok) throw new Error(result.error);
      drafts.set(savingEngine, { ...result, common: {}, dirty: false });
      if (engine === savingEngine) render();
      status(savingEngine === 'codex' ? 'Codex settings saved in Camellia. Applies to the next message.' : savingEngine === 'antigravity' ? "Antigravity settings saved. Applies to the next message." : "Global settings saved. Original files were backed up on first overwrite.");
      if (savingEngine === 'dsh') void nativePanel(true);
    } catch (e) { status(e.message, true); $('saveEngine').disabled = false; }
    finally { $('engineContent').inert = false; }
  };
  $('runtimesPage').onclick = async e => {
    const pathButton = e.target.closest('[data-path-action]');
    if (pathButton) {
      if (runtimePathBusy) return;
      const field = pathButton.closest('.runtime-path'), input = field.querySelector('input');
      const key = input.dataset.runtimePath;
      // The shared Python interpreter is stored globally; engine paths stay in
      // the per-engine map.
      const isPython = key === 'python';
      const selectedEngine = field.dataset.runtime, mode = field.dataset.mode;
      try {
        if (pathButton.dataset.pathAction === 'browse') {
          const result = await api.pickFile({ kind: 'file' });
          if (!result.canceled && result.path) {
            runtimePathDrafts.set(key, result.path);
            if (isPython) renderPython(pythonState); else renderRuntimePaths();
          }
          return;
        }
        runtimePathBusy = true;
        if (isPython) renderPython(pythonState); else renderRuntimePaths();
        status('Validating runtime path…');
        const file = pathButton.dataset.pathAction === 'reset' ? '' : input.value;
        const result = isPython ? await api.runtimeSetPython({ file })
          : await api.runtimeSetPath({ engine: selectedEngine, mode, file });
        if (!result.ok) throw new Error(result.error);
        runtimePathDrafts.delete(key);
        if (isPython) { renderPython(result.python); status('Python path saved. Applies to the next message.'); }
        else { delete runtimeUpdateInfo[selectedEngine]; renderRuntimes(result.engines); status('Runtime path saved. Applies to the next message.'); }
      } catch (error) { status(error.message, true); }
      finally { runtimePathBusy = false; if (isPython) renderPython(pythonState); else renderRuntimePaths(); }
      return;
    }
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
  // Python is shared, so its state can change without any engine card changing.
  api.onRuntimePythonState?.(renderPython);
  api.onNativeSettingsReady(() => { nativeReady = true; clearTimeout(nativeReadyTimer); $('nativeLoading').textContent = ''; $('retryNative').hidden = true; });
  let layoutFrame;
  const layout = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(() => { void placeNative(); }); };
  window.addEventListener('resize', layout);
  document.querySelector('.scroll-content').addEventListener('scroll', layout);
  new ResizeObserver(layout).observe($('engineContent'));
  return { select, openAccount, accountsPage, runtimePage, selected: () => engine, setVisible,
    // The active Kimi account owns the balance card behind "View usage and quotas".
    activeSubscriptionId: () => 'kimi:' + (kimiAccount?.activeId || 'default') };
};
