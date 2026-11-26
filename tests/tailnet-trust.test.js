'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { TailnetTrust } = require('../src/main/remote/tailnet-trust');
const { removeTree } = require('./test-fs.cjs');

function fixture(context, { autoApprove = false, enabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tailnet-'));
  const trust = new TailnetTrust({ file: path.join(root, 'tailnet-trust.json') });
  trust.setIdentity({ userId: '42', login: 'me@example.com', displayName: 'Me', tailnet: 'example.ts.net' });
  trust.update({ enabled, autoApprove });
  const access = new RemoteAccess({ file: path.join(root, 'devices.json'), tailnetTrust: trust });
  const gateway = new RemoteGateway({ access, reader: null, commands: null, computerId: 'computer-1',
    computerName: 'Study PC', tailnetTrust: trust, validateHost: host => host === '127.0.0.1',
    transportInfo: () => ({
      lan: { protocol: 1, url: 'https://192.168.1.8:43127', fingerprint: 'a'.repeat(64), allowJoin: true },
      tailscale: { protocol: 1, url: 'http://100.80.1.2:43127', address: '100.80.1.2' },
    }) });
  context.after(async () => { await gateway.stop(); removeTree(root); });
  return { root, trust, access, gateway };
}

function identity(nodeId = 'phone-node') {
  return { 'x-camellia-tailnet-node': nodeId, 'x-camellia-tailnet-user': '42',
    'x-camellia-tailnet-login': 'me@example.com', 'x-camellia-tailnet-name': 'phone.tailnet.ts.net',
    'x-camellia-tailnet-tags': 'tag:phone' };
}

async function raw(url, { method = 'GET', headers = {}, payload } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: {
      ...headers, ...(payload ? { 'Content-Type': 'application/json' } : {}),
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { body = Buffer.concat(chunks).toString('utf8'); }
        resolve({ status: response.statusCode, body });
      });
    });
    request.on('error', reject);
    request.end(payload ? JSON.stringify(payload) : undefined);
  });
}

test('Tailnet trust evaluates the owner, explicit users, tags and auto-approval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tailnet-policy-'));
  const file = path.join(root, 'policy.json');
  try {
    const trust = new TailnetTrust({ file });
    trust.setIdentity({ userId: '42', login: 'me@example.com', displayName: 'Me', tailnet: 'example.ts.net' });
    assert.equal(trust.evaluate({ nodeId: 'n1', userId: '42' }).allowed, false);
    trust.update({ enabled: true });
    assert.deepEqual(trust.evaluate({ nodeId: 'n1', userId: '42' }), { allowed: true, autoApprove: false, reason: 'owner' });
    assert.equal(trust.evaluate({ nodeId: 'n2', userId: '99', login: 'other@example.com' }).allowed, false);
    trust.update({ allowedUsers: ['other@example.com'], allowedTags: ['tag:phone'] });
    assert.equal(trust.evaluate({ nodeId: 'n2', userId: '99', login: 'other@example.com' }).reason, 'user');
    assert.equal(trust.evaluate({ nodeId: 'n3', userId: '100', tags: ['tag:phone'] }).reason, 'tag');
    trust.update({ autoApprove: true });
    assert.equal(trust.evaluate({ nodeId: 'n1', userId: '42' }).autoApprove, true);
    trust.update({ enabled: false });
    assert.equal(trust.evaluate({ nodeId: 'n1', userId: '42' }).autoApprove, false);
    assert.equal(trust.view().ready, true);
    trust.update({ enabled: true, allowedTags: ['tag:phone'] });
    const reopened = new TailnetTrust({ file });
    assert.equal(reopened.view().enabled, true);
    assert.deepEqual(reopened.view().allowedTags, ['tag:phone']);
    assert.equal(reopened.view().ownerLogin, 'me@example.com');
  } finally {
    removeTree(root);
  }
});

