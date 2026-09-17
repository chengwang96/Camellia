'use strict';
const api = window.dshDesktop, $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = value => new Intl.NumberFormat(window.CamelliaI18n.locale, { maximumFractionDigits: 2 }).format(value || 0);
const compact = value => new Intl.NumberFormat(window.CamelliaI18n.locale, { maximumFractionDigits: 1, notation: 'compact' }).format(value || 0);
const when = value => value ? new Date(value).toLocaleString(window.CamelliaI18n.locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "Not queried yet";
const uid = () => crypto.randomUUID();
const keyName = (key, index = 0) => key.name || key.maskedKey || `Key ${index + 1}`;
const mark = type => ({ gemini: 'G', ollama: 'O', kimi: 'K', 'kimi-code': 'K', deepseek: 'D', commandcode: '⌘', opencode: 'OC', 'opencode-go': 'OC' }[type] || 'API');
const titles = {
  providers: ["Providers & Keys", "Manage API keys and subscription accounts."],
  usage: ["Usage", "Track requests by model and route."],
  balances: ["Balances & Quotas", "Account balances, subscription limits, and trends."],
  general: ["General", "Language, appearance, and local preferences."],
  engines: ["Engine Settings", "Manage native settings in one place."],
  runtimes: ["Runtime", "Download only the engines you need."],
};
let config, live, presets = [], insight = { providers: {}, keys: {} }, selected = null, view = 'providers';
let dirty = false, saving = false, balanceKey = null, balanceMetric = '', usageData = [];
let catalog = [], catalogSelected = new Set(), catalogProvider = null;
function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
function edited() { dirty = true; $('save').disabled = false; status("You have unsaved changes"); }
function current() { return config?.providers.find(p => p.id === selected); }
function assertClean() { if (dirty) throw new Error("Save your changes before querying or validating keys"); }
function setView(next, engine, focus) {
  if (!titles[next]) next = 'providers';
  view = next;
  for (const id of Object.keys(titles)) $(id + 'Page').hidden = id !== next;
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === next); button.setAttribute('aria-current', button.dataset.view === next ? 'page' : 'false'); });
  [$('pageTitle').textContent, $('pageSubtitle').textContent] = titles[next];
  $('save').hidden = next !== 'providers';
  engineUI.setVisible(next === 'engines');
  if (next === 'usage') { fillUsageFilters(); renderUsage(); }
  if (next === 'balances') renderBalances();
  if (next === 'engines') void (focus === 'account' ? engineUI.openAccount(engine) : engineUI.select(engine || engineUI.selected()));
  if (next === 'runtimes') void engineUI.runtimePage(focus);
}
function navigateSettings(target = {}) {
  if (target.subscriptionId) balanceKey = target.subscriptionId;
  setView(target.page || 'providers', target.engine, target.focus);
}
const engineUI = window.createEngineSettingsUI({ api, status, navigate: navigateSettings });
$('kimiUsage').onclick = () => navigateSettings({ page: 'balances', subscriptionId: 'kimi-subscription' });
api.onSettingsNavigate(navigateSettings);
function showLive() {
  $('routerLabel').textContent = live.running ? "Router running" : "Setup required";
  $('routerDot').classList.toggle('online', !!live.running);
  const last = live.lastRoute;
  $('live').textContent = (live.running ? live.url : live.error || "The router starts after you add models and keys.") + (last ? ` · ${last.model} → ${last.providerName} · ${last.reason}` : '');
}
function keyBadge(k) {
  const u = live.usage?.[k.id] || {}, info = insight.keys[k.id] || {}, v = info.verification;
  if (!k.enabled) return ["Disabled", ''];
  if (u.blocked) return ["Authentication failed", 'bad'];
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
    return `<article class="provider"><button data-select="${p.id}"><span class="provider-title"><span class="provider-mark">${mark(p.type)}</span>${esc(p.name)}</span><p class="hint" data-i18n>Keys: ${p.keys.length} · Models: ${p.models.length}${p.enabled ? '' : " · Disabled"}</p><span data-i18n class="badge ${connected ? 'good' : ''}">${connected ? connected + " connected" : "Not connected"}</span></button><div class="provider-footer"><small data-i18n>Total ${fmt(requests)} successful requests</small><button data-up="${i}" aria-label="Move up ${esc(p.name)}" ${i ? '' : 'disabled'} data-i18n-attrs="aria-label">↑</button><button data-down="${i}" aria-label="Move down ${esc(p.name)}" ${i === config.providers.length-1 ? 'disabled' : ''} data-i18n-attrs="aria-label">↓</button></div></article>`;
  }).join('') || "<div class=\"empty\"><img src=\"../../../assets/icon-256.png\" alt=\"\"><h2 data-i18n>Add your first provider</h2><p data-i18n>Choose a service, paste your keys, and select models.</p><p class=\"hint\" data-i18n>DSH, Claude, and Kimi share these connections.</p></div>";
}
function renderEditor() {
  renderProviders();
  const p = current(); $('editor').hidden = !p;
  if (!p) { $('editor').innerHTML = ''; return; }
  $('editor').innerHTML = `<button class="back" id="backProviders" data-i18n>← All providers</button>
    <div class="editor-heading"><span class="provider-mark">${mark(p.type)}</span><input id="pName" value="${esc(p.name)}" aria-label="Provider name" data-i18n-attrs="aria-label"><label><input id="pEnabled" type="checkbox" ${p.enabled ? 'checked' : ''}>Enabled</label></div>
    <div class="section-head"><h2 data-i18n>API Key</h2><button id="showImport" data-i18n>Import keys</button><button id="addKey" data-i18n>+ Add key</button></div>
    <p class="hint" data-i18n>Keys are tried in order. Leave a key blank to keep it. Use labels to identify accounts.</p><div id="keyRows"></div>
    <div id="keyImport" class="key-import" hidden><label for="bulkKeys" data-i18n>One key per line</label><textarea id="bulkKeys" placeholder="Paste API keys" spellcheck="false" data-i18n-attrs="placeholder"></textarea><button id="importKeys" data-i18n>Add to key pool</button><p class="hint" data-i18n>Duplicate keys for this provider are merged on save.</p></div>
    <div class="section"><div class="section-head"><h2 data-i18n>Model</h2><button id="discoverModels" data-i18n>Fetch models</button></div><div id="modelChips" class="model-chips"></div>
      <details class="advanced" id="modelAdvanced"><summary data-i18n>Manual models and mappings</summary><p class="hint" data-i18n>Routes switch only within the same model ID. Keep versions and aliases such as latest and chat separate.</p><div class="table-scroll"><table class="model-table"><thead><tr><th data-i18n>Canonical model ID</th><th data-i18n>Upstream model ID</th><th data-i18n>Protocol</th><th></th></tr></thead><tbody id="modelRows"></tbody></table></div><button id="addModel" data-i18n>+ Add model</button></details>
      <div class="row" style="margin-top:18px"><label data-i18n>Validation model<select id="verifyModel" aria-label="Validation model" data-i18n-attrs="aria-label"></select></label></div><p class="hint" data-i18n>Validate sends a short model request and may incur a charge. Fetching the catalog only checks catalog access.</p>
    </div>
    <details class="advanced section" id="connectionAdvanced" ${p.type === 'custom' ? 'open' : ''}><summary data-i18n>Advanced connection settings</summary><div class="grid">
      <div class="full"><label for="pUrl" data-i18n>API URL</label><input id="pUrl" value="${esc(p.baseUrl)}" placeholder="https://api.example.com/v1" spellcheck="false" data-i18n-attrs="placeholder"></div>
      <div><label for="pProtocol" data-i18n>Default protocol</label><select id="pProtocol"><option value="openai" data-i18n>OpenAI Chat Completions</option><option value="anthropic" data-i18n>Anthropic Messages</option><option value="dual" data-i18n>Both protocols</option></select></div>
      <div class="full" id="aUrlField"><label for="pAUrl" data-i18n>Anthropic URL (leave blank if the same)</label><input id="pAUrl" value="${esc(p.anthropicBaseUrl || '')}" spellcheck="false"></div></div></details>
    <details class="advanced section"><summary data-i18n>Active routes and priority</summary><div id="routeRows"></div></details>
    <button id="deleteProvider" class="danger" style="margin-top:24px" data-i18n>Remove provider</button>`;
  $('pProtocol').value = p.protocol; $('aUrlField').hidden = p.protocol !== 'dual';
  $('backProviders').onclick = () => { selected = null; renderEditor(); };
  for (const [id, field] of [['pName','name'], ['pUrl','baseUrl'], ['pAUrl','anthropicBaseUrl']]) $(id).oninput = e => { p[field] = e.target.value; edited(); };
  $('pProtocol').onchange = e => { p.protocol = e.target.value; $('aUrlField').hidden = p.protocol !== 'dual'; edited(); };
  $('pEnabled').onchange = e => { p.enabled = e.target.checked; edited(); };
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
    const [text, cls] = keyBadge(k), u = live.usage?.[k.id] || {}, v = insight.keys[k.id]?.verification;
    badge.className = `badge ${cls}`; badge.textContent = text;
    const cooldown = Object.entries(u.models || {}).filter(([,s]) => s.until > Date.now()).map(([m,s]) => `${m} cooldown until ${when(s.until)}`).join('; ');
    note.textContent = `${fmt(u.requests)} successful · Input ${fmt(u.inputTokens)} / Output ${fmt(u.outputTokens)} tokens · Failed ${fmt(u.failures)}` + (v ? ` · Last validated ${v.model} ${when(v.at)}${v.error ? ' · ' + v.error : ''}` : '') + (cooldown ? ' · ' + cooldown : '') + (u.lastError ? ' · ' + u.lastError.reason : '');
  }
}
function renderModels() {
  const p = current(); if (!p) return;
  $('modelChips').innerHTML = p.models.filter(m => m.id).map(m => `<span class="model-chip">${esc(m.id)}</span>`).join('') || "<p class=\"hint\" data-i18n>Fetch the provider catalog and choose models, or add them manually.</p>";
  $('modelRows').innerHTML = p.models.map((m,i) => `<tr><td><input data-model="${i}" data-field="id" value="${esc(m.id)}" aria-label="Canonical model ID ${i+1}" spellcheck="false" data-i18n-attrs="aria-label"></td><td><input data-model="${i}" data-field="upstream" value="${esc(m.upstream)}" aria-label="Upstream model ID ${i+1}" spellcheck="false" data-i18n-attrs="aria-label"></td><td><select data-model="${i}" data-field="protocol" aria-label="Model protocol ${i+1}" data-i18n-attrs="aria-label"><option value="auto" data-i18n>Default</option><option value="openai" data-i18n>OpenAI</option><option value="anthropic" data-i18n>Anthropic</option></select></td><td><button data-remove-model="${i}" aria-label="Remove model ${i+1}" data-i18n-attrs="aria-label">×</button></td></tr>`).join('');
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
    catalog = result.models; catalogProvider = p.id; catalogSelected = new Set();
    $('modelSearch').value = ''; renderCatalog(); $('modelDialog').showModal();
    status(`Found ${catalog.length} models. Catalog access does not verify inference access for this key.`);
  } catch (e) { status(e.message, true); } finally { button.disabled = false; }
}
function renderCatalog() {
  const query = $('modelSearch').value.trim().toLowerCase(), p = config.providers.find(p => p.id === catalogProvider);
  $('catalogList').innerHTML = catalog.filter(m => m.id.toLowerCase().includes(query)).map((m) => {
    const existing = p?.models.some(x => x.id === m.id);
    return `<label class="catalog-option"><input type="checkbox" data-catalog="${esc(m.id)}" ${existing || catalogSelected.has(m.id) ? 'checked' : ''} ${existing ? 'disabled' : ''}>${esc(m.id)}${existing ? "<small data-i18n>Added</small>" : ''}</label>`;
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
  fillSelect($('usageKey'), providers.flatMap(p => p.keys.map((k,i) => [k.id, p.name + ' · ' + keyName(k,i)])), "All keys");
  const models = new Set(providers.flatMap(p => p.keys.filter(k => !$('usageKey').value || k.id === $('usageKey').value).flatMap(k => [...Object.keys(live.usage?.[k.id]?.byModel || {}), ...p.models.map(m => m.id)])));
  fillSelect($('usageModel'), [...models].sort().map(id => [id,id]), "All models");
}
const statsFields = ['requests', 'failures', 'cancelled', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unreported'];
const blankStats = () => Object.fromEntries(statsFields.map(key => [key,0]));
function addStats(target, source) { for (const key of statsFields) target[key] += source[key] || 0; return target; }
function localDay(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function usageRows() {
  const result = [], days = new Map(), range = $('usageRange').value, selectedModel = $('usageModel').value;
  const earliest = new Date(); earliest.setDate(earliest.getDate() - (range === 'all' ? 89 : Number(range)-1));
  const min = localDay(earliest);
  for (const p of live.providers) {
    if ($('usageProvider').value && $('usageProvider').value !== p.id) continue;
    for (const [i,k] of p.keys.entries()) {
      if ($('usageKey').value && $('usageKey').value !== k.id) continue;
      const usage = live.usage?.[k.id] || {}, totals = {};
      for (const [day, models] of Object.entries(usage.daily || {})) {
        if (day < min) continue;
        for (const [model, stats] of Object.entries(models)) {
          if (selectedModel && model !== selectedModel) continue;
          totals[model] ||= blankStats(); addStats(totals[model], stats);
          if (!days.has(day)) days.set(day, blankStats()); addStats(days.get(day), stats);
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
    }
  }
  return { rows: result.sort((a,b) => b.requests - a.requests || a.model.localeCompare(b.model)), days };
}
function renderUsage() {
  const { rows, days } = usageRows(); usageData = rows;
  const sum = rows.reduce(addStats, blankStats());
  $('usageSummary').innerHTML = [["Successful requests", sum.requests, "requests"], ["Input tokens", sum.inputTokens, "Includes cache"], ["Output tokens", sum.outputTokens, "Reported by provider"], ["Failed / Canceled", sum.failures + sum.cancelled, "requests"]].map(([label,value,note]) => `<div><small data-i18n>${label}</small><strong>${compact(value)}</strong><small data-i18n>${note}</small></div>`).join('');
  const metric = $('usageMetric').value;
  const points = [...days].map(([day, stats]) => ({ at: day + 'T12:00:00', value: metric === 'tokens' ? stats.inputTokens + stats.outputTokens : stats[metric] }));
  $('usageChart').innerHTML = SettingsCharts.line(points, { label: "Request trends", width: $('usageChart').clientWidth, unit: metric === 'tokens' ? ' Token' : " requests" }) + (sum.unreported ? `<p class="hint">${fmt(sum.unreported)} successful requests did not report token usage. No estimate was added.</p>` : '') + ($('usageRange').value === 'all' ? "<p class=\"hint\" data-i18n>The chart shows the last 90 recorded days. Totals and details are cumulative.</p>" : '');
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
    ${info.error ? `<p class="error">${esc(t(info.error))}</p>` : ''}</button>`;
}
function renderSubscriptions() {
  const accounts = accountsList().filter(a => a.subscriptionId);
  $('subscriptionOverview').hidden = !accounts.length;
  $('subscriptionUsage').hidden = !accounts.length;
  const cards = accounts.map(a => accountCard(a)).join('');
  $('subscriptionCards').innerHTML = cards;
  $('subscriptionUsageCards').innerHTML = cards;
}
function renderBalances() {
  const all = accountsList();
  fillSelect($('balanceProvider'), [...new Map(all.map(a => [a.providerId, a.provider])).entries()], "All providers");
  const query = $('balanceSearch').value.trim().toLowerCase();
  const accounts = all.filter(a => (!$('balanceProvider').value || a.providerId === $('balanceProvider').value) && `${a.provider} ${a.name} ${a.maskedKey || ''}`.toLowerCase().includes(query));
  if (!accounts.some(a => a.id === balanceKey)) balanceKey = accounts[0]?.id || null;
  $('balanceCards').innerHTML = accounts.map(a => accountCard(a, a.id === balanceKey)).join('') || (all.length ? "<div class=\"empty\" data-i18n>No matching accounts.</div>" : "<div class=\"empty\"><h2 data-i18n>Connect an account to view its balance</h2><p class=\"hint\" data-i18n>Add a connection in Providers & Keys.</p></div>");
  renderBalanceDetail();
}
function renderBalanceDetail() {
  const t = window.CamelliaI18n.t;
  const account = accountsList().find(a => a.id === balanceKey);
  if (!account) { $('balanceDetail').innerHTML = ''; return; }
  const { id, providerId, provider, name, info, capability, subscriptionId } = account, latest = info.latest;
  const metrics = [...(latest?.balances || []).map(b => ({ id: 'balance/' + b.id, label: t(b.label) + ' · ' + b.currency, type: 'balances', key: b.id, unit: b.currency })), ...(latest?.windows || []).map(w => ({ id: 'window/' + w.id, label: t(w.label) + ' · ' + t('Remaining'), type: 'windows', key: w.id, unit: '%' }))];
  if (!metrics.some(m => m.id === balanceMetric)) balanceMetric = metrics[0]?.id || '';
  const metric = metrics.find(m => m.id === balanceMetric);
  const sourceNote = capability.source === 'observed' ? "Uses an undocumented endpoint. Upstream changes may affect account queries." : capability.source === 'client' ? "Uses an endpoint from the provider's official client or open-source service." : "Uses the provider's documented account API.";
  const points = metric ? (info.history || []).map(sample => { const item = sample[metric.type]?.find(x => x.id === metric.key); return { at: sample.at, value: item ? metric.type === 'windows' ? remaining(item) : item.value : null }; }) : [];
  $('balanceDetail').innerHTML = `<div class="chart-panel"><div class="section-head"><h2>${esc(provider)} · ${esc(subscriptionId ? window.CamelliaI18n.t(name) : name)}</h2><button data-i18n id="refreshOneBalance" ${info.refreshing || !capability.supported ? 'disabled' : ''}>${info.refreshing ? "Querying…" : subscriptionId ? "Refresh account" : "Refresh this key"}</button></div>
    ${subscriptionId ? '<p class="hint" data-i18n>Subscription quota is separate from API billing. A balance appears only when Kimi reports an extra usage wallet.</p>' : ''}
    ${subscriptionId ? '' : !capability.supported ? `<p class="hint">${esc(t(capability.label))}. <span data-i18n>Local token and request records remain available in Usage.</span></p>` : `<p class="hint">${esc(t(capability.label))} · ${esc(t(sourceNote))}</p>`}
    ${info.error ? `<p class="error">${esc(t(info.error))}${latest ? ' ' + esc(t('The last successful result is shown below.')) : ''}</p>` : ''}
    <div class="balance-values">${(latest?.balances || []).map(b => `<div><small>${esc(t(b.label))}</small><strong>${esc(money(b))}</strong><small>${(b.parts || []).filter(part => part.value !== null).map(part => `${esc(t(part.label))} ${fmt(part.value)}`).join(' · ')}</small></div>`).join('')}${(latest?.windows || []).map(w => `<div class="window-item"><small>${esc(t(w.label))}</small><strong data-i18n>${fmt(remaining(w))}% remaining</strong>${meter(w)}<small data-i18n>${w.resetsAt ? "Resets " + when(w.resetsAt) : "Reset time not provided"}</small></div>`).join('')}</div>
    ${metrics.length ? `<div class="section-head"><h2 data-i18n>30-day observations</h2><select id="balanceMetric" aria-label="Balance metric" data-i18n-attrs="aria-label">${metrics.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}</select></div>${SettingsCharts.line(points, { label: metric.label, width: $('balanceDetail').clientWidth - 38, unit: metric.unit, percent: metric.type === 'windows' })}` : capability.supported ? `<div class="chart-empty" data-i18n>${subscriptionId ? 'Refresh account to start recording quotas.' : 'Refresh this key to start recording balances and quotas.'}</div>` : ''}
    ${(latest?.modelUsage || []).length ? `<details class="advanced"><summary data-i18n>Model request counts reported by provider</summary><div class="table-scroll"><table><thead><tr><th data-i18n>Model</th><th data-i18n>Reporting window</th><th data-i18n>Requests</th></tr></thead><tbody>${latest.modelUsage.map(m => `<tr><td>${esc(m.model)}</td><td>${esc(m.period)}</td><td>${m.requests === null ? "Not provided" : fmt(m.requests)}</td></tr>`).join('')}</tbody></table></div><p class="hint" data-i18n>Account-level data may include other applications. It is not added to local usage.</p></details>` : ''}</div>`;
  $('refreshOneBalance').onclick = () => refreshBalances(subscriptionId ? { subscriptionId } : { providerId, keyId: id });
  if ($('balanceMetric')) { $('balanceMetric').value = balanceMetric; $('balanceMetric').onchange = e => { balanceMetric = e.target.value; renderBalanceDetail(); }; }
}
async function refreshBalances(payload = {}) {
  try {
    if (!payload.subscriptionId) assertClean(); $('refreshBalances').disabled = true; status("Querying balances and quotas…");
    const result = await api.providerRefresh(payload); if (!result.ok) throw new Error(result.error);
    insight = result; renderBalances(); renderSubscriptions(); updateKeyStats();
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
$('editor').onclick = async e => {
  const button = e.target.closest('button'), p = current(); if (!button || !p) return;
  const d = button.dataset;
  if (d.removeModel !== undefined) { p.models.splice(Number(d.removeModel),1); edited(); renderModels(); }
  if (d.removeKey !== undefined) { p.keys.splice(Number(d.removeKey),1); edited(); renderKeys(); }
  if (d.upKey !== undefined || d.downKey !== undefined) { const i = Number(d.upKey ?? d.downKey), j = d.upKey !== undefined ? i-1 : i+1; [p.keys[i], p.keys[j]] = [p.keys[j], p.keys[i]]; edited(); renderKeys(); }
  try {
    if (d.keyUsage) { assertClean(); setView('usage'); $('usageProvider').value = p.id; fillUsageFilters(); $('usageKey').value = d.keyUsage; fillUsageFilters(); renderUsage(); }
    if (d.keyBalance) { assertClean(); balanceKey = d.keyBalance; setView('balances'); }
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
  } catch (e) { status(e.message, true); } finally { if (d.verify) button.disabled = false; }
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
  if (p) { for (const model of catalog) if (catalogSelected.has(model.id) && !p.models.some(m => m.id === model.id)) p.models.push(model); edited(); if (selected === p.id) renderModels(); }
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
for (const id of ['usageRange','usageProvider','usageKey','usageModel','usageMetric']) $(id).onchange = () => { fillUsageFilters(); renderUsage(); };
$('balanceCards').onclick = e => { const button = e.target.closest('[data-balance]'); if (button) { balanceKey = button.dataset.balance; renderBalances(); } };
for (const id of ['subscriptionCards', 'subscriptionUsageCards']) $(id).onclick = e => {
  const button = e.target.closest('[data-balance]');
  if (button) { balanceKey = button.dataset.balance; $('balanceProvider').value = ''; $('balanceSearch').value = ''; setView('balances'); }
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
$('openLogs').onclick = () => api.openLogs();
$('saveGeneral').onclick = async () => {
  try {
    const result = await api.workbenchSaveSettings({ language: $('language').value, theme: $('theme').value, autoRefreshBalances: $('autoRefreshBalances').checked,
      conversations: { mode: $('conversationMode').value, warnOnSwitch: $('conversationWarn').checked, showOrigin: $('conversationOriginSetting').checked } });
    if (!result.ok) throw new Error(result.error);
    window.CamelliaI18n.setLanguage($('language').value); status("Preferences saved");
  } catch (e) { status(e.message, true); }
};
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
    showLive(); renderSubscriptions(); if (view === 'usage') { fillUsageFilters(); renderUsage(); } if (view === 'balances') renderBalances();
    if (!dirty) status(details.ok ? '' : details.error, !details.ok);
    if (initial) {
      const preferences = await api.workbenchSettings();
      if (!preferences.ok) throw new Error(preferences.error);
      $('language').value = preferences.language || 'en';
      $('theme').value = preferences.theme; $('autoRefreshBalances').checked = preferences.autoRefreshBalances;
      $('conversationMode').value = preferences.conversations?.mode || 'direct'; $('conversationWarn').checked = !!preferences.conversations?.warnOnSwitch;
      $('conversationOriginSetting').checked = !!preferences.conversations?.showOrigin;
      $('dataPath').textContent = preferences.dataPath; $('version').textContent = 'v' + preferences.version;
    }
  } catch (e) { status(e.message, true); }
}
$('refresh').onclick = () => refresh();
api.onApiRouterState(state => {
  if (!live) return; live = { ...live, ...state }; showLive(); updateKeyStats();
  if (view === 'usage') { fillUsageFilters(); renderUsage(); }
  if (!dirty && !current()) renderProviders();
});
api.onProviderInsights(state => {
  insight = state; if (!config) return;
  updateKeyStats(); renderSubscriptions(); if (view === 'balances') renderBalances();
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
    if (view === 'usage') renderUsage();
    if (view === 'balances') renderBalances();
  });
}).observe(document.querySelector('.scroll-content'));
void refresh(true).then(() => navigateSettings(Object.fromEntries(new URLSearchParams(location.search))));
window.addEventListener('camellia:language', () => {
  if (!live) return;
  renderSubscriptions(); if (view === 'balances') renderBalances();
});
