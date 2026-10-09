'use strict';
const api = window.dshDesktop, $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = value => new Intl.NumberFormat(window.CamelliaI18n.locale, { maximumFractionDigits: 2 }).format(value || 0);
const compact = value => new Intl.NumberFormat(window.CamelliaI18n.locale, { maximumFractionDigits: 1, notation: 'compact' }).format(value || 0);
const when = value => value ? new Date(value).toLocaleString(window.CamelliaI18n.locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "Not queried yet";
const uid = () => crypto.randomUUID();
const routingId = window.CamelliaModelNames.canonicalModelId;
const maskKey = value => { const s = String(value || ''); return s.length > 12 ? s.slice(0, 4) + '…' + s.slice(-4) : '••••••••'; };
const keyName = (key, index = 0) => key.name || key.maskedKey || `Key ${index + 1}`;
const mark = type => ({ gemini: 'G', ollama: 'O', kimi: 'K', 'kimi-code': 'K', deepseek: 'D', commandcode: '⌘', opencode: 'OC', 'opencode-go': 'OC', qclaw: 'Q' }[type] || 'API');
const titles = {
  subscriptions: ["Subscription accounts", "Manage subscription sign-ins, quotas and login preferences."],
  providers: ["API Keys", "Manage API providers, keys, balances, models and routes."],
  usage: ["Usage", "Track requests and token consumption."],
  general: ["General", "Language, appearance, and local preferences."],
  data: ["Data & backups", ""],
  network: ["Network", "Choose how Camellia reaches the internet and test each connection."],
  archived: ["Archived", "Restore or permanently delete archived conversations."],
  mobile: ["Mobile access", "Connect your phone through Tailscale."],
  devices: ["CLI devices", "Manage server connections and default harnesses. Open a server from Home to work."],
  engines: ["Engine Settings", "Manage engine installation, updates, permissions, instructions and tools."],
  models: ["Model Settings", "Manage API key routing, visible subscription models, quick-switch defaults and model sessions."],
};
let config, live, presets = [], insight = { providers: {}, keys: {} }, selected = null, view = 'general';
let balanceKey = null, usageData = [];
let catalog = [], catalogSelected = new Set(), catalogProvider = null;
let statusTimer;
function status(text, error = false) {
  const toast = $('statusToast');
  $('status').textContent = text; $('status').className = error ? 'error' : '';
  clearTimeout(statusTimer);
  toast.hidden = !text;
  // An error stays until the next message; a routine note fades out so it does
  // not linger as a permanent banner.
  if (text && !error) statusTimer = setTimeout(() => { if (!$('status').classList.contains('error')) toast.hidden = true; }, 2500);
}
// Provider edits save on change, like the engine and subscription pages. A
// revision counter survives an edit that lands while a save is in flight.
let revision = 0, savedRevision = 0, saving = false, saveTimer = null, saveChain = Promise.resolve(), lastSaveError = null;
const savedModels = new WeakMap();
const isDirty = () => revision !== savedRevision;
function edited(immediate = false) {
  revision++;
  clearTimeout(saveTimer);
  // Save shortly after typing stops; leaving the field flushes immediately.
  if (immediate) void flushSave();
  else saveTimer = setTimeout(() => { saveTimer = null; void flushSave(false); }, 700);
}
// A key or model row starts empty and only becomes valid once it is filled in.
// Stay quiet for those half-finished rows and save as soon as they are usable,
// instead of flashing a validation error on every "add row" click.
function draftComplete() {
  return !config.providers.some(p => !String(p.baseUrl || '').trim()
    || p.models.some(m => (savedModels.has(m) || String(m.id || '').trim() || String(m.upstream || '').trim())
      && (!String(m.id || '').trim() || !String(m.upstream || '').trim()))
    || p.keys.some(k => !String(k.key || '').trim() && !k.maskedKey && k.name && p.type !== 'qclaw'));
}
function providerSnapshot() {
  const snapshot = structuredClone(config);
  snapshot.providers = snapshot.providers.flatMap((provider, index) => {
    const draft = config.providers[index];
    if (!String(provider.baseUrl || '').trim()) {
      const stored = live.providers.find(item => item.id === provider.id);
      if (!stored) return [];
      provider.baseUrl = stored.baseUrl;
    }
    provider.keys = provider.keys.filter(key => String(key.key || '').trim() || key.maskedKey);
    provider.models = provider.models.flatMap((model, modelIndex) => {
      if (String(model.id || '').trim() && String(model.upstream || '').trim()) return [model];
      const stored = savedModels.get(draft.models[modelIndex]);
      return stored ? [structuredClone(stored)] : [];
    });
    return [provider];
  });
  return snapshot;
}
function modelReferences() {
  return config.providers.flatMap(provider => provider.models.map(model => {
    const id = String(model.id || '').trim(), upstream = String(model.upstream || '').trim();
    const stored = savedModels.get(model), complete = id && upstream;
    return { providerId: provider.id, model, id: complete ? routingId(id) : stored?.id,
      upstream: complete ? upstream : stored?.upstream };
  }));
}
function rememberSavedModels(references = modelReferences()) {
  for (const reference of references) {
    const stored = live.providers.find(item => item.id === reference.providerId);
    const saved = stored?.models.find(item => item.id === reference.id && item.upstream === reference.upstream);
    if (saved) savedModels.set(reference.model, structuredClone(saved));
  }
}
function flushSave(explicit = true) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveChain = saveChain.then(() => saveProviders(explicit));
  return saveChain;
}
async function saveProviders(explicit) {
  if (saving || !isDirty()) return;
  saving = true;
  try {
    let warning = null;
    // Keep saving until the revision stops moving, so an edit typed during the
    // round trip is never dropped.
    do {
      while (isDirty()) {
        const target = revision, snapshot = providerSnapshot(), references = modelReferences();
        const result = await api.apiRouterSaveConfig(snapshot);
        if (!result.ok) throw new Error(result.error);
        savedRevision = target; lastSaveError = null; warning = result.warning || null;
        live = { ...live, ...result.state };
        rememberSavedModels(references);
        syncMaskedKeys(snapshot);
      }
      const data = await api.providerInsights().catch(error => ({ ok: false, error: error.message }));
      if (data.ok) insight = data;
      else warning = warning || data.error;
    } while (isDirty());
    if (current()?.type === 'qclaw') renderKeys();
    showLive(); updateKeyStats(); renderRoutes(); renderProviders(); renderModelChips();
    if (warning) status(warning, true);
    else if (draftComplete()) status("Saved. All engines share these connections.");
    else if (explicit) status("Complete the API URL, key or model fields to finish saving.", true);
  } catch (e) { lastSaveError = e.message; status(e.message, true); }
  finally { saving = false; }
}
// The router stores keys masked; mirror that back into the open editor so a
// secret that has been saved stops sitting in a password field.
function syncMaskedKeys(snapshot) {
  let changed = false;
  for (const p of config.providers) {
    const stored = (live.providers || []).find(item => item.id === p.id); if (!stored) continue;
    const submittedProvider = snapshot?.providers.find(item => item.id === p.id);
    for (const [field, inputId] of [['baseUrl', 'pUrl'], ['anthropicBaseUrl', 'pAUrl']]) {
      // Only mirror a normalized URL if it still matches the submitted edit.
      // A newer edit typed during the save must keep its value.
      if (!submittedProvider || p[field] !== submittedProvider[field] || p[field] === stored[field]) continue;
      p[field] = stored[field];
      if (selected === p.id && $(inputId)) $(inputId).value = stored[field] || '';
    }
    if (p.type === 'qclaw') {
      if (JSON.stringify(p.keys) !== JSON.stringify(stored.keys)) changed = true;
      p.keys = structuredClone(stored.keys); p.baseUrl = stored.baseUrl;
      continue;
    }
    for (const k of p.keys) {
      if (snapshot) {
        const submitted = snapshot.providers.find(item => item.id === p.id)?.keys.find(item => item.id === k.id);
        if (!submitted || String(k.key || '').trim() !== String(submitted.key || '').trim()) continue;
      }
      const saved = stored.keys.find(item => item.id === k.id); if (!saved?.maskedKey) continue;
      k.maskedKey = saved.maskedKey;
      if (!k.key) continue;
      k.key = '';
      const input = document.querySelector(`[data-key-card="${k.id}"] [data-field=key]`);
      if (input) { input.value = ''; input.placeholder = saved.maskedKey + ' · Leave blank to keep'; }
    }
  }
  return changed;
}
function current() { return config?.providers.find(p => p.id === selected); }
async function assertClean() {
  if (!isDirty()) return;
  await flushSave();
  if (isDirty()) throw new Error(lastSaveError || "API changes could not be saved. Check the highlighted error and try again.");
}
function setView(next, engine, focus) {
  if (isDirty()) void flushSave();
  // Keep older download links working, including the requested engine.
  if (next === 'runtimes') next = focus === 'python' || focus === 'runtime-path-python' ? 'general' : 'engines';
  if (next === 'general' && ['quickSwitchModels', 'conversationSessionTtl', 'conversationSessionLimit'].includes(focus)) next = 'models';
  if (next === 'engines' && focus === 'account') { next = 'subscriptions'; focus = engine; }
  if (next === 'providers' && ['kimi', 'codex', 'antigravity'].includes(focus)) next = 'subscriptions';
  if (next === 'balances') next = 'providers';
  if (next === 'storage') { next = 'data'; focus ||= 'storageSection'; }
  if (next === 'general' && ['dataDirectorySection', 'dataPath', 'dataDirectoryStatus', 'migrateDataDirectory', 'openLogs',
    'dataMigrationSection', 'dataMigrationStatus', 'exportData', 'importData', 'importDataAgain', 'storageSection'].includes(focus)) next = 'data';
  // The connection settings live on their own page now; the download prompt and
  // older links still ask for General or Runtime, so redirect them.
  if (next === 'general' && (focus === 'networkMode' || focus === 'downloadProxyUrl')) next = 'network';
  if (!titles[next]) next = 'general';
  view = next;
  for (const id of Object.keys(titles)) $(id + 'Page').hidden = id !== next;
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === next); button.setAttribute('aria-current', button.dataset.view === next ? 'page' : 'false'); });
  [$('pageTitle').textContent, $('pageSubtitle').textContent] = titles[next];
  engineUI.setVisible(next === 'engines');
  window.mobileAccessUI.setVisible(next === 'mobile');
  window.cliDevicesUI?.setVisible(next === 'devices');
  if (next === 'usage' && live) { fillUsageFilters(); renderUsage(); }
  if ((next === 'providers' || next === 'subscriptions') && live) renderBalances();
  if (next === 'subscriptions') void engineUI.accountsPage(focus || engine);
  if (next === 'engines') {
    void engineUI.select(engine || engineUI.selected());
    void engineUI.runtimePage();
    if (focus === 'updates') void engineUI.checkRuntimeUpdates();
  }
  if (next === 'general') void engineUI.pythonPage();
  if (next === 'models') void renderModelSettings();
  if (next === 'archived') void renderArchived();
  if (next === 'network') void loadDownloadSettings(focus);
  if (next === 'data' && focus) requestAnimationFrame(() => {
    if (view === 'data' && $(focus)?.closest('#dataPage')) $(focus).scrollIntoView({ block: 'center' });
  });
}
function navigateSettings(target = {}) {
  if (target.subscriptionId) balanceKey = target.subscriptionId;
  setView(target.subscriptionId ? 'subscriptions' : target.page || 'general', target.engine, target.subscriptionId ? 'kimi' : target.focus);
}
const engineUI = window.createEngineSettingsUI({ api, status, navigate: navigateSettings });
$('kimiUsage').onclick = () => refreshBalances({ subscriptionId: engineUI.activeSubscriptionId() });
api.onSettingsNavigate(navigateSettings);
// The main process downgrades a stale system proxy in the background; surface
// the same notice here even when the network page is not open.
api.onNetworkHealth(payload => window.CamelliaNetworkNotice?.sync(payload));
function showLive() {
  $('routerLabel').textContent = live.running ? "Router running" : "Setup required";
  $('routerDot').classList.toggle('online', !!live.running);
  const last = live.lastRoute;
  $('live').textContent = (live.running ? live.url : live.error || "The router starts after you add models and keys.") + (last ? ` · ${last.model} → ${last.providerName} · ${last.reason}` : '');
}
function keyBadge(k) {
  const t = window.CamelliaI18n.t;
  const u = live.usage?.[k.id] || {}, info = insight.keys[k.id] || {}, v = info.verification;
  if (!k.enabled) return ["Disabled", ''];
  if (u.blocked) return ["Authentication failed", 'bad'];
  if (live.quotaCheck?.enabled !== false && !live.quota?.[k.id]?.stale && live.quota?.[k.id]?.exhausted) return [t(live.quota[k.id].balanceExhausted ? 'Balance exhausted' : 'Quota exhausted'), 'bad'];
  if (v && !v.ok) return ["Validation failed", 'bad'];
  if (u.requests) return ["Used", 'good'];
  if (v?.ok) return ["Model verified", 'good'];
  if (info.status === 'ok') return ["Account connected", 'good'];
  return ["Not verified", ''];
}
function renderProviders() {
  $('providerSummary').textContent = `Providers: ${config.providers.length} · Keys: ${config.providers.reduce((sum,p) => sum + p.keys.length, 0)}`;
  $('providers').hidden = !!current();
  $('providers').innerHTML = config.providers.map((p,i) => {
    const connected = p.keys.filter(k => keyBadge(k)[1] === 'good').length;
    const requests = p.keys.reduce((sum,k) => sum + (live.usage?.[k.id]?.requests || 0), 0);
    return `<article class="provider"><button data-select="${p.id}"><span class="provider-title"><span class="provider-mark">${mark(p.type)}</span>${esc(p.name)}</span><p class="hint" data-i18n>Keys: ${p.keys.length} · Models: ${p.models.length}${p.enabled ? '' : " · Disabled"}</p></button><div class="provider-footer"><button data-select="${p.id}"><span data-i18n class="badge ${connected ? 'good' : ''}">${connected ? connected + " connected" : "Not connected"}</span><small data-i18n>Total ${fmt(requests)} successful requests</small></button><button data-up="${i}" aria-label="Move up ${esc(p.name)}" ${i ? '' : 'disabled'} data-i18n-attrs="aria-label">↑</button><button data-down="${i}" aria-label="Move down ${esc(p.name)}" ${i === config.providers.length-1 ? 'disabled' : ''} data-i18n-attrs="aria-label">↓</button></div></article>`;
  }).join('') || "<div class=\"empty\"><img src=\"../../../assets/icon-256.png\" alt=\"\"><h2 data-i18n>Add your first provider</h2><p data-i18n>Choose a service, paste your keys, and select models.</p><p class=\"hint\" data-i18n>DSH, Claude, and Kimi share these connections.</p></div>";
}
function renderEditor() {
  renderProviders();
  const p = current(); $('editor').hidden = !p;
  // The overview heading and the account balances describe the whole key pool,
  // not one provider, so both step aside while an editor is open.
  $('providersHeading').hidden = !!p;
  $('balancesSection').hidden = !!p;
  if (!p) { $('editor').innerHTML = ''; return; }
  $('editor').innerHTML = `<button class="back" id="backProviders" data-i18n>← All providers</button>
    <div class="editor-heading"><span class="provider-mark">${mark(p.type)}</span><input id="pName" value="${esc(p.name)}" aria-label="Provider name" data-i18n-attrs="aria-label"><label><input id="pEnabled" type="checkbox" ${p.enabled ? 'checked' : ''}>Enabled</label></div>
    <label for="pPriority" data-i18n>API priority</label><select id="pPriority"><option value="-1" data-i18n>Low</option><option value="0" data-i18n>Default</option><option value="1" data-i18n>High</option></select>
    <p class="hint" data-i18n>Routes follow High, Default, Low priority. Configure multi-key concurrency and automatic key failover in Model Settings. Next route manually switches among available keys at the highest available priority.</p>
    ${p.type.startsWith('mimo-token-plan-') ? '<p class="hint" data-i18n>Use your Token Plan tp- key and the region shown in your console. Coding use only. Do not add a pay-as-you-go route for the same model unless you want paid fallback. Check remaining Credits in the MiMo console.</p>' : ''}
    ${p.type === 'mimo' ? '<p class="hint" data-i18n>Use a regular MiMo API key, not a Token Plan tp- key. Requests are billed to your API balance. Adding this provider alongside Token Plan for the same model allows paid fallback.</p>' : ''}
    <div class="section-head"><h2 data-i18n>${p.type === 'qclaw' ? 'Connection' : 'API Key'}</h2><button id="showImport" ${p.type === 'qclaw' ? 'hidden' : ''} data-i18n>Import keys</button><button id="addKey" ${p.type === 'qclaw' ? 'hidden' : ''} data-i18n>+ Add key</button></div>
    <p class="hint" ${p.type === 'qclaw' ? 'hidden' : ''} data-i18n>Keys are tried in order. Leave a key blank to keep it. Use labels to identify accounts.</p><div id="keyRows"></div>
    <div id="keyImport" class="key-import" hidden><label for="bulkKeys" data-i18n>One key per line</label><textarea id="bulkKeys" placeholder="Paste API keys" spellcheck="false" data-i18n-attrs="placeholder"></textarea><button id="importKeys" data-i18n>Add to key pool</button><p class="hint" data-i18n>Duplicate keys for this provider are merged on save.</p></div>
    <div class="section"><div class="section-head"><h2 data-i18n>Model</h2><button id="mapModels" data-i18n>Map model aliases</button><button id="discoverModels" data-i18n>Fetch models</button></div><div id="modelChips" class="model-chips"></div>
      <details class="advanced" id="modelAdvanced"><summary data-i18n>Manual models and mappings</summary><p class="hint" data-i18n>Recognized owner prefixes and letter case are normalized automatically. For other aliases of the same model, choose the same routing model ID. Upstream IDs are sent unchanged. Keep versions, dates, variants and moving aliases separate. Mappings save automatically.</p><div class="table-scroll"><table class="model-table"><thead><tr><th data-i18n>Routing model ID</th><th data-i18n>Upstream model ID</th><th data-i18n>Protocol</th><th data-i18n>Context</th><th></th></tr></thead><tbody id="modelRows"></tbody></table></div><datalist id="routingModelIds"></datalist><button id="addModel" data-i18n>+ Add model</button></details>
      <div class="row verify-row" style="margin-top:18px"><label data-i18n>Validation model<select id="verifyModel" aria-label="Validation model" data-i18n-attrs="aria-label"></select></label><button id="verifyNow" data-verify-now data-i18n>Validate</button></div><p class="hint" data-i18n>Validate sends a short model request and may incur a charge. Fetching the catalog only checks catalog access.</p>
    </div>
    <details class="advanced section" id="connectionAdvanced" ${p.type === 'custom' ? 'open' : ''}><summary data-i18n>Advanced connection settings</summary><div class="grid">
      <div class="full"><label for="pUrl" data-i18n>API URL</label><input id="pUrl" value="${esc(p.baseUrl)}" placeholder="https://api.example.com/v1" spellcheck="false" data-i18n-attrs="placeholder"></div>
      <div><label for="pProtocol" data-i18n>Default protocol</label><select id="pProtocol"><option value="openai" data-i18n>OpenAI Chat Completions</option><option value="anthropic" data-i18n>Anthropic Messages</option><option value="dual" data-i18n>Both protocols</option></select></div>
      <div class="full" id="aUrlField"><label for="pAUrl" data-i18n>Anthropic URL (leave blank if the same)</label><input id="pAUrl" value="${esc(p.anthropicBaseUrl || '')}" spellcheck="false"></div></div></details>
    <details class="advanced section"><summary data-i18n>Active routes and priority</summary><div id="routeRows"></div></details>
    <button id="deleteProvider" class="danger" style="margin-top:24px" data-i18n>Remove provider</button>`;
  $('pProtocol').value = p.protocol; $('aUrlField').hidden = p.protocol !== 'dual';
  $('backProviders').onclick = () => { void flushSave(); selected = null; renderEditor(); };
  for (const [id, field] of [['pName','name'], ['pUrl','baseUrl'], ['pAUrl','anthropicBaseUrl']]) {
    $(id).oninput = e => {
      if (field !== 'name' && p[field] !== e.target.value) for (const model of p.models) delete model.thinking;
      p[field] = e.target.value; edited();
    };
    $(id).onblur = () => void flushSave();
  }
  $('pProtocol').onchange = e => { p.protocol = e.target.value; $('aUrlField').hidden = p.protocol !== 'dual'; edited(true); };
  $('pEnabled').onchange = e => { p.enabled = e.target.checked; edited(true); };
  $('pPriority').value = String(Math.sign(p.priority ?? 0));
  $('pPriority').onchange = e => { p.priority = Number(e.target.value); edited(true); };
  $('addKey').onclick = () => { p.keys.push({ id: uid(), key: '', name: '', enabled: true }); edited(); renderKeys(); };
  $('showImport').onclick = () => { $('keyImport').hidden = !$('keyImport').hidden; if (!$('keyImport').hidden) $('bulkKeys').focus(); };
  $('importKeys').onclick = () => {
    const keys = [...new Set($('bulkKeys').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    if (!keys.length) return status("Paste at least one key", true);
    p.keys = p.keys.filter(k => k.key || k.maskedKey);
    // A saved key comes back masked, so compare on the mask too. Otherwise a
    // pasted duplicate of an already-stored key appends a second entry that
    // looks distinct only because its stored value is masked.
    for (const key of keys) if (!p.keys.some(k => k.key === key || k.maskedKey === maskKey(key))) p.keys.push({ id: uid(), key, name: '', enabled: true });
    $('bulkKeys').value = ''; $('keyImport').hidden = true; edited(true); renderKeys(); status(`Added ${keys.length} keys.`);
  };
  $('addModel').onclick = () => { p.models.push({ id: '', upstream: '', protocol: 'auto' }); edited(); renderModels(); };
  $('mapModels').onclick = () => { $('modelAdvanced').open = true; $('modelRows').querySelector('[data-field="id"]')?.focus(); };
  $('discoverModels').onclick = () => discoverModels(p);
  $('deleteProvider').onclick = () => { config.providers = config.providers.filter(x => x.id !== p.id); selected = null; edited(true); renderEditor(); };
  renderKeys(); renderModels(); renderRoutes();
}
function renderKeys() {
  const p = current(); if (!p) return;
  if (p.type === 'qclaw') {
    $('keyRows').innerHTML = p.keys.map(key => `<div class="key-card" data-key-card="${key.id}"><div class="key-actions"><span data-i18n data-badge="${key.id}"></span><button data-verify="${key.id}" data-i18n>Validate</button><button data-key-usage="${key.id}" data-i18n>Usage</button><button data-reset-key="${key.id}" data-i18n>Reset</button></div><div class="key-note" data-i18n data-note="${key.id}"></div></div>`).join('') || '<p class="hint" data-i18n>QClaw gateway was not found. Start QClaw and try again; no API key is required.</p>';
    updateKeyStats();
    return;
  }
  $('keyRows').innerHTML = p.keys.map((k,i) => `<div class="key-card" data-key-card="${k.id}"><div class="key-row"><input type="checkbox" data-key="${i}" data-field="enabled" ${k.enabled ? 'checked' : ''} aria-label="Enable key ${i+1}" data-i18n-attrs="aria-label"><input class="key-name" data-key="${i}" data-field="name" value="${esc(k.name)}" placeholder="Key ${i+1}" aria-label="Key label ${i+1}" data-i18n-attrs="aria-label placeholder"><input type="password" data-key="${i}" data-field="key" value="${esc(k.key || '')}" placeholder="${esc(k.maskedKey ? k.maskedKey + " · Leave blank to keep" : "Paste API key")}" aria-label="API Key ${i+1}" autocomplete="new-password" spellcheck="false" data-i18n-attrs="aria-label placeholder"></div><div class="key-actions"><span data-i18n data-badge="${k.id}"></span><button data-verify="${k.id}" data-i18n>Validate</button><button data-key-usage="${k.id}" data-i18n>Usage</button><button data-key-balance="${k.id}" data-i18n>Balance</button><button data-up-key="${i}" aria-label="Move key up ${i+1}" ${i ? '' : 'disabled'} data-i18n-attrs="aria-label">↑</button><button data-down-key="${i}" aria-label="Move key down ${i+1}" ${i === p.keys.length-1 ? 'disabled' : ''} data-i18n-attrs="aria-label">↓</button><button data-reset-key="${k.id}" data-i18n>Reset</button><button data-remove-key="${i}" aria-label="Remove key ${i+1}" data-i18n-attrs="aria-label">×</button></div><div class="key-note" data-i18n data-note="${k.id}"></div></div>`).join('') || "<p class=\"hint\" data-i18n>Add a key to connect this provider.</p>";
  updateKeyStats();
}
function updateKeyStats() {
  for (const k of current()?.keys || []) {
    const badge = document.querySelector(`[data-badge="${k.id}"]`), note = document.querySelector(`[data-note="${k.id}"]`);
    if (!badge || !note) continue;
    const t = window.CamelliaI18n.t;
    const [text, cls] = keyBadge(k), u = live.usage?.[k.id] || {}, v = insight.keys[k.id]?.verification;
    badge.className = `badge ${cls}`; badge.textContent = text;
    const cooldown = Object.entries(u.models || {}).filter(([,s]) => s.until > Date.now()).map(([m,s]) => `${m} cooldown until ${when(s.until)}`).join('; ');
    // Reported quota comes from the router, which reads it for every provider
    // with an account API, and is what keeps an exhausted key out of rotation.
    const quota = live.quota?.[k.id];
    const windows = (quota?.windows || []).map(window => `${t(window.label || window.id)} ${window.usedPercent === null ? '—' : fmt(window.usedPercent) + '%'}`).join(' · ');
    const balances = (quota?.balances || []).map(balance => `${balance.currency || balance.id} ${balance.value === null ? '—' : fmt(balance.value)}`).join(' · ');
    const quotaNote = (windows ? ` · ${t('Quota')}: ${windows}` : '') + (balances ? ` · ${t('Balance')}: ${balances}` : '')
      + (quota?.checkedAt ? ` · ${t('Updated ' + when(quota.checkedAt))}` : '')
      + (quota?.stale ? ` · ${t('Quota reading expired')}` : '')
      + (live.quotaCheck?.enabled === false && quota ? ` · ${t('Automatic quota checks disabled')}` : '')
      + (quota?.error ? ` · ${t('Quota check failed')}: ${quota.error}` : '');
    note.textContent = `${fmt(u.requests)} successful · Input ${fmt(u.inputTokens)} / Output ${fmt(u.outputTokens)} tokens · Failed ${fmt(u.failures)}` + (v ? ` · Last validated ${v.model} ${when(v.at)}${v.error ? ' · ' + v.error : ''}` : '') + (cooldown ? ' · ' + cooldown : '') + (u.lastError ? ' · ' + u.lastError.reason : '') + quotaNote;
  }
}
function routeKeySummary(id) {
  const keys = (live.providers || []).filter(provider => provider.enabled !== false && provider.models.some(model => routingId(model.id) === id))
    .flatMap(provider => provider.keys.filter(key => key.enabled !== false));
  const available = live.enabled === false ? 0 : keys.filter(key => !live.usage?.[key.id]?.blocked && !(live.usage?.[key.id]?.models?.[id]?.until > Date.now())
    && !(live.quotaCheck?.enabled !== false && !live.quota?.[key.id]?.stale && live.quota?.[key.id]?.exhausted)).length;
  return `Available keys: ${available} / ${keys.length}`;
}
function renderModelChips() {
  const p = current(); if (!p) return;
  const groups = new Map();
  for (const model of p.models) if (model.id) {
    const id = routingId(model.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(model.upstream);
  }
  $('modelChips').innerHTML = [...groups].map(([id, upstreams]) => `<span class="model-chip" title="${esc(upstreams.join('\n'))}"><span>${esc(id)} <small data-i18n>${esc(routeKeySummary(id))}</small></span><button type="button" data-remove-model-group="${esc(id)}" aria-label="Remove model ${esc(id)}" data-i18n-attrs="aria-label">×</button></span>`).join('') || "<p class=\"hint\" data-i18n>Fetch the provider catalog and choose models, or add them manually.</p>";
}
function renderModels() {
  const p = current(); if (!p) return;
  renderModelChips();
  $('modelRows').innerHTML = p.models.map((m,i) => `<tr><td><input data-model="${i}" data-field="id" value="${esc(m.id)}" aria-label="Canonical model ID ${i+1}" spellcheck="false" data-i18n-attrs="aria-label"></td><td><input data-model="${i}" data-field="upstream" value="${esc(m.upstream)}" aria-label="Upstream model ID ${i+1}" spellcheck="false" data-i18n-attrs="aria-label"></td><td><select data-model="${i}" data-field="protocol" aria-label="Model protocol ${i+1}" data-i18n-attrs="aria-label"><option value="auto" data-i18n>Default</option><option value="openai" data-i18n>OpenAI</option><option value="anthropic" data-i18n>Anthropic</option></select></td><td><input type="number" min="4096" max="${m.maxContext || 2000000}" step="1024" data-model="${i}" data-field="contextWindow" value="${m.contextWindow || ''}" placeholder="${m.maxContext ? '\u2264 ' + m.maxContext : 'Auto'}" aria-label="Context window ${i+1}" data-i18n-attrs="aria-label" style="width:96px"></td><td><button data-remove-model="${i}" aria-label="Remove model ${i+1}" data-i18n-attrs="aria-label">×</button></td></tr>`).join('');
  document.querySelectorAll('[data-model][data-field=protocol]').forEach(el => { el.value = p.models[Number(el.dataset.model)].protocol || 'auto'; });
  const ids = [...new Set(config.providers.flatMap(provider => provider.models.map(model => routingId(model.id))).filter(Boolean))];
  $('routingModelIds').innerHTML = ids.map(id => `<option value="${esc(id)}"></option>`).join('');
  $('modelRows').querySelectorAll('[data-field="id"]').forEach(input => input.setAttribute('list', 'routingModelIds'));
  fillSelect($('verifyModel'), [...new Set(p.models.filter(m => m.id).map(m => routingId(m.id)))].map(id => [id, id]), "Select model", false);
}
function renderRoutes() {
  const p = current(); if (!p) return;
  $('routeRows').innerHTML = (live.models || []).filter(id => p.models.some(m => routingId(m.id) === id)).map(id => {
    const active = (live.providers || []).find(p => p.keys.some(k => k.id === live.active?.[id]));
    const key = active?.keys.find(k => k.id === live.active?.[id]);
    return `<div class="route-row"><span>${esc(id)}<br><small><span data-i18n>${esc(routeKeySummary(id))}</span> · ${active ? esc(active.name + ' · ' + keyName(key)) : '<span data-i18n>Use priority order</span>'}</small></span><button data-rotate="${esc(id)}" data-i18n>Next route</button><button data-reset-model="${esc(id)}" data-i18n>Reset priority</button></div>`;
  }).join('') || "<p class=\"hint\" data-i18n>Add models and keys to see available routes.</p>";
}
async function discoverModels(p) {
  const button = $('discoverModels'); button.disabled = true; status("Fetching model catalog…");
  try {
    await assertClean();
    const source = structuredClone(p);
    const result = await api.providerModels({ provider: source }); if (!result.ok) throw new Error(result.error);
    if (p.baseUrl !== source.baseUrl || p.anthropicBaseUrl !== source.anthropicBaseUrl || p.type !== source.type || !config.providers.includes(p)) return;
    catalog = result.models; catalogProvider = p.id; catalogSelected = new Set(p.models.map(model => model.upstream));
    let limits = 0, changed = false;
    for (const m of p.models) {
      const hit = catalog.find(x => x.upstream.replace(/:cloud$/, '') === m.upstream.replace(/:cloud$/, ''));
      if (hit?.maxContext && m.maxContext !== hit.maxContext) { m.maxContext = hit.maxContext; limits++; changed = true; }
      if (hit?.thinking && JSON.stringify(m.thinking) !== JSON.stringify(hit.thinking)) { m.thinking = structuredClone(hit.thinking); changed = true; }
    }
    if (changed) { edited(); renderModels(); }
    $('modelSearch').value = ''; renderCatalog(); $('modelDialog').showModal();
    status(limits
      ? `Found ${catalog.length} models. Context limits updated for ${limits} of your models.`
      : `Found ${catalog.length} models. Catalog access does not verify inference access for this key.`);
  } catch (e) { status(e.message, true); } finally { button.disabled = false; }
}
function renderCatalog() {
  const query = $('modelSearch').value.trim().toLowerCase(), p = config.providers.find(p => p.id === catalogProvider);
  $('catalogList').innerHTML = catalog.filter(m => [m.id, m.upstream].some(name => name.toLowerCase().includes(query))).map((m) => {
    const existing = p?.models.some(x => x.upstream === m.upstream);
    return `<label class="catalog-option"><input type="checkbox" data-catalog="${esc(m.upstream)}" ${catalogSelected.has(m.upstream) ? 'checked' : ''}>${esc(m.id)}${m.id !== m.upstream ? `<small class="hint">← ${esc(m.upstream)}</small>` : ''}${m.maxContext ? `<small class="hint">· ${Math.round(m.maxContext / 1024)}K ctx</small>` : ''}${existing ? "<small data-i18n>Added</small>" : ''}</label>`;
  }).join('') || "<p class=\"hint\" data-i18n>No matching models</p>";
}

function fillSelect(el, options, placeholder, includeAll = true) {
  const old = el.value;
  el.innerHTML = (includeAll || !options.length ? `<option data-i18n value="">${esc(placeholder)}</option>` : '') + options.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
  if ([...el.options].some(o => o.value === old)) el.value = old;
}
function fillUsageFilters() {
  const sources = usageSources();
  fillSelect($('usageProvider'), sources.map(p => [p.id, p.name]), "All providers");
  const providers = sources.filter(p => !$('usageProvider').value || p.id === $('usageProvider').value);
  // Key labels stay short — just enough to tell keys apart; the provider
  // dropdown sits immediately to the left. Duplicated labels gain the provider.
  const shortKey = (k, i) => { const s = keyName(k, i); return s.length > 18 ? s.slice(0, 16) + '…' : s; };
  const keyEntries = providers.flatMap(p => p.keys.map((k,i) => ({ id: k.id, label: shortKey(k,i), provider: p.name })));
  const labelCount = new Map();
  for (const e of keyEntries) labelCount.set(e.label, (labelCount.get(e.label) || 0) + 1);
  fillSelect($('usageKey'), keyEntries.map(e => [e.id, labelCount.get(e.label) > 1 ? e.label + ' · ' + e.provider : e.label]), "All accounts / keys");
  const models = new Set(providers.flatMap(p => p.keys.filter(k => !$('usageKey').value || k.id === $('usageKey').value).flatMap(k => [...Object.keys((k.usage || live.usage?.[k.id])?.byModel || {}), ...p.models.map(m => m.id)])));
  fillSelect($('usageModel'), [...models].sort().map(id => [id,id]), "All models");
}
function usageSources() {
  const source = $('usageSource').value;
  const providers = source === 'subscription' ? [] : (live.providers || []).map(p => ({ ...p, keys: [...p.keys], source: 'api' }));
  if (source !== 'subscription') for (const archived of live.usageArchive || []) {
    let provider = providers.find(p => p.id === archived.providerId || p.id === 'history:' + archived.providerId);
    if (!provider) {
      provider = { id: 'history:' + archived.providerId, name: archived.providerName,
        keys: [], models: [], source: 'api' };
      providers.push(provider);
    }
    const label = archived.keyName || archived.maskedKey || 'Key';
    provider.keys.push({ id: archived.id, name: `${label} · ${window.CamelliaI18n.t('Previous key')}`,
      usage: archived.usage });
  }
  if (source === 'api') return providers;
  const subscriptions = new Map();
  for (const account of live.subscriptionUsage?.accounts || []) {
    const id = 'subscription:' + account.engine;
    if (!subscriptions.has(id)) subscriptions.set(id, { id, name: account.provider || account.engine, source: 'subscription', keys: [], models: [] });
    subscriptions.get(id).keys.push({ id: 'subscription:' + account.id, name: account.label || account.accountId, usage: account.usage || {} });
  }
  return [...providers, ...subscriptions.values()];
}
const statsFields = ['requests', 'failures', 'cancelled', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unreported', 'reasoningTokens', 'estimatedCostUsd', 'pricedTokens', 'unpricedTokens'];
const blankStats = () => Object.fromEntries(statsFields.map(key => [key,0]));
function addStats(target, source) { for (const key of statsFields) target[key] += source[key] || 0; return target; }
function localDay(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function usageRows() {
  const result = [], series = [], range = $('usageRange').value, selectedModel = $('usageModel').value;
  const earliest = new Date(); earliest.setDate(earliest.getDate() - (range === 'all' ? 89 : Number(range)-1));
  const min = localDay(earliest);
  for (const p of usageSources()) {
    if ($('usageProvider').value && $('usageProvider').value !== p.id) continue;
    for (const [i,k] of p.keys.entries()) {
      if ($('usageKey').value && $('usageKey').value !== k.id) continue;
      const usage = k.usage || live.usage?.[k.id] || {}, totals = {}, modelDays = new Map();
      for (const [day, models] of Object.entries(usage.daily || {})) {
        if (day < min) continue;
        for (const [model, stats] of Object.entries(models)) {
          if (selectedModel && model !== selectedModel) continue;
          totals[model] ||= blankStats(); addStats(totals[model], stats);
          if (!modelDays.has(model)) modelDays.set(model, []);
          modelDays.get(model).push({ at: day + 'T12:00:00', stats: { ...blankStats(), ...stats } });
        }
      }
      if (range === 'all') {
        for (const key of Object.keys(totals)) delete totals[key];
        for (const [model, stats] of Object.entries(usage.byModel || {})) if (!selectedModel || model === selectedModel) totals[model] = { ...blankStats(), ...stats };
        if (!selectedModel) {
          const assigned = Object.values(usage.byModel || {}).reduce(addStats, blankStats());
          const old = Object.fromEntries(statsFields.map(field => [field, Math.max(0, (usage[field] || 0) - assigned[field])]));
          if (Object.values(old).some(Boolean)) totals["Legacy totals (not grouped by model)"] = old;
        }
      }
      for (const [model, stats] of Object.entries(totals)) result.push({ model, provider: p.name, source: p.source, key: keyName(k,i), keyId: k.id, ...stats });
      for (const [model, points] of modelDays) series.push({ model, provider: p.name, source: p.source, key: keyName(k,i), points });
    }
  }
  return { rows: result.sort((a,b) => b.requests - a.requests || a.model.localeCompare(b.model)), series };
}
function renderChartGrid(container, charts) {
  container.innerHTML = charts.map(chart => `<section class="chart-panel chart-tile" data-chart-kind="${esc(chart.kind)}"><h3>${esc(chart.label)}</h3><p class="hint">${esc(chart.description)}</p><div class="chart-tile-body"></div></section>`).join('') || '<div class="chart-empty" data-i18n>No requests in this period.</div>';
  container.querySelectorAll('.chart-tile-body').forEach((body, index) => {
    const chart = charts[index];
    body.innerHTML = SettingsCharts.line(chart.points, { ...chart, width: body.clientWidth, area: chart.kind === 'usage' });
    SettingsCharts.bindHover(body);
  });
}
function renderUsage() {
  const { rows, series } = usageRows(); usageData = rows;
  const sum = rows.reduce(addStats, blankStats());
  const hasSubscriptions = $('usageSource').value === 'subscription' || rows.some(row => row.source === 'subscription');
  const countLabel = hasSubscriptions ? 'Successful requests / turns' : 'Successful requests';
  const countUnit = hasSubscriptions ? 'requests / turns' : 'requests';
  $('usageSummary').innerHTML = [[countLabel, sum.requests, countUnit], ["Input tokens", sum.inputTokens, "Includes cache"], ["Output tokens", sum.outputTokens, "Reported by provider"], ["Failed / Canceled", sum.failures + sum.cancelled, countUnit]].map(([label,value,note]) => `<div><small data-i18n>${label}</small><strong>${compact(value)}</strong><small data-i18n>${note}</small></div>`).join('');
  const t = window.CamelliaI18n.t;
  const subscription = rows.filter(row => row.source === 'subscription').reduce(addStats, blankStats());
  const usd = value => new Intl.NumberFormat(window.CamelliaI18n.locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);
  const estimate = stats => stats.pricedTokens > 0 ? usd(stats.estimatedCostUsd) : t('Unavailable');
  $('subscriptionCost').textContent = estimate(subscription);
  $('subscriptionCostNote').textContent = t('Standard text API equivalent, not your subscription bill.')
    + (live.subscriptionUsage?.pricing?.checkedAt ? ' LiteLLM · ' + live.subscriptionUsage.pricing.checkedAt : '');
  $('subscriptionUsageSince').textContent = live.subscriptionUsage?.since ? t('Subscription recording started: ' + new Date(live.subscriptionUsage.since).toLocaleDateString(window.CamelliaI18n.locale)) : '';
  $('subscriptionCostCard').hidden = $('usageSource').value === 'api';
  const pricing = live.subscriptionUsage?.pricing || {};
  $('subscriptionPricesRefresh').disabled = Boolean(pricing.refreshing);
  $('subscriptionPriceStatus').textContent = (pricing.refreshing ? t('Refreshing prices…') : pricing.error ? t(pricing.error) : t('Prices refresh automatically every day.'))
    + (subscription.unpricedTokens ? ' ' + t('Unpriced tokens: {0}').replace('{0}', fmt(subscription.unpricedTokens)) + ' ' + t('Older aggregate usage cannot be repriced accurately.') : '');
  const metric = $('usageMetric').value;
  const metricLabel = t({ tokens: 'Token usage', requests: countLabel, inputTokens: 'Input tokens', outputTokens: 'Output tokens', failures: 'Failed / Canceled', estimatedCostUsd: 'Subscription estimate (USD)' }[metric]);
  renderChartGrid($('usageChart'), series.filter(row => metric !== 'estimatedCostUsd' || row.source === 'subscription' && row.points.some(point => point.stats.pricedTokens > 0)).map(series => ({
    kind: 'usage', label: `${series.key} · ${series.model}`,
    description: `${series.provider} · ${metricLabel}`, unit: metric === 'estimatedCostUsd' ? ' USD' : metric === 'tokens' || metric.endsWith('Tokens') ? ' Token' : ' ' + t(countUnit),
    points: series.points.filter(point => metric !== 'estimatedCostUsd' || point.stats.pricedTokens > 0).map(({ at, stats }) => ({ at, value: metric === 'tokens' ? stats.inputTokens + stats.outputTokens : metric === 'failures' ? stats.failures + stats.cancelled : stats[metric] })),
  })));
  $('usageChartNotes').innerHTML = (sum.unreported ? `<p class="hint">${esc(t('Requests / turns with missing or incomplete token usage: ' + fmt(sum.unreported)))}</p>` : '') + ($('usageRange').value === 'all' ? "<p class=\"hint\" data-i18n>The chart shows the last 90 recorded days. Totals and details are cumulative.</p>" : '') + (live.subscriptionUsage?.error ? `<p class="error">${esc(t(live.subscriptionUsage.error))}</p>` : '');
  $('usageRows').innerHTML = rows.map(row => `<tr><td>${esc(row.model)}<small>${esc(row.provider)}</small><small>${esc(t(row.source === 'subscription' ? 'Subscription' : 'API key'))}</small></td><td>${esc(row.key)}</td><td>${fmt(row.requests)}</td><td>${fmt(row.inputTokens)}</td><td>${fmt(row.outputTokens)}</td><td>${fmt(row.cacheReadTokens)}</td><td>${fmt(row.cacheWriteTokens)}</td><td>${fmt(row.failures + row.cancelled)}</td><td>${row.source === 'subscription' ? esc(estimate(row)) : '—'}</td></tr>`).join('') || "<tr><td colspan=\"9\"><div class=\"chart-empty\" data-i18n>No requests in this period.</div></td></tr>";
}
function money(balance) { return `${balance.currency === 'CNY' ? '¥' : balance.currency === 'USD' ? '$' : ''}${fmt(balance.value)}${balance.currency === 'credits' ? ' Credits' : !['CNY','USD'].includes(balance.currency) ? ' ' + balance.currency : ''}`; }
function remaining(window) { return Math.max(0, 100 - window.usedPercent); }
function meter(window) { const value = remaining(window); return `<div class="meter ${value < 15 ? 'low' : ''}"><span style="width:${Math.min(100,value)}%"></span></div>`; }
function accountsList() {
  return [...(insight.subscriptions || []).map(s => ({ id: s.id, providerId: s.id, provider: s.name, name: s.label,
    subscriptionId: s.id, engine: s.engine, enabled: true, info: s.info, capability: s.capability })),
  ...live.providers.flatMap(p => p.keys.map((k,i) => ({ id: k.id, providerId: p.id, provider: p.name, type: p.type,
    name: keyName(k,i), maskedKey: k.maskedKey, enabled: k.enabled && p.enabled, info: insight.keys[k.id] || {},
    capability: insight.providers[p.id] || { supported: false, label: "Balance queries not supported" } })))];
}
function accountCard(account, selected = false) {
  const { id, provider, name, info, capability, subscriptionId, engine, type, enabled } = account;
  const t = window.CamelliaI18n.t;
  const latest = info.latest, balance = latest?.balances?.[0], quota = latest?.windows?.[0];
  const summary = balance ? money(balance) : quota ? t(`${fmt(remaining(quota))}% remaining`) : capability.supported ? t('Not queried') : t('Not supported');
  const brand = subscriptionId ? `<img src="../../../assets/brands/${engine}.svg" alt="">` : mark(type);
  return `<${subscriptionId ? 'div' : 'button'} class="balance-card ${selected ? 'selected' : ''}" data-balance="${esc(id)}"><span class="provider-title"><span class="provider-mark${subscriptionId ? ' engine-mark' : ''}"${subscriptionId ? ` data-engine="${engine}"` : ''}>${brand}</span>${esc(provider)}</span>
    <p>${esc(subscriptionId ? t(name) : name)}${enabled ? '' : ' · ' + t('Disabled')}${subscriptionId ? ' · ' + t('Signed in') : ''}</p>
    <strong>${esc(summary)}</strong>${quota && !balance ? meter(quota) : ''}
    <p>${quota && !balance ? esc(t(quota.label)) + ' · ' : ''}${esc(info.refreshing ? t('Querying…') : latest ? t('Updated ' + when(latest.at)) : t(capability.label))}</p>
    ${subscriptionId ? `<div class="quota-preview">${(latest?.windows || []).slice(balance ? 0 : 1).map(w => `<small>${esc(t(w.label))} · ${esc(t(`${fmt(remaining(w))}% remaining`))}</small>`).join('')}</div>` : ''}
    ${(latest?.windows || []).filter(w => w.resetsAt).map(w => `<small>${esc(t(w.label))} · ${esc(t('Resets'))} ${esc(when(w.resetsAt))}</small>`).join('')}
    ${info.error ? `<p class="error">${esc(t(info.error))}${latest ? ' ' + esc(t('The last successful result is shown below.')) : ''}</p>` : ''}</${subscriptionId ? 'div' : 'button'}>`;
}
function renderBalances() {
  const all = accountsList().filter(account => !account.subscriptionId);
  fillSelect($('balanceProvider'), [...new Map(all.map(a => [a.providerId, a.provider])).entries()], "All providers");
  const query = $('balanceSearch').value.trim().toLowerCase();
  const accounts = all.filter(a => (!$('balanceProvider').value || a.providerId === $('balanceProvider').value) && `${a.provider} ${a.name} ${a.maskedKey || ''}`.toLowerCase().includes(query));
  if (!accounts.some(a => a.id === balanceKey)) balanceKey = accounts[0]?.id || null;
  $('balanceCards').innerHTML = accounts.map(a => accountCard(a, a.id === balanceKey)).join('') || (all.length ? "<div class=\"empty\" data-i18n>No matching accounts.</div>" : "<div class=\"empty\"><h2 data-i18n>Connect an account to view its balance</h2><p class=\"hint\" data-i18n>Add a connection in Providers & Keys.</p></div>");
  renderChartGrid($('balanceChart'), balanceChartSeries());
}
function balanceChartSeries(id = balanceKey) {
  const t = window.CamelliaI18n.t;
  const account = accountsList().find(account => account.id === id);
  if (!account) return [];
  const latest = account.info.latest;
  const metrics = [...(latest?.balances || []).map(balance => ({ label: t(balance.label), type: 'balances', key: balance.id, unit: balance.currency })), ...(latest?.windows || []).map(window => ({ label: t(window.label) + ' · ' + t('Remaining'), type: 'windows', key: window.id, unit: '%' }))];
  return metrics.map(metric => ({
    kind: 'quota', label: metric.label + ' · ' + metric.unit,
    description: `${account.provider} · ${t(account.name)} · ${t('30-day observations')}`,
    unit: metric.unit, percent: metric.type === 'windows',
    points: (account.info.history || []).map(sample => {
      const item = sample[metric.type]?.find(entry => entry.id === metric.key);
      return { at: sample.at, value: item ? metric.type === 'windows' ? remaining(item) : item.value : null };
    }),
  }));
}
async function refreshBalances(payload = {}) {
  try {
    if (!payload.subscriptionId) await assertClean(); $('refreshBalances').disabled = true; $('kimiUsage').disabled = true; status("Querying balances and quotas…");
    const result = await api.providerRefresh(payload.subscriptionId ? payload : { ...payload, apiOnly: true }); if (!result.ok) throw new Error(result.error);
    insight = result; renderBalances(); updateKeyStats();
    const refreshed = payload.subscriptionId
      ? (insight.subscriptions || []).filter(account => account.id === payload.subscriptionId).map(account => account.info)
      : Object.values(insight.keys);
    const errors = refreshed.filter(info => info.status === 'error').length;
    status(errors ? `Query complete. ${errors} accounts could not be queried. See their cards for details.` : "Account status updated.");
  } catch (e) { status(e.message, true); } finally { $('refreshBalances').disabled = false; $('kimiUsage').disabled = false; }
}
document.querySelector('.settings-nav nav').onclick = e => { const button = e.target.closest('[data-view]'); if (button) setView(button.dataset.view); };
$('providers').onclick = e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.dataset.select) { selected = button.dataset.select; renderEditor(); return; }
  const i = Number(button.dataset.up ?? button.dataset.down), j = button.dataset.up !== undefined ? i-1 : i+1;
  [config.providers[i], config.providers[j]] = [config.providers[j], config.providers[i]]; edited(true); renderProviders();
};
function updateEditorField(element) {
  const provider = current(); if (!provider) return;
  const row = element.dataset.model !== undefined ? provider.models[Number(element.dataset.model)]
    : element.dataset.key !== undefined ? provider.keys[Number(element.dataset.key)] : null;
  if (!row) return;
  const value = element.type === 'checkbox' ? element.checked : element.value;
  if (row[element.dataset.field] === value) return;
  if (element.dataset.model !== undefined && ['upstream', 'protocol'].includes(element.dataset.field)) delete row.thinking;
  row[element.dataset.field] = value; edited();
}
$('editor').oninput = event => updateEditorField(event.target);
// Clamp the context window to the model's known limit once editing finishes,
// so a value beyond the catalog maximum never reaches save-time validation.
$('editor').onchange = e => {
  const el = e.target, p = current();
  if (!p) return;
  updateEditorField(el);
  if (el.dataset.model !== undefined && el.dataset.field === 'id' && el.value.trim()) {
    const id = routingId(el.value);
    if (id !== p.models[Number(el.dataset.model)].id) { el.value = id; p.models[Number(el.dataset.model)].id = id; edited(); }
    renderModelChips();
  }
  if (el.dataset.model !== undefined && el.dataset.field === 'contextWindow') {
    const model = p.models[Number(el.dataset.model)], raw = String(el.value).trim();
    const value = Number(raw);
    if (raw && Number.isInteger(value)) {
      const cap = model.maxContext || 2000000, clamped = Math.min(cap, Math.max(4096, value));
      if (clamped !== value) {
        el.value = clamped; model.contextWindow = clamped; edited();
        status(value > cap ? `Context window capped at the model's maximum (${cap})` : "Context window must be an integer between 4096 and 2000000", true);
      }
    }
  }
  void flushSave();
};
$('editor').addEventListener('focusout', event => {
  if (event.target.matches('input, select, textarea')) void flushSave();
});
$('editor').onclick = async e => {
  const button = e.target.closest('button'), p = current(); if (!button || !p) return;
  const d = button.dataset;
  if (d.removeModelGroup !== undefined) { p.models = p.models.filter(model => routingId(model.id) !== d.removeModelGroup); edited(true); renderModels(); renderRoutes(); }
  if (d.removeModel !== undefined) { p.models.splice(Number(d.removeModel),1); edited(true); renderModels(); renderRoutes(); }
  if (d.removeKey !== undefined) { p.keys.splice(Number(d.removeKey),1); edited(true); renderKeys(); }
  if (d.upKey !== undefined || d.downKey !== undefined) { const i = Number(d.upKey ?? d.downKey), j = d.upKey !== undefined ? i-1 : i+1; [p.keys[i], p.keys[j]] = [p.keys[j], p.keys[i]]; edited(true); renderKeys(); }
  try {
    if (d.keyUsage) {
      await assertClean(); $('usageSource').value = 'api'; $('usageModel').value = '';
      if ($('usageMetric').value === 'estimatedCostUsd') $('usageMetric').value = 'tokens';
      setView('usage'); $('usageProvider').value = p.id; fillUsageFilters();
      $('usageKey').value = d.keyUsage; fillUsageFilters(); renderUsage();
    }
    if (d.keyBalance) {
      await assertClean(); balanceKey = d.keyBalance; $('balanceProvider').value = ''; $('balanceSearch').value = '';
      selected = null; renderEditor(); renderBalances(); $('balanceCards').scrollIntoView({ block: 'start' });
    }
    if (d.verifyNow !== undefined) {
      await assertClean();
      const model = $('verifyModel').value; if (!model) throw new Error("Add and select a model first");
      const key = p.keys.find(k => k.enabled !== false && (k.key || k.maskedKey));
      if (!key && p.type !== 'qclaw') throw new Error("Add a key to validate with first");
      button.disabled = true; status(`Validating ${model}…`);
      const result = await api.providerVerify({ providerId: p.id, keyId: key?.id, model });
      if (result.state) insight = result.state;
      updateKeyStats(); if (!result.ok) throw new Error(result.error);
      status(`Validation succeeded for ${model}. Select other models to validate them separately.`);
    }
    if (d.verify) {
      await assertClean(); const model = $('verifyModel').value; if (!model) throw new Error("Add and select a model first");
      button.disabled = true; status(`Validating ${model}…`);
      const result = await api.providerVerify({ providerId: p.id, keyId: d.verify, model });
      if (result.state) insight = result.state;
      updateKeyStats(); if (!result.ok) throw new Error(result.error);
      status(`Validation succeeded for ${model}. Select other models to validate them separately.`);
    }
    if (d.rotate || d.resetModel || d.resetKey) {
      await assertClean();
      const result = d.rotate ? await api.apiRouterRotate(d.rotate) : await api.apiRouterReset({ model: d.resetModel, keyId: d.resetKey });
      if (!result.ok) throw new Error(result.error);
      live = { ...live, ...result.state }; showLive(); updateKeyStats(); renderRoutes(); renderModelChips(); status(d.rotate ? "Switched to the next available route for the same model" : "Route checks reset. Usage history retained.");
    }
  } catch (e) { status(e.message, true); } finally { if (d.verify || d.verifyNow !== undefined) button.disabled = false; }
};
function openAccountSettings(engine) {
  if ($('addDialog').open) $('addDialog').close();
  setView('subscriptions', undefined, engine);
}
document.querySelectorAll('[data-account-engine]').forEach(button => {
  button.onclick = () => openAccountSettings(button.dataset.accountEngine);
});
function renderPresetAccount() {
  const provider = $('preset').value;
  const engine = ['kimi', 'kimi-code'].includes(provider) ? 'kimi' : provider === 'gemini' ? 'antigravity' : '';
  $('presetAccount').hidden = !engine;
  $('openPresetAccount').dataset.accountEngine = engine;
  $('openPresetAccount').textContent = engine === 'kimi' ? 'Open Kimi sign-in settings' : 'Open Google sign-in settings';
  $('presetAccountHint').textContent = engine === 'kimi'
    ? 'Have a Kimi subscription? Use browser sign-in in Kimi Code. This API provider requires a key.'
    : 'Google account sign-in is available in Antigravity. Choose it to see your eligible account models; this Gemini API connection requires an API key.';
}
$('openPresetAccount').onclick = () => openAccountSettings($('openPresetAccount').dataset.accountEngine);
$('preset').onchange = renderPresetAccount;
$('addProvider').onclick = () => { if (config) { renderPresetAccount(); $('addDialog').showModal(); } };
$('confirmAdd').onclick = () => {
  const p = structuredClone(presets.find(p => p.type === $('preset').value));
  p.id = uid(); p.enabled = true; p.keys = p.type === 'qclaw' ? [] : [{ id: uid(), name: '', key: '', enabled: true }];
  config.providers.push(p); selected = p.id; $('addDialog').close(); edited(true); renderEditor();
};
$('modelSearch').oninput = renderCatalog;
$('catalogList').onchange = e => { const id = e.target.dataset.catalog; if (id) e.target.checked ? catalogSelected.add(id) : catalogSelected.delete(id); };
$('applyModels').onclick = () => {
  const p = config.providers.find(p => p.id === catalogProvider);
  if (p) {
    const catalogIds = new Set(catalog.map(model => model.upstream));
    p.models = p.models.filter(model => !catalogIds.has(model.upstream) || catalogSelected.has(model.upstream));
    for (const model of catalog) if (catalogSelected.has(model.upstream) && !p.models.some(existing => existing.upstream === model.upstream)) p.models.push(structuredClone(model));
    edited(true);
    if (selected === p.id) { renderModels(); renderRoutes(); }
  }
  $('modelDialog').close();
};
$('enabled').onchange = e => { config.enabled = e.target.checked; edited(true); };
$('port').oninput = e => { config.port = Number(e.target.value); edited(); };
$('port').onchange = () => void flushSave();
$('port').onblur = () => void flushSave();
for (const id of ['usageSource','usageRange','usageProvider','usageKey','usageModel','usageMetric']) $(id).onchange = () => {
  fillUsageFilters();
  renderUsage();
};
$('subscriptionPricesRefresh').onclick = async () => {
  $('subscriptionPricesRefresh').disabled = true;
  try { live = await api.subscriptionPricesRefresh(); renderUsage(); }
  catch { $('subscriptionPriceStatus').textContent = window.CamelliaI18n.t('Prices could not be refreshed. The last available catalog is in use.'); }
  finally { $('subscriptionPricesRefresh').disabled = false; }
};
$('balanceCards').onclick = e => {
  const button = e.target.closest('[data-balance]');
  if (!button) return;
  balanceKey = button.dataset.balance;
  renderBalances();
};
$('balanceProvider').onchange = renderBalances;
$('balanceSearch').oninput = renderBalances;
$('refreshBalances').onclick = () => refreshBalances();
$('exportUsage').onclick = () => {
  const field = value => { let text = String(value ?? ''); if (/^[=+@\-\t\r]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
  const rows = [["Model", "Provider", 'Account / Key', "Successful requests / turns", "Input tokens", "Output tokens", "Cache-read tokens", "Failed", "Cancel", "Source", "Cache-write tokens", "Reasoning tokens (included in output)", "Standard API estimate (USD)", "Unpriced tokens", "Incomplete usage", "Account / Key ID"], ...usageData.map(r => [r.model, r.provider, r.key, r.requests, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.failures, r.cancelled, r.source, r.cacheWriteTokens, r.reasoningTokens, r.source === 'subscription' && r.pricedTokens > 0 ? r.estimatedCostUsd : '', r.unpricedTokens, r.unreported, r.keyId])];
  const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map(r => r.map(field).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `workbench-usage-${localDay(new Date())}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('openLogs').onclick = () => api.openLogs();

// Move the profile to another install, folder or computer. Both directions are
// explicit and the page reports real progress; importing overwrites matching
// files, so the main process asks for confirmation first.
let dataMigrationBusy = false, dataMigrationActive = false, dataMigrationPackage = null, dataDirectory = null;
const migrationBytes = bytes => bytes < 1024 ? bytes + ' B' : bytes < 1024 ** 2 ? (bytes / 1024).toFixed(1) + ' KiB' : bytes < 1024 ** 3 ? (bytes / 1024 ** 2).toFixed(1) + ' MiB' : (bytes / 1024 ** 3).toFixed(2) + ' GiB';
const migrationIdle = () => window.CamelliaI18n.t('Choose API configuration, application settings or conversation history to transfer. Subscription accounts are not transferred.');
function dataMigrationControls() {
  $('exportData').disabled = dataMigrationBusy;
  $('importData').disabled = dataMigrationBusy;
  $('importDataAgain').hidden = !dataMigrationPackage;
  $('importDataAgain').disabled = dataMigrationBusy;
  $('migrateDataDirectory').disabled = dataMigrationBusy || !dataDirectory?.canMigrate;
  $('maintainPluginCaches').disabled = dataMigrationBusy || !api.pluginCacheMaintain;
}
function renderDataDirectory(state) {
  dataDirectory = state;
  $('migrateDataDirectory').hidden = !state?.legacy;
  const message = state?.migrationError || state?.error || (state?.legacy ? 'Restart to move your data. The old folder is deleted after verification.' : '');
  $('dataDirectoryStatus').hidden = !message;
  $('dataDirectoryStatus').textContent = window.CamelliaI18n.t(message);
  $('dataDirectoryStatus').classList.toggle('error', Boolean(state?.error || state?.migrationError));
  dataMigrationControls();
}
$('migrateDataDirectory').onclick = async () => {
  if (dataMigrationBusy) return;
  dataMigrationBusy = true; dataMigrationControls();
  try {
    await assertClean();
    const result = await api.dataDirectoryMigrate();
    if (!result.ok) throw new Error(result.error);
    $('dataDirectoryStatus').classList.remove('error');
    $('dataDirectoryStatus').textContent = window.CamelliaI18n.t('Restarting to move your data…');
  } catch (error) {
    $('dataDirectoryStatus').textContent = window.CamelliaI18n.t(error.message);
    $('dataDirectoryStatus').classList.add('error');
    dataMigrationBusy = false; dataMigrationControls();
  }
};
$('exportData').onclick = async () => {
  if (dataMigrationBusy) return;
  dataMigrationBusy = true; dataMigrationActive = true; dataMigrationControls();
  $('dataMigrationProgress').hidden = false; $('dataMigrationProgress').value = 0;
  $('dataMigrationStatus').classList.remove('error');
  $('dataMigrationStatus').textContent = window.CamelliaI18n.t('Preparing the data package…');
  try {
    await assertClean();
    const scope = await chooseDataScope({ mode: 'export' });
    if (!scope) { $('dataMigrationStatus').textContent = migrationIdle(); return; }
    const result = await api.dataExport(scope);
    if (result.canceled) $('dataMigrationStatus').textContent = migrationIdle();
    else if (!result.ok) throw new Error(result.error);
    else {
      const parts = Array.isArray(result.parts) ? result.parts : [result.file];
      const baseName = String(parts[0] || '').split(/[\\/]/).pop();
      const where = parts.length > 1
        ? window.CamelliaI18n.t('{0} parts beside {1}').replace('{0}', () => fmt(parts.length)).replace('{1}', () => baseName)
        : result.file;
      $('dataMigrationStatus').textContent = window.CamelliaI18n.t('Exported {0} files ({1}) to {2}.')
        .replace('{0}', () => fmt(result.files)).replace('{1}', () => migrationBytes(result.bytes)).replace('{2}', () => where);
      if (result.locked > 0) {
        $('dataMigrationStatus').textContent += ' ' + window.CamelliaI18n.t('The package omits {0} unreadable files. Close running engines and export again to include them.')
          .replace('{0}', () => fmt(result.locked)) + (result.lockedFiles?.length ? '\n' + result.lockedFiles.join('\n') : '');
        $('dataMigrationStatus').classList.add('error');
      }
    }
  } catch (error) { $('dataMigrationStatus').textContent = window.CamelliaI18n.t(error.message); $('dataMigrationStatus').classList.add('error'); }
  finally { dataMigrationBusy = false; dataMigrationActive = false; dataMigrationControls(); $('dataMigrationProgress').hidden = true; }
};
const importData = async file => {
  if (dataMigrationBusy) return;
  dataMigrationBusy = true; dataMigrationControls();
  $('dataMigrationProgress').hidden = false; $('dataMigrationProgress').value = 0;
  $('dataMigrationStatus').classList.remove('error');
  $('dataMigrationStatus').textContent = window.CamelliaI18n.t('Reading the data package…');
  try {
    await assertClean();
    let selectedFile = file;
    // Preview reads only the package index; importing requires confirmation.
    let result = await api.dataImport(file);
    if (result.ok && result.needsSelection) {
      const scope = await chooseDataScope(result);
      if (!scope) { $('dataMigrationStatus').textContent = migrationIdle(); return; }
      $('dataMigrationStatus').textContent = window.CamelliaI18n.t('Reading the data package…');
      dataMigrationActive = true;
      selectedFile = result.file || file;
      result = await api.dataImport(selectedFile, scope);
    }
    if (result.canceled) $('dataMigrationStatus').textContent = migrationIdle();
    else if (!result.ok) throw new Error(result.error + (result.recoveryRequired && result.backupDir ? '\nBackup directory: ' + result.backupDir : ''));
    else {
      const scope = scopeLabel(result.scope);
      const note = window.CamelliaI18n.t('Imported {0} files ({1}) · {2}. Restart Camellia to use the restored data.')
        .replace('{0}', () => fmt(result.restored)).replace('{1}', () => migrationBytes(result.bytes)).replace('{2}', () => scope);
      const backup = result.backupDir ? ' ' + window.CamelliaI18n.t('Previous files were backed up; review them only if something looks wrong.') : '';
      $('dataMigrationStatus').textContent = note + backup + (result.warning ? '\n' + result.warning : '');
      dataMigrationPackage = selectedFile || true;
    }
  } catch (error) { $('dataMigrationStatus').textContent = error.message; $('dataMigrationStatus').classList.add('error'); }
  finally { dataMigrationBusy = false; dataMigrationActive = false; dataMigrationControls(); $('dataMigrationProgress').hidden = true; }
};
const scopeLabel = kinds => {
  const list = Array.isArray(kinds) ? kinds : [];
  if (list.length === 3) return window.CamelliaI18n.t('Everything');
  return list.map(kind => window.CamelliaI18n.t(kind === 'api' ? 'API configuration'
    : kind === 'conversations' ? 'Conversation history' : 'Application settings')).join(' + ');
};
// The scope dialog is opened by script so the checkboxes can reflect what the
// package actually contains; an empty category is disabled and unchecked.
function chooseDataScope({ mode = 'import', categories = {} }) {
  const exporting = mode === 'export';
  $('dataScopeTitle').textContent = exporting ? 'Export data' : 'Import data';
  $('confirmImportData').textContent = exporting ? 'Export selected data' : 'Import selected data';
  $('dataScopeNote').textContent = exporting ? 'Data packages can contain API keys. Keep them private.'
    : 'Selected files overwrite matching ones in this installation; current files are backed up first. Restart Camellia when the import finishes.';
  const rows = [['api', 'importScopeApi'], ['settings', 'importScopeSettings'], ['conversations', 'importScopeConversations']];
  for (const [kind, id] of rows) {
    const entry = categories[kind];
    const available = exporting || Number(entry?.files) > 0;
    $(id).disabled = !available;
    $(id).checked = available;
  }
  for (const [kind, id] of [['api', 'importScopeApiHint'], ['settings', 'importScopeSettingsHint'], ['conversations', 'importScopeConversationsHint']]) {
    const entry = categories[kind];
    $(id).hidden = exporting;
    $(id).textContent = Number(entry?.files) > 0 ? window.CamelliaI18n.t('{0} files · {1}').replace('{0}', () => fmt(entry.files)).replace('{1}', () => migrationBytes(entry.bytes))
      : window.CamelliaI18n.t('None in this package');
  }
  const available = rows.map(([, id]) => $(id)).filter(input => !input.disabled);
  const selectAll = $('dataScopeAll');
  const updateAll = () => {
    const count = available.filter(input => input.checked).length;
    selectAll.disabled = !available.length;
    selectAll.checked = count > 0 && count === available.length;
    selectAll.indeterminate = count > 0 && count < available.length;
  };
  selectAll.onchange = () => { for (const input of available) input.checked = selectAll.checked; updateAll(); };
  for (const input of available) input.onchange = updateAll;
  updateAll();
  $('importDataError').hidden = true;
  const dialog = $('importDataDialog');
  dialog.showModal();
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      dialog.close();
      $('confirmImportData').onclick = null;
      dialog.oncancel = null;
      dialog.onclose = null;
      selectAll.onchange = null;
      for (const [, id] of rows) $(id).onchange = null;
      resolve(value);
    };
    dialog.oncancel = () => finish(null);
    dialog.onclose = () => finish(null);
    $('confirmImportData').onclick = () => {
      const scope = rows.filter(([, id]) => $(id).checked && !$(id).disabled).map(([kind]) => kind);
      if (!scope.length) { $('importDataError').textContent = window.CamelliaI18n.t(exporting ? 'Choose at least one category to export' : 'Choose at least one category to import'); $('importDataError').hidden = false; return; }
      finish(scope);
    };
  });
}
// Reuse the exact file when the main process already knows it, otherwise ask.
$('importData').onclick = () => importData(null);
$('importDataAgain').onclick = () => importData(typeof dataMigrationPackage === 'string' ? dataMigrationPackage : null);
api.onDataMigrationProgress(state => {
  // Ignore any progress event that arrives after the call already finished, so
  // a late percentage cannot overwrite the final result text.
  if (!state || !dataMigrationActive) return;
  const bar = $('dataMigrationProgress');
  if (typeof state.bytes === 'number' && typeof state.totalBytes === 'number' && state.totalBytes > 0) {
    bar.value = Math.min(100, Math.round(state.bytes / state.totalBytes * 100));
    $('dataMigrationStatus').textContent = (state.phase === 'snapshot' ? window.CamelliaI18n.t('Preparing the data package…') : state.phase === 'import'
      ? window.CamelliaI18n.t('Importing data…') : window.CamelliaI18n.t('Exporting data…')) + ' ' + bar.value + '%';
  } else if (state.files && state.totalFiles) {
    bar.value = Math.min(100, Math.round(state.files / state.totalFiles * 100));
  }
});

// Application updates: checking is read-only; installing replaces this
// installation in place and restarts, so both steps stay explicit.
let appUpdate = null, appUpdateBusy = false;
function appUpdateControls() {
  $('checkAppUpdate').disabled = appUpdateBusy;
  const installable = Boolean(appUpdate?.updateAvailable && appUpdate.supported && appUpdate.name);
  $('installAppUpdate').hidden = !installable;
  $('installAppUpdate').disabled = appUpdateBusy;
}
function renderAppUpdate() {
  const meta = $('appUpdateMeta'), details = $('appUpdateDetails');
  if (!appUpdate) { details.hidden = true; return; }
  const parts = [appUpdate.updateAvailable ? `v${appUpdate.latest} · ${appUpdate.name || ''}` : `v${appUpdate.current}`,
    appUpdate.size ? `${(appUpdate.size / 1024 ** 2).toFixed(1)} MiB` : '', appUpdate.publishedAt ? new Date(appUpdate.publishedAt).toLocaleDateString(window.CamelliaI18n.locale) : ''].filter(Boolean);
  meta.textContent = parts.join(' · ');
  $('appUpdateNotes').textContent = appUpdate.notes || '';
  details.hidden = !appUpdate.updateAvailable || !(appUpdate.notes || appUpdate.name);
}
$('checkAppUpdate').onclick = async () => {
  if (appUpdateBusy) return;
  appUpdateBusy = true; appUpdateControls();
  $('appUpdateStatus').textContent = window.CamelliaI18n.t('Checking for updates…');
  $('appUpdateProgress').hidden = true;
  try {
    const result = await api.appUpdateCheck();
    if (!result.ok) throw new Error(result.error);
    appUpdate = result;
    $('appUpdateStatus').classList.remove('error');
    $('appUpdateStatus').textContent = !result.updateAvailable ? window.CamelliaI18n.t('Camellia is up to date.')
      : result.supported ? window.CamelliaI18n.t('v{0} is available.').replace('{0}', () => result.latest)
      : window.CamelliaI18n.t('v{0} is available, but this platform has no in-place package.').replace('{0}', () => result.latest);
  } catch (error) { appUpdate = null; $('appUpdateStatus').textContent = error.message; $('appUpdateStatus').classList.add('error'); }
  finally { appUpdateBusy = false; appUpdateControls(); renderAppUpdate(); }
};
$('installAppUpdate').onclick = async () => {
  if (appUpdateBusy) return;
  appUpdateBusy = true; appUpdateControls();
  $('appUpdateProgress').hidden = false; $('appUpdateProgress').value = 0;
  $('appUpdateStatus').textContent = window.CamelliaI18n.t('Downloading the update…');
  try {
    const result = await api.appUpdateInstall();
    if (!result.ok) throw new Error(result.error);
    if (result.kind === 'disk-image') $('appUpdateStatus').textContent = window.CamelliaI18n.t('The installer was downloaded. Open it to finish updating.');
  } catch (error) { $('appUpdateStatus').textContent = error.message; }
  finally { appUpdateBusy = false; appUpdateControls(); }
};
api.onAppUpdateState(state => {
  $('appUpdateProgress').hidden = state.status === 'error';
  if (typeof state.percent === 'number') $('appUpdateProgress').value = state.percent;
  $('appUpdateStatus').textContent = state.status === 'downloading'
    ? window.CamelliaI18n.t('Downloading the update…') + (typeof state.percent === 'number' ? ` ${state.percent}%` : '')
    : state.status === 'applying' ? window.CamelliaI18n.t('Installing the update…')
    : state.status === 'restarting' ? window.CamelliaI18n.t('Restarting Camellia…')
    : state.status === 'error' ? state.error : $('appUpdateStatus').textContent;
});
// Quick-switch targets are app preferences, independent of CLI defaults. Each
// engine gets a model and a reasoning level; both are applied together when the
// composer's model menu is double-clicked.
const QUICK_SWITCH_ENGINES = [['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['dsh', 'DSH'], ['kimi', 'Kimi Code'], ['antigravity', 'Antigravity'], ['pi', 'Pi']];
const SUBSCRIPTION_MODEL_ENGINES = [['codex', 'ChatGPT'], ['kimi', 'Kimi'], ['antigravity', 'Google']];
let modelPreferences = null, subscriptionModelAccounts = {}, visibilitySaving = false, modelSettingsSeq = 0, quickSwitchRenderSeq = 0;

async function accountModelState(engine) {
  try {
    const active = await api[engine + 'AccountState']();
    if (!active?.ok) throw new Error(active?.error || 'Could not load account models');
    const accounts = await Promise.all((active.accounts || []).filter(account => account.signedIn && account.id !== active.activeId)
      .map(account => api[engine + 'AccountState']({ id: account.id }).catch(() => null)));
    const models = new Map();
    for (const state of [active, ...accounts]) {
      for (const model of state?.models || []) {
        if (typeof model.id === 'string' && model.id && !models.has(model.id)) models.set(model.id, model);
      }
    }
    return { active, models: [...models.values()] };
  } catch (error) { return { active: null, models: [], error: error.message }; }
}

function renderSubscriptionModels() {
  const container = $('subscriptionModels'), t = window.CamelliaI18n.t;
  container.replaceChildren();
  for (const [engine, title] of SUBSCRIPTION_MODEL_ENGINES) {
    const group = document.createElement('section'); group.className = 'subscription-model-group';
    const heading = document.createElement('h3'); heading.textContent = title;
    group.append(heading);
    const account = subscriptionModelAccounts[engine] || { models: [] };
    const models = account.models;
    if (!models.length) {
      const hint = document.createElement('p'); hint.className = 'hint';
      hint.textContent = account.error || t('Sign in or refresh this subscription to load models.');
      group.append(hint);
    } else {
      const shown = models.filter(model => window.CamelliaSubscriptionModels.isVisible(modelPreferences?.hiddenSubscriptionModels, engine, model.id)).length;
      const count = document.createElement('p'); count.className = 'hint'; count.textContent = t(`${shown} of ${models.length} shown`);
      group.append(count);
      for (const model of models) {
        const row = document.createElement('label'); row.className = 'subscription-model-row';
        const name = document.createElement('span'); name.textContent = model.name || model.displayName || model.id;
        name.title = model.id;
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        checkbox.checked = window.CamelliaSubscriptionModels.isVisible(modelPreferences?.hiddenSubscriptionModels, engine, model.id);
        checkbox.disabled = visibilitySaving;
        checkbox.addEventListener('change', () => void saveSubscriptionModelVisibility(engine, model.id, checkbox.checked));
        row.append(name, checkbox); group.append(row);
      }
    }
    container.append(group);
  }
}

async function saveSubscriptionModelVisibility(engine, modelId, visible) {
  if (visibilitySaving || !modelPreferences) return;
  visibilitySaving = true; renderSubscriptionModels();
  const previous = modelPreferences.hiddenSubscriptionModels?.[engine] || [];
  const next = new Set(previous);
  if (visible) next.delete(modelId); else next.add(modelId);
  try {
    const result = await api.workbenchSaveSettings({ hiddenSubscriptionModels: { [engine]: [...next] } });
    if (!result.ok) throw new Error(result.error);
    modelPreferences.hiddenSubscriptionModels = { ...modelPreferences.hiddenSubscriptionModels, [engine]: [...next] };
    status('Preferences saved');
    void renderQuickSwitchModels(modelPreferences, subscriptionModelAccounts);
  } catch (error) { status(error.message || 'Could not save model visibility', true); }
  finally { visibilitySaving = false; renderSubscriptionModels(); }
}

function renderRoutingSettings() {
  for (const field of ['multiKeyConcurrency', 'multiKeyFailover']) {
    $(field).checked = config?.routing?.[field] !== false;
    $(field).disabled = !config;
  }
}
for (const field of ['multiKeyConcurrency', 'multiKeyFailover']) {
  $(field).addEventListener('change', () => {
    config.routing ||= {};
    config.routing[field] = $(field).checked;
    edited();
    void flushSave();
  });
}
async function renderModelSettings(preferences) {
  renderRoutingSettings();
  const seq = ++modelSettingsSeq;
  const [loaded, ...accounts] = await Promise.all([
    preferences || api.workbenchSettings(),
    ...SUBSCRIPTION_MODEL_ENGINES.map(([engine]) => accountModelState(engine)),
  ]);
  if (seq !== modelSettingsSeq) return;
  if (!loaded?.ok) { status(loaded?.error || 'Could not load model settings', true); return; }
  modelPreferences = { ...loaded, hiddenSubscriptionModels: loaded.hiddenSubscriptionModels || {} };
  subscriptionModelAccounts = Object.fromEntries(SUBSCRIPTION_MODEL_ENGINES.map(([engine], index) => [engine, accounts[index]]));
  renderSubscriptionModels();
  await renderQuickSwitchModels(modelPreferences, subscriptionModelAccounts);
}
window.addEventListener('camellia:language', () => {
  if (!modelPreferences) return;
  renderSubscriptionModels();
  void renderQuickSwitchModels(modelPreferences, subscriptionModelAccounts);
});
function quickSwitchLadder(engine, modelId, account, router) {
  const effort = (account?.models || []).find(model => model.id === modelId)?.supportedReasoningEfforts;
  return Array.isArray(effort) ? effort.map(level => level.reasoningEffort || level).filter(level => typeof level === 'string')
    : window.CamelliaModelLevels.levelsFor(modelId, router);
}
function fillQuickSwitchLevels(select, engine, modelId, saved, account, router) {
  select.replaceChildren();
  const unset = new Option('Not configured', ''); unset.dataset.i18n = '';
  select.add(unset);
  const levels = quickSwitchLadder(engine, modelId, account, router);
  for (const id of levels) {
    const option = new Option(window.CamelliaModelLevels.labelFor(id, modelId, account?.models?.some(model => model.id === modelId) ? undefined : router), id);
    option.dataset.i18n = '';
    select.add(option);
  }
  select.value = levels.includes(saved) ? saved : '';
}
async function saveQuickSwitch(patch, select, errorFallback) {
  select.disabled = true;
  try {
    const result = await api.workbenchSaveSettings(patch);
    if (!result.ok) throw new Error(result.error);
    for (const key of ['quickSwitchModels', 'quickSwitchLevels']) {
      if (patch[key]) modelPreferences[key] = { ...modelPreferences[key], ...patch[key] };
    }
    status('Preferences saved');
    return true;
  } catch (error) { select.value = select.dataset.saved; status(error.message || errorFallback, true); return false; }
  finally { select.disabled = false; }
}
async function renderQuickSwitchModels(preferences, accountStates = {}) {
  const seq = ++quickSwitchRenderSeq;
  const container = $('quickSwitchModels');
  const router = await api.apiRouterGetState();
  if (seq !== quickSwitchRenderSeq) return;
  const table = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'quick-switch-row quick-switch-head';
  for (const title of ['Engine', 'Model', 'Reasoning level']) {
    const cell = document.createElement('span'); cell.className = 'hint'; cell.dataset.i18n = ''; cell.textContent = title;
    head.append(cell);
  }
  table.append(head);
  for (const [engine, label] of QUICK_SWITCH_ENGINES) {
    const row = document.createElement('div'); row.className = 'quick-switch-row';
    const name = document.createElement('label'); name.textContent = label; name.htmlFor = 'quickSwitch-' + engine;
    const modelSelect = document.createElement('select'); modelSelect.id = name.htmlFor; modelSelect.className = 'quick-switch-model'; modelSelect.disabled = true;
    const levelSelect = document.createElement('select'); levelSelect.id = 'quickSwitchLevel-' + engine;
    levelSelect.className = 'quick-switch-level'; levelSelect.disabled = true;
    levelSelect.setAttribute('aria-label', label + ' reasoning level');
    row.append(name, modelSelect, levelSelect); table.append(row);
    const account = accountStates[engine]?.active || null;
    const models = new Map((router.enabled ? router.models || [] : []).map(id => [id, id]));
    for (const model of account?.models || []) {
      if (window.CamelliaSubscriptionModels.isVisible(preferences.hiddenSubscriptionModels, engine, model.id)) {
        models.set(model.id, model.name || model.displayName || model.id);
      }
    }
    const savedModel = preferences.quickSwitchModels?.[engine] || '';
    let hiddenSavedModel = false;
    if (savedModel && !models.has(savedModel)) {
      hiddenSavedModel = !window.CamelliaSubscriptionModels.isVisible(preferences.hiddenSubscriptionModels, engine, savedModel);
      models.set(savedModel, savedModel + (hiddenSavedModel ? ' (' + window.CamelliaI18n.t('Hidden') + ')' : ''));
    }
    const unset = new Option('Not configured', ''); unset.dataset.i18n = '';
    modelSelect.add(unset);
    for (const [id, title] of models) {
      const option = new Option(title, id);
      option.disabled = hiddenSavedModel && id === savedModel;
      modelSelect.add(option);
    }
    const savedLevel = preferences.quickSwitchLevels?.[engine] || '';
    modelSelect.value = savedModel; modelSelect.dataset.saved = savedModel;
    modelSelect.disabled = false;
    fillQuickSwitchLevels(levelSelect, engine, savedModel, savedLevel, account, router);
    levelSelect.dataset.saved = savedLevel;
    levelSelect.disabled = false;
    modelSelect.addEventListener('change', async () => {
      // Clearing the model clears its level in the same save: a reasoning level
      // without a model has nothing to apply to.
      const clearing = !modelSelect.value;
      const patch = { quickSwitchModels: { [engine]: modelSelect.value } };
      if (clearing && levelSelect.dataset.saved) patch.quickSwitchLevels = { [engine]: '' };
      if (!await saveQuickSwitch(patch, modelSelect, 'Could not save the model')) return;
      modelSelect.dataset.saved = modelSelect.value;
      if (clearing) levelSelect.dataset.saved = '';
      // Otherwise the ladder follows the newly chosen model.
      fillQuickSwitchLevels(levelSelect, engine, modelSelect.value, levelSelect.dataset.saved, account, router);
      levelSelect.dataset.saved = levelSelect.value;
    });
    levelSelect.addEventListener('change', async () => {
      if (!await saveQuickSwitch({ quickSwitchLevels: { [engine]: levelSelect.value } }, levelSelect, 'Could not save the reasoning level')) return;
      levelSelect.dataset.saved = levelSelect.value;
    });
  }
  container.replaceChildren(table);
}

// General and model-session preferences apply on change.
let memorySaveQueue = Promise.resolve();
function saveMemoryDirectory() {
  const memoryDirectory = $('memoryDirectory').value;
  memorySaveQueue = memorySaveQueue.then(async () => {
    try {
      const result = await api.workbenchSaveSettings({ memoryDirectory });
      if (!result.ok) throw new Error(result.error);
      status('Memory folder saved. Applies from the next message.');
    } catch (error) { status(error.message, true); }
  });
  return memorySaveQueue;
}
$('memoryDirectory').addEventListener('change', saveMemoryDirectory);
$('chooseMemoryDirectory').onclick = async () => {
  try {
    const result = await api.pickFile({ kind: 'directory', title: 'Choose a memory folder' });
    if (result.canceled || !result.path) return;
    $('memoryDirectory').value = result.path;
    await saveMemoryDirectory();
  } catch (error) { status(error.message, true); }
};
async function saveGeneral() {
  try {
    const result = await api.workbenchSaveSettings({ language: $('language').value, theme: $('theme').value, autoRefreshBalances: $('autoRefreshBalances').checked, closeToTray: $('closeToTray').checked,
      chatContentWidth: $('chatContentWidth').value,
      subscriptionAutoRefresh: { antigravity: $('antigravityAutoRefresh').checked },
      accountRefreshMinutes: Number($('accountRefreshMinutes').value),
      conversations: { mode: $('conversationMode').value, warnOnSwitch: $('conversationWarn').checked, showOrigin: $('conversationOriginSetting').checked,
        sessionTtlMinutes: Number($('conversationSessionTtl').value), sessionLimit: Number($('conversationSessionLimit').value) } });
    if (!result.ok) throw new Error(result.error);
    window.CamelliaI18n.setLanguage($('language').value); status("Preferences saved");
  } catch (e) { status(e.message, true); }
}
for (const id of ['language', 'theme', 'chatContentWidth', 'autoRefreshBalances', 'antigravityAutoRefresh', 'accountRefreshMinutes', 'closeToTray', 'conversationMode', 'conversationWarn', 'conversationOriginSetting', 'conversationSessionTtl', 'conversationSessionLimit']) {
  $(id).addEventListener('change', saveGeneral);
}
// General connection preference: serialized saves preserve the latest choice.
let networkSaveQueue = Promise.resolve(), networkSaving = false;
function renderNetworkModeHint(value = lastNetworkValue) {
  const t = window.CamelliaI18n.t;
  const mode = value?.configured || $('networkMode').value || 'direct';
  const text = {
    auto: 'Auto tests the connections and keeps direct-first only when direct works everywhere; otherwise it stays on the system proxy. Requests already sent are not replayed.',
    direct: 'Every request goes straight out without a proxy, including subscriptions and downloads.',
    system: 'Every request goes through the detected system proxy. If that proxy stops working, Camellia switches to Auto so work continues.',
  }[mode] || '';
  $('networkModeHint').textContent = t(text);
}
function renderNetworkSettings(value) {
  const t = window.CamelliaI18n.t;
  $('networkMode').value = value.configured || (['auto', 'direct', 'system'].includes(value.mode) ? value.mode : 'direct');
  // A downgraded proxy is why the connection is direct-first even though the
  // saved choice was "Use system proxy"; say so instead of only listing it.
  const status = value.degraded
    ? t('The detected system proxy is not reachable, so connections are using Auto. Repair the proxy, then choose Use system proxy again.')
    : value.autoFallback
      ? t('Auto kept the system proxy because a direct connection did not work everywhere.')
      : value.detectedUrl ? t('Detected system proxy') + ': ' + value.detectedUrl
      : value.error ? t(value.error)
      : t(value.unsupported ? 'The detected proxy protocol is not supported. Enable an HTTP or mixed proxy port.' : 'No system proxy detected. Enable the system proxy and detect again.');
  $('systemProxyStatus').textContent = status + (value.degraded || value.autoFallback ? (value.detectedUrl ? ' · ' + value.detectedUrl : '') : '');
  $('systemProxyStatus').classList.toggle('bad', Boolean(value.degraded || value.error));
  renderNetworkModeHint(value);
}
function renderConnectivity(result) {
  const t = window.CamelliaI18n.t;
  const container = $('networkResults');
  if (!result) { container.innerHTML = ''; return; }
  if (result.ok === false) { container.innerHTML = `<p class="connectivity-summary bad">${esc(t(result.error || 'The connectivity test failed.'))}</p>`; return; }
  const { summary = {}, results = [] } = result;
  // A tick or cross is unambiguous in every language; the words only repeated
  // "Direct"/"Proxy" under a header that already said which column it was.
  const check = ok => `<span class="route-mark ${ok ? 'good' : 'bad'}" aria-hidden="true">${ok ? '✓' : '✕'}</span>`;
  const summaryText = summary.total === 0
    ? t('No provider routes or signed-in subscriptions to test yet.')
    : `${summary.direct} / ${summary.total} ${t('reachable directly')} · ${summary.proxy} / ${summary.total} ${t('reachable through the proxy')}` +
      (summary.unreachable?.length ? ` · ${t('No route to')}: ${summary.unreachable.join(', ')}` : '');
  const rows = results.map(row => {
    const label = row.label || row.host;
    const models = (row.models || []).slice(0, 4).map(model => `<span class="model-chip">${esc(model)}</span>`).join('');
    return `<div class="connectivity-row">
      <div class="connectivity-target"><strong>${esc(label)}</strong><small>${esc(row.host)}:${esc(String(row.port))}</small>${row.kind === 'subscription' ? `<small>${esc(t('Subscription sign-in'))}</small>` : ''}</div>
      <div class="connectivity-route"><small class="route-label">${esc(t('Direct'))}</small>${check(row.direct)}</div>
      <div class="connectivity-route"><small class="route-label">${esc(t('Proxy'))}</small>${check(row.proxy)}</div>
      <div class="connectivity-models">${models}</div>
    </div>`;
  }).join('');
  container.innerHTML = `<p class="connectivity-summary${summary.unreachable?.length ? ' bad' : ''}">${esc(summaryText)}</p>` +
    (rows ? `<div class="connectivity-head"><span>${esc(t('Target'))}</span><span>${esc(t('Direct'))}</span><span>${esc(t('Proxy'))}</span><span>${esc(t('Models'))}</span></div>${rows}` : '');
}
let lastNetworkValue = null;
async function loadDownloadSettings(focus) {
  if (networkSaving) return;
  try {
    const value = await api.networkSettings();
    if (!value.ok) throw new Error(value.error);
    lastNetworkValue = value;
    if (networkSaving) return;
    renderNetworkSettings(value);
    if (focus === 'networkTest') void $('networkTest').click();
    window.CamelliaNetworkNotice?.sync({ degraded: value.degraded, proxy: value.detectedUrl });
  } catch (error) { status(error.message, true); }
}
let networkTesting = false;
$('networkTest').onclick = async () => {
  if (networkTesting) return;
  const t = window.CamelliaI18n.t;
  networkTesting = true;
  $('networkTest').disabled = true;
  $('networkResults').innerHTML = `<p class="connectivity-summary">${esc(t('Testing connections…'))}</p>`;
  try {
    const result = await api.networkTest();
    if (!result.ok) throw new Error(result.error);
    renderConnectivity(result);
  } catch (error) {
    $('networkResults').innerHTML = `<p class="connectivity-summary bad">${esc(error.message)}</p>`;
  } finally { networkTesting = false; $('networkTest').disabled = false; }
};
$('networkMode').onchange = () => {
  const t = window.CamelliaI18n.t;
  const mode = $('networkMode').value;
  networkSaving = true;
  $('networkMode').disabled = true;
  renderNetworkModeHint({ configured: mode });
  networkSaveQueue = networkSaveQueue.then(async () => {
    try {
      const value = await api.networkSaveSettings({ mode });
      if (!value.ok) throw new Error(value.error);
      renderNetworkSettings(value);
      // Say whether the change is already live, or waiting for a running
      // response to finish, rather than leaving the user to restart Camellia.
      status(value.engineRestart ? t('Network connection saved and applied to running engines')
        : t('Network connection saved; it applies once the current response finishes'));
    } catch (error) { status(t(error.message), true); }
    finally { networkSaving = false; $('networkMode').disabled = false; await loadDownloadSettings(); }
  });
};
$('detectSystemProxy').onclick = async () => {
  $('detectSystemProxy').disabled = true;
  try {
    await loadDownloadSettings();
    if ($('networkMode').value !== 'direct') {
      $('networkMode').onchange();
      await networkSaveQueue;
    }
  } finally { $('detectSystemProxy').disabled = false; }
};
async function refresh(initial = false) {
  try {
    const [state, details] = await Promise.all([api.apiRouterGetState(), api.providerInsights()]);
    if (!state.ok) throw new Error(state.error);
    live = state; presets = state.presets || presets;
    if (details.ok) insight = details;
    if (initial || !isDirty()) {
      config = structuredClone(live); $('enabled').checked = config.enabled; $('port').value = config.port;
      renderRoutingSettings();
      rememberSavedModels();
      const selectedPreset = $('preset').value;
      $('preset').innerHTML = presets.map(p => `<option value="${p.type}">${esc(p.name)}</option>`).join('');
      if (presets.some(p => p.type === selectedPreset)) $('preset').value = selectedPreset;
      renderPresetAccount();
      renderEditor();
    }
    showLive(); renderBalances(); if (view === 'usage') { fillUsageFilters(); renderUsage(); } if (view === 'archived') void renderArchived();
    if (!isDirty()) status(details.ok ? '' : details.error, !details.ok);
    if (initial) {
      const preferences = await api.workbenchSettings();
      if (!preferences.ok) throw new Error(preferences.error);
      $('language').value = preferences.language || 'en';
      $('theme').value = preferences.theme; $('autoRefreshBalances').checked = preferences.autoRefreshBalances; $('closeToTray').checked = !!preferences.closeToTray;
      $('antigravityAutoRefresh').checked = preferences.subscriptionAutoRefresh?.antigravity !== false;
      $('chatContentWidth').value = preferences.chatContentWidth || 'standard';
      $('memoryDirectory').value = preferences.memoryDirectory || '';
      $('accountRefreshMinutes').value = String(preferences.accountRefreshMinutes || 15);
      $('conversationMode').value = preferences.conversations?.mode || 'direct'; $('conversationWarn').checked = !!preferences.conversations?.warnOnSwitch;
      $('conversationOriginSetting').checked = !!preferences.conversations?.showOrigin;
      $('conversationSessionTtl').value = String(preferences.conversations?.sessionTtlMinutes ?? 30);
      $('conversationSessionLimit').value = String(preferences.conversations?.sessionLimit ?? 4);
      $('dataPath').textContent = preferences.dataPath; $('version').textContent = 'v' + preferences.version;
      renderDataDirectory(preferences.dataDirectory);
      renderPluginCacheMaintenance(preferences.pluginCacheMaintenance);
      await renderModelSettings(preferences);
    }
  } catch (e) { status(e.message, true); }
}
let storagePreview = null, storageBusy = false;
let pluginCacheState = null;
function renderPluginCacheMaintenance(state) {
  pluginCacheState = state;
  const result = state?.result;
  const t = window.CamelliaI18n.t;
  $('pluginCacheStatus').classList.toggle('error', Boolean(result?.error));
  $('pluginCacheStatus').textContent = result?.error ? t(result.error) : result
    ? t('Shared {0} duplicate caches; freed {1}. Skipped {2} items.').replace('{0}', () => fmt(result.duplicates || 0)).replace('{1}', () => migrationBytes(result.bytes || 0)).replace('{2}', () => fmt(result.skipped?.length || 0))
    : t('Restart to share identical cached plugins and free space. Conversation history and account data are kept.');
}
$('maintainPluginCaches').onclick = async () => {
  if (dataMigrationBusy || storageBusy) return;
  dataMigrationBusy = true; dataMigrationControls(); storageControls();
  try {
    await assertClean();
    const result = await api.pluginCacheMaintain();
    if (!result.ok) throw new Error(result.error);
    $('pluginCacheStatus').classList.remove('error');
    $('pluginCacheStatus').textContent = window.CamelliaI18n.t('Restarting to deduplicate Codex plugin caches…');
  } catch (error) {
    $('pluginCacheStatus').textContent = window.CamelliaI18n.t(error.message);
    $('pluginCacheStatus').classList.add('error');
    dataMigrationBusy = false; dataMigrationControls(); storageControls();
  }
};
const storageBytes = bytes => bytes < 1024 ? fmt(bytes) + ' B' : bytes < 1024 ** 2 ? fmt(bytes / 1024) + ' KiB' : bytes < 1024 ** 3 ? fmt(bytes / 1024 ** 2) + ' MiB' : fmt(bytes / 1024 ** 3) + ' GiB';
function storageControls() {
  $('scanStorage').disabled = storageBusy || dataMigrationBusy;
  $('cleanStorage').disabled = storageBusy || dataMigrationBusy || !storagePreview?.candidates.length;
  $('maintainPluginCaches').disabled = storageBusy || dataMigrationBusy || !api.pluginCacheMaintain;
}
function storageEstimate(preview) {
  const count = preview.candidates.reduce((total, entry) => total + entry.count, 0);
  const bytes = preview.candidates.reduce((total, entry) => total + entry.bytes, 0);
  return window.CamelliaI18n.t('{0} files · {1} eligible for cleanup').replace('{0}', () => fmt(count)).replace('{1}', () => storageBytes(bytes));
}
$('scanStorage').onclick = async () => {
  if (storageBusy) return;
  storageBusy = true; storagePreview = null; storageControls();
  $('storageStatus').textContent = window.CamelliaI18n.t('Checking file ownership…');
  $('storageSummary').replaceChildren(); $('storageFiles').replaceChildren(); $('storageDetails').hidden = true;
  try {
    const result = await api.storageScan();
    if (!result.ok) throw new Error(result.error);
    storagePreview = result;
    $('storageStatus').textContent = result.candidates.length ? storageEstimate(result) : window.CamelliaI18n.t('No safely removable files found.');
    const groups = new Map();
    for (const entry of result.candidates) {
      const group = groups.get(entry.category) || { count: 0, bytes: 0 };
      group.count += entry.count; group.bytes += entry.bytes; groups.set(entry.category, group);
    }
    $('storageSummary').innerHTML = [...groups].map(([category, group]) => `<div class="setting-row"><h2 data-i18n>${esc(category)}</h2><span>${esc(fmt(group.count))} · ${esc(storageBytes(group.bytes))}</span></div>`).join('');
    if (result.backups) {
      const summary = window.CamelliaI18n.t('{0} backups · {1} stored · {2} reclaimable')
        .replace('{0}', () => fmt(result.backups.count)).replace('{1}', () => storageBytes(result.backups.bytes))
        .replace('{2}', () => storageBytes(result.backups.reclaimableBytes));
      $('storageSummary').insertAdjacentHTML('afterbegin', `<div class="setting-row"><h2 data-i18n>Import backups</h2><span>${esc(summary)}</span></div>`);
    }
    if (result.active) {
      const notice = document.createElement('p');
      notice.textContent = window.CamelliaI18n.t('Conversations are running. Attachments, import backups and handoffs/summaries are protected; scan again when idle to include them.');
      $('storageSummary').append(notice);
    }
    if (result.skipped) {
      const notice = document.createElement('p');
      notice.textContent = window.CamelliaI18n.t('{0} protected or unverifiable items skipped.').replace('{0}', () => fmt(result.skipped));
      $('storageSummary').append(notice);
    }
    $('storageDetails').hidden = !result.candidates.length;
    let shown = 0;
    const showMore = () => {
      $('storageFiles').querySelector('button')?.remove();
      const batch = result.candidates.slice(shown, shown + 200);
      shown += batch.length;
      $('storageFiles').insertAdjacentHTML('beforeend', batch.map(entry => `<div class="setting-row storage-file"><code>${esc(entry.path)}</code><span>${esc(storageBytes(entry.bytes))}</span></div>`).join(''));
      if (shown < result.candidates.length) {
        const button = document.createElement('button');
        button.textContent = 'Show more paths'; button.setAttribute('data-i18n', '');
        button.onclick = showMore; $('storageFiles').append(button);
      }
    };
    showMore();
  } catch (error) { $('storageStatus').textContent = error.message; }
  finally { storageBusy = false; storageControls(); }
};
$('cleanStorage').onclick = () => {
  if (storageBusy || !storagePreview?.candidates.length) return;
  $('cleanStorageEstimate').textContent = storageEstimate(storagePreview);
  $('cleanStorageDialog').showModal();
};
$('confirmCleanStorage').onclick = async () => {
  $('cleanStorageDialog').close();
  if (storageBusy || !storagePreview) return;
  const token = storagePreview.token;
  storagePreview = null; storageBusy = true; storageControls();
  $('storageStatus').textContent = window.CamelliaI18n.t('Rechecking references and cleaning…');
  try {
    const result = await api.storageClean(token);
    if (!result.ok) throw new Error(result.error);
    $('storageStatus').textContent = window.CamelliaI18n.t('Removed {0} files ({1}). Skipped {2} candidates; {3} errors. Scan again to review remaining files.')
      .replace('{0}', () => fmt(result.files)).replace('{1}', () => storageBytes(result.bytes)).replace('{2}', () => fmt(result.skipped)).replace('{3}', () => fmt(result.errors.length));
    $('storageSummary').textContent = result.errors.map(entry => entry.path + ': ' + entry.error).join('\n');
    await renderArchived();
  } catch (error) { $('storageStatus').textContent = error.message; $('storageSummary').replaceChildren(); }
  finally { $('storageDetails').hidden = true; $('storageFiles').replaceChildren(); storageBusy = false; storageControls(); }
};
// ---------- Archived conversations ----------
const engineNames = { claude: 'Claude Code', codex: 'Codex CLI', dsh: 'DeepSeek Harness', kimi: 'Kimi Code', antigravity: 'Antigravity', pi: 'Pi' };
let archivedPendingDelete = null, archivedCount = 0, archivedDeleting = false, archivedRenderSeq = 0;
function archivedDeleteProgress({ processed, total }) {
  const t = window.CamelliaI18n.t;
  $('archivedDeleteStatus').textContent = t('Deleting archived conversations: {0} of {1}')
    .replace('{0}', () => fmt(processed)).replace('{1}', () => fmt(total));
  $('archivedDeleteProgress').max = Math.max(total, 1);
  $('archivedDeleteProgress').value = processed;
}
api.onArchivedDeleteProgress(archivedDeleteProgress);
function setArchivedDeleting(busy) {
  archivedDeleting = busy;
  $('archivedDeleteActivity').hidden = !busy;
  $('deleteAllArchived').disabled = busy || !archivedCount;
  $('archivedList').setAttribute('aria-busy', String(busy));
  $('archivedList').querySelectorAll('button').forEach(button => { button.disabled = busy; });
}
async function renderArchived() {
  if (archivedDeleting) return;
  const sequence = ++archivedRenderSeq;
  try {
    const result = await api.archivedSessionsList();
    if (!result.ok) throw new Error(result.error);
    if (sequence !== archivedRenderSeq || archivedDeleting) return;
    archivedCount = result.sessions.length;
    $('deleteAllArchived').disabled = !archivedCount;
    const t = window.CamelliaI18n.t;
    $('archivedList').innerHTML = result.sessions.map(s => `<div class="setting-row archived-row">
      <div><h2>${esc(s.title)}</h2><p class="hint">${esc(engineNames[s.origin || s.source] || s.source)} · ${esc(t("Archived"))} ${when(s.archivedAt)}${s.missing ? ' · ' + esc(t("Files missing")) : ''}</p></div>
      <div class="archived-actions"><button data-restore="${esc(s.source)}:${esc(s.id)}" data-i18n>Restore</button><button class="danger" data-delete="${esc(s.source)}:${esc(s.id)}" data-i18n>Delete</button></div>
    </div>`).join('') || `<div class="empty"><h2 data-i18n>No archived conversations</h2><p class="hint" data-i18n>Archive a conversation from its ⋯ menu in the sidebar and it will appear here.</p></div>`;
  } catch (e) { if (sequence === archivedRenderSeq && !archivedDeleting) status(e.message, true); }
}
$('archivedList').onclick = async e => {
  if (archivedDeleting) return;
  const button = e.target.closest('button'); if (!button) return;
  const key = button.dataset.restore ?? button.dataset.delete;
  if (key === undefined) return;
  const sep = key.indexOf(':');
  const target = { source: key.slice(0, sep), id: key.slice(sep + 1) };
  if (button.dataset.delete !== undefined) {
    archivedPendingDelete = target;
    $('deleteArchivedTitle').textContent = button.closest('.archived-row').querySelector('h2').textContent;
    $('deleteArchivedDialog').showModal();
    return;
  }
  button.disabled = true;
  try {
    const result = await api.archivedSessionAction({ ...target, action: 'restore' });
    if (!result.ok) throw new Error(result.error);
    status("Conversation restored");
  } catch (err) { status(err.message, true); }
  await renderArchived();
};
$('confirmDeleteArchived').onclick = async () => {
  if (archivedDeleting) return;
  const target = archivedPendingDelete;
  archivedPendingDelete = null;
  $('deleteArchivedDialog').close();
  if (!target) return;
  try {
    const result = await api.archivedSessionAction({ ...target, action: 'delete' });
    if (!result.ok) throw new Error(result.error);
    status("Conversation deleted");
  } catch (err) { status(err.message, true); }
  await renderArchived();
};
$('deleteAllArchived').onclick = () => {
  if (archivedDeleting || !archivedCount) return;
  $('deleteAllArchivedCount').textContent = window.CamelliaI18n.t(`All ${archivedCount} archived conversations will be deleted.`);
  $('deleteAllArchivedDialog').showModal();
};
$('confirmDeleteAllArchived').onclick = async () => {
  $('deleteAllArchivedDialog').close();
  if (archivedDeleting || !archivedCount) return;
  setArchivedDeleting(true);
  archivedDeleteProgress({ processed: 0, total: archivedCount });
  try {
    const result = await api.archivedSessionAction({ action: 'delete-all' });
    if (!result.ok) throw new Error(result.error);
    status(window.CamelliaI18n.t('Deleted {0} archived conversations.').replace('{0}', () => fmt(result.deleted)));
  } catch (err) { status(err.message, true); }
  finally {
    archivedDeleting = false;
    try { await renderArchived(); }
    finally { setArchivedDeleting(false); }
  }
};
api.onApiRouterState(state => {
  if (!live) return; live = { ...live, ...state }; showLive(); updateKeyStats();
  if (!saving && !isDirty() && config && state.routing) {
    config.routing = structuredClone(state.routing); renderRoutingSettings();
  }
  renderRoutes(); renderModelChips();
  if (!saving && !isDirty() && syncMaskedKeys() && current()?.type === 'qclaw') renderKeys();
  if (view === 'usage') { fillUsageFilters(); renderUsage(); }
  if (!isDirty() && !current()) renderProviders();
});
api.onProviderInsights(state => {
  insight = state; if (!config) return;
  updateKeyStats(); renderBalances();
  if (!isDirty() && !current()) renderProviders();
});
let chartLayoutWidth = 0, chartLayoutFrame;
new ResizeObserver(() => {
  const width = document.querySelector('.scroll-content').clientWidth;
  if (width === chartLayoutWidth) return;
  chartLayoutWidth = width;
  cancelAnimationFrame(chartLayoutFrame);
  chartLayoutFrame = requestAnimationFrame(() => {
    if (!live) return;
    if (view === 'usage') renderUsage();
    if (view === 'providers' || view === 'subscriptions') renderBalances();
  });
}).observe(document.querySelector('.scroll-content'));
navigateSettings(Object.fromEntries(new URLSearchParams(location.search)));
void refresh(true);
window.flushApiSettings = async () => {
  if (!config) return { ok: !isDirty() };
  await flushSave();
  if (!draftComplete()) {
    status("Complete the API URL, key or model fields to finish saving.", true);
    return { ok: false };
  }
  return { ok: !isDirty() && !lastSaveError };
};
// Closing the window must not drop a debounced edit.
window.addEventListener('beforeunload', () => { if (isDirty()) void flushSave(); });
window.addEventListener('camellia:language', () => {
  // This status is rendered by script, not by data-i18n, so it needs an
  // explicit re-render to leave the previous language.
  if (lastNetworkValue) renderNetworkSettings(lastNetworkValue);
  if (dataDirectory && !dataMigrationBusy) renderDataDirectory(dataDirectory);
  if (!dataMigrationBusy) renderPluginCacheMaintenance(pluginCacheState);
  if (!live) return;
  if (view === 'usage') { fillUsageFilters(); renderUsage(); }
  if (view === 'providers' || view === 'subscriptions') renderBalances();
  if (view === 'archived') void renderArchived();
});
