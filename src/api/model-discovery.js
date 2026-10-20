'use strict';

const { createHash } = require('node:crypto');
const { fetchModels } = require('./provider-accounts');

// Metadata calls only: successful inference does not prove an effort was used.
// Providers can silently ignore an unsupported effort or map it to a default.
function createModelDiscovery({ getConfig, apply, fetchImpl, now = Date.now,
  intervalMs = 24 * 60 * 60000, retryMs = 5 * 60000 } = {}) {
  const entries = new Map();
  let closed = false;
  function identity(provider) {
    return createHash('sha256').update(JSON.stringify([provider.type, provider.baseUrl, provider.anthropicBaseUrl,
      provider.protocol, provider.models.map(m => [m.id, m.upstream, m.protocol]),
      provider.keys.filter(k => k.enabled).map(k => [k.id, k.key])])).digest('hex');
  }
  function providers() {
    const config = getConfig();
    return config.enabled === false ? [] : config.providers.filter(p => p.enabled && p.type !== 'qclaw'
      && p.models.length && p.keys.some(k => k.enabled));
  }
  async function discover(provider, id) {
    const controller = new AbortController();
    const entry = { id, controller, nextAt: Infinity, pending: null };
    entries.set(provider.id, entry);
    entry.pending = (async () => {
      let complete = false;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
      // A key may lack catalog access; try the next enabled key without
      // declaring missing metadata to be an unsupported model capability.
      for (const key of provider.keys.filter(k => k.enabled)) {
        if (signal.aborted) break;
        try {
          const models = await fetchModels(provider, key.key, { fetchImpl, configuredOnly: true,
            timeoutMs: 5000, signal });
          if (closed || controller.signal.aborted) return;
          const current = providers().find(p => p.id === provider.id);
          if (!current || identity(current) !== id) return;
          apply(current, models);
          complete = models.every(model => model.thinking);
          if (complete) break;
        } catch { if (closed || controller.signal.aborted) return; }
      }
      entry.nextAt = now() + (complete ? intervalMs : retryMs);
    })().finally(() => { entry.pending = null; });
    return entry.pending;
  }
  async function refresh() {
    if (closed) return;
    const active = providers();
    for (const [id, entry] of entries) {
      if (!active.some(p => p.id === id && identity(p) === entry.id)) {
        entry.controller.abort(); entries.delete(id);
      }
    }
    const queue = active.slice();
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length && !closed) {
        const provider = structuredClone(queue.shift()), id = identity(provider);
        if (!providers().some(p => p.id === provider.id && identity(p) === id)) continue;
        const entry = entries.get(provider.id);
        if (entry?.id === id && entry.pending) { await entry.pending; continue; }
        if (entry?.id === id && now() < entry.nextAt) continue;
        await discover(provider, id);
      }
    }));
  }
  function close() {
    closed = true;
    for (const entry of entries.values()) entry.controller.abort();
    entries.clear();
  }
  return { refresh, close };
}

module.exports = { createModelDiscovery };
