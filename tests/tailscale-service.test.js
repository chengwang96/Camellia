'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRemoteService } = require('../src/main/remote/service');
const { TailscaleAPI } = require('../src/main/remote/tailscale-api');
const { removeTree } = require('./test-fs.cjs');

const credentials = { clientId: 'client-id.example', clientSecret: 'tskey-client-test-secret' };
const policy = { grants: [{ src: ['100.64.0.2'], dst: ['100.64.0.9'], app: { 'tailscale.com/cap/relay': [] } }] };
const selected = view => view.devices.find(device => device.id === 'relay1').relaySelected;
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', etag: 'W/"policy"' } });

function harness(context, { saved = false, readPolicy = () => response(policy) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-relay-service-'));
  const storage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  if (saved) new TailscaleAPI({ file: path.join(root, 'remote/tailscale-oauth.json'), safeStorage: storage }).save(credentials);
  let reads = 0;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ access_token: 'test-access-token', expires_in: 3600,
      scope: 'policy_file:write devices:core:write' });
    assert.equal(options.method, 'GET', 'an existing relay grant must not be rewritten');
    if (url.endsWith('/tailnet/-/devices')) return response({ devices: [
      { id: 'hp1', addresses: ['100.64.0.2'] },
      { id: 'relay1', name: 'relay.example.ts.net', os: 'linux', addresses: ['100.64.0.9'], connectedToControl: true },
    ] });
    if (url.endsWith('/tailnet/-/acl')) { reads++; return readPolicy(reads); }
    throw new Error(`Unexpected URL ${url}`);
  });
  const network = { snapshot: { state: 'Stopped' },
    async start() { this.snapshot = { state: 'Running', deviceId: 'embedded-node-id', address: '100.64.0.2' }; },
    async status() { return this.snapshot; }, async listen() {}, async stop() { this.snapshot = { state: 'Stopped' }; } };
  const service = createRemoteService({ dataDir: root, safeStorage: storage, networkFactory: () => network,
    manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } } });
  context.after(async () => { await service.close(); removeTree(root); });
  return { service, network, reads: () => reads };
}

test('saving credentials uses the embedded address immediately and unchanged polls do not reload relay state', async context => {
  const { service, reads } = harness(context);
  assert.equal((await service.command('start')).ok, true);
  const result = await service.command('tailscale-save', credentials);
  assert.equal(result.ok, true);
  assert.equal(selected(result.result), true);
  const before = reads();
  for (let i = 0; i < 3; i++) {
    assert.equal(selected((await service.command('state')).result.tailscale), true);
  }
  assert.equal(reads(), before);
});

test('enabling an already authorized relay returns on state through the service and later polls', async context => {
  const { service } = harness(context, { saved: true });
  assert.equal(selected((await service.command('tailscale-status')).result), false);
  await service.command('start');
  const result = await service.command('tailscale-apply-peer-relay', { enabled: true, deviceId: 'relay1' });
  assert.equal(result.ok, true);
  assert.equal(result.result.alreadyConfigured, true);
  assert.equal(selected(result.result), true);
  assert.equal(selected((await service.command('state')).result.tailscale), true);
});

test('a late startup status cannot overwrite the relay state returned by a newer command', async context => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const { service } = harness(context, { saved: true, readPolicy: count => {
    if (count === 1) { entered(); return delayed; }
    return response(policy);
  } });
  await started;
  await service.command('start');
  const result = await service.command('tailscale-apply-peer-relay', { enabled: true, deviceId: 'relay1' });
  assert.equal(selected(result.result), true);
  release(response({}));
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.equal(selected((await service.command('state')).result.tailscale), true);
});

test('a failed post-apply status read is visible instead of silently reverting to the old switch state', async context => {
  let remaining = 0;
  const { service } = harness(context, { saved: true, readPolicy: () => {
    if (remaining && --remaining === 0) throw new Error('Test control plane offline');
    return response(policy);
  } });
  await service.command('start');
  await service.command('tailscale-status');
  remaining = 2; // Initial apply read succeeds; verification read fails.
  const result = await service.command('tailscale-apply-peer-relay', { enabled: true, deviceId: 'relay1' });
  assert.equal(result.result.state, 'error');
  const view = (await service.command('state')).result.tailscale;
  assert.equal(view.state, 'error');
  assert.match(view.error, /Test control plane offline/);
});
