'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { createLanFirewall } = require('../src/main/remote/lan-firewall');
const { createMacLanPermissions } = require('../src/main/remote/mac-lan-permissions');
const { createRemoteService } = require('../src/main/remote/service');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { DISCOVERY_MESSAGE, LanAccess, LanDiscovery, LanIdentity, LanUdpDiscovery, MAX_FAILURES, chooseLanAddress, isPrivateIPv4 } = require('../src/main/remote/lan');
const { removeTree } = require('./test-fs.cjs');

function workspace(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-lan-'));
  context.after(() => removeTree(root));
  return root;
}

test('Windows LAN firewall prompts only for explicit changes and reuses existing rules', async () => {
  const scripts = [];
  const results = ['absent', 'absent', '', 'ready', 'ready', 'ready', '', 'absent'];
  const firewall = createLanFirewall({
    platform: 'win32', executable: "C:\\Users\\O'Neil\\Camellia.exe",
    run: async (file, args) => {
      assert.match(file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
      scripts.push(Buffer.from(args.at(-1), 'base64').toString('utf16le'));
      return { stdout: results.shift() };
    },
  });
  assert.equal(createLanFirewall({ platform: 'darwin' }), null);
  assert.equal(await firewall.configure(true), false);
  assert.equal(scripts.length, 1);
  assert.equal(await firewall.configure(true, { prompt: true }), true);
  assert.equal(await firewall.configure(true, { prompt: true }), true);
  assert.equal(await firewall.configure(false, { prompt: true }), true);
  const elevatedScripts = scripts.flatMap(script => {
    const match = script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)'/);
    return match ? [Buffer.from(match[1], 'base64').toString('utf16le')] : [];
  });
  assert.equal(elevatedScripts.length, 2);
  assert.match(elevatedScripts[0], /O''Neil/);
  assert.match(elevatedScripts[0], /\$rule.RemoteAddresses = 'LocalSubnet'/);
  assert.match(elevatedScripts[0], /\$rule.ApplicationName = \$application/);
  assert.ok(elevatedScripts[0].includes(`Ports = '${firewall.port}'`));
  assert.ok(elevatedScripts[0].includes("Ports = '5353,52638'"));
  assert.match(elevatedScripts[1], /if \(\$false\)/);
  assert.deepEqual(results, []);
});

test('explicit LAN retry and disable handle a cancelled Windows firewall request', async context => {
  context.mock.method(os, 'networkInterfaces', () => ({}));
  const calls = [];
  const dataDir = workspace(context);
  const service = createRemoteService({
    dataDir, manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } },
    networkFactory: () => ({ stop() {} }),
    lanFirewall: { async configure(enabled, options) {
      calls.push([enabled, options.prompt]);
      if (calls.length === 2) throw new Error('Cancelled');
      return true;
    } },
  });
  context.after(() => service.close());
  await service.startTrustedDevices();
  assert.equal((await service.command('lan-enable')).result.lan.firewall, 'authorization-required');
  assert.equal((await service.command('lan-enable')).result.lan.firewall, undefined);
  assert.equal((await service.command('lan-disable')).result.lan.firewall, undefined);
  assert.deepEqual(calls, [[false, false], [true, true], [true, true], [false, true]]);
});

test('macOS LAN settings open only supported system panels from local controls', async context => {
  const opened = [];
  const permissions = createMacLanPermissions({
    platform: 'darwin', release: '24.1.0', openExternal: async url => opened.push(url),
  });
  const service = createRemoteService({
    dataDir: workspace(context), manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } },
    networkFactory: () => ({ stop() {} }), macLanPermissions: permissions,
  });
  context.after(() => service.close());
  assert.deepEqual((await service.command('lan-state')).result.lan.macPermissionPanels, ['firewall', 'privacy']);
  assert.equal((await service.command('lan-open-mac-settings', { panel: 'privacy' })).ok, true);
  assert.equal((await service.command('lan-open-mac-settings', { panel: 'firewall' })).ok, true);
  assert.equal((await service.command('lan-open-mac-settings', { panel: 'https://example.test' })).ok, false);
  assert.deepEqual(opened, [
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork',
    'x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall',
  ]);
  assert.deepEqual(createMacLanPermissions({ platform: 'darwin', release: '23.6.0' }).panels, ['firewall']);
  assert.equal(createMacLanPermissions({ platform: 'win32' }), null);
  assert.ok(require('../package.json').build.mac.extendInfo.NSBonjourServices.includes('_camellia._tcp'));
});

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
  assert.equal(chooseLanAddress({
    utun4: [{ family: 'IPv4', address: '192.168.2.1', internal: false }],
    bridge100: [{ family: 'IPv4', address: '192.168.64.1', internal: false }],
    en0: [{ family: 'IPv4', address: '10.0.0.8', internal: false }],
  }), '10.0.0.8');
});
