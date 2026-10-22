'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createRemoteService } = require('../src/main/remote/service');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { EmbeddedNetwork } = require('../src/main/remote/embedded-network');
const { removeTree } = require('./test-fs.cjs');

async function harness(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-path-'));
  const token = 'a'.repeat(43), probes = [];
  fs.mkdirSync(path.join(root, 'remote'));
  fs.writeFileSync(path.join(root, 'remote/devices.json'), JSON.stringify({ devices: [{ id: 'phone', name: 'Phone', permission: 'control',
    tokenDigest: createHash('sha256').update(token).digest('hex'), allWorkspaces: true, includeUnassigned: true, workspaceIds: [] }] }));
  let transport;
  const network = {
    snapshot: { state: 'Stopped' },
    async start() { this.snapshot = { state: 'Running', address: '100.80.1.2' }; },
    async status() { return this.snapshot; },
    async listen(target, secret) { transport = { target, secret }; },
    async stop() { this.snapshot = { state: 'Stopped' }; },
    async diagnosePeer(address) { probes.push(address); return { peerAddress: address, path: 'direct', endpoint: '203.0.113.4:41641', latencyMs: 21, checkedAt: Date.now() }; },
  };
  const service = createRemoteService({ dataDir: root, networkFactory: () => network,
    manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } } });
  context.after(async () => { await service.close(); removeTree(root); });
  await service.startTrustedDevices();
  const request = (headers = {}) => new Promise((resolve, reject) => {
    const req = http.get(new URL('/v1/diagnostic-test', transport.target), { headers: {
      Host: '100.80.1.2:43127', Authorization: `Bearer ${token}`,
      'X-Camellia-Transport': transport.secret, 'X-Camellia-Peer': '100.90.1.2', ...headers,
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    req.on('error', reject);
  });
  return { service, network, request, probes };
}

test('diagnostics target the authenticated phone rather than a caller-supplied address', async context => {
  const { service, request, probes } = await harness(context);
  assert.match((await service.command('diagnose', { id: 'phone' })).error, /Open this computer on the phone/);
  assert.equal(await request({ Authorization: `Bearer ${'b'.repeat(43)}` }), 401);
  assert.equal(await request({ 'X-Camellia-Transport': 'b'.repeat(64) }), 403);
  assert.equal((await service.command('state')).result.devices[0].peerAddress, null);
  assert.equal(await request(), 404);
  assert.equal((await service.command('state')).result.devices[0].peerAddress, '100.90.1.2');
  assert.equal((await service.command('diagnose', { id: 'unknown', target: '127.0.0.1' })).ok, false);
  const result = await service.command('diagnose', { id: 'phone', target: '127.0.0.1' });
  assert.equal(result.result.path, 'direct'); assert.deepEqual(probes, ['100.90.1.2']);
  await service.command('stop');
  assert.equal((await service.command('state')).result.devices[0].peerAddress, null);
  assert.equal((await service.command('diagnose', { id: 'phone' })).ok, false);
});

test('probe failures leave networking running, and revocation discards a pending result', async context => {
  const { service, network, request } = await harness(context);
  await request();
  network.diagnosePeer = async () => { throw new Error('Probe failed'); };
  assert.equal((await service.command('diagnose', { id: 'phone' })).error, 'Probe failed');
  assert.equal((await service.command('state')).result.running, true);
  assert.equal(network.snapshot.state, 'Running');
  let finish;
  network.diagnosePeer = () => new Promise(resolve => { finish = resolve; });
  const pending = service.command('diagnose', { id: 'phone' });
  assert.equal((await service.command('diagnose', { id: 'phone' })).ok, false);
  assert.equal((await service.command('state')).result.running, true);
  await service.command('revoke', { id: 'phone' });
  finish({ path: 'direct' });
  assert.match((await pending).error, /connection changed/);
});

test('a plain HTTP listener cannot learn a peer from a forged helper header', async context => {
  const gateway = new RemoteGateway({ access: { authenticate: () => ({ id: 'phone' }), clearPairing() {} }, reader: {},
    validateHost: host => host === '127.0.0.1' });
  context.after(() => gateway.stop());
  await gateway.start('127.0.0.1', 0);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(gateway.url + '/v1/diagnostic-test', { headers: { Authorization: `Bearer ${'a'.repeat(43)}`, 'X-Camellia-Peer': '100.90.1.2' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(status, 404); assert.equal(gateway.peerAddresses.size, 0);
});

test('an outdated helper explains the restart and diagnostic targets stay restricted', async () => {
  const network = new EmbeddedNetwork({}); network.child = {};
  let called = false;
  network.request = async () => { called = true; throw new Error('unsupported network action'); };
  await assert.rejects(network.diagnosePeer('127.0.0.1'), /Invalid diagnostic/); assert.equal(called, false);
  await assert.rejects(network.diagnosePeer('100.90.1.2'), /updated helper.*restart/);
  assert.ok(network.child, 'Unsupported diagnostics must not stop existing remote access');
});
