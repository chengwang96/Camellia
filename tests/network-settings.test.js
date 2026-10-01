'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { detectedProxy, networkEnvironment, subscriptionEnvironment, createNetworkSettings } = require('../src/main/network-settings');
const { createFallbackProxy } = require('../src/main/network-fallback');

test('system detection respects DIRECT and rejects unsupported protocols', () => {
  assert.equal(detectedProxy('PROXY localhost:7890; DIRECT').url, 'http://localhost:7890/');
  assert.equal(detectedProxy('DIRECT; PROXY localhost:7890').url, '');
  assert.equal(detectedProxy('SOCKS5 localhost:7890').unsupported, true);
});
test('direct explicitly clears inherited proxy variants; fallback uses shared transport', () => {
  const env = networkEnvironment({ http_proxy: 'old', HTTPS_PROXY: 'old', npm_config_proxy: 'old', PATH: 'keep' }, { mode: 'direct' });
  assert.equal(env.http_proxy, undefined); assert.equal(env.HTTPS_PROXY, ''); assert.equal(env.NO_PROXY, '*');
  assert.equal(env.PATH, 'keep');
  assert.equal(networkEnvironment(env, { mode: 'prefer-direct', url: 'http://localhost:42' }).HTTPS_PROXY, 'http://localhost:42');
});
test('subscription engines honor central preference over legacy per-account proxies', () => {
  const { codexEnvironment } = require('../src/engines/codex-client');
  const { subscriptionEnvironment } = require('../src/engines/antigravity/subscription');
  for (const mode of ['direct', 'system', 'prefer-direct']) {
    const env = networkEnvironment({ https_proxy: 'http://old:10' }, { mode, url: 'http://localhost:12345' });
    for (const actual of [codexEnvironment('/test', env, 'http://legacy:1'), subscriptionEnvironment(env, 'http://legacy:1')]) {
      assert.equal(actual.HTTPS_PROXY, mode === 'direct' ? '' : 'http://localhost:12345');
      assert.equal(actual.https_proxy, undefined);
    }
  }
});
test('a ChatGPT subscription uses the real proxy instead of the prefer-direct bridge', () => {
  const { codexEnvironment } = require('../src/engines/codex-client');
  // "Prefer direct" installs a loopback bridge for the API engines; the
  // ChatGPT CLI must skip that direct first attempt and go straight to the
  // detected proxy, or sign-in and streaming hang on the blocked route.
  const env = networkEnvironment({ https_proxy: 'http://old:10', CAMELLIA_SUBSCRIPTION_PROXY: 'http://127.0.0.1:7890/' },
    { mode: 'prefer-direct', url: 'http://127.0.0.1:54321', subscriptionProxy: 'http://127.0.0.1:7890/' });
  const subscription = codexEnvironment('/test', env, '', { subscription: true });
  assert.equal(subscription.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(subscription.ALL_PROXY, '');
  // An API route keeps the bridge because it dials direct first and falls back.
  const api = codexEnvironment('/test', env, '', { subscription: false });
  assert.equal(api.HTTPS_PROXY, 'http://127.0.0.1:54321');
  // Without a detected proxy the subscription connects directly.
  assert.equal(subscriptionEnvironment({ CAMELLIA_SUBSCRIPTION_PROXY: '', HTTPS_PROXY: 'http://stale:1' }).HTTPS_PROXY, '');
  assert.equal(subscriptionEnvironment({ CAMELLIA_SUBSCRIPTION_PROXY: 'http://127.0.0.1:7890/' }).NO_PROXY, 'localhost,127.0.0.1,::1');
});
test('three modes persist, share download transport and do not save missing system proxy', async () => {
  let config = {}, route = 'PROXY localhost:7890', applied;
  const service = createNetworkSettings({ loadConfig: () => config, saveConfig: value => Object.assign(config, value),
    sessions: () => ({ fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => route }), defaultSession: { setProxy: async () => {} } }),
    applyEnvironment: env => { applied = env; }, createFallback: async () => ({ url: 'http://127.0.0.1:12345', close() {} }) });
  await service.save({ mode: 'system' }); assert.equal(applied.HTTPS_PROXY, 'http://localhost:7890/');
  await service.save({ mode: 'prefer-direct' }); assert.equal(config.network.mode, 'prefer-direct');
  assert.equal(config.downloadProxy.url, applied.HTTPS_PROXY);
  route = 'DIRECT'; await assert.rejects(service.save({ mode: 'system' }), /No system proxy/);
  assert.equal(config.network.mode, 'prefer-direct');
  await service.save({ mode: 'direct' }); assert.equal(applied.NO_PROXY, '*');
  // Startup must not install a loopback proxy with no upstream: the embedded
  // Tailscale node reads this environment and would then never reach its
  // control plane. Fall back to a direct connection and keep the reason.
  config.network.mode = 'system'; await service.initialize();
  assert.equal(applied.HTTPS_PROXY, ''); assert.equal(applied.NO_PROXY, '*');
  assert.match(service.state().error, /No system proxy/);
});
test('a system proxy that cannot reach the internet downgrades to prefer-direct once', async () => {
  let config = { network: { mode: 'system' } }, applied, events = [];
  const service = createNetworkSettings({ loadConfig: () => config, saveConfig: value => Object.assign(config, value),
    sessions: () => ({ fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'PROXY localhost:7890' }), defaultSession: { setProxy: async () => {} } }),
    applyEnvironment: env => { applied = env; }, createFallback: async () => ({ url: 'http://127.0.0.1:12345', close() {} }),
    healthCheckImpl: async () => ({ direct: true, proxy: false }), onHealthChange: payload => events.push(payload) });
  await service.initialize();
  // Startup probes first, so the dead proxy never becomes the live transport.
  assert.equal(service.state().mode, 'prefer-direct'); assert.equal(service.state().degraded, true);
  assert.equal(applied.HTTPS_PROXY, 'http://127.0.0.1:12345'); // prefer-direct keeps a bridge
  assert.deepEqual(events.map(event => event.degraded), [true]);
  assert.equal(events[0].proxy, 'http://localhost:7890/');
  // Re-probing while still broken must not notify or re-apply repeatedly.
  await service.checkHealth();
  assert.deepEqual(events.map(event => event.degraded), [true]);
  // Reading the settings state must not hide the downgrade behind a re-detect.
  await service.detect();
  assert.equal(service.state().degraded, true); assert.equal(service.state().mode, 'prefer-direct');
  service.close();
});
test('a recovered proxy restores the stored system-proxy choice', async () => {
  let config = { network: { mode: 'system' } }, applied, proxyDown = true, events = [];
  const service = createNetworkSettings({ loadConfig: () => config, saveConfig: value => Object.assign(config, value),
    sessions: () => ({ fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'PROXY localhost:7890' }), defaultSession: { setProxy: async () => {} } }),
    applyEnvironment: env => { applied = env; }, createFallback: async () => ({ url: 'http://127.0.0.1:12345', close() {} }),
    healthCheckImpl: async () => ({ direct: true, proxy: !proxyDown }), onHealthChange: payload => events.push(payload) });
  await service.initialize();
  assert.equal(service.state().mode, 'prefer-direct');
  proxyDown = false;
  await service.checkHealth();
  assert.equal(service.state().mode, 'system'); assert.equal(service.state().degraded, false);
  assert.equal(applied.HTTPS_PROXY, 'http://localhost:7890/');
  assert.equal(config.network.mode, 'system'); // the stored choice was never rewritten
  assert.deepEqual(events.map(event => event.degraded), [true, false]);
  service.close();
});
test('a proxy that also blocks direct connections is not downgraded', async () => {
  let config = { network: { mode: 'system' } }, events = [];
  const service = createNetworkSettings({ loadConfig: () => config, saveConfig: value => Object.assign(config, value),
    sessions: () => ({ fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'PROXY localhost:7890' }), defaultSession: { setProxy: async () => {} } }),
    applyEnvironment: () => {}, createFallback: async () => ({ url: 'http://127.0.0.1:12345', close() {} }),
    healthCheckImpl: async () => ({ direct: false, proxy: false }), onHealthChange: payload => events.push(payload) });
  await service.initialize();
  await service.checkHealth();
  assert.equal(service.state().mode, 'system'); assert.equal(service.state().degraded, false);
  assert.equal(events.length, 0);
  service.close();
});
test('healthCheck probes direct and proxy routes over raw TCP', async () => {
  const { healthCheck } = require('../src/main/network-settings');
  const net = require('node:net');
  const origin = net.createServer(socket => socket.end());
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${origin.address().port}`;
  assert.deepEqual(await healthCheck('http://127.0.0.1:1', { url: target, timeout: 300 }), { direct: true, proxy: false });
  origin.closeAllConnections?.(); origin.close();
});
function probeStub(summary) {
  return async (targets, options) => targets.map(target => ({ ...target,
    direct: summary.direct, proxy: summary.proxy, preferred: summary.direct ? 'direct' : 'proxy', durationMs: 1 }));
}
test('connectivity test probes provider hosts and signed-in subscriptions without changing the mode', async () => {
  const providerTargetsImpl = () => [{ id: 'api.a.example:443', kind: 'provider', host: 'api.a.example', port: 443, label: 'Provider A', models: ['a-1'] }];
  let config = { network: { mode: 'system' } }, applied;
  const service = createNetworkSettings({ loadConfig: () => config, saveConfig: value => Object.assign(config, value),
    sessions: () => ({ fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'PROXY localhost:7890' }), defaultSession: { setProxy: async () => {} } }),
    applyEnvironment: env => { applied = env; }, createFallback: async () => ({ url: 'http://127.0.0.1:12345', close() {} }),
    providerTargetsImpl, subscriptionEngines: () => ['codex'], probeImpl: probeStub({ direct: true, proxy: false }) });
  const result = await service.testConnectivity();
  assert.equal(result.ok, true);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.direct, 2);
  // A read-only test never rewrites the stored choice or the live transport.
  assert.equal(config.network.mode, 'system'); assert.equal(applied, undefined);
  service.close();
});
test('auto falls back to the system proxy when a direct connection fails', async () => {
  const providerTargetsImpl = () => [{ id: 'api.a.example:443', kind: 'provider', host: 'api.a.example', port: 443, label: 'Provider A', models: [] }];
  let config = {}, applied;
  const service = createNetworkSettings({ loadConfig: () => config, saveConfig: value => Object.assign(config, value),
    sessions: () => ({ fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'PROXY localhost:7890' }), defaultSession: { setProxy: async () => {} } }),
    applyEnvironment: env => { applied = env; }, createFallback: async () => ({ url: 'http://127.0.0.1:12345', close() {} }),
    providerTargetsImpl, subscriptionEngines: () => [], probeImpl: probeStub({ direct: false, proxy: true }) });
  const result = await service.save({ mode: 'auto' });
  // Direct is blocked, so the proxy stays live even though "auto" was selected.
  assert.equal(applied.HTTPS_PROXY, 'http://localhost:7890/');
  assert.equal(result.mode, 'auto'); assert.equal(result.autoFallback, true); assert.equal(result.directFirst, false);
  assert.equal(config.network.mode, 'auto');
  service.close();
});
test('auto takes the direct-first bridge when direct works everywhere', async () => {
  const providerTargetsImpl = () => [{ id: 'api.a.example:443', kind: 'provider', host: 'api.a.example', port: 443, label: 'Provider A', models: [] }];
  let config = {}, applied;
  const service = createNetworkSettings({ loadConfig: () => config, saveConfig: value => Object.assign(config, value),
    sessions: () => ({ fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'PROXY localhost:7890' }), defaultSession: { setProxy: async () => {} } }),
    applyEnvironment: env => { applied = env; }, createFallback: async () => ({ url: 'http://127.0.0.1:12345', close() {} }),
    providerTargetsImpl, subscriptionEngines: () => [], probeImpl: probeStub({ direct: true, proxy: true }) });
  const result = await service.save({ mode: 'auto' });
  assert.equal(applied.HTTPS_PROXY, 'http://127.0.0.1:12345'); assert.equal(applied.CAMELLIA_NETWORK_MODE, 'auto');
  assert.equal(result.mode, 'auto'); assert.equal(result.directFirst, true); assert.equal(result.autoFallback, false);
  service.close();
});

async function fixture(t, failDirect) {
  let proxied = 0, received = 0;
  const origin = http.createServer((req, res) => { received++; res.statusCode = req.url === '/quota' ? 429 : 200; res.end('response'); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer(); const sockets = new Set();
  proxy.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  proxy.on('connect', (req, socket, head) => {
    proxied++;
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 OK\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const connect = failDirect ? () => { const socket = new PassThrough(); process.nextTick(() => socket.destroy(Object.assign(new Error('blocked'), { code: 'ECONNREFUSED' }))); return socket; } : net.connect;
  const bridge = await createFallbackProxy(`http://127.0.0.1:${proxy.address().port}`, { connect, timeout: 100 });
  t.after(() => { bridge.close(); for (const socket of sockets) socket.destroy(); proxy.close(); origin.closeAllConnections(); origin.close(); });
  async function request(path = '/') {
    return new Promise((resolve, reject) => {
      const req = http.request(bridge.url, { method: 'POST', path: `http://127.0.0.1:${origin.address().port}${path}`, agent: false }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }); req.on('error', reject); req.end('one request');
    });
  }
  return { request, counts: () => ({ proxied, received }), bridge, origin };
}
test('successful direct requests and HTTP quota errors never trigger proxy retry', async t => {
  const f = await fixture(t, false);
  assert.equal(await f.request(), 200); assert.equal(await f.request('/quota'), 429);
  assert.deepEqual(f.counts(), { proxied: 0, received: 2 });
});
test('failed direct connection falls back once, sending POST exactly once', async t => {
  const f = await fixture(t, true);
  assert.equal(await f.request(), 200); assert.deepEqual(f.counts(), { proxied: 1, received: 1 });
});
test('CONNECT clients also use the fallback transport', async t => {
  const f = await fixture(t, true);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.bridge.url, { method: 'CONNECT', path: `127.0.0.1:${f.origin.address().port}` });
    req.on('error', reject); req.on('connect', (res, socket) => {
      let data = ''; socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    }); req.end();
  });
  assert.match(status, /200 OK/); assert.deepEqual(f.counts(), { proxied: 1, received: 1 });
});
