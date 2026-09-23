'use strict';

const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../shared/json-store');
const accounts = require('./provider-accounts');

const fingerprint = (provider, key) => createHash('sha256').update(JSON.stringify([provider.baseUrl, provider.anthropicBaseUrl, key.key])).digest('hex');
function createProviderInsights({ file, getConfig, onChange = () => {}, now = () => Date.now(), fetchImpl, getRefreshIntervalMs = () => 15 * 60000 } = {}) {
  const data = readJson(file, { keys: {} });
  const pending = new Map();
  function find(providerId, keyId) {
    const provider = getConfig().providers.find(p => p.id === providerId);
    const key = provider?.keys.find(k => k.id === keyId);
    if (!key) throw new Error("Save this key first");
    return { provider, key };
  }
  function entryFor(provider, key) {
    const identity = fingerprint(provider, key);
    const entry = data.keys[key.id];
    if (entry?.identity === identity) return entry;
    return { identity, history: [] };
  }
  function state() {
    const providers = getConfig().providers;
    return { ok: true, providers: Object.fromEntries(providers.map(p => [p.id, accounts.accountCapability(p)])),
      keys: Object.fromEntries(providers.flatMap(p => p.keys.map(k => {
        const { identity, ...entry } = entryFor(p, k);
        return [k.id, { ...structuredClone(entry), refreshing: pending.has(k.id) }];
      }))) };
  }
  function publish() { writeJson(file, data); onChange(state()); }
  async function refreshOne(provider, key, force) {
    if (pending.has(key.id)) return pending.get(key.id);
    const entry = entryFor(provider, key);
    const configuredInterval = getRefreshIntervalMs();
    const refreshInterval = Number.isFinite(configuredInterval) && configuredInterval >= 1000 ? configuredInterval : 15 * 60000;
    if (!force && entry.checkedAt && now() - Date.parse(entry.checkedAt) < refreshInterval) return;
    const operation = (async () => {
      const checkedAt = new Date(now()).toISOString();
      let result;
      try {
        result = await accounts.queryAccount(provider, key.key, { fetchImpl });
      } catch (error) { result = { status: 'error', error: error.message }; }
      // A completed request still belongs to the credential that started it.
      let current;
      try { current = find(provider.id, key.id); } catch { return; }
      if (fingerprint(current.provider, current.key) !== entry.identity) return;
      entry.checkedAt = checkedAt;
      entry.status = result.status;
      entry.error = result.error || null;
      if (result.status === 'ok') {
        entry.latest = { ...result, at: checkedAt };
        const sample = { at: checkedAt, balances: result.balances, windows: result.windows };
        const bucket = value => Math.floor(Date.parse(value) / (15 * 60000));
        if (entry.history.length && bucket(entry.history.at(-1).at) === bucket(checkedAt)) entry.history[entry.history.length - 1] = sample;
        else entry.history.push(sample);
        entry.history = entry.history.filter(s => Date.parse(s.at) >= now() - 30 * 86400000).slice(-3000);
      }
      // Model verification can finish before this account query returns.
      data.keys[key.id] = { ...entry, verification: entryFor(current.provider, current.key).verification };
      publish();
    })().finally(() => { pending.delete(key.id); onChange(state()); });
    pending.set(key.id, operation);
    onChange(state());
    return operation;
  }
  async function refresh({ providerId, keyId, force = true } = {}) {
    const providers = getConfig().providers.filter(p => (!providerId || p.id === providerId) && (providerId || p.enabled));
    const queue = providers.flatMap(p => p.keys.filter(k => (!keyId || k.id === keyId) && (keyId || k.enabled)).map(k => ({ p, k })));
    // Bound concurrent account queries; a large imported pool must not burst.
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) { const { p, k } = queue.shift(); await refreshOne(p, k, force); }
    }));
    return state();
  }
  async function verify({ providerId, keyId, model }) {
    const { provider, key } = find(providerId, keyId);
    const selected = provider.models.find(m => m.id === model);
    if (!selected) throw new Error("Choose a configured model to validate");
    const entry = entryFor(provider, key);
    let verification;
    try { await accounts.verifyModel(provider, key.key, selected, { fetchImpl }); verification = { ok: true, model, at: new Date(now()).toISOString() }; }
    catch (error) { verification = { ok: false, model, at: new Date(now()).toISOString(), error: error.message }; }
    const current = find(providerId, keyId);
    if (fingerprint(current.provider, current.key) === entry.identity) {
      // A balance refresh may have completed while this model was replying.
      data.keys[key.id] = { ...entryFor(current.provider, current.key), verification };
      publish();
    }
    return { ok: verification.ok, error: verification.error, state: state() };
  }
  async function models({ provider: draft, keyId }) {
    const provider = structuredClone(draft);
    const key = provider.keys?.find(k => k.id === keyId) || provider.keys?.find(k => k.key || k.maskedKey);
    if (!key) throw new Error("Paste an API key first");
    const value = key.key || find(provider.id, key.id).key.key;
    return { ok: true, models: await accounts.fetchModels(provider, value, { fetchImpl }) };
  }
  return { state, refresh, verify, models };
}
module.exports = { createProviderInsights };
