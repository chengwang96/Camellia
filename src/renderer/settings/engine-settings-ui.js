'use strict';
window.createEngineSettingsUI = ({ api, status, navigate }) => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const drafts = new Map();
  let engine = 'claude', documentId = 'settings', nativePending = false, activePage = false, nativeStarted = false, nativeNeedsRuntime = false;
  let nativeReady = false, nativeReadyTimer;
  const current = () => drafts.get(engine);
  function changed() { current().dirty = true; $('saveEngine').disabled = false; $('reloadEngine').textContent = "Discard and reload"; $('engineSaveHint').textContent = "You have unsaved changes"; if (['codex', 'kimi', 'antigravity', 'grok'].includes(engine)) renderConnection(); }
  let googleAccount = null, accountBusy = false;
  let googleSigningOut = false, googleActionVersion = 0;
  let codexAccount = null, codexBusy = false;
  let kimiAccount = null, kimiBusy = false;
  let grokAccount = null, grokBusy = false;
  const t = text => window.CamelliaI18n.t(text);
  const codexReset = window.createCodexResetUI({ api, status,
    onState: result => { codexAccount = result; renderCodexAccount(); },
    onBusy: busy => { codexBusy = busy; renderCodexAccount(); } });
  const loginPreferences = new Map(), loginDrafts = new Map();
  let accountsLoaded = false;
  for (const [id, prefix, title] of [['codex', 'codex', 'ChatGPT account · Codex'], ['kimi', 'kimi', 'Kimi account · Kimi Code'], ['grok', 'grok', 'Grok account · Grok Build'], ['antigravity', 'google', 'Google account · Antigravity']]) {
    const panel = $(prefix + 'AccountPanel');
    const heading = document.createElement('h3'); heading.textContent = title; heading.dataset.i18n = '';
    panel.prepend(heading); panel.classList.add('subscription-account'); panel.hidden = false;
    $('subscriptionAccounts').append(panel);
    const rotation = document.createElement('label'); rotation.className = 'subscription-rotation'; rotation.hidden = true;
    rotation.innerHTML = '<input type="checkbox" id="' + id + 'AutoSwitchQuota"><span data-i18n>Automatically switch accounts when quota is exhausted</span>';
    panel.append(rotation);
    const toggle = rotation.querySelector('input');
    toggle.onchange = async () => {
      const checked = toggle.checked; toggle.disabled = true;
      try {
        const result = await api.subscriptionPreferencesSave({ engine: id, preferences: { autoSwitchQuota: checked } });
        if (!result.ok) throw new Error(result.error);
        loginPreferences.set(id, { ...accountPreferences(id), autoSwitchQuota: checked });
      } catch (error) { toggle.checked = !checked; status(error.message, true); }
      finally { toggle.disabled = false; }
    };

    if (id === 'kimi') {
      const control = $('kimiLoginRegion');
      panel.insertBefore(control.closest('.engine-field'), heading.nextSibling);
      const draftPreference = () => loginDrafts.set(id, { ...accountPreferences(id), region: control.value });
      control.oninput = draftPreference;
      control.onchange = () => { draftPreference(); void queueLoginPreferences(id); renderConnection(); };
    }
    if (id === 'antigravity') {
      $('googleAccountList').removeAttribute('role');
      const credits = document.createElement('div'); credits.className = 'engine-field';
      credits.innerHTML = '<label for="googleUseCredits" data-i18n>Use AI credits after the plan quota is exhausted</label><input id="googleUseCredits" type="checkbox">';
      panel.append(credits);
      $('googleUseCredits').onchange = event => {
        loginDrafts.set(id, { ...accountPreferences(id), useG1Credits: event.target.checked });
        void queueLoginPreferences(id);
      };
    }
    if (id !== 'antigravity') $(prefix + 'AccountList').setAttribute('aria-label', 'Preferred subscription account');
    $(id + 'ConnectionPanel').remove();
  }
  function accountPreferences(id) { return loginDrafts.get(id) || loginPreferences.get(id) || {}; }
  // Login preferences save on change, like the other settings pages. Saves are
  // chained per engine so two quick edits cannot interleave their API work.
  const loginSaveQueue = new Map();
  function queueLoginPreferences(id) {
    const previous = loginSaveQueue.get(id) || Promise.resolve();
    const next = previous.then(() => saveLoginPreferences(id), () => saveLoginPreferences(id));
    loginSaveQueue.set(id, next);
    return next;
  }
  // A sign-in reads the saved preference, so it must not overtake an edit that
  // is still being written. A rejected save keeps its draft; retry it once and
  // stop the account action if it still cannot be stored.
  async function flushLoginPreferences(id) {
    if (loginDrafts.has(id)) await queueLoginPreferences(id);
    else await (loginSaveQueue.get(id) || Promise.resolve());
    if (loginDrafts.has(id)) throw new Error('Fix the login preference before continuing: ' + $('status').textContent);
  }
  async function saveLoginPreferences(id) {
    const submitted = accountPreferences(id);
    try {
      const result = await api.subscriptionPreferencesSave({ engine: id, preferences: submitted });
      if (!result.ok) throw new Error(result.error);
      loginPreferences.set(id, result.preferences);
      // A newer edit may have replaced this draft while the save was in flight;
      // keep that draft so its own queued save still persists it.
      if (loginDrafts.get(id) === submitted) loginDrafts.delete(id);
      const draft = drafts.get(id);
      if (draft && id !== 'antigravity') Object.assign(draft.desktop, result.preferences);
      if (draft && id === 'antigravity' && !draft.dirty) drafts.delete(id);
      status('Subscription settings saved. Account changes apply on the next message.');
      renderConnection();
    } catch (error) { status(error.message, true); }
  }
  async function accountsPage(focus) {
    if (!accountsLoaded) {
      try {
        const results = await Promise.all(['codex', 'kimi', 'antigravity', 'grok'].map(async id => {
          const result = await api.subscriptionPreferencesGet({ engine: id });
          if (!result.ok) throw new Error(result.error);
          return [id, result.preferences];
        }));
        for (const [id, preferences] of results) loginPreferences.set(id, preferences);
        accountsLoaded = true;
      } catch (error) { status(error.message, true); }
    }
    await Promise.all([loadCodexAccount(), loadKimiAccount(), loadGrokAccount(), loadAccount()].map(task => task.catch(error => status(error.message, true))));
    if (!$('subscriptionsPage').hidden && ['codex', 'kimi', 'antigravity', 'grok'].includes(focus)) {
      const panel = $((focus === 'antigravity' ? 'google' : focus) + 'AccountPanel');
      panel.scrollIntoView({ block: 'start' });
      const target = focus === 'antigravity' ? panel.querySelector(googleAccount?.verification === 'verified'
        ? '[data-card-action="refresh"]:not(:disabled)' : '[data-card-action="verify"]:not(:disabled)')
        || panel.querySelector('[data-card-action="login"]:not(:disabled), #googleAccountActions:not([hidden]) button:not(:disabled)') || $('googleUseCredits') : $(focus + 'SignIn');
      if (!target.disabled) target.focus({ preventScroll: true });
    }
  }
  // One row per signed-in account. Selecting a row makes it the account used
  // for the next message; every engine keeps its own list.
  function renderAccountList(options) {
    window.renderSubscriptionCards({ ...options, container: $(options.containerId),
      engine: options.containerId.startsWith('codex') ? 'codex' : options.containerId.startsWith('grok') ? 'grok' : 'kimi' });
  }
  function renderGoogleAccountList() {
    // The default profile is also the CLI sign-in slot. Only a signed-in or
    // previously verified account belongs in the card list.
    const accounts = (googleAccount?.accounts || []).filter(account => account.signedIn || account.stale);
    const signingOut = googleSigningOut || googleAccount?.signingOut;
    const busy = accountBusy || googleAccount?.usage?.refreshing || signingOut;
    $('googleAccountActions').hidden = accounts.length > 0;
    $('googleSignIn').disabled = Boolean(busy);
    $('googleVerify').disabled = Boolean(busy || !googleAccount?.installed);
    $('googleSignOut').disabled = Boolean(signingOut);
    // An open note editor must not retain a card after the account signs out.
    if (!accounts.length) $('googleAccountList').replaceChildren();
    window.renderSubscriptionCards({ container: $('googleAccountList'),
      state: googleAccount && { ...googleAccount, accounts },
      engine: 'antigravity', manage: false,
      busy: accountBusy || googleAccount?.usage?.refreshing,
      signOutBusy: googleSigningOut || googleAccount?.signingOut,
      onRefresh: () => void googleAccountAction(() => api.antigravityAccountRefreshUsage()),
      onVerify: () => void googleAccountAction(() => api.antigravityAccountRefresh()),
      onSignIn: () => void googleAccountAction(() => api.antigravitySignIn(), 'Waiting for external sign-in. Return here to verify.'),
      onSignOut: () => void googleSignOut(),
      onLabel: (_, label) => void googleAccountAction(() => api.antigravityAccountLabel(label), 'Account note saved.') });
  }
  async function accountAction(call, apply) {
    if (codexBusy || kimiBusy || grokBusy || accountBusy) return;
    codexBusy = true; kimiBusy = grokBusy = 'account'; renderConnection();
    try { const result = await call(); if (!result.ok) throw new Error(result.error); apply(result); }
    catch (error) { status(error.message, true); }
    finally { codexBusy = false; kimiBusy = grokBusy = false; renderConnection(); }
  }
  function renderKimiAccount() {
    renderRotation('kimi', kimiAccount);
    const preferences = accountPreferences('kimi'), pending = Boolean(kimiAccount?.loginPending), busy = kimiBusy || kimiAccount?.refreshing || kimiAccount?.signingOut || kimiAccount?.waking;
    const hasAccounts = kimiAccount?.accounts?.some(account => account.signedIn);
    $('kimiSignIn').hidden = Boolean(hasAccounts);
    $('kimiAddAccount').hidden = !hasAccounts;
    $('kimiRefresh').hidden = Boolean(hasAccounts);
    $('kimiLoginRegion').value = accountPreferences('kimi').region || 'mainland-cn';
    $('kimiSignIn').disabled = Boolean(busy || pending);
    $('kimiAddAccount').disabled = Boolean(busy || pending);
    $('kimiRefresh').disabled = Boolean(busy || pending || !kimiAccount?.installed);
    $('kimiSignOut').disabled = Boolean(busy || pending);
    $('kimiSignOut').hidden = true;
    $('kimiUsage').hidden = !kimiAccount?.account;
    $('kimiCancelLogin').hidden = !pending;
    $('kimiCancelLogin').disabled = kimiBusy === 'kimiCancelLogin';
    $('kimiLoginRegion').disabled = Boolean(busy || pending);
    $('kimiAccountStatus').textContent = kimiAccount?.signingOut ? 'Signing out of Kimi…' : busy ? 'Checking Kimi account…'
      : pending ? 'Complete Kimi sign-in in your browser. This page updates automatically.'
      : kimiAccount?.error || (kimiAccount?.account ? `Signed in · ${kimiAccount.models.length} account models available` : 'Sign in with Kimi to load your account models.');
    $('kimiDeviceLogin').hidden = !pending || !kimiAccount?.login?.userCode;
    $('kimiUserCode').textContent = kimiAccount?.login?.userCode || '';
    $('kimiLoginExpiry').textContent = kimiAccount?.login?.expiresAt ? 'Code expires at ' + new Date(kimiAccount.login.expiresAt).toLocaleTimeString() : '';
    $('kimiOpenLogin').disabled = !kimiAccount?.login?.verificationUrl;
    renderAccountList({ containerId: 'kimiAccountList', state: kimiAccount && { ...kimiAccount, accounts: kimiAccount.accounts?.filter(account => account.signedIn) },
      busy: Boolean(busy),
      onRefresh: id => accountAction(() => api.kimiAccountRefresh(id), result => { kimiAccount = result; }),
      onWake: id => accountAction(() => api.kimiAccountWake(id), result => { kimiAccount = result; status(t(result.warning || 'Greeting sent. Quota refreshed; reset time follows the provider.')); }),
      onSignIn: id => accountAction(async () => { const selected = await api.kimiAccountSelect(id); if (!selected.ok) throw new Error(selected.error); await flushLoginPreferences('kimi'); return api.kimiSignIn(); }, result => { kimiAccount = result; }),
      onSelect: id => accountAction(() => api.kimiAccountSelect(id), result => { kimiAccount = result; renderKimiAccount(); }),
      onRemove: id => accountAction(() => api.kimiAccountRemove(id), result => { kimiAccount = result; renderKimiAccount(); }),
      onLabel: (id, label) => accountAction(() => api.kimiAccountLabel(id, label), result => { kimiAccount = result; }) });
  }
  async function loadKimiAccount() {
    const result = await api.kimiAccountState(); if (!result.ok) throw new Error(result.error);
    kimiAccount = result; renderKimiAccount();
  }
  function renderGrokAccount() {
    renderRotation('grok', grokAccount);
    const pending = Boolean(grokAccount?.loginPending), busy = grokBusy || grokAccount?.refreshing || grokAccount?.signingOut;
    const hasAccounts = grokAccount?.accounts?.some(account => account.signedIn);
    $('grokSignIn').hidden = Boolean(hasAccounts);
    $('grokAddAccount').hidden = !hasAccounts;
    $('grokRefresh').hidden = Boolean(hasAccounts);
    for (const id of ['grokSignIn', 'grokAddAccount', 'grokRefresh']) $(id).disabled = Boolean(busy || pending || !grokAccount?.installed);
    $('grokCancelLogin').hidden = !pending;
    $('grokCancelLogin').disabled = grokBusy === 'grokCancelLogin';
    $('grokSignOut').hidden = true;
    $('grokAccountStatus').textContent = grokAccount?.signingOut ? 'Signing out of Grok…' : busy ? 'Checking Grok account…'
      : pending ? 'Complete Grok sign-in in your browser. This page updates automatically.'
      : grokAccount?.error || (grokAccount?.account ? `Signed in · ${grokAccount.models.length} account models available` : 'Sign in with Grok to load your account models and quota.');
    $('grokDeviceLogin').hidden = !pending || !grokAccount?.login?.userCode;
    $('grokUserCode').textContent = grokAccount?.login?.userCode || '';
    $('grokOpenLogin').disabled = !grokAccount?.login?.verificationUrl;
    renderAccountList({ containerId: 'grokAccountList', state: grokAccount && { ...grokAccount, accounts: grokAccount.accounts?.filter(account => account.signedIn) },
      busy: Boolean(busy),
      onRefresh: id => accountAction(() => api.grokAccountRefresh(id), result => { grokAccount = result; }),
      onSignIn: id => accountAction(async () => { const selected = await api.grokAccountSelect(id); if (!selected.ok) throw new Error(selected.error); await flushLoginPreferences('grok'); return api.grokSignIn(); }, result => { grokAccount = result; }),
      onSelect: id => accountAction(() => api.grokAccountSelect(id), result => { grokAccount = result; renderGrokAccount(); }),
      onRemove: id => accountAction(() => api.grokAccountRemove(id), result => { grokAccount = result; renderGrokAccount(); }),
      onLabel: (id, label) => accountAction(() => api.grokAccountLabel(id, label), result => { grokAccount = result; }) });
  }
  async function loadGrokAccount() {
    const result = await api.grokAccountState(); if (!result.ok) throw new Error(result.error);
    grokAccount = result; renderGrokAccount();
  }
  function renderRotation(id, account) {
    const toggle = $(id + 'AutoSwitchQuota');
    toggle.parentElement.hidden = (account?.accounts || []).filter(item => item.signedIn).length < 2;
    if (!toggle.disabled) toggle.checked = accountPreferences(id).autoSwitchQuota !== false;
  }
  function renderCodexAccount() {
    renderRotation('codex', codexAccount);
    const preferences = accountPreferences('codex');
    const hasAccounts = codexAccount?.accounts?.some(account => account.signedIn);
    $('codexSignIn').hidden = Boolean(hasAccounts);
    $('codexAddAccount').hidden = !hasAccounts;
    $('codexRefresh').hidden = Boolean(hasAccounts);
    for (const id of ['codexSignIn', 'codexAddAccount', 'codexRefresh', 'codexSignOut']) $(id).disabled = codexBusy || Boolean(codexAccount?.loginPending);
    $('codexRefresh').disabled ||= !codexAccount?.installed;
    $('codexCancelLogin').disabled = codexBusy;
    $('codexCancelLogin').hidden = !codexAccount?.loginPending;
    $('codexSignOut').hidden = true;
    const account = codexAccount?.account;
    $('codexAccountStatus').textContent = codexBusy ? 'Connecting to Codex…'
      : codexAccount?.loginPending ? 'Complete ChatGPT sign-in in your browser.' : codexAccount?.error || (account ? (account.email || 'Signed in') + ' · ' + (account.planType || 'ChatGPT') : 'Sign in with ChatGPT to load your models and quota.');
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
    renderAccountList({ containerId: 'codexAccountList', state: codexAccount && { ...codexAccount, accounts: codexAccount.accounts?.filter(account => account.signedIn) },
      busy: codexBusy,
      onRefresh: id => accountAction(() => api.codexAccountRefresh(id), result => { codexAccount = result; }),
      onReset: id => { if (!codexBusy && !kimiBusy && !accountBusy) void codexReset.open(id); },
      onWake: id => accountAction(() => api.codexAccountWake(id), result => { codexAccount = result; status(t(result.warning || 'Greeting sent. Quota refreshed; reset time follows the provider.')); }),
      onSignIn: id => accountAction(async () => { const selected = await api.codexAccountSelect(id); if (!selected.ok) throw new Error(selected.error); await flushLoginPreferences('codex'); return api.codexSignIn(); }, result => { codexAccount = result; }),
      onSelect: id => accountAction(() => api.codexAccountSelect(id), result => { codexAccount = result; renderCodexAccount(); }),
      onRemove: id => accountAction(() => api.codexAccountRemove(id), result => { codexAccount = result; renderCodexAccount(); }),
      onLabel: (id, label) => accountAction(() => api.codexAccountLabel(id, label), result => { codexAccount = result; }) });
  }
  async function loadCodexAccount() {
    const result = await api.codexAccountState(); if (!result.ok) throw new Error(result.error);
    codexAccount = result; renderCodexAccount();
  }
  function googleQuotaMessage(error) {
    // CLI diagnostics can contain URLs, JSON and terminal output. Keep them in
    // the disclosure and use stable, translatable messages for the main notice.
    const raw = String(error || '');
    if (!/\binvalid_grant\b/i.test(raw) && /token (?:refresh|validation) failed due to network error|https:\/\/oauth2\.googleapis\.com\/token["\s\S]{0,200}(?:\bEOF\b|TLS handshake timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed?\s*out|context deadline exceeded|connection reset|fetch failed)/i.test(raw)) return t('Could not connect to Google. Check your network or proxy settings and retry.');
    if (/\b(invalid_grant|unauthenticated|unauthorized)\b|sign-in has expired|headless auth|no valid auth|(?:token|credentials?|session).*(?:expired|invalid)/i.test(raw)) return t('Google sign-in has expired or is invalid. Sign in again and retry.');
    if (/\b(EOF|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b|timed?\s*out|network|connection|fetch failed/i.test(raw)) return t('Could not connect to Google. Check your network or proxy settings and retry.');
    return t('Could not refresh Google quota. Try again later or expand the error details.');
  }
  const isGoogleAvatarFailure = error => /profile picture/i.test(String(error || ''));
  function renderConnection() {
    renderCodexAccount();
    renderKimiAccount();
    renderGrokAccount();
    const preferences = accountPreferences('antigravity');
    $('googleUseCredits').checked = preferences.useG1Credits === true;
    $('googleAccountStatus').textContent = googleSigningOut || googleAccount?.signingOut ? 'Signing out of Google…' : accountBusy ? 'Connecting to Google…' : googleAccount?.verification === 'pending' ? 'Waiting for external sign-in. Return here to verify.'
      : googleAccount?.verification === 'stale-error' ? t('The last model refresh failed. Showing the previous model list; refresh the account to update it.')
      : googleAccount?.error ? googleAccount.error
      : googleAccount?.verification === 'unverified' || googleAccount?.verification === 'error' || !googleAccount?.installed
        ? t('Sign in or refresh an existing CLI sign-in. The required runtime is downloaded on demand.') : '';
    const rawQuotaError = googleAccount?.usage?.error || '';
    const quotaError = isGoogleAvatarFailure(rawQuotaError) ? '' : rawQuotaError;
    $('googleQuotaStatus').textContent = quotaError ? googleQuotaMessage(quotaError)
      + (googleAccount.usage.latest ? ' ' + t('Quota refresh failed. Showing the last successful reading.') : '') : '';
    $('googleQuotaStatus').hidden = !quotaError;
    const details = $('googleQuotaErrorDetails');
    if ($('googleQuotaErrorRaw').textContent !== quotaError || !quotaError) details.open = false;
    details.hidden = !quotaError;
    $('googleQuotaErrorRaw').textContent = quotaError;
    // The official CLI owns one global Google credential, so the list shows the
    // single account and its two limit groups without account-selection actions.
    renderGoogleAccountList();
  }
  async function loadAccount(version = googleActionVersion) {
    const result = await api.antigravityAccountState();
    if (version !== googleActionVersion) return;
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
    $('engineScopeTitle').textContent = appScope ? ({ codex: 'Codex in Camellia', antigravity: 'Antigravity in Camellia', grok: 'Grok Build in Camellia' })[engine] : 'These settings also apply to the CLI';
    $('engineScopeDescription').textContent = engine === 'grok'
      ? 'Grok Build settings and instructions are stored in Camellia. Choose a subscription account or a shared API model in the conversation.' : appScope
      ? (engine === 'codex' ? 'Codex configuration, credentials and history are stored inside Camellia. Saving here does not change your personal ~/.codex directory.' : 'These settings apply to the Antigravity engine in Camellia. Choose models and manage API keys in Providers & Keys.')
      : "Saving overwrites the CLI's global settings and affects other CLI sessions. Before the first overwrite, an original .workbench.bak backup is kept.";
    $('engineRouteHint').textContent = engine === 'grok' ? 'Grok Build uses a signed-in Grok account or the shared API routes. Select a connection and model in the conversation.' : engine === 'antigravity'
      ? appScope ? 'API mode uses the shared key pool; choose a Google account model in the composer to use your Google plan.'
        : 'Subscription mode uses the official Google account provider. Review tool approvals in the conversation; configure permission rules here. AI credits are used only if you enable them.'
      : "Camellia manages API routes centrally; CLI sessions using its router need the app running. Project settings follow each engine's precedence rules.";
    $('engineAdvancedHint').textContent = engine === 'grok' ? 'Edit native Grok TOML, including MCP servers, plugins and permission rules. Camellia manages models and credentials; these instructions apply to every session.' : engine === 'codex' ? 'Edit native TOML, including [mcp_servers] and skills. Connection settings and credentials are managed by Camellia.' : appScope
      ? 'Add MCP servers under mcpServers and local skill directories under skillsPaths. Common options above are applied when you save.'
      : 'Edit full native configuration, including tools, hooks, plugins, and permission rules. Camellia manages API connections; common options above apply on save.';
    $('nativeDocuments').querySelector('summary').textContent = engine === 'grok' ? 'Advanced configuration · MCP · Global instructions' : engine === 'dsh' ? "Advanced configuration · Full YAML" : "Advanced configuration · MCP · " + (engine === 'kimi' ? "Terminal" : engine === 'antigravity' ? "Skills" : "Global instructions");
    $('engineCommon').innerHTML = state.fields.map((field, i) => {
      const value = field.key in state.common ? state.common[field.key] : field.value;
      const id = 'nativeField' + i;
      const input = field.type === 'select' ? `<select id="${id}" data-field="${field.key}">${field.options.map(([id, name]) => `<option data-i18n value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>`
        : field.type === 'textarea' ? `<textarea id="${id}" data-field="${field.key}" rows="4" placeholder="${esc(field.placeholder || '')}" data-i18n-attrs="placeholder">${esc(value)}</textarea>`
        : `<input id="${id}" data-field="${field.key}" type="${field.type}" ${field.type === 'checkbox' ? value ? 'checked' : '' : `value="${esc(value)}" placeholder="${esc(field.placeholder || '')}"`} ${field.type === 'number' ? `min="${field.min}" max="${field.max}"` : ''} data-i18n-attrs="placeholder">`;
      return `<div class="engine-field"><label for="${id}" data-i18n>${esc(field.label)}</label>${input}</div>`;
    }).join('') + (engine === 'dsh' ? '' : `<h2 class="engine-common-title" data-i18n>Workbench sessions</h2><div class="engine-field"><label for="engineCwd" data-i18n>Default directory for standalone sessions<small class="hint" style="display:block" data-i18n>Leave blank to use the application directory. Workspace sessions use their own folders.</small></label><input id="engineCwd" data-desktop="cwd" value="${esc(state.desktop.cwd || '')}" placeholder="Application session directory" data-i18n-attrs="placeholder"></div>`)
      + (['kimi', 'grok'].includes(engine) ? `<div class="engine-field"><label for="engineContext" data-i18n>API model context window (tokens)<small class="hint" data-i18n>Subscription models use the context limit reported by the provider.</small></label><input id="engineContext" data-desktop="contextWindow" type="number" min="4096" max="2000000" value="${state.desktop.contextWindow || 131072}"></div>` : '');
    $('engineDocument').innerHTML = state.files.map(file => `<option data-i18n value="${file.id}">${esc(file.label)}</option>`).join('');
    renderDocument(); $('saveEngine').disabled = !state.dirty;
    $('reloadEngine').textContent = state.dirty ? "Discard and reload" : "Reload";
    $('engineSaveHint').textContent = state.dirty ? "You have unsaved changes" : engine === 'grok' ? 'Defaults apply to new conversations; instructions apply to the next message.' : "Applies to the next message";
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
    if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'grok'].includes(next)) next = 'claude';
    engine = next;
    showSelectedRuntime();
    void placeNative();
    document.querySelectorAll('.engine-tabs [data-engine]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.engine === engine)));
    $('engineContent').hidden = true; $('engineLoading').hidden = false; $('engineLoading').textContent = "Loading settings…";
    try {
      // A saved draft is re-read so the page reflects a connection the composer
      // changed; unsaved edits are kept.
      if (!drafts.has(next) || drafts.get(next).dirty !== true || reload) {
        const result = await api.engineSettingsGet({ engine: next }); if (!result.ok) throw new Error(result.error);
        drafts.set(next, { ...result, common: {}, dirty: false });
      }
      if (engine !== next) return;
      render();
      if (next === 'dsh') { if (nativeStarted) void placeNative(); else void nativePanel(); }
    } catch (e) { if (engine === next) $('engineLoading').textContent = e.message; }
  }
  async function openAccount(next) {
    if (!['kimi', 'antigravity', 'codex', 'grok'].includes(next)) return;
    navigate({ page: 'subscriptions', focus: next });
  }
  let runtimeRows = [], runtimeUpdateInfo = {}, runtimeUpdatesBusy = false;
  const runtimeUpdating = new Set();
  const runtimeReinstalling = new Set();
  const runtimeUninstalling = new Set();
  const isRuntimeUpdating = id => runtimeUpdating.has(id) || runtimeRows.some(row => row.id === id && row.updating);
  const isRuntimeReinstalling = id => runtimeReinstalling.has(id) || runtimeRows.some(row => row.id === id && row.reinstalling);
  const isRuntimeUninstalling = id => runtimeUninstalling.has(id) || runtimeRows.some(row => row.id === id && row.uninstalling);
  const runtimePathDrafts = new Map();
  let pythonState = {};
  let runtimePathBusy = false;
  let runtimeReinstallPromptPending = false;
  async function confirmRuntimeReinstall(id, mode) {
    const preview = await api.runtimeReinstallPreview({ engine: id, ...(mode ? { mode } : {}) });
    if (!preview.ok) throw new Error(preview.error);
    const dialog = $('runtimeReinstallDialog');
    $('runtimeReinstallTitle').textContent = `Reinstall ${preview.name}`;
    $('runtimeReinstallOriginal').textContent = preview.file;
    $('runtimeReinstallDestination').textContent = preview.destination;
    dialog.returnValue = '';
    const confirmed = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'reinstall'), { once: true }));
    dialog.showModal();
    return await confirmed ? { engine: id, token: preview.token } : null;
  }
  async function confirmRuntimeUninstall(id, mode) {
    const preview = await api.runtimeUninstallPreview({ engine: id, mode });
    if (!preview.ok) throw new Error(preview.error);
    const dialog = $('runtimeUninstallDialog');
    $('runtimeUninstallTitle').textContent = t('Uninstall {0}').replace('{0}', () => preview.name);
    $('runtimeUninstallOriginal').textContent = preview.file;
    $('runtimeUninstallTargets').textContent = preview.targets.join('\n');
    $('runtimeUninstallPythonHint').hidden = id !== 'antigravity';
    dialog.returnValue = '';
    const confirmed = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'uninstall'), { once: true }));
    dialog.showModal();
    return await confirmed ? { engine: id, token: preview.token } : null;
  }
  function runtimePathControls(row) {
    if (!api.runtimeSetPath) return '';
    // Python is a shared interpreter configured on the General page.
    const controls = (row.id === 'antigravity' ? ['subscription'] : ['api']).map(mode => {
      const key = row.id + ':' + mode;
      const saved = row.paths?.[mode] || (row.mode === mode ? row.customPath : '') || '';
      const label = row.id === 'antigravity' ? 'Antigravity CLI executable (Google subscription)' : ['dsh', 'kimi'].includes(row.id) ? 'Local JavaScript entry file' : 'Local executable';
      return `<fieldset class="runtime-path" data-runtime="${row.id}" data-mode="${mode}" ${runtimePathBusy || row.status === 'installing' || isRuntimeUpdating(row.id) ? 'disabled' : ''}><div class="runtime-path-actions"><label for="runtime-path-${row.id}-${mode}" data-i18n>${label}</label><input id="runtime-path-${row.id}-${mode}" type="text" data-runtime-path="${key}" value="${esc(runtimePathDrafts.get(key) ?? saved)}" placeholder="Automatic detection" data-i18n-attrs="placeholder" spellcheck="false"><button type="button" data-path-action="browse" data-i18n>Browse…</button><button type="button" data-path-action="save" data-i18n>Save path</button><button type="button" data-path-action="reset" data-i18n>Use automatic detection</button></div><p class="hint" data-i18n>Choose a local executable or paste its full path. Saving runs it to check its version. Clear to use automatic detection.</p></fieldset>`;
    }).join('');
    if (row.id !== 'antigravity' || row.mode === 'subscription' || !row.subscriptionRuntime) return controls;
    const cli = row.subscriptionRuntime, ready = cli.status === 'ready';
    const description = ready ? `v${esc(cli.version)} · <span data-i18n>${esc(cli.source)}</span>`
      : `<span data-i18n>${esc(cli.message || 'Downloads the official CLI for Google sign-in. No Python environment is needed.')}</span>`;
    return `<section class="runtime-subscription" data-runtime-mode="subscription"><div class="runtime-header"><div class="runtime-summary"><h3 data-i18n>Google subscription CLI</h3><p class="hint runtime-version">${description}</p></div><div class="runtime-actions">${runtimeStatusControls(cli, 'data-cli-status')}</div></div>${cli.file ? `<div class="runtime-installation-path"><span data-i18n>CLI installation path</span><code>${esc(cli.file)}</code></div>` : ''}${controls}</section>`;
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
      : t('Choose any Python 3 installation; Camellia never edits it or installs packages.');
  }
  function runtimeStatusControls(row, marker = 'data-runtime-status') {
    if (isRuntimeUninstalling(row.id)) return `<button ${marker} data-uninstall="${row.id}" data-i18n disabled>Uninstalling…</button>`;
    const controls = runtimeVersionControls(row, marker);
    return controls + (api.runtimeUninstall && row.status === 'ready' && !isRuntimeUpdating(row.id)
      ? ` <button data-uninstall="${row.id}" data-i18n ${runtimePathBusy || runtimeReinstallPromptPending ? 'disabled' : ''}>Uninstall</button>` : '');
  }
  function runtimeVersionControls(row, marker) {
    const id = row.id;
    if (isRuntimeReinstalling(id)) return `<p class="hint runtime-update"><button ${marker} data-reinstall="${id}" data-i18n disabled>Reinstalling…</button></p>`;
    if (isRuntimeUpdating(id)) return `<p class="hint runtime-update"><button ${marker} data-update="${id}" data-i18n disabled>Updating…</button></p>`;
    if (row.status === 'installing') return `<button ${marker} data-install="${id}" data-i18n disabled>Downloading…</button>`;
    if (id === 'antigravity' && row.status === 'error' && row.customPath) return `<span ${marker} data-i18n class="badge bad">CLI path unavailable</span>`;
    if (row.status !== 'ready') return `${row.status === 'error' ? `<span ${marker} data-i18n class="badge bad">Download failed</span>` : ''}<button ${row.status === 'error' ? '' : marker} data-install="${id}" data-i18n>${row.status === 'error' ? 'Retry download' : 'Download'}</button>`;
    if (row.external) return `<p class="hint runtime-update runtime-external-update"><span ${marker} data-i18n>Update this CLI using its original installer</span>${api.runtimeReinstall ? ` <button data-reinstall="${id}" data-i18n ${runtimePathBusy ? 'disabled' : ''}>Use Camellia</button>` : ''}</p>`;
    const info = runtimeUpdateInfo[id];
    // Mode changes must not reuse the SDK's version check for the native CLI.
    if (id === 'antigravity' && info && info.mode !== row.mode) return `<span ${marker} data-i18n class="badge good">Installed</span>`;
    if (!info || info.installed && info.installed !== row.version) return `<span ${marker} data-i18n class="badge good">Installed</span>`;
    if (!info.checkable) return `<p ${marker} class="hint runtime-update" data-i18n>${info.external ? 'Update this CLI using its original installer' : 'Updates ship with the app'}</p>`;
    if (info.error) return `<p ${marker} class="hint runtime-update"><span data-i18n>Update check failed</span> · ${esc(info.error)}</p>`;
    if (!info.installed) return `<span ${marker} data-i18n class="badge good">Installed</span>`;
    if (info.updateAvailable && info.latest !== row.version) return `<p class="hint runtime-update"><span ${marker} data-i18n class="badge">v${esc(info.latest)} is available</span> <button data-update="${id}" data-i18n ${runtimeUpdatesBusy ? 'disabled' : ''}>Update</button></p>`;
    return `<span ${marker} data-i18n class="badge good">Up to date</span>`;
  }
  function renderRuntimes(rows) {
    runtimeRows = rows;
    $('runtimeCards').innerHTML = rows.map(row => {
      const ready = row.status === 'ready';
      const description = ready ? `v${esc(row.version)} · <span data-i18n>${esc(row.source)}</span>`
        : esc(row.message || (row.id === 'antigravity' ? row.mode === 'subscription'
          ? 'Downloads the official CLI for Google sign-in. No Python environment is needed.'
          : 'Downloads the official SDK and its own Python environment. Other engines stay uninstalled.'
          : 'Download this engine when you need it. Other engines stay uninstalled.'));
      return `<article class="runtime-card" data-runtime-mode="${esc(row.mode)}"><div class="runtime-header"><div class="runtime-summary"><h2>${esc(row.name)}${row.id === 'antigravity' ? ` · ${row.mode === 'subscription' ? 'Google subscription' : 'API'}` : ''}</h2>${ready ? `<p class="hint runtime-version">${description}</p>` : ''}</div><div class="runtime-actions">${runtimeStatusControls(row)}</div></div>${ready ? '' : `<p class="hint runtime-description" data-i18n>${description}</p>`}${row.warning ? `<p class="hint runtime-cleanup-warning">${esc(row.warning)}</p>` : ''}${row.file ? `<div class="runtime-installation-path"><span data-i18n>${row.id === 'antigravity' && row.mode !== 'subscription' ? 'Python interpreter (API)' : 'Installation path'}</span><code>${esc(row.file)}</code></div>` : ''}</article>`;
    }).join('');
    renderRuntimePaths();
    showSelectedRuntime();
  }
  function receiveRuntimes(rows) {
    for (const row of rows) {
      if (!Object.hasOwn(row, 'updateInfo')) continue;
      if (row.updateInfo) runtimeUpdateInfo[row.id] = row.updateInfo;
      else delete runtimeUpdateInfo[row.id];
    }
    renderRuntimes(rows);
  }
  function showSelectedRuntime() {
    $('runtimeCards').querySelectorAll('.runtime-card').forEach((card, index) => {
      card.hidden = runtimeRows[index]?.id !== engine;
    });
  }
  function renderRuntimePaths() {
    $('runtimeCards').querySelectorAll('.runtime-card').forEach((card, index) => {
      card.querySelectorAll('.runtime-subscription, .runtime-path').forEach(control => control.remove());
      card.insertAdjacentHTML('beforeend', runtimePathControls(runtimeRows[index]));
    });
  }
  const rememberRuntimePath = event => {
    if (event.target.dataset.runtimePath) runtimePathDrafts.set(event.target.dataset.runtimePath, event.target.value);
  };
  $('runtimeCards').oninput = rememberRuntimePath;
  $('pythonCard').oninput = rememberRuntimePath;
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
  async function runtimePage({ checkUpdates = false } = {}) {
    const selectedEngine = engine;
    try {
      const result = await api.runtimeState();
      if (!result.ok) throw new Error(result.error);
      receiveRuntimes(result.engines);
      // Home already checked before showing its reminder. Reuse that result,
      // including when Settings is newly opened or was already running.
      if (checkUpdates && activePage && engine === selectedEngine && !runtimeUpdateInfo[selectedEngine]) await checkRuntimeUpdates();
    } catch (e) { status(e.message, true); }
  }
  async function pythonPage() {
    if (!api.runtimePythonState) return;
    try {
      const result = await api.runtimePythonState();
      if (!result.ok) throw new Error(result.error);
      renderPython(result.python);
    } catch (e) { status(e.message, true); }
  }
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
      if (['codexSignIn', 'codexAccountAdd', 'codexAccountRefresh'].includes(action)) await flushLoginPreferences('codex');
      const result = await api[action](); if (!result.ok) throw new Error(result.error);
      if (!result.canceled) codexAccount = result;
      if (id === 'codexAddAccount') status(t('Complete ChatGPT sign-in in your browser.'));
    } catch (error) { status(error.message, true); }
    finally { codexBusy = false; renderCodexAccount(); }
  };
  api.onCodexAccount(account => { codexAccount = account; renderCodexAccount(); });
  for (const [id, action] of [['kimiSignIn', 'kimiSignIn'], ['kimiAddAccount', 'kimiAccountAdd'], ['kimiRefresh', 'kimiAccountRefresh'],
    ['kimiSignOut', 'kimiSignOut'], ['kimiCancelLogin', 'kimiCancelLogin'], ['kimiOpenLogin', 'kimiOpenLogin']]) $(id).onclick = async () => {
    kimiBusy = action; renderKimiAccount();
    try {
      if (['kimiSignIn', 'kimiAccountAdd', 'kimiAccountRefresh'].includes(action)) await flushLoginPreferences('kimi');
      const result = await api[action](); if (!result.ok) throw new Error(result.error);
      if (!result.canceled) kimiAccount = result;
      if (id === 'kimiAddAccount') status(t('Complete Kimi sign-in in your browser. This page updates automatically.'));
    } catch (error) { status(error.message, true); }
    finally { kimiBusy = false; renderKimiAccount(); }
  };
  api.onKimiAccount(account => { kimiAccount = account; renderKimiAccount(); });
  for (const [id, action] of [['grokSignIn', 'grokSignIn'], ['grokAddAccount', 'grokAccountAdd'], ['grokRefresh', 'grokAccountRefresh'],
    ['grokSignOut', 'grokSignOut'], ['grokCancelLogin', 'grokCancelLogin'], ['grokOpenLogin', 'grokOpenLogin']]) $(id).onclick = async () => {
    grokBusy = action; renderGrokAccount();
    try {
      if (['grokSignIn', 'grokAccountAdd', 'grokAccountRefresh'].includes(action)) await flushLoginPreferences('grok');
      const result = await api[action](); if (!result.ok) throw new Error(result.error);
      if (!result.canceled) grokAccount = result;
      if (id === 'grokAddAccount') status(t('Complete Grok sign-in in your browser. This page updates automatically.'));
    } catch (error) { status(error.message, true); }
    finally { grokBusy = false; renderGrokAccount(); }
  };
  api.onGrokAccount(account => { grokAccount = account; renderGrokAccount(); });
  api.onAntigravityAccount?.(account => { googleAccount = account; renderConnection(); });
  $('googleSignIn').onclick = () => void googleAccountAction(() => api.antigravitySignIn(), 'Waiting for external sign-in. Return here to verify.');
  $('googleVerify').onclick = () => void googleAccountAction(() => api.antigravityAccountRefresh());
  $('googleSignOut').onclick = async () => {
    if (await confirmSubscriptionAccountRemoval('default', googleAccount?.accounts?.[0], 'antigravity')) await googleSignOut();
  };
  async function googleAccountAction(call, message = 'Account status updated.') {
    if (accountBusy || googleSigningOut || googleAccount?.signingOut || googleAccount?.usage?.refreshing) return;
    const version = ++googleActionVersion;
    accountBusy = true; renderConnection();
    try {
      await flushLoginPreferences('antigravity');
      if (version !== googleActionVersion) return;
      const result = await call();
      if (version !== googleActionVersion) return;
      if (!result.ok) throw new Error(result.error);
      if (!result.canceled) {
        await loadAccount(version);
        if (version !== googleActionVersion) return;
        if (message === 'Account status updated.' && googleAccount.usage?.error && !isGoogleAvatarFailure(googleAccount.usage.error)) status(googleQuotaMessage(googleAccount.usage.error), true);
        else status(message);
      }
    } catch (error) {
      if (version !== googleActionVersion) return;
      status(error.message, true);
      try { await loadAccount(version); } catch { /* Keep the last visible account when IPC is unavailable. */ }
    }
    finally { if (version === googleActionVersion) { accountBusy = false; renderConnection(); } }
  }
  async function googleSignOut() {
    if (googleSigningOut || googleAccount?.signingOut) return;
    ++googleActionVersion;
    googleSigningOut = true; accountBusy = true; renderConnection();
    try {
      const result = await api.antigravitySignOut();
      if (!result.ok) throw new Error(result.error);
      googleAccount = result;
      status('Signed out of Google.');
    } catch (error) {
      status(error.message, true);
      try { await loadAccount(); } catch { /* Keep the current account state if IPC is unavailable. */ }
    } finally { googleSigningOut = false; accountBusy = false; renderConnection(); }
  }
  $('engineSource').oninput = e => { current().files.find(file => file.id === documentId).text = e.target.value; changed(); };
  $('engineDocument').onchange = e => { documentId = e.target.value; renderDocument(); };
  $('reloadEngine').onclick = () => select(engine, true);
  $('retryNative').onclick = () => nativeNeedsRuntime ? navigate({ page: 'engines', engine: 'dsh' }) : nativePanel(true);
  document.querySelectorAll('.engine-tabs [data-engine]').forEach(button => { button.onclick = () => select(button.dataset.engine); });
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
      status(savingEngine === 'grok' ? 'Grok Build settings saved. Applies to the next message.' : savingEngine === 'codex' ? 'Codex settings saved in Camellia. Applies to the next message.' : savingEngine === 'antigravity' ? "Antigravity settings saved. Applies to the next message." : "Global settings saved. Original files were backed up on first overwrite.");
      if (savingEngine === 'dsh') void nativePanel(true);
    } catch (e) { status(e.message, true); $('saveEngine').disabled = false; }
    finally { $('engineContent').inert = false; }
  };
  const runtimeAction = async e => {
    const uninstallButton = e.target.closest('[data-uninstall]');
    if (uninstallButton) {
      const id = uninstallButton.dataset.uninstall;
      const mode = uninstallButton.closest('[data-runtime-mode]')?.dataset.runtimeMode;
      if (uninstallButton.disabled || runtimeReinstallPromptPending || isRuntimeUpdating(id) || isRuntimeUninstalling(id)) return;
      runtimeReinstallPromptPending = true;
      uninstallButton.disabled = true;
      let payload;
      try { payload = await confirmRuntimeUninstall(id, mode); }
      catch (error) { status(error.message, true); }
      finally { runtimeReinstallPromptPending = false; uninstallButton.disabled = false; }
      if (!payload) { document.querySelector(`[data-runtime-mode="${mode}"] [data-uninstall="${id}"]`)?.focus(); return; }
      runtimeUpdating.add(id); runtimeUninstalling.add(id); renderRuntimes(runtimeRows);
      status(t('Uninstalling…'));
      try {
        const result = await api.runtimeUninstall(payload);
        if (!result.ok) throw new Error(result.error);
        delete runtimeUpdateInfo[id];
        for (const connection of ['api', 'subscription']) runtimePathDrafts.delete(id + ':' + connection);
        status(t('Engine uninstalled. Your conversations, accounts and settings are kept.'));
        if (id === 'dsh') { nativeStarted = false; nativeReady = false; await nativePanel(true); }
      } catch (error) { status(error.message, true); }
      finally { runtimeUpdating.delete(id); runtimeUninstalling.delete(id); await runtimePage(); }
      return;
    }
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
        else { delete runtimeUpdateInfo[selectedEngine]; receiveRuntimes(result.engines); status('Runtime path saved. Applies to the next message.'); }
      } catch (error) { status(error.message, true); }
      finally { runtimePathBusy = false; if (isPython) renderPython(pythonState); else renderRuntimePaths(); }
      return;
    }
    const updateButton = e.target.closest('[data-update], [data-reinstall]');
    if (updateButton) {
      const reinstall = Boolean(updateButton.dataset.reinstall);
      const updatingEngine = updateButton.dataset.reinstall || updateButton.dataset.update;
      const runtimeMode = updatingEngine === 'antigravity' ? updateButton.closest('[data-runtime-mode]')?.dataset.runtimeMode : undefined;
      if (updateButton.disabled || isRuntimeUpdating(updatingEngine)) return;
      let payload = { engine: updatingEngine };
      if (reinstall) {
        if (runtimeReinstallPromptPending) return;
        runtimeReinstallPromptPending = true;
        updateButton.disabled = true;
        try { payload = await confirmRuntimeReinstall(updatingEngine, runtimeMode); }
        catch (error) { status(error.message, true); return; }
        finally { runtimeReinstallPromptPending = false; updateButton.disabled = false; }
        if (!payload) { document.querySelector(`[data-reinstall="${updatingEngine}"]`)?.focus(); return; }
      }
      runtimeUpdating.add(updatingEngine);
      if (reinstall) runtimeReinstalling.add(updatingEngine);
      renderRuntimes(runtimeRows);
      status(reinstall ? 'Reinstalling…' : 'Updating…');
      try {
        const result = await (reinstall ? api.runtimeReinstall : api.runtimeUpdate)(payload);
        if (!result.ok) throw new Error(result.error);
        if (result.canceled) { status(''); return; }
        if (result.restarting) return;
        if (reinstall) {
          for (const mode of ['api', 'subscription']) runtimePathDrafts.delete(updatingEngine + ':' + mode);
          delete runtimeUpdateInfo[updatingEngine];
          await runtimePage();
        }
        await checkRuntimeUpdates();
        if (reinstall) status(t('Reinstalled with Camellia. Future updates are managed here.') + (result.runtime?.warning ? '\n' + result.runtime.warning : ''));
        else if (result.changed) {
          const name = (runtimeRows.find(row => row.id === result.engine) || {}).name || result.engine;
          status(`Updated ${name} to v${result.to}`);
        } else status('Up to date');
      } catch (error) { status(error.message, true); }
      finally { runtimeUpdating.delete(updatingEngine); runtimeReinstalling.delete(updatingEngine); await runtimePage(); }
      return;
    }
    const button = e.target.closest('[data-install]'); if (!button) return;
    button.disabled = true;
    const selectedMode = button.dataset.install === 'antigravity' ? button.closest('[data-runtime-mode]')?.dataset.runtimeMode : undefined;
    try { const result = await api.runtimeEnsure({ engine: button.dataset.install, ...(selectedMode ? { mode: selectedMode } : {}) }); if (!result.ok) throw new Error(result.error); status(result.canceled ? '' : "Runtime ready"); delete runtimeUpdateInfo[button.dataset.install]; }
    catch (e) { status(e.message, true); } finally { void runtimePage(); }
  };
  $('runtimeCards').onclick = runtimeAction;
  $('pythonCard').onclick = runtimeAction;
  api.onRuntimeState(receiveRuntimes);
  // Python is shared, so its state can change without any engine card changing.
  api.onRuntimePythonState?.(renderPython);
  api.onNativeSettingsReady(() => { nativeReady = true; clearTimeout(nativeReadyTimer); $('nativeLoading').textContent = ''; $('retryNative').hidden = true; });
  let layoutFrame;
  const layout = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(() => { void placeNative(); }); };
  window.addEventListener('resize', layout);
  document.querySelector('.scroll-content').addEventListener('scroll', layout);
  new ResizeObserver(layout).observe($('engineContent'));
  // Installation status and path controls now sit above the native surface.
  // Their height can change without resizing the surface itself.
  new ResizeObserver(layout).observe($('runtimeCards'), { box: 'border-box' });
  return { select, openAccount, accountsPage, runtimePage, checkRuntimeUpdates, pythonPage, selected: () => engine, setVisible,
    // Refresh quota for the preferred Kimi account.
    activeSubscriptionId: () => 'kimi:' + (kimiAccount?.activeId || 'default') };
};
