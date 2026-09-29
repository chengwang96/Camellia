'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { detectedProxy, networkEnvironment, createNetworkSettings } = require('../src/main/network-settings');
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
  config.network.mode = 'system'; await service.initialize();
  assert.equal(applied.HTTPS_PROXY, 'http://127.0.0.1:12345'); // unavailable system proxy fails closed
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
