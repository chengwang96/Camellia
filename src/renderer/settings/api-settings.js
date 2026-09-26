'use strict';
const api = window.dshDesktop, $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = value => new Intl.NumberFormat(window.CamelliaI18n.locale, { maximumFractionDigits: 2 }).format(value || 0);
const compact = value => new Intl.NumberFormat(window.CamelliaI18n.locale, { maximumFractionDigits: 1, notation: 'compact' }).format(value || 0);
const when = value => value ? new Date(value).toLocaleString(window.CamelliaI18n.locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "Not queried yet";
const uid = () => crypto.randomUUID();
const keyName = (key, index = 0) => key.name || key.maskedKey || `Key ${index + 1}`;
const mark = type => ({ gemini: 'G', ollama: 'O', kimi: 'K', 'kimi-code': 'K', deepseek: 'D', commandcode: '⌘', opencode: 'OC', 'opencode-go': 'OC', qclaw: 'Q' }[type] || 'API');
const titles = {
  providers: ["Providers & Keys", "Manage API keys and subscription accounts."],
  usage: ["Usage", "Track requests, balances, and quotas."],
  general: ["General", "Language, appearance, and local preferences."],
  archived: ["Archived", "Restore or permanently delete archived conversations."],
  storage: ["Space cleanup", "Review unused local files before deleting them."],
  mobile: ["Mobile access", "Connect your phone through Tailscale."],
  devices: ["CLI devices", "Add Linux servers through Tailscale and work in their workspaces."],
  engines: ["Engine Settings", "Manage native settings in one place."],
  runtimes: ["Runtime", "Download only the engines you need."],
};
let config, live, presets = [], insight = { providers: {}, keys: {} }, selected = null, view = 'general';
let dirty = false, saving = false, balanceKey = null, usageData = [];
let catalog = [], catalogSelected = new Set(), catalogProvider = null;
function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
function edited() { dirty = true; $('save').disabled = false; status("You have unsaved changes"); }
function current() { return config?.providers.find(p => p.id === selected); }
function assertClean() { if (dirty) throw new Error("Save your changes before querying or validating keys"); }
function setView(next, engine, focus) {
  if (next === 'balances') next = 'usage';
  if (!titles[next]) next = 'general';
  view = next;
  for (const id of Object.keys(titles)) $(id + 'Page').hidden = id !== next;
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === next); button.setAttribute('aria-current', button.dataset.view === next ? 'page' : 'false'); });
  [$('pageTitle').textContent, $('pageSubtitle').textContent] = titles[next];
  $('save').hidden = next !== 'providers';
  engineUI.setVisible(next === 'engines');
  window.mobileAccessUI.setVisible(next === 'mobile');
  window.cliDevicesUI?.setVisible(next === 'devices');
  if (next === 'usage') { fillUsageFilters(); renderUsage(); renderBalances(); }
  if (next === 'engines') void (focus === 'account' ? engineUI.openAccount(engine) : engineUI.select(engine || engineUI.selected()));
  if (next === 'runtimes') void engineUI.runtimePage(focus);
  if (next === 'archived') void renderArchived();
}
function navigateSettings(target = {}) {
  if (target.subscriptionId) balanceKey = target.subscriptionId;
  setView(target.page || 'general', target.engine, target.focus);
}
const engineUI = window.createEngineSettingsUI({ api, status, navigate: navigateSettings });
const capacityUI = window.createContextCapacityUI({ api, current, assertClean, status, esc, fmt, keyName });
$('kimiUsage').onclick = () => navigateSettings({ page: 'usage', subscriptionId: engineUI.activeSubscriptionId() });
api.onSettingsNavigate(navigateSettings);
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
  if (!p) { $('editor').innerHTML = ''; return; }
  $('editor').innerHTML = `<button class="back" id="backProviders" data-i18n>← All providers</button>
    <div class="editor-heading"><span class="provider-mark">${mark(p.type)}</span><input id="pName" value="${esc(p.name)}" aria-label="Provider name" data-i18n-attrs="aria-label"><label><input id="pEnabled" type="checkbox" ${p.enabled ? 'checked' : ''}>Enabled</label></div>
    <label for="pPriority" data-i18n>API priority</label><select id="pPriority"><option value="-1" data-i18n>Low</option><option value="0" data-i18n>Default</option><option value="1" data-i18n>High</option></select>
    <p class="hint" data-i18n>Routes are tried in order: High, Default, Low. Unavailable routes are skipped. Equal priorities retain the current route, then follow provider and key order. Next route switches only within the highest available priority.</p>
    ${p.type.startsWith('mimo-token-plan-') ? '<p class="hint" data-i18n>Use your Token Plan tp- key and the region shown in your console. Coding use only. Do not add a pay-as-you-go route for the same model unless you want paid fallback. Check remaining Credits in the MiMo console.</p>' : ''}
    ${p.type === 'mimo' ? '<p class="hint" data-i18n>Use a regular MiMo API key, not a Token Plan tp- key. Requests are billed to your API balance. Adding this provider alongside Token Plan for the same model allows paid fallback.</p>' : ''}
    ${p.type === 'qclaw' ? '<p class="hint" data-i18n>QClaw chooses its local gateway port at start time and rotates its token, so Camellia reads both from QClaw state file on every request. Start QClaw first; there is no key or URL to fill in here.</p>' : ''}
    <div class="section-head"><h2 data-i18n>API Key</h2><button id="showImport" data-i18n>Import keys</button><button id="addKey" data-i18n>+ Add key</button></div>
    <p class="hint" data-i18n>Keys are tried in order. Leave a key blank to keep it. Use labels to identify accounts.</p><div id="keyRows"></div>
    <div id="keyImport" class="key-import" hidden><label for="bulkKeys" data-i18n>One key per line</label><textarea id="bulkKeys" placeholder="Paste API keys" spellcheck="false" data-i18n-attrs="placeholder"></textarea><button id="importKeys" data-i18n>Add to key pool</button><p class="hint" data-i18n>Duplicate keys for this provider are merged on save.</p></div>
    <div class="section"><div class="section-head"><h2 data-i18n>Model</h2><button id="discoverModels" data-i18n>Fetch models</button></div><div id="modelChips" class="model-chips"></div>
      <details class="advanced" id="modelAdvanced"><summary data-i18n>Manual models and mappings</summary><p class="hint" data-i18n>Routes switch only within the same model ID. Keep versions and aliases such as latest and chat separate.</p><div class="table-scroll"><table class="model-table"><thead><tr><th data-i18n>Canonical model ID</th><th data-i18n>Upstream model ID</th><th data-i18n>Protocol</th><th data-i18n>Context</th><th></th></tr></thead><tbody id="modelRows"></tbody></table></div><button id="addModel" data-i18n>+ Add model</button></details>
      <div class="row verify-row" style="margin-top:18px"><label data-i18n>Validation model<select id="verifyModel" aria-label="Validation model" data-i18n-attrs="aria-label"></select></label><button id="verifyNow" data-verify-now data-i18n>Validate</button></div><p class="hint" data-i18n>Validate sends a short model request and may incur a charge. Fetching the catalog only checks catalog access.</p>
    </div>
    <div id="contextCapacityPanel"></div>
    <details class="advanced section" id="connectionAdvanced" ${p.type === 'custom' ? 'open' : ''}><summary data-i18n>Advanced connection settings</summary><div class="grid">
      <div class="full"><label for="pUrl" data-i18n>API URL</label><input id="pUrl" value="${esc(p.baseUrl)}" placeholder="https://api.example.com/v1" spellcheck="false" data-i18n-attrs="placeholder"></div>
      <div><label for="pProtocol" data-i18n>Default protocol</label><select id="pProtocol"><option value="openai" data-i18n>OpenAI Chat Completions</option><option value="anthropic" data-i18n>Anthropic Messages</option><option value="dual" data-i18n>Both protocols</option></select></div>
      <div class="full" id="aUrlField"><label for="pAUrl" data-i18n>Anthropic URL (leave blank if the same)</label><input id="pAUrl" value="${esc(p.anthropicBaseUrl || '')}" spellcheck="false"></div></div></details>
    <details class="advanced section"><summary data-i18n>Active routes and priority</summary><div id="routeRows"></div></details>
    <button id="deleteProvider" class="danger" style="margin-top:24px" data-i18n>Remove provider</button>`;
  $('pProtocol').value = p.protocol; $('aUrlField').hidden = p.protocol !== 'dual';
  capacityUI.mount();
  $('backProviders').onclick = () => { selected = null; renderEditor(); };
  for (const [id, field] of [['pName','name'], ['pUrl','baseUrl'], ['pAUrl','anthropicBaseUrl']]) $(id).oninput = e => { p[field] = e.target.value; edited(); };
  $('pProtocol').onchange = e => { p.protocol = e.target.value; $('aUrlField').hidden = p.protocol !== 'dual'; edited(); };
  $('pEnabled').onchange = e => { p.enabled = e.target.checked; edited(); };
  $('pPriority').value = String(Math.sign(p.priority ?? 0));
  $('pPriority').onchange = e => { p.priority = Number(e.target.value); edited(); };
  $('addKey').onclick = () => { p.keys.push({ id: uid(), key: '', name: '', enabled: true }); edited(); renderKeys(); };
  $('showImport').onclick = () => { $('keyImport').hidden = !$('keyImport').hidden; if (!$('keyImport').hidden) $('bulkKeys').focus(); };
  $('importKeys').onclick = () => {
    const keys = [...new Set($('bulkKeys').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    if (!keys.length) return status("Paste at least one key", true);
    p.keys = p.keys.filter(k => k.key || k.maskedKey);
    for (const key of keys) if (!p.keys.some(k => k.key === key)) p.keys.push({ id: uid(), key, name: '', enabled: true });
    $('bulkKeys').value = ''; $('keyImport').hidden = true; edited(); renderKeys(); status(`Added ${keys.length} keys. Save your changes.`);
  };
  $('addModel').onclick = () => { p.models.push({ id: '', upstream: '', protocol: 'auto' }); edited(); renderModels(); };
  $('discoverModels').onclick = () => discoverModels(p);
  $('deleteProvider').onclick = () => { config.providers = config.providers.filter(x => x.id !== p.id); selected = null; edited(); renderEditor(); };
  renderKeys(); renderModels(); renderRoutes();
}
function renderKeys() {
  const p = current(); if (!p) return;
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
function renderModels() {
  const p = current(); if (!p) return;
  $('modelChips').innerHTML = p.models.map((m, index) => m.id ? `<span class="model-chip"><span>${esc(m.id)}</span><button type="button" data-remove-model="${index}" aria-label="Remove model ${esc(m.id)}" data-i18n-attrs="aria-label">×</button></span>` : '').join('') || "<p class=\"hint\" data-i18n>Fetch the provider catalog and choose models, or add them manually.</p>";
  $('modelRows').innerHTML = p.models.map((m,i) => `<tr><td><input data-model="${i}" data-field="id" value="${esc(m.id)}" aria-label="Canonical model ID ${i+1}" spellcheck="false" data-i18n-attrs="aria-label"></td><td><input data-model="${i}" data-field="upstream" value="${esc(m.upstream)}" aria-label="Upstream model ID ${i+1}" spellcheck="false" data-i18n-attrs="aria-label"></td><td><select data-model="${i}" data-field="protocol" aria-label="Model protocol ${i+1}" data-i18n-attrs="aria-label"><option value="auto" data-i18n>Default</option><option value="openai" data-i18n>OpenAI</option><option value="anthropic" data-i18n>Anthropic</option></select></td><td><input type="number" min="4096" max="${m.maxContext || 2000000}" step="1024" data-model="${i}" data-field="contextWindow" value="${m.contextWindow || ''}" placeholder="${m.maxContext ? '\u2264 ' + m.maxContext : 'Auto'}" aria-label="Context window ${i+1}" data-i18n-attrs="aria-label" style="width:96px"></td><td><button data-remove-model="${i}" aria-label="Remove model ${i+1}" data-i18n-attrs="aria-label">×</button></td></tr>`).join('');
  document.querySelectorAll('[data-model][data-field=protocol]').forEach(el => { el.value = p.models[Number(el.dataset.model)].protocol || 'auto'; });
  fillSelect($('verifyModel'), p.models.filter(m => m.id).map(m => [m.id, m.id]), "Select model", false);
}
function renderRoutes() {
  const p = current(); if (!p) return;
  $('routeRows').innerHTML = (live.models || []).filter(id => p.models.some(m => m.id === id)).map(id => {
    const active = (live.providers || []).find(p => p.keys.some(k => k.id === live.active?.[id]));
    const key = active?.keys.find(k => k.id === live.active?.[id]);
    return `<div class="route-row"><span>${esc(id)}<br><small>${active ? esc(active.name + ' · ' + keyName(key)) : "Use priority order"}</small></span><button data-rotate="${esc(id)}" data-i18n>Next route</button><button data-reset-model="${esc(id)}" data-i18n>Reset priority</button></div>`;
  }).join('') || "<p class=\"hint\" data-i18n>Save models and keys to see available routes.</p>";
}
async function discoverModels(p) {
  const button = $('discoverModels'); button.disabled = true; status("Fetching model catalog…");
  try {
    const result = await api.providerModels({ provider: p }); if (!result.ok) throw new Error(result.error);
    catalog = result.models; catalogProvider = p.id; catalogSelected = new Set(p.models.map(model => model.id));
    // Catalogs that report context limits backfill models added earlier, so the
    // cap is known (and enforced) before a value is typed into the table.
    let limits = 0;
    for (const m of p.models) {
      const hit = catalog.find(x => x.id === m.id && x.maxContext);
      if (hit && m.maxContext !== hit.maxContext) { m.maxContext = hit.maxContext; limits++; }
    }
    if (limits) { edited(); renderModels(); }
    $('modelSearch').value = ''; renderCatalog(); $('modelDialog').showModal();
    status(limits
      ? `Found ${catalog.length} models. Context limits updated for ${limits} of your models.`
      : `Found ${catalog.length} models. Catalog access does not verify inference access for this key.`);
  } catch (e) { status(e.message, true); } finally { button.disabled = false; }
}
function renderCatalog() {
  const query = $('modelSearch').value.trim().toLowerCase(), p = config.providers.find(p => p.id === catalogProvider);
  $('catalogList').innerHTML = catalog.filter(m => m.id.toLowerCase().includes(query)).map((m) => {
    const existing = p?.models.some(x => x.id === m.id);
    return `<label class="catalog-option"><input type="checkbox" data-catalog="${esc(m.id)}" ${catalogSelected.has(m.id) ? 'checked' : ''}>${esc(m.id)}${m.maxContext ? `<small class="hint">· ${Math.round(m.maxContext / 1024)}K ctx</small>` : ''}${existing ? "<small data-i18n>Added</small>" : ''}</label>`;
  }).join('') || "<p class=\"hint\" data-i18n>No matching models</p>";
}

function fillSelect(el, options, placeholder, includeAll = true) {
  const old = el.value;
  el.innerHTML = (includeAll || !options.length ? `<option data-i18n value="">${esc(placeholder)}</option>` : '') + options.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
  if ([...el.options].some(o => o.value === old)) el.value = old;
}
function fillUsageFilters() {
  fillSelect($('usageProvider'), live.providers.map(p => [p.id, p.name]), "All providers");
  const providers = live.providers.filter(p => !$('usageProvider').value || p.id === $('usageProvider').value);
  // Key labels stay short — just enough to tell keys apart; the provider
  // dropdown sits immediately to the left. Duplicated labels gain the provider.
  const shortKey = (k, i) => { const s = keyName(k, i); return s.length > 18 ? s.slice(0, 16) + '…' : s; };
  const keyEntries = providers.flatMap(p => p.keys.map((k,i) => ({ id: k.id, label: shortKey(k,i), provider: p.name })));
  const labelCount = new Map();
  for (const e of keyEntries) labelCount.set(e.label, (labelCount.get(e.label) || 0) + 1);
  fillSelect($('usageKey'), keyEntries.map(e => [e.id, labelCount.get(e.label) > 1 ? e.label + ' · ' + e.provider : e.label]), "All keys");
  const models = new Set(providers.flatMap(p => p.keys.filter(k => !$('usageKey').value || k.id === $('usageKey').value).flatMap(k => [...Object.keys(live.usage?.[k.id]?.byModel || {}), ...p.models.map(m => m.id)])));
  fillSelect($('usageModel'), [...models].sort().map(id => [id,id]), "All models");
}
const statsFields = ['requests', 'failures', 'cancelled', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unreported'];
const blankStats = () => Object.fromEntries(statsFields.map(key => [key,0]));
function addStats(target, source) { for (const key of statsFields) target[key] += source[key] || 0; return target; }
function localDay(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function usageRows() {
  const result = [], series = [], range = $('usageRange').value, selectedModel = $('usageModel').value;
  const earliest = new Date(); earliest.setDate(earliest.getDate() - (range === 'all' ? 89 : Number(range)-1));
  const min = localDay(earliest);
  for (const p of live.providers) {
    if ($('usageProvider').value && $('usageProvider').value !== p.id) continue;
    for (const [i,k] of p.keys.entries()) {
      if ($('usageKey').value && $('usageKey').value !== k.id) continue;
      const usage = live.usage?.[k.id] || {}, totals = {}, modelDays = new Map();
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
      for (const [model, stats] of Object.entries(totals)) result.push({ model, provider: p.name, key: keyName(k,i), keyId: k.id, ...stats });
      for (const [model, points] of modelDays) series.push({ model, provider: p.name, key: keyName(k,i), points });
    }
  }
  return { rows: result.sort((a,b) => b.requests - a.requests || a.model.localeCompare(b.model)), series };
}
function renderChartGrid(container, charts) {
  container.innerHTML = charts.map(chart => `<section class="chart-panel chart-tile" data-chart-kind="${esc(chart.kind)}"><h3>${esc(chart.label)}</h3><p class="hint">${esc(chart.description)}</p><div class="chart-tile-body"></div></section>`).join('') || '<div class="chart-empty" data-i18n>No requests in this period.</div>';
  container.querySelectorAll('.chart-tile-body').forEach((body, index) => {
    const chart = charts[index];
    body.innerHTML = SettingsCharts.line(chart.points, { ...chart, width: body.clientWidth });
    SettingsCharts.bindHover(body);
  });
}
function renderUsage() {
  const { rows, series } = usageRows(); usageData = rows;
  const sum = rows.reduce(addStats, blankStats());
  $('usageSummary').innerHTML = [["Successful requests", sum.requests, "requests"], ["Input tokens", sum.inputTokens, "Includes cache"], ["Output tokens", sum.outputTokens, "Reported by provider"], ["Failed / Canceled", sum.failures + sum.cancelled, "requests"]].map(([label,value,note]) => `<div><small data-i18n>${label}</small><strong>${compact(value)}</strong><small data-i18n>${note}</small></div>`).join('');
  const t = window.CamelliaI18n.t;
  const metric = $('usageMetric').value;
  const metricLabel = t({ tokens: 'Token usage', requests: 'Successful requests', inputTokens: 'Input tokens', outputTokens: 'Output tokens', failures: 'Failed / Canceled' }[metric]);
  renderChartGrid($('usageChart'), [...balanceChartSeries(), ...series.map(series => ({
    kind: 'usage', label: `${series.key} · ${series.model}`,
    description: `${series.provider} · ${metricLabel}`, unit: metric === 'tokens' || metric.endsWith('Tokens') ? ' Token' : ' ' + t('requests'),
    points: series.points.map(({ at, stats }) => ({ at, value: metric === 'tokens' ? stats.inputTokens + stats.outputTokens : metric === 'failures' ? stats.failures + stats.cancelled : stats[metric] })),
  }))]);
  $('usageChartNotes').innerHTML = (sum.unreported ? `<p class="hint">${fmt(sum.unreported)} successful requests did not report token usage. No estimate was added.</p>` : '') + ($('usageRange').value === 'all' ? "<p class=\"hint\" data-i18n>The chart shows the last 90 recorded days. Totals and details are cumulative.</p>" : '');
  $('usageRows').innerHTML = rows.map(row => `<tr><td>${esc(row.model)}<small>${esc(row.provider)}</small></td><td>${esc(row.key)}</td><td>${fmt(row.requests)}</td><td>${fmt(row.inputTokens)}</td><td>${fmt(row.outputTokens)}</td><td>${fmt(row.cacheReadTokens)}</td><td>${fmt(row.failures)}</td></tr>`).join('') || "<tr><td colspan=\"7\"><div class=\"chart-empty\" data-i18n>No requests in this period.</div></td></tr>";
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
  return `<button class="balance-card ${selected ? 'selected' : ''}" data-balance="${esc(id)}"><span class="provider-title"><span class="provider-mark${subscriptionId ? ' engine-mark' : ''}"${subscriptionId ? ` data-engine="${engine}"` : ''}>${brand}</span>${esc(provider)}</span>
    <p>${esc(subscriptionId ? t(name) : name)}${enabled ? '' : ' · ' + t('Disabled')}${subscriptionId ? ' · ' + t('Signed in') : ''}</p>
    <strong>${esc(summary)}</strong>${quota && !balance ? meter(quota) : ''}
    <p>${quota && !balance ? esc(t(quota.label)) + ' · ' : ''}${esc(info.refreshing ? t('Querying…') : latest ? t('Updated ' + when(latest.at)) : t(capability.label))}</p>
    ${subscriptionId ? `<div class="quota-preview">${(latest?.windows || []).slice(balance ? 0 : 1).map(w => `<small>${esc(t(w.label))} · ${esc(t(`${fmt(remaining(w))}% remaining`))}</small>`).join('')}</div>` : ''}
    ${info.error ? `<p class="error">${esc(t(info.error))}${latest ? ' ' + esc(t('The last successful result is shown below.')) : ''}</p>` : ''}</button>`;
}
function renderBalances() {
  const all = accountsList();
  fillSelect($('balanceProvider'), [...new Map(all.map(a => [a.providerId, a.provider])).entries()], "All providers");
  const query = $('balanceSearch').value.trim().toLowerCase();
  const accounts = all.filter(a => (!$('balanceProvider').value || a.providerId === $('balanceProvider').value) && `${a.provider} ${a.name} ${a.maskedKey || ''}`.toLowerCase().includes(query));
  if (!accounts.some(a => a.id === balanceKey)) balanceKey = accounts[0]?.id || null;
  $('balanceCards').innerHTML = accounts.map(a => accountCard(a, a.id === balanceKey)).join('') || (all.length ? "<div class=\"empty\" data-i18n>No matching accounts.</div>" : "<div class=\"empty\"><h2 data-i18n>Connect an account to view its balance</h2><p class=\"hint\" data-i18n>Add a connection in Providers & Keys.</p></div>");
  renderUsage();
}
function balanceChartSeries() {
  const t = window.CamelliaI18n.t;
  const account = accountsList().find(account => account.id === balanceKey);
  if (!account) return [];
  if (!account.subscriptionId && (($('usageProvider').value && $('usageProvider').value !== account.providerId) || ($('usageKey').value && $('usageKey').value !== account.id))) return [];
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
    if (!payload.subscriptionId) assertClean(); $('refreshBalances').disabled = true; status("Querying balances and quotas…");
    const result = await api.providerRefresh(payload); if (!result.ok) throw new Error(result.error);
    insight = result; renderBalances(); updateKeyStats();
    const errors = [...Object.values(insight.keys), ...(insight.subscriptions || []).map(a => a.info)].filter(info => info.status === 'error').length;
    status(errors ? `Query complete. ${errors} accounts could not be queried. See their cards for details.` : "Account status updated.");
  } catch (e) { status(e.message, true); } finally { $('refreshBalances').disabled = false; }
}
document.querySelector('.settings-nav nav').onclick = e => { const button = e.target.closest('[data-view]'); if (button && config) setView(button.dataset.view); };
$('providers').onclick = e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.dataset.select) { selected = button.dataset.select; renderEditor(); return; }
  const i = Number(button.dataset.up ?? button.dataset.down), j = button.dataset.up !== undefined ? i-1 : i+1;
  [config.providers[i], config.providers[j]] = [config.providers[j], config.providers[i]]; edited(); renderProviders();
};
$('editor').oninput = e => {
  const el = e.target, p = current(); if (!p) return;
  if (el.dataset.model !== undefined) { p.models[Number(el.dataset.model)][el.dataset.field] = el.value; edited(); }
  if (el.dataset.key !== undefined) { p.keys[Number(el.dataset.key)][el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value; edited(); }
};
// Clamp the context window to the model's known limit once editing finishes,
// so a value beyond the catalog maximum never reaches save-time validation.
$('editor').onchange = e => {
  const el = e.target, p = current();
  if (!p || el.dataset.model === undefined || el.dataset.field !== 'contextWindow') return;
  const m = p.models[Number(el.dataset.model)], raw = String(el.value).trim();
  if (!raw) { m.contextWindow = ''; return; }
  const value = Number(raw);
  if (!Number.isInteger(value)) return;
  const cap = m.maxContext || 2000000, clamped = Math.min(cap, Math.max(4096, value));
  if (clamped === value) return;
  el.value = clamped; m.contextWindow = clamped;
  status(value > cap ? `Context window capped at the model's maximum (${cap})` : "Context window must be an integer between 4096 and 2000000", true);
};
$('editor').onclick = async e => {
  const button = e.target.closest('button'), p = current(); if (!button || !p) return;
  const d = button.dataset;
  if (d.removeModel !== undefined) { p.models.splice(Number(d.removeModel),1); edited(); renderModels(); renderRoutes(); }
  if (d.removeKey !== undefined) { p.keys.splice(Number(d.removeKey),1); edited(); renderKeys(); }
  if (d.upKey !== undefined || d.downKey !== undefined) { const i = Number(d.upKey ?? d.downKey), j = d.upKey !== undefined ? i-1 : i+1; [p.keys[i], p.keys[j]] = [p.keys[j], p.keys[i]]; edited(); renderKeys(); }
  try {
    if (d.keyUsage) { assertClean(); setView('usage'); $('usageProvider').value = p.id; fillUsageFilters(); $('usageKey').value = d.keyUsage; fillUsageFilters(); renderUsage(); }
    if (d.keyBalance) { assertClean(); balanceKey = d.keyBalance; setView('usage'); }
    if (d.verifyNow !== undefined) {
      assertClean();
      const model = $('verifyModel').value; if (!model) throw new Error("Add and select a model first");
      const key = p.keys.find(k => k.enabled !== false && (k.key || k.maskedKey));
      if (!key) throw new Error("Add a key to validate with first");
      button.disabled = true; status(`Validating ${model}…`);
      const result = await api.providerVerify({ providerId: p.id, keyId: key.id, model });
      if (result.state) insight = result.state;
      updateKeyStats(); if (!result.ok) throw new Error(result.error);
      status(`Validation succeeded for ${model}. Select other models to validate them separately.`);
    }
    if (d.verify) {
      assertClean(); const model = $('verifyModel').value; if (!model) throw new Error("Add and select a model first");
      button.disabled = true; status(`Validating ${model}…`);
      const result = await api.providerVerify({ providerId: p.id, keyId: d.verify, model });
      if (result.state) insight = result.state;
      updateKeyStats(); if (!result.ok) throw new Error(result.error);
      status(`Validation succeeded for ${model}. Select other models to validate them separately.`);
    }
    if (d.rotate || d.resetModel || d.resetKey) {
      assertClean();
      const result = d.rotate ? await api.apiRouterRotate(d.rotate) : await api.apiRouterReset({ model: d.resetModel, keyId: d.resetKey });
      if (!result.ok) throw new Error(result.error);
      live = { ...live, ...result.state }; showLive(); updateKeyStats(); renderRoutes(); status(d.rotate ? "Switched to the next available route for the same model" : "Route checks reset. Usage history retained.");
    }
  } catch (e) { status(e.message, true); } finally { if (d.verify || d.verifyNow !== undefined) button.disabled = false; }
};
function openAccountSettings(engine) {
  if ($('addDialog').open) $('addDialog').close();
  setView('engines', engine, 'account');
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
  p.id = uid(); p.enabled = true; p.keys = [{ id: uid(), name: '', key: '', enabled: true }];
  config.providers.push(p); selected = p.id; $('addDialog').close(); edited(); renderEditor();
};
$('modelSearch').oninput = renderCatalog;
$('catalogList').onchange = e => { const id = e.target.dataset.catalog; if (id) e.target.checked ? catalogSelected.add(id) : catalogSelected.delete(id); };
$('applyModels').onclick = () => {
  const p = config.providers.find(p => p.id === catalogProvider);
  if (p) {
    const catalogIds = new Set(catalog.map(model => model.id));
    p.models = p.models.filter(model => !catalogIds.has(model.id) || catalogSelected.has(model.id));
    for (const model of catalog) if (catalogSelected.has(model.id) && !p.models.some(existing => existing.id === model.id)) p.models.push(model);
    edited();
    if (selected === p.id) { renderModels(); renderRoutes(); }
  }
  $('modelDialog').close();
};
$('enabled').onchange = e => { config.enabled = e.target.checked; edited(); };
$('port').oninput = e => { config.port = Number(e.target.value); edited(); };
$('save').onclick = async () => {
  if (saving) return; saving = true; $('save').disabled = true; $('refresh').disabled = true;
  document.querySelector('.scroll-content').inert = true; status("Saving…");
  try {
    const result = await api.apiRouterSaveConfig(config); if (!result.ok) throw new Error(result.error);
    live = { ...live, ...result.state }; config = structuredClone(live); dirty = false;
    const data = await api.providerInsights(); if (data.ok) insight = data;
    renderEditor(); showLive(); status(result.warning || live.error || "Saved. All engines share these connections.", !!(result.warning || live.error));
  } catch (e) { status(e.message, true); }
  finally { saving = false; $('save').disabled = !dirty; $('refresh').disabled = false; document.querySelector('.scroll-content').inert = false; }
};
for (const id of ['usageRange','usageProvider','usageKey','usageModel','usageMetric']) $(id).onchange = () => {
  fillUsageFilters();
  if (id === 'usageKey' && $('usageKey').value) {
    balanceKey = $('usageKey').value; $('balanceProvider').value = ''; $('balanceSearch').value = ''; renderBalances();
  } else renderUsage();
};
$('balanceCards').onclick = e => {
  const button = e.target.closest('[data-balance]');
  if (!button) return;
  balanceKey = button.dataset.balance;
  const account = accountsList().find(account => account.id === balanceKey);
  if (account && !account.subscriptionId) {
    $('usageProvider').value = account.providerId; fillUsageFilters();
    $('usageKey').value = account.id; $('usageModel').value = ''; fillUsageFilters();
  }
  renderBalances();
};
$('balanceProvider').onchange = renderBalances;
$('balanceSearch').oninput = renderBalances;
$('refreshBalances').onclick = () => refreshBalances();
$('exportUsage').onclick = () => {
  const field = value => { let text = String(value ?? ''); if (/^[=+@\-\t\r]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
  const rows = [["Model", "Provider", 'Key', "Successful requests", "Input tokens", "Output tokens", "Cache-read tokens", "Failed", "Cancel"], ...usageData.map(r => [r.model, r.provider, r.key, r.requests, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.failures, r.cancelled])];
  const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map(r => r.map(field).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `workbench-usage-${localDay(new Date())}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('exportConfig').onclick = async () => {
  try {
    const result = await api.apiRouterExport();
    if (result?.ok && !result.canceled) status("Configuration exported. The file contains raw API keys — store it carefully.");
    else if (result && !result.ok) throw new Error(result.error);
  } catch (e) { status(e.message, true); }
};
$('importConfig').onclick = async () => {
  try {
    const result = await api.apiRouterImport();
    if (result?.ok && !result.canceled) { status(`Configuration imported: ${result.providers} providers. Subscriptions still need a local sign-in.`); await refresh(); }
    else if (result && !result.ok) throw new Error(result.error);
  } catch (e) { status(e.message, true); }
};
$('openLogs').onclick = () => api.openLogs();

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
// General preferences apply on change, like the engines' own settings pages.
async function saveGeneral() {
  try {
    const result = await api.workbenchSaveSettings({ language: $('language').value, theme: $('theme').value, autoRefreshBalances: $('autoRefreshBalances').checked, closeToTray: $('closeToTray').checked,
      accountRefreshMinutes: Number($('accountRefreshMinutes').value),
      conversations: { mode: $('conversationMode').value, warnOnSwitch: $('conversationWarn').checked, showOrigin: $('conversationOriginSetting').checked } });
    if (!result.ok) throw new Error(result.error);
    window.CamelliaI18n.setLanguage($('language').value); status("Preferences saved");
  } catch (e) { status(e.message, true); }
}
for (const id of ['language', 'theme', 'autoRefreshBalances', 'accountRefreshMinutes', 'closeToTray', 'conversationMode', 'conversationWarn', 'conversationOriginSetting']) {
  $(id).addEventListener('change', saveGeneral);
}
async function refresh(initial = false) {
  try {
    const [state, details] = await Promise.all([api.apiRouterGetState(), api.providerInsights()]);
    if (!state.ok) throw new Error(state.error);
    live = state; presets = state.presets || presets;
    if (details.ok) insight = details;
    if (initial || !dirty) {
      config = structuredClone(live); $('enabled').checked = config.enabled; $('port').value = config.port;
      const selectedPreset = $('preset').value;
      $('preset').innerHTML = presets.map(p => `<option value="${p.type}">${esc(p.name)}</option>`).join('');
      if (presets.some(p => p.type === selectedPreset)) $('preset').value = selectedPreset;
      renderPresetAccount();
      renderEditor();
    }
    showLive(); if (view === 'usage') { fillUsageFilters(); renderUsage(); renderBalances(); } if (view === 'archived') void renderArchived();
    if (!dirty) status(details.ok ? '' : details.error, !details.ok);
    if (initial) {
      const preferences = await api.workbenchSettings();
      if (!preferences.ok) throw new Error(preferences.error);
      $('language').value = preferences.language || 'en';
      $('theme').value = preferences.theme; $('autoRefreshBalances').checked = preferences.autoRefreshBalances; $('closeToTray').checked = !!preferences.closeToTray;
      $('accountRefreshMinutes').value = String(preferences.accountRefreshMinutes || 15);
      $('conversationMode').value = preferences.conversations?.mode || 'direct'; $('conversationWarn').checked = !!preferences.conversations?.warnOnSwitch;
      $('conversationOriginSetting').checked = !!preferences.conversations?.showOrigin;
      $('dataPath').textContent = preferences.dataPath; $('version').textContent = 'v' + preferences.version;
    }
  } catch (e) { status(e.message, true); }
}
$('refresh').onclick = () => view === 'mobile' ? window.mobileAccessUI.refresh() : view === 'devices' ? window.cliDevicesUI?.refresh() : refresh();
let storagePreview = null, storageBusy = false;
const storageBytes = bytes => bytes < 1024 ? fmt(bytes) + ' B' : bytes < 1024 ** 2 ? fmt(bytes / 1024) + ' KiB' : bytes < 1024 ** 3 ? fmt(bytes / 1024 ** 2) + ' MiB' : fmt(bytes / 1024 ** 3) + ' GiB';
function storageControls() {
  $('scanStorage').disabled = storageBusy;
  $('cleanStorage').disabled = storageBusy || !storagePreview?.candidates.length;
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
    if (result.active) {
      const notice = document.createElement('p');
      notice.textContent = window.CamelliaI18n.t('Conversations are running. Pasted attachments and handoffs/summaries are protected; scan again when idle to include them.');
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
  } catch (error) { $('storageStatus').textContent = error.message; $('storageSummary').replaceChildren(); }
  finally { $('storageDetails').hidden = true; $('storageFiles').replaceChildren(); storageBusy = false; storageControls(); }
};
// ---------- Archived conversations ----------
const engineNames = { claude: 'Claude Code', codex: 'Codex CLI', dsh: 'DeepSeek Harness', kimi: 'Kimi Code', antigravity: 'Antigravity' };
let archivedPendingDelete = null, archivedCount = 0;
async function renderArchived() {
  try {
    const result = await api.archivedSessionsList();
    if (!result.ok) throw new Error(result.error);
    archivedCount = result.sessions.length;
    $('deleteAllArchived').disabled = !archivedCount;
    const t = window.CamelliaI18n.t;
    $('archivedList').innerHTML = result.sessions.map(s => `<div class="setting-row archived-row">
      <div><h2>${esc(s.title)}</h2><p class="hint">${esc(engineNames[s.origin || s.source] || s.source)} · ${esc(t("Archived"))} ${when(s.archivedAt)}${s.missing ? ' · ' + esc(t("Files missing")) : ''}</p></div>
      <div class="archived-actions"><button data-restore="${esc(s.source)}:${esc(s.id)}" data-i18n>Restore</button><button class="danger" data-delete="${esc(s.source)}:${esc(s.id)}" data-i18n>Delete</button></div>
    </div>`).join('') || `<div class="empty"><h2 data-i18n>No archived conversations</h2><p class="hint" data-i18n>Archive a conversation from its ⋯ menu in the sidebar and it will appear here.</p></div>`;
  } catch (e) { status(e.message, true); }
}
$('archivedList').onclick = async e => {
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
  $('deleteAllArchivedCount').textContent = window.CamelliaI18n.t(`All ${archivedCount} archived conversations will be deleted.`);
  $('deleteAllArchivedDialog').showModal();
};
$('confirmDeleteAllArchived').onclick = async () => {
  $('deleteAllArchivedDialog').close();
  try {
    const result = await api.archivedSessionAction({ action: 'delete-all' });
    if (!result.ok) throw new Error(result.error);
    status("All archived conversations deleted");
  } catch (err) { status(err.message, true); }
  await renderArchived();
};
api.onApiRouterState(state => {
  if (!live) return; live = { ...live, ...state }; showLive(); updateKeyStats();
  if (view === 'usage') { fillUsageFilters(); renderUsage(); }
  if (!dirty && !current()) renderProviders();
});
api.onProviderInsights(state => {
  insight = state; if (!config) return;
  updateKeyStats(); if (view === 'usage') renderBalances();
  if (!dirty && !current()) renderProviders();
});
let chartLayoutWidth = 0, chartLayoutFrame;
new ResizeObserver(() => {
  const width = document.querySelector('.scroll-content').clientWidth;
  if (width === chartLayoutWidth) return;
  chartLayoutWidth = width;
  cancelAnimationFrame(chartLayoutFrame);
  chartLayoutFrame = requestAnimationFrame(() => {
    if (!live) return;
    if (view === 'usage') { renderUsage(); renderBalances(); }
  });
}).observe(document.querySelector('.scroll-content'));
void refresh(true).then(() => navigateSettings(Object.fromEntries(new URLSearchParams(location.search))));
window.addEventListener('camellia:language', () => {
  if (!live) return;
  if (view === 'usage') { renderUsage(); renderBalances(); } if (view === 'archived') void renderArchived();
});
