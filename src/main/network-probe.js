'use strict';

const { directConnection, proxyConnection } = require('./network-fallback');

const DEFAULT_TIMEOUT = 4000;
// A handful of routes in flight keeps the test quick without bursting the
// network (or the proxy) with dozens of simultaneous connects.
const MAX_CONCURRENCY = 4;
// Subscription CLIs authenticate and stream against provider-owned hosts. They
// are only taken over the direct-first bridge when these hosts are reachable
// directly, because a blocked route would otherwise stall sign-in.
const SUBSCRIPTION_HOSTS = {
  codex: { host: 'chatgpt.com', port: 443, label: 'ChatGPT account' },
  kimi: { host: 'api.kimi.com', port: 443, label: 'Kimi account' },
  antigravity: { host: 'cloudcode-pa.googleapis.com', port: 443, label: 'Google account' },
};

function hostOf(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ''));
    if (!/^https?:$/.test(url.protocol)) return null;
    return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
  } catch { return null; }
}

// One route per host: several models on the same provider share a connection,
// so probing each model separately would only repeat the same TCP attempt.
function providerTargets(config) {
  const grouped = new Map();
  for (const provider of config?.providers || []) {
    if (!provider.enabled || !provider.keys?.some(key => key.enabled)) continue;
    const models = (provider.models || []).map(model => model.id);
    for (const base of [provider.baseUrl, provider.anthropicBaseUrl].filter(Boolean)) {
      const target = hostOf(base);
      if (!target) continue;
      const id = `${target.host}:${target.port}`;
      const entry = grouped.get(id) || { id, kind: 'provider', ...target, providers: new Set(), models: new Set() };
      entry.providers.add(provider.name || target.host);
      for (const model of models) entry.models.add(model);
      grouped.set(id, entry);
    }
  }
  return [...grouped.values()].map(({ providers, models, ...entry }) => ({
    ...entry, label: [...providers].join(', '), models: [...models],
  }));
}

function subscriptionTargets(engines = []) {
  return engines.flatMap(engine => {
    const target = SUBSCRIPTION_HOSTS[engine];
    return target ? [{ id: 'subscription:' + engine, kind: 'subscription', engine, ...target }] : [];
  });
}

async function probeTarget(target, { proxyUrl = '', timeout = DEFAULT_TIMEOUT } = {}) {
  const reachable = connect => connect().then(socket => { socket.destroy(); return true; }, () => false);
  const startedAt = Date.now();
  // Direct and proxy routes are independent, so they run together and the
  // slower of the two no longer doubles the time the whole test takes.
  const [direct, proxy] = await Promise.all([
    reachable(() => directConnection(target.host, target.port, { timeout })),
    proxyUrl ? reachable(() => proxyConnection(proxyUrl, target.host, target.port, { timeout })) : Promise.resolve(false),
  ]);
  return { ...target, direct, proxy, preferred: direct ? 'direct' : proxy ? 'proxy' : 'none', durationMs: Date.now() - startedAt };
}

async function probeTargets(targets, { probe = probeTarget, ...options } = {}) {
  const results = new Array(targets.length);
  let next = 0;
  const workers = Math.max(1, Math.min(MAX_CONCURRENCY, targets.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < targets.length) {
      const index = next++;
      results[index] = await probe(targets[index], options);
    }
  }));
  return results;
}

function summarize(results) {
  const subscriptions = results.filter(result => result.kind === 'subscription');
  return {
    total: results.length,
    direct: results.filter(result => result.direct).length,
    proxy: results.filter(result => result.proxy).length,
    unreachable: results.filter(result => !result.direct && !result.proxy).map(result => result.label),
    hasSubscriptions: subscriptions.length > 0,
    // The subscriptions' own hosts must all be reachable directly before the
    // direct-first bridge can replace the real proxy for their CLIs. With no
    // signed-in subscription there is nothing that has to fall back.
    subscriptionDirect: subscriptions.length === 0 || subscriptions.every(result => result.direct),
  };
}

module.exports = { providerTargets, subscriptionTargets, probeTarget, probeTargets, summarize, SUBSCRIPTION_HOSTS, DEFAULT_TIMEOUT };
