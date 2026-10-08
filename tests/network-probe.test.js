'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { providerTargets, subscriptionTargets, probeTarget, probeTargets, summarize } = require('../src/main/network-probe');

const config = { providers: [
  { id: 'a', name: 'Provider A', enabled: true, baseUrl: 'https://api.a.example/v1',
    models: [{ id: 'a-1' }, { id: 'a-2' }], keys: [{ enabled: true }] },
  { id: 'b', name: 'Provider B', enabled: true, baseUrl: 'https://api.b.example/v1',
    anthropicBaseUrl: 'https://api.b.example/anthropic/v1', models: [{ id: 'b-1' }], keys: [{ enabled: true }] },
  { id: 'off', name: 'Disabled', enabled: false, baseUrl: 'https://off.example/v1',
    models: [{ id: 'off-1' }], keys: [{ enabled: true }] },
  { id: 'nokey', name: 'No key', enabled: true, baseUrl: 'https://nokey.example/v1',
    models: [{ id: 'nokey-1' }], keys: [{ enabled: false }] },
] };

test('provider targets are grouped per host and skip disabled providers', () => {
  const targets = providerTargets(config);
  assert.deepEqual(targets.map(target => target.id).sort(), ['api.a.example:443', 'api.b.example:443']);
  const a = targets.find(target => target.id === 'api.a.example:443');
  assert.equal(a.port, 443);
  assert.equal(a.secure, true);
  assert.deepEqual(a.models.sort(), ['a-1', 'a-2']);
  assert.equal(a.label, 'Provider A');
  // A provider with an Anthropic endpoint is probed once per host, not per key.
  assert.equal(targets.filter(target => target.id === 'api.b.example:443').length, 1);
});

test('subscription targets only cover signed-in engines', () => {
  assert.deepEqual(subscriptionTargets([]), []);
  const targets = subscriptionTargets(['codex', 'antigravity']);
  assert.deepEqual(targets.map(target => [target.engine, target.host]),
    [['codex', 'chatgpt.com'], ['antigravity', 'cloudcode-pa.googleapis.com']]);
});

test('a target reports direct and proxy reachability independently', async () => {
  const origin = net.createServer(socket => socket.end());
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const result = await probeTarget({ id: 't', host: '127.0.0.1', port: origin.address().port, label: 'Local' },
    { proxyUrl: 'http://127.0.0.1:1', timeout: 300 });
  assert.equal(result.direct, true);
  assert.equal(result.proxy, false);
  assert.equal(result.preferred, 'direct');
  origin.closeAllConnections?.(); origin.close();
});

test('HTTPS reachability rejects a route that accepts TCP but never completes TLS', async t => {
  const sockets = new Set();
  const origin = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => {}); // TCP succeeds; no TLS ServerHello is returned.
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); origin.close(); });
  const target = { id: 't', host: '127.0.0.1', port: origin.address().port, label: 'Local' };
  const tcp = await probeTarget({ ...target, secure: false }, { timeout: 100 });
  assert.equal(tcp.direct, true);
  const https = await probeTarget({ ...target, secure: true }, { timeout: 100 });
  assert.equal(https.direct, false);
  assert.equal(https.preferred, 'none');
});

test('summary counts routes and flags unreachable hosts', () => {
  const results = [
    { kind: 'provider', label: 'A', direct: true, proxy: true },
    { kind: 'provider', label: 'B', direct: false, proxy: true },
    { kind: 'subscription', label: 'ChatGPT account', direct: false, proxy: true },
  ];
  const summary = summarize(results);
  assert.equal(summary.total, 3);
  assert.equal(summary.direct, 1);
  assert.equal(summary.proxy, 3);
  assert.deepEqual(summary.unreachable, []);
  assert.equal(summary.hasSubscriptions, true);
  // A blocked subscription host keeps "auto" on the real proxy.
  assert.equal(summary.subscriptionDirect, false);
});

test('probes run with bounded concurrency and keep result order', async () => {
  const seen = new Set();
  const targets = Array.from({ length: 9 }, (_, index) => ({ id: 't' + index, host: 'h' + index, port: 443 }));
  const results = await probeTargets(targets, { probe: async target => { seen.add(target.id); return target.id; } });
  assert.deepEqual(results, targets.map(target => target.id));
  assert.equal(seen.size, 9);
});
