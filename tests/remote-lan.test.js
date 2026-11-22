'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { DISCOVERY_MESSAGE, LanAccess, LanDiscovery, LanIdentity, LanUdpDiscovery, MAX_FAILURES, chooseLanAddress, isPrivateIPv4 } = require('../src/main/remote/lan');
const { removeTree } = require('./test-fs.cjs');

function workspace(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-lan-'));
  context.after(() => removeTree(root));
  return root;
}

function request(port, route, { method = 'GET', token, payload, host } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = https.request({
      host: '127.0.0.1',
      port,
      path: route,
      method,
      rejectUnauthorized: false,
      headers: {
        host: host || `127.0.0.1:${port}`,
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('LAN PIN is hashed, rate limited and enrolls a device token', async context => {
  const root = workspace(context);
  const access = new RemoteAccess({ file: path.join(root, 'devices.json') });
  const lan = new LanAccess({ file: path.join(root, 'lan.json'), access });
  assert.equal(lan.setPin('123456').pin, '');
  assert.equal(lan.setEnabled(true).enabled, true);
  const joined = lan.join({ pin: '123456', name: 'Android', remoteAddress: '192.168.1.8' });
  assert.equal(joined.permission, 'control');
  assert.equal(access.devices.length, 1);
  const reused = lan.join({ pin: '123456', name: 'Android again', token: joined.token, remoteAddress: '192.168.1.8' });
  assert.equal(reused.deviceId, joined.deviceId);
  assert.equal(reused.token, joined.token);
  assert.equal(access.devices.length, 1);
  lan.setAllowJoin(false);
  assert.equal(lan.join({ pin: '123456', name: 'Android again', token: joined.token, remoteAddress: '192.168.1.8' }).deviceId, joined.deviceId);
  assert.throws(() => lan.join({ pin: '123456', name: 'New phone', remoteAddress: '192.168.1.8' }), /not allowed/);
  for (let index = 0; index < MAX_FAILURES; index++) {
    assert.throws(() => lan.join({ pin: '000000', name: 'Phone', remoteAddress: '192.168.1.9' }), /Incorrect LAN PIN/);
  }
  assert.throws(() => lan.verifyPin('123456', '192.168.1.9'), /too many/i);
  assert.equal(lan.verifyPin('123456', '192.168.1.10'), undefined);
});

test('LAN identity inspection does not generate a certificate before it is needed', async context => {
  const root = workspace(context), file = path.join(root, 'identity.json');
  const identity = new LanIdentity({ file, computerId: 'computer-before-certificate' });
  assert.deepEqual(identity.peek(), { computerId: 'computer-before-certificate', fingerprint: '' });
  assert.equal(fs.existsSync(file), false);
  assert.equal(identity.view().computerId, 'computer-before-certificate');
  assert.equal(fs.existsSync(file), true);
});

test('LAN identity survives restart and keeps one certificate fingerprint', async context => {
  const root = workspace(context);
  const file = path.join(root, 'identity.json');
  const first = new LanIdentity({ file }).view();
  const second = new LanIdentity({ file }).view();
  assert.equal(first.computerId, second.computerId);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
});

test('LAN gateway uses HTTPS, rejects wrong PIN and accepts the issued token', async context => {
  const root = workspace(context);
  const access = new RemoteAccess({ file: path.join(root, 'devices.json') });
  const lanAccess = new LanAccess({ file: path.join(root, 'lan.json'), access });
  lanAccess.setEnabled(true);
  lanAccess.setPin('654321');
  const identity = new LanIdentity({ file: path.join(root, 'identity.json') }).get();
  let gateway;
  gateway = new RemoteGateway({
    access,
    reader: { workspaces: () => [], manager: { remoteEngines: [] } },
    commands: null,
    lanAccess,
    computerId: identity.computerId,
    transportInfo: () => ({ lan: { protocol: 1, url: gateway.url, fingerprint: identity.fingerprint } }),
  });
  await gateway.start('127.0.0.1', 0, { mode: 'lan', certificate: identity.certificate, privateKey: identity.privateKey });
  context.after(() => gateway.stop({ shared: true }));
  const port = gateway.server.address().port;

  const rejected = await request(port, '/v1/lan/join', { method: 'POST', payload: { pin: '111111', name: 'Phone' } });
  assert.equal(rejected.status, 401);
  const joined = await request(port, '/v1/lan/join', { method: 'POST', payload: { pin: '654321', name: 'Phone' } });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.permission, 'control');
  assert.equal(joined.body.computerId, identity.computerId);
  assert.equal(joined.body.lan.fingerprint, identity.fingerprint);

  assert.equal((await request(port, '/v1/status')).status, 401);
  const status = await request(port, '/v1/status', { token: joined.body.token });
  assert.equal(status.status, 200);
  assert.equal(status.body.protocol, 1);
  assert.equal(status.body.computerId, identity.computerId);
  assert.equal(status.body.transports.lan.fingerprint, identity.fingerprint);
  const wrongHost = await request(port, '/v1/status', { token: joined.body.token, host: `localhost:${port}` });
  assert.equal(wrongHost.status, 403);
});

test('LAN discovery publishes only connection hints and never the PIN', () => {
  const published = [];
  const stopped = [];
  const discovery = new LanDiscovery({
    createBonjour: () => ({
      publish(record) {
        published.push(record);
        return { on() {}, stop() { stopped.push(true); } };
      },
      destroy() { stopped.push(true); },
    }),
    createUdpSocket: () => ({ on() {}, bind() {}, close() {}, send() {} }),
  });
  discovery.start({ address: '192.168.1.5', port: 43127, computerId: 'computer-1', fingerprint: 'a'.repeat(64),
    computerName: 'Study PC', allowJoin: true });
  assert.equal(published[0].txt.id, 'computer-1');
  assert.equal(published[0].txt.ip, '192.168.1.5');
  assert.equal(published[0].txt.join, '1');
  assert.equal(Object.values(published[0].txt).includes('123456'), false);
  discovery.stop();
  assert.ok(stopped.length);
});

test('LAN UDP discovery answers the fixed broadcast probe without exposing the PIN', async () => {
  const replies = [];
  const socket = {
    on(name, listener) {
      if (name === 'message') this.message = listener;
      return this;
    },
    bind() {},
    close() {},
    send(payload, port, address) { replies.push({ payload, port, address }); },
  };
  const discovery = new LanUdpDiscovery({ createSocket: () => socket, port: 52638 });
  discovery.start({ address: '192.168.3.59', port: 4194, computerId: 'computer-1',
    fingerprint: 'a'.repeat(64), computerName: 'Study PC', allowJoin: true });
  socket.message(Buffer.from(DISCOVERY_MESSAGE), { address: '192.168.3.47', port: 40000 });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].address, '192.168.3.47');
  assert.equal(replies[0].port, 40000);
  const body = JSON.parse(replies[0].payload);
  assert.deepEqual(body, { v: 1, id: 'computer-1', name: 'Study PC', ip: '192.168.3.59',
    port: 4194, fp: 'a'.repeat(64), join: 1 });
  discovery.stop();
});

test('LAN address selection ignores virtual adapters and accepts only private addresses', () => {
  assert.equal(isPrivateIPv4('192.168.1.2'), true);
  assert.equal(isPrivateIPv4('::ffff:10.0.0.2'), true);
  assert.equal(isPrivateIPv4('100.64.0.1'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  const selected = chooseLanAddress({
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.7', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '10.0.0.7', internal: false }],
  });
  assert.equal(selected, '192.168.1.7');
});