test('Tailnet pairing stays pending, claims only from the same node and records its identity', async context => {
  const { trust, access } = fixture(context);
  const request = access.requestTailnet({ name: 'Phone' }, { nodeId: 'phone-node', userId: '42',
    login: 'me@example.com', name: 'phone.tailnet.ts.net', tags: ['tag:phone'] });
  assert.equal(request.state, 'pending');
  assert.equal(access.view().pending[0].auth, 'tailnet');
  assert.equal(access.view().pending[0].tailnet.nodeId, 'phone-node');
  assert.throws(() => access.claim(request.id, request.claim, { nodeId: 'other-node' }), /Tailnet device changed/);
  access.approve(request.id);
  const claimed = access.claim(request.id, request.claim, { nodeId: 'phone-node' });
  assert.equal(claimed.state, 'approved');
  assert.equal(claimed.auth, 'tailnet');
  assert.equal(claimed.tailnet.nodeId, 'phone-node');
  assert.equal(access.view().devices[0].auth, 'tailnet');
  assert.equal(access.view().devices[0].tailnet.login, 'me@example.com');
  assert.throws(() => access.requestTailnet({ name: 'Phone' }, { nodeId: 'phone-node', userId: '42' }),
    /already authorized/);
  assert.equal(trust.view().enabled, true);
});

test('Tailnet auto-approval issues a claim immediately and a disabled policy rejects access', async context => {
  const { trust, access } = fixture(context, { autoApprove: true });
  const request = access.requestTailnet({ name: 'Phone' }, { nodeId: 'phone-auto', userId: '42',
    login: 'me@example.com' });
  assert.equal(request.state, 'approved');
  const claimed = access.claim(request.id, request.claim, { nodeId: 'phone-auto' });
  assert.equal(claimed.state, 'approved');
  trust.update({ enabled: false });
  assert.throws(() => access.requestTailnet({ name: 'Other' }, { nodeId: 'phone-2', userId: '42' }),
    /disabled/);
});

test('hello is available before device authentication and exposes the trust contract', async context => {
  const { gateway } = fixture(context);
  await gateway.start('127.0.0.1', 0);
  const response = await raw(gateway.url + '/v1/hello');
  assert.equal(response.status, 200);
  assert.equal(response.body.app, 'camellia');
  assert.equal(response.body.computerId, 'computer-1');
  assert.equal(response.body.computerName, 'Study PC');
  assert.deepEqual(response.body.auth, { tailnet: true, lan: true, pairing: true });
  assert.deepEqual(response.body.join, { tailnet: true, lan: true, pairing: true });
  assert.equal(response.body.transports.lan.allowJoin, true);
});

test('the embedded gateway requires a verified identity and returns a tailnet claim', async context => {
  const { access, gateway } = fixture(context);
  const token = 'a'.repeat(64);
  await gateway.start('127.0.0.1', 0, { address: '100.80.1.2', token });
  const port = gateway.server.address().port;
  const url = `http://127.0.0.1:${port}/v1/tailnet/request`;
  const headers = { Host: '100.80.1.2:43127', 'X-Camellia-Transport': token,
    'X-Camellia-Peer': '100.90.1.2', ...identity() };
  const requested = await raw(url, { method: 'POST', headers, payload: { name: 'Phone' } });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.state, 'pending');
  assert.equal(requested.body.computerName, 'Study PC');
  assert.equal(access.view().pending[0].tailnet.login, 'me@example.com');

  const unverified = await raw(url, { method: 'POST',
    headers: { Host: '100.80.1.2:43127', 'X-Camellia-Transport': token, 'X-Camellia-Peer': '100.90.1.2' },
    payload: { name: 'Phone' } });
  assert.equal(unverified.status, 403);

  access.approve(requested.body.id);
  const claimed = await raw(`http://127.0.0.1:${port}/v1/tailnet/claim`, { method: 'POST', headers,
    payload: { id: requested.body.id, claim: requested.body.claim } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.state, 'approved');
  assert.equal(claimed.body.auth, 'tailnet');
  assert.equal(claimed.body.computerId, 'computer-1');
  assert.match(claimed.body.token, /^[A-Za-z0-9_-]{43}$/);
});
