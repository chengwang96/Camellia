'use strict';

const { readJson, writeJson } = require('../shared/json-store.js');
const { createHash, randomUUID } = require('node:crypto');
const { counters, normalizeBreakdown } = require('./api-usage');
const DEFAULT_PORT = 8788;
const legacyModels = ['kimi-k3', 'deepseek-v4-pro', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'kimi-k2.6', 'kimi-k2.5'];
const PRESETS = [
  { type: 'ollama', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', protocol: 'dual',
    models: legacyModels.map(id => ({ id, upstream: id + ':cloud' })) },
  { type: 'kimi', name: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai',
    models: ['kimi-k2.6', 'kimi-k2.5'].map(id => ({ id, upstream: id })) },
  { type: 'deepseek', name: "DeepSeek", baseUrl: 'https://api.deepseek.com/v1', protocol: 'dual',
    anthropicBaseUrl: 'https://api.deepseek.com/anthropic/v1', models: [] },
  { type: 'commandcode', name: 'Command Code GOAT', baseUrl: 'https://api.commandcode.ai/provider/v1', protocol: 'openai',
    models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.5'].map(id => ({ id, upstream: 'moonshotai/' + id })) },
  { type: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', protocol: 'dual', models: [] },
  { type: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', protocol: 'dual', models: [] },
  { type: 'kimi-code', name: "Kimi Code subscription", baseUrl: 'https://api.kimi.com/coding/v1', protocol: 'dual', models: [] },
  { type: 'custom', name: "Custom provider", baseUrl: '', protocol: 'openai', models: [] },
];

function modelId(value) {
  const id = String(value || '').trim().replace(/:cloud$/, '');
  if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error("Enter a valid model ID");
  return id;
}
function endpoint(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error("Enter a complete provider API URL"); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error("Remote APIs require HTTPS. Local services may use HTTP.");
  if (url.username || url.password || url.search || url.hash) throw new Error("API URLs cannot contain passwords, query parameters, or fragments");
  return url.href.replace(/\/+$/, '');
}
function maskKey(value) { const s = String(value || ''); return s.length > 12 ? s.slice(0, 4) + '…' + s.slice(-4) : '••••••••'; }
function keyId(provider, key) { return 'key-' + createHash('sha256').update(provider + ':' + key).digest('hex').slice(0, 20); }
function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value); }
function emptyUsage() { return { ...counters(), lastUsedAt: null, lastError: null, blocked: false, models: {}, byModel: {}, daily: {} }; }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : counter(value) || null;
function normalizeUsage(value) {
  const source = record(value) ? value : {};
  const usage = emptyUsage();
  Object.assign(usage, counters(source));
  usage.byModel = normalizeBreakdown(source.byModel);
  for (const [day, data] of Object.entries(record(source.daily) ? source.daily : {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) usage.daily[day] = normalizeBreakdown(data);
  }
  usage.lastUsedAt = timestamp(source.lastUsedAt);
  usage.blocked = source.blocked === true;
  if (record(source.lastError)) usage.lastError = { at: timestamp(source.lastError.at), status: counter(source.lastError.status), reason: String(source.lastError.reason || '').slice(0, 200) };
  for (const [id, state] of Object.entries(record(source.models) ? source.models : {})) {
    if (!record(state) || !counter(state.until)) continue;
    usage.models[modelId(id)] = { until: counter(state.until), reason: String(state.reason || '').slice(0, 200) };
  }
  return usage;
}

// Keep the historical file name so the desktop app and existing CLI share one pool.
function normalizeConfig(raw = {}, previous = null) {
  if (!record(raw)) throw new Error("API route configuration must be a JSON object");
  if (raw.version !== undefined && ![1, 2].includes(raw.version)) throw new Error("Unsupported API route configuration version");
  if ((raw.version === 2 || raw.providers !== undefined) && !Array.isArray(raw.providers)) throw new Error("Providers must be an array");
  if (raw.keys !== undefined && !Array.isArray(raw.keys)) throw new Error("Legacy keys must be an array");
  const port = Number(raw.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Router port must be between 1024 and 65535");
  const cfg = { version: 2, enabled: raw.enabled !== false, port, providers: [], usage: {}, active: {} };
  if (!Array.isArray(raw.providers)) {
    const keys = [...new Set((raw.keys || []).map(k => String(k).trim()).filter(Boolean))];
    if (keys.length) {
      const provider = { ...structuredClone(PRESETS[0]), id: 'ollama-legacy', enabled: true,
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
    const protocol = p.protocol || 'openai';
    if (!['openai', 'anthropic', 'dual'].includes(protocol)) throw new Error("Unsupported API protocol");
    const models = (p.models || []).map(m => {
      if (!record(m)) throw new Error("Invalid model configuration");
      const protocol = m.protocol || 'auto';
      if (!['auto', 'openai', 'anthropic'].includes(protocol)) throw new Error("Unsupported model API protocol");
      const upstream = String(m.upstream || '').trim();
      if (!upstream || upstream.length > 200 || /[\s\x00-\x1f]/.test(upstream)) throw new Error("Enter the provider's upstream model ID");
      return { id: modelId(m.id), upstream, protocol };
    });
    if (new Set(models.map(m => m.id)).size !== models.length) throw new Error("A provider cannot contain duplicate entries for the same model");
    const seenKeys = new Set();
    const keys = [];
    for (const k of p.keys || []) {
      if (!record(k)) throw new Error("Invalid key configuration");
      const old = previousKeys.get(id + '/' + k.id);
      const key = String(k.key || old?.key || '').trim();
      if (!key) throw new Error("New routes require an API key. Leave existing keys blank to keep them.");
      if (/[\r\n]/.test(key)) throw new Error("API keys cannot contain line breaks");
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const kid = validId(k.id) ? k.id : keyId(id, key);
      if (ids.has(kid)) throw new Error("Duplicate key ID");
      ids.add(kid);
      keys.push({ id: kid, key, name: String(k.name || '').trim().slice(0, 80), enabled: k.enabled !== false });
      const stats = old && old.key !== key ? {} : (previous?.usage?.[kid] || raw.usage?.[kid] || {});
      cfg.usage[kid] = normalizeUsage(stats);
    }
    cfg.providers.push({ id, type: String(p.type || 'custom'), name: String(p.name || "Provider").trim().slice(0, 100),
      enabled: p.enabled !== false, protocol, baseUrl: endpoint(p.baseUrl),
      anthropicBaseUrl: p.anthropicBaseUrl ? endpoint(p.anthropicBaseUrl) : '', models, keys });
  }
  const availableKeys = new Set(cfg.providers.flatMap(p => p.keys.map(k => k.id)));
  for (const [m, k] of Object.entries(previous?.active || raw.active || {})) {
    if (availableKeys.has(k)) cfg.active[modelId(m)] = k;
  }
  return cfg;
}

function loadConfig(file) {
  return normalizeConfig(readJson(file, {}));
}
function writeConfig(file, cfg) {
  writeJson(file, cfg);
}
function hasRoutes(cfg) { return cfg.enabled && cfg.providers.some(p => p.enabled && p.models.length && p.keys.some(k => k.enabled)); }
function publicState(cfg) {
  const providers = cfg.providers.map(p => ({ ...p, models: p.models.map(m => ({ ...m })), keys: p.keys.map(({ key, ...k }) => ({ ...k, maskedKey: maskKey(key) })) }));
  const models = [...new Set(cfg.providers.filter(p => p.enabled && p.keys.some(k => k.enabled)).flatMap(p => p.models.map(m => m.id)))];
  return { version: 2, enabled: cfg.enabled, port: cfg.port, providers, models, usage: structuredClone(cfg.usage), active: { ...cfg.active } };
}

module.exports = { DEFAULT_PORT, PRESETS, modelId, endpoint, normalizeConfig, loadConfig, writeConfig, hasRoutes, publicState, maskKey };
