'use strict';

const { readJson, writeJson } = require('../shared/json-store.js');
const { createHash, randomUUID } = require('node:crypto');
const { FIELDS, counters, normalizeBreakdown } = require('./api-usage');
const { discoverQclaw, DEFAULT_BASE_URL } = require('./qclaw-provider');
const { normalizeThinking, thinkingFor } = require('../shared/model-levels');
const { canonicalModelId } = require('../shared/model-names');
const DEFAULT_PORT = 8788;
// QClaw answers through an agent runtime, so the prompt also carries that
// runtime's own instructions and skills. Measured overflow lands near 110k
// total tokens, which leaves roughly 90k for the conversation itself; the
// router's own estimator is deliberately pessimistic, so this stays safe.
const QCLAW_CONTEXT_WINDOW = 88000;
const legacyModels = ['kimi-k3', 'deepseek-v4-pro', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'kimi-k2.6', 'kimi-k2.5'];
const PRESETS = [
  { type: 'ollama', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', protocol: 'dual',
    models: legacyModels.map(id => ({ id, upstream: id + ':cloud' })) },
  { type: 'kimi', name: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai',
    models: ['kimi-k2.6', 'kimi-k2.5'].map(id => ({ id, upstream: id })) },
  { type: 'deepseek', name: "DeepSeek", baseUrl: 'https://api.deepseek.com/v1', protocol: 'dual',
    anthropicBaseUrl: 'https://api.deepseek.com/anthropic/v1', models: [] },
  { type: 'commandcode', name: 'Command Code GOAT', baseUrl: 'https://api.commandcode.ai/provider/v1', protocol: 'openai',
    models: [
      { id: 'deepseek-v4.1-flash', upstream: 'deepseek/deepseek-v4.1-flash' },
      { id: 'kimi-k3', upstream: 'moonshotai/Kimi-K3' },
      { id: 'glm-5.3', upstream: 'zai-org/GLM-5.3' },
      { id: 'kimi-k2.6', upstream: 'moonshotai/Kimi-K2.6' },
      { id: 'kimi-k2.5', upstream: 'moonshotai/Kimi-K2.5' },
    ] },
  { type: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', protocol: 'dual', models: [] },
  { type: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', protocol: 'dual', models: [] },
  { type: 'kimi-code', name: 'Kimi Code (API key)', baseUrl: 'https://api.kimi.com/coding/v1', protocol: 'dual', models: [] },
  { type: 'mimo', name: 'MiMo (pay-as-you-go)', baseUrl: 'https://api.xiaomimimo.com/v1', protocol: 'dual',
    anthropicBaseUrl: 'https://api.xiaomimimo.com/anthropic/v1',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'].map(id => ({ id, upstream: id })) },
  ...[['cn', 'China'], ['sgp', 'Singapore'], ['ams', 'Europe']].map(([region, label]) => ({
    type: `mimo-token-plan-${region}`, name: `MiMo Token Plan (${label})`,
    baseUrl: `https://token-plan-${region}.xiaomimimo.com/v1`, protocol: 'dual',
    anthropicBaseUrl: `https://token-plan-${region}.xiaomimimo.com/anthropic/v1`,
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'].map(id => ({ id, upstream: id })),
  })),
  { type: 'gemini', name: 'Google Gemini API', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai', models: [] },
  { type: 'qclaw', name: 'QClaw (local)', baseUrl: DEFAULT_BASE_URL, protocol: 'openai',
    models: [{ id: 'openclaw/main', upstream: 'openclaw/main', contextWindow: QCLAW_CONTEXT_WINDOW }] },
  { type: 'custom', name: "Custom provider", baseUrl: '', protocol: 'openai', models: [] },
];

function modelId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error("Enter a valid model ID");
  const canonical = canonicalModelId(id);
  if (!canonical || ['__proto__', 'constructor', 'prototype'].includes(canonical)) throw new Error("Enter a valid model ID");
  return canonical;
}
function endpoint(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error("Enter a complete provider API URL"); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error("Remote APIs require HTTPS. Local services may use HTTP.");
  if (url.username || url.password || url.search || url.hash) throw new Error("API URLs cannot contain passwords, query parameters, or fragments");
  // The docs list complete request URLs, but this field stores the base to
  // which discovery, validation and routing append their own endpoint.
  if (url.hostname === 'api.commandcode.ai'
    && /^\/provider\/v1\/(?:chat\/completions|responses|messages(?:\/count_tokens)?|models)\/*$/.test(url.pathname)) {
    url.pathname = '/provider/v1';
  }
  return url.href.replace(/\/+$/, '');
}
function maskKey(value) { const s = String(value || ''); return s.length > 12 ? s.slice(0, 4) + '…' + s.slice(-4) : '••••••••'; }
function keyId(provider, key) { return 'key-' + createHash('sha256').update(provider + ':' + key).digest('hex').slice(0, 20); }
function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value); }
function emptyUsage() { return { ...counters(), lastUsedAt: null, lastError: null, blocked: false, models: {}, byModel: {}, daily: {} }; }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : counter(value) || null;
function modelBreakdown(value) {
  const result = {};
  for (const [name, stats] of Object.entries(normalizeBreakdown(value))) {
    const id = canonicalModelId(name);
    if (!id || ['__proto__', 'constructor', 'prototype'].includes(id)) continue;
    const target = result[id] ||= counters();
    for (const field of FIELDS) target[field] += stats[field];
  }
  return result;
}
function normalizeUsage(value) {
  const source = record(value) ? value : {};
  const usage = emptyUsage();
  Object.assign(usage, counters(source));
  usage.byModel = modelBreakdown(source.byModel);
  for (const [day, data] of Object.entries(record(source.daily) ? source.daily : {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) usage.daily[day] = modelBreakdown(data);
  }
  usage.lastUsedAt = timestamp(source.lastUsedAt);
  usage.blocked = source.blocked === true;
  if (record(source.lastError)) usage.lastError = { at: timestamp(source.lastError.at), status: counter(source.lastError.status), reason: String(source.lastError.reason || '').slice(0, 200) };
  for (const [id, state] of Object.entries(record(source.models) ? source.models : {})) {
    if (!record(state) || !counter(state.until)) continue;
    const name = modelId(id), until = counter(state.until);
    if (until > (usage.models[name]?.until || 0)) usage.models[name] = { until, reason: String(state.reason || '').slice(0, 200) };
  }
  return usage;
}
function recordedUsage(value) {
  return value && (FIELDS.some(field => Number(value[field]) > 0)
    || Object.values(value.byModel || {}).some(stats => FIELDS.some(field => Number(stats[field]) > 0)));
}
function normalizeUsageArchive(entries) {
  if (entries !== undefined && !Array.isArray(entries)) throw new Error('Usage archive must be an array');
  const seen = new Set();
  return (entries || []).flatMap(entry => {
    if (!record(entry) || !validId(entry.id) || !validId(entry.providerId)) throw new Error('Invalid usage archive entry');
    if (seen.has(entry.id)) return [];
    seen.add(entry.id);
    return [{ id: entry.id, providerId: entry.providerId,
      keyId: validId(entry.keyId) ? entry.keyId : '',
      providerName: String(entry.providerName || 'Provider').slice(0, 100),
      keyName: String(entry.keyName || '').slice(0, 80),
      maskedKey: String(entry.maskedKey || '').slice(0, 80),
      usage: normalizeUsage(entry.usage) }];
  });
}

// Keep the historical file name so the desktop app and existing CLI share one pool.
function normalizeConfig(raw = {}, previous = null, options = {}) {
  if (!record(raw)) throw new Error("API route configuration must be a JSON object");
  if (raw.version !== undefined && ![1, 2].includes(raw.version)) throw new Error("Unsupported API route configuration version");
  if ((raw.version === 2 || raw.providers !== undefined) && !Array.isArray(raw.providers)) throw new Error("Providers must be an array");
  if (raw.keys !== undefined && !Array.isArray(raw.keys)) throw new Error("Legacy keys must be an array");
  const port = Number(raw.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Router port must be between 1024 and 65535");
  const routing = raw.routing === undefined ? {} : raw.routing;
  if (!record(routing)) throw new Error("Invalid API routing settings");
  const routingOptions = {};
  for (const field of ['multiKeyConcurrency', 'multiKeyFailover']) {
    if (routing[field] !== undefined && typeof routing[field] !== 'boolean') throw new Error("API routing switches must be true or false");
    routingOptions[field] = routing[field] ?? previous?.routing?.[field] ?? true;
  }
  const cfg = { version: 2, enabled: raw.enabled !== false, port, routing: routingOptions, providers: [], usage: {},
    usageArchive: normalizeUsageArchive(previous?.usageArchive || raw.usageArchive), active: {} };
  // QClaw rewrites its gateway port and token into its own state file on every
  // start, so a stored endpoint goes stale. Resolve the live one once, and only
  // when a QClaw route is actually present, so other providers never touch disk.
  let qclawLive;
  let qclawResolved = false;
  const liveQclaw = () => {
    if (!qclawResolved) {
      qclawResolved = true;
      try { qclawLive = (options.discoverQclaw || discoverQclaw)(); } catch { qclawLive = null; }
    }
    return qclawLive;
  };
  if (!Array.isArray(raw.providers)) {
    const keys = [...new Set((raw.keys || []).map(k => String(k).trim()).filter(Boolean))];
    if (keys.length) {
      const provider = { ...structuredClone(PRESETS[0]), id: 'ollama-legacy', enabled: true, priority: 0,
        keys: keys.map(key => ({ id: keyId('ollama-legacy', key), key, enabled: true })) };
      cfg.providers.push(provider);
      provider.keys.forEach((key, i) => {
        const old = raw.usage?.[i] || {};
        cfg.usage[key.id] = normalizeUsage({ ...old, failures: old.quotaFailures });
      });
      const active = provider.keys[raw.activeIndex || 0] || provider.keys[0];
      for (const m of provider.models) cfg.active[m.id] = active.id;
    }
    return cfg;
  }
  const previousKeys = new Map((previous?.providers || []).flatMap(p => p.keys.map(k => [p.id + '/' + k.id, k])));
  const ids = new Set();
  for (const p of raw.providers) {
    if (!record(p) || (p.models !== undefined && !Array.isArray(p.models)) || (p.keys !== undefined && !Array.isArray(p.keys))) throw new Error("Invalid provider, model, or key configuration");
    const id = validId(p.id) ? p.id : randomUUID();
    if (ids.has(id)) throw new Error("Duplicate provider ID");
    ids.add(id);
    const rawPriority = p.priority === undefined ? 0 : Number(p.priority);
    if (!['number', 'string', 'undefined'].includes(typeof p.priority) || (typeof p.priority === 'string' && !p.priority.trim()) || !Number.isInteger(rawPriority) || rawPriority < -1 || rawPriority > 9999) throw new Error("Choose Low, Default, or High API priority");
    const priority = Math.sign(rawPriority);
    const protocol = p.protocol || 'openai';
    if (!['openai', 'anthropic', 'dual'].includes(protocol)) throw new Error("Unsupported API protocol");
    const type = String(p.type || 'custom');
    const live = type === 'qclaw' ? liveQclaw() : null;
    const declaredBaseUrl = String(p.baseUrl || (type === 'qclaw' ? DEFAULT_BASE_URL : '')).trim();
    const models = (p.models || []).map(m => {
      if (!record(m)) throw new Error("Invalid model configuration");
      const protocol = m.protocol || 'auto';
      if (!['auto', 'openai', 'anthropic'].includes(protocol)) throw new Error("Unsupported model API protocol");
      const upstream = String(m.upstream || '').trim();
      if (!upstream || upstream.length > 200 || /[\s\x00-\x1f]/.test(upstream)) throw new Error("Enter the provider's upstream model ID");
      const contextWindow = m.contextWindow === undefined || m.contextWindow === null || m.contextWindow === '' ? undefined : Number(m.contextWindow);
      if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow < 4096 || contextWindow > 2000000)) throw new Error("Context window must be an integer between 4096 and 2000000");
      const maxContext = Number.isInteger(m.maxContext) && m.maxContext >= 4096 ? m.maxContext : undefined;
      if (contextWindow !== undefined && maxContext && contextWindow > maxContext) throw new Error("Context window exceeds the model's maximum (" + maxContext + ")");
      const thinking = normalizeThinking(m.thinking);
      return { id: modelId(m.id), upstream, protocol, ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxContext !== undefined ? { maxContext } : {}), ...(thinking ? { thinking } : {}) };
    });
    if (new Set(models.map(m => JSON.stringify([m.id, m.upstream, m.protocol]))).size !== models.length) throw new Error("A provider cannot contain duplicate entries for the same model route");
    const seenKeys = new Set();
    const keys = [];
    const keySource = live?.token
      ? [{ id: 'qclaw-auto', key: live.token, name: 'QClaw (auto)', enabled: true }]
      : (p.keys || []);
    for (const k of keySource) {
      if (!record(k)) throw new Error("Invalid key configuration");
      const old = previousKeys.get(id + '/' + k.id);
      const key = String(k.key || old?.key || '').trim();
      // A local QClaw route has no key of its own to store: the token comes
      // from QClaw's state file, so an empty entry only means QClaw is not
      // running and the route simply stays unroutable.
      if (!key && type === 'qclaw') continue;
      if (!key) throw new Error("New routes require an API key. Leave existing keys blank to keep them.");
      if (/[\r\n]/.test(key)) throw new Error("API keys cannot contain line breaks");
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const kid = validId(k.id) ? k.id : keyId(id, key);
      if (ids.has(kid)) throw new Error("Duplicate key ID");
      ids.add(kid);
      keys.push({ id: kid, key, name: String(k.name || '').trim().slice(0, 80), enabled: k.enabled !== false });
      // QClaw rotates its token on purpose, so a changed value must not reset
      // the counters the way a manually swapped API key does.
      const sameCredential = old && (old.key === key || type === 'qclaw' && kid === 'qclaw-auto');
      const stats = previous ? (sameCredential ? previous.usage?.[kid] : {}) : raw.usage?.[kid];
      cfg.usage[kid] = normalizeUsage(stats);
    }
    cfg.providers.push({ id, type, name: String(p.name || "Provider").trim().slice(0, 100),
      enabled: p.enabled !== false, priority, protocol, baseUrl: endpoint(live?.baseUrl || declaredBaseUrl),
      anthropicBaseUrl: p.anthropicBaseUrl ? endpoint(p.anthropicBaseUrl) : '', models, keys });
  }
  // A replaced or deleted credential leaves the route pool, but its recorded
  // traffic remains part of Usage. Archive metadata never contains the secret.
  for (const provider of previous?.providers || []) for (const key of provider.keys) {
    const current = cfg.providers.find(p => p.id === provider.id)?.keys.find(k => k.id === key.id);
    if (current && (current.key === key.key || provider.type === 'qclaw' && key.id === 'qclaw-auto')) continue;
    const usage = previous.usage?.[key.id];
    if (!recordedUsage(usage) && !options.archiveEmptyKeys?.has(provider.id + '/' + key.id)) continue;
    cfg.usageArchive.push({ id: 'history-' + randomUUID(), providerId: provider.id, keyId: key.id,
      providerName: provider.name, keyName: key.name || '', maskedKey: maskKey(key.key),
      usage: normalizeUsage(usage) });
  }
  const availableKeys = new Set(cfg.providers.flatMap(p => p.keys.map(k => k.id)));
  for (const [m, k] of Object.entries(previous?.active || raw.active || {})) {
    if (availableKeys.has(k)) cfg.active[modelId(m)] = k;
  }
  return cfg;
}

function loadConfig(file) {
  const raw = readJson(file, {});
  // Optional one-time recovery of older counters. IDs make repeated loads
  // harmless after the archive is written into the main configuration.
  const recovery = readJson(file + '.usage-recovery.json', null);
  if (recovery) {
    if (recovery.version !== 1 || !Array.isArray(recovery.entries)) throw new Error('Invalid usage recovery file');
    raw.usageArchive = [...(raw.usageArchive || []), ...recovery.entries];
  }
  const cfg = normalizeConfig(raw);
  let metadata;
  try { metadata = readJson(file + '.model-metadata.json', null); } catch {}
  if (metadata?.version === 1 && Array.isArray(metadata.models)) {
    for (const provider of cfg.providers) for (const model of provider.models) {
      if (model.thinking) continue;
      const cached = metadata.models.find(entry => entry?.providerId === provider.id && entry.baseUrl === provider.baseUrl
        && entry.anthropicBaseUrl === provider.anthropicBaseUrl && entry.providerProtocol === provider.protocol
        && entry.upstream === model.upstream && entry.protocol === model.protocol);
      const thinking = normalizeThinking(cached?.thinking);
      if (thinking) model.thinking = thinking;
    }
  }
  return cfg;
}
function metadataEntry(provider, model) {
  const thinking = normalizeThinking(model.thinking);
  return thinking ? { providerId: provider.id, baseUrl: provider.baseUrl, anthropicBaseUrl: provider.anthropicBaseUrl,
    providerProtocol: provider.protocol, upstream: model.upstream, protocol: model.protocol, thinking } : null;
}
function metadataKey(entry) {
  return [entry.providerId, entry.baseUrl, entry.anthropicBaseUrl, entry.providerProtocol, entry.upstream, entry.protocol].join('\0');
}
function writeConfigMetadata(file, cfg) {
  let cached;
  try { cached = readJson(file + '.model-metadata.json', null); } catch {}
  const currentRoutes = new Set((cfg.providers || []).flatMap(provider => (provider.models || []).map(model => metadataKey({
    providerId: provider.id, baseUrl: provider.baseUrl, anthropicBaseUrl: provider.anthropicBaseUrl,
    providerProtocol: provider.protocol, upstream: model.upstream, protocol: model.protocol,
  }))));
  const entries = new Map();
  if (cached?.version === 1 && Array.isArray(cached.models)) for (const entry of cached.models) {
    if (!entry || typeof entry.providerId !== 'string' || typeof entry.baseUrl !== 'string' || typeof entry.anthropicBaseUrl !== 'string'
      || typeof entry.providerProtocol !== 'string' || typeof entry.upstream !== 'string' || typeof entry.protocol !== 'string') continue;
    const thinking = normalizeThinking(entry.thinking);
    if (!thinking) continue;
    const normalized = { providerId: entry.providerId, baseUrl: entry.baseUrl, anthropicBaseUrl: entry.anthropicBaseUrl,
      providerProtocol: entry.providerProtocol, upstream: entry.upstream, protocol: entry.protocol, thinking };
    if (!currentRoutes.has(metadataKey(normalized))) continue;
    entries.set(metadataKey(normalized), normalized);
  }
  for (const provider of cfg.providers || []) for (const model of provider.models || []) {
    const entry = metadataEntry(provider, model);
    if (entry) entries.set(metadataKey(entry), entry);
  }
  if (entries.size || cached?.version === 1) writeJson(file + '.model-metadata.json', { version: 1, models: [...entries.values()] });
}
function writeConfig(file, cfg) {
  writeJson(file, cfg);
  writeConfigMetadata(file, cfg);
}
function hasRoutes(cfg) { return cfg.enabled && cfg.providers.some(p => p.enabled && p.models.length && p.keys.some(k => k.enabled)); }
// The actual upstream protocol can differ from the client's protocol. Keep
// enumeration shared by routing and capacity evidence so neither guesses it.
function modelRoutes(cfg, id, protocol) {
  if (!cfg.enabled) return [];
  id = modelId(id);
  return cfg.providers.filter(provider => provider.enabled).flatMap(provider => {
    return provider.models.filter(model => modelId(model.id) === id).flatMap(model => {
      const protocols = model.protocol && model.protocol !== 'auto' ? [model.protocol]
        : provider.protocol === 'dual' ? (protocol ? [protocol === 'responses' ? 'openai' : protocol] : ['openai', 'anthropic']) : [provider.protocol || 'openai'];
      return provider.keys.filter(key => key.enabled).flatMap(key => protocols.map(protocol => ({ provider, key, model, protocol })));
    });
  });
}
function modelContextWindow(cfg, id) {
  if (!hasRoutes(cfg)) return undefined;
  id = modelId(id);
  const limits = cfg.providers.filter(provider => provider.enabled && provider.keys.some(key => key.enabled))
    .flatMap(provider => provider.models).filter(model => modelId(model.id) === id)
    .map(model => model.contextWindow || model.maxContext);
  // An unknown fallback route must not inherit another provider's declaration.
  return limits.length && limits.every(limit => Number.isInteger(limit) && limit >= 4096) ? Math.min(...limits) : undefined;
}
function publicState(cfg) {
  const providers = cfg.providers.map(p => ({ ...p, models: p.models.map(m => ({ ...m })), keys: p.keys.map(({ key, ...k }) => ({ ...k, maskedKey: maskKey(key) })) }));
  const models = [...new Set(cfg.providers.filter(p => p.enabled && p.keys.some(k => k.enabled)).flatMap(p => p.models.map(m => modelId(m.id))))];
  const modelThinking = Object.fromEntries(models.map(id => [id, thinkingFor(id, cfg)]).filter(([, thinking]) => thinking));
  return { version: 2, enabled: cfg.enabled, port: cfg.port, routing: { ...cfg.routing }, providers, models, modelThinking, usage: structuredClone(cfg.usage),
    usageArchive: structuredClone(cfg.usageArchive), active: { ...cfg.active } };
}

module.exports = { DEFAULT_PORT, PRESETS, modelId, endpoint, normalizeConfig, loadConfig, writeConfig, hasRoutes, publicState, maskKey, modelRoutes, modelContextWindow };
