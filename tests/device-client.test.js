'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DeviceClient } = require('../src/main/remote/device-client');
const { RemoteAccess } = require('../src/main/remote/access');
const { removeTree } = require('./test-fs.cjs');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-devices-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  const key = crypto.randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-encrypted',
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
  const access = new RemoteAccess({ file: path.join(root, 'server.json') });
  const calls = [], connections = [], instanceId = crypto.randomUUID(), commonConversationId = crypto.randomUUID();
  const network = { async connect(address) {
    const connection = { closed: false,
      async json(endpoint, options = {}) {
        calls.push({ address, endpoint, options });
        if (endpoint === '/v1/pair/request') return access.request(options.body);
        if (endpoint === '/v1/pair/claim') return access.claim(options.body.id, options.body.claim);
        access.authenticate(options.bearer);
        if (endpoint === '/v1/status') return { instanceId, protocol: 1, capabilities: ['create'] };
        if (endpoint.startsWith('/v1/conversations?')) return { instanceId, conversations: [{ id: commonConversationId, title: address }] };
        if (endpoint.endsWith('/commands')) return { ok: true, state: 'accepted', requestId: options.body.requestId };
        return { conversation: { id: commonConversationId }, messages: [] };
      },
      async *events() { yield { type: 'snapshot', data: { instanceId } }; },
      async open(endpoint, options = {}) { access.authenticate(options.bearer); calls.push({ address, endpoint, options }); return { fixtureStream: true }; },
      async close() { this.closed = true; },
    };
    connections.push(connection); return connection;
  } };
  const file = path.join(root, 'desktop-devices.json');
  const client = new DeviceClient({ file, safeStorage: storage, network });
  const clients = [client];
  context.after(async () => { for (const instance of clients) await instance.close(); removeTree(root); });
  async function pair(address = 'http://100.80.1.2:43127') {
    const invitation = access.invite([], { allWorkspaces: true, includeUnassigned: true });
    const pending = await client.pair({ address, code: invitation.code, clientName: 'My GUI', deviceName: 'Server' });
    assert.equal((await client.claim(pending.id)).state, 'pending');
    access.approve(access.view().pending[0].id);
    return client.claim(pending.id);
  }
  return { client, clients, access, pair, file, storage, network, calls, connections, instanceId, commonConversationId };
}

test('device pairing waits for local approval, encrypts credentials and exposes only device metadata', async context => {
  const { client, clients, access, pair, file, storage, network, calls } = fixture(context);
  const paired = await pair();
  assert.equal(paired.state, 'approved');
  assert.equal(paired.device.name, 'Server');
  const status = await client.status(paired.id);
  assert.equal(status.protocol, 1);
  const token = calls.at(-1).options.bearer;
  assert.equal(typeof token, 'string');
  assert.equal(JSON.stringify(client.list()).includes(token), false);
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes(token), false);
  assert.equal(disk.includes('100.80.1.2'), false);
  assert.equal(access.view().devices.length, 1);
  const restored = new DeviceClient({ file, safeStorage: storage, network }); clients.push(restored);
  assert.deepEqual(restored.list(), client.list());
  assert.equal((await restored.status(paired.id)).protocol, 1);
});

test('device contexts isolate identical conversation IDs and commands preserve retry identity', async context => {
  const { client, pair, instanceId, calls, commonConversationId } = fixture(context);
  const first = await pair(), second = await pair('http://100.80.1.3:43127');
  const firstList = await client.conversations(first.id), secondList = await client.conversations(second.id);
  assert.equal(firstList.conversations[0].id, secondList.conversations[0].id);
  assert.notEqual(firstList.conversations[0].title, secondList.conversations[0].title);
  const command = { action: 'send', prompt: 'hello', requestId: crypto.randomUUID(), instanceId };
  await client.command(first.id, commonConversationId, command);
  assert.deepEqual(calls.at(-1).options.body, command);
  await assert.rejects(client.command(first.id, null, { action: 'create' }), /stable request ID/);
  assert.equal((await client.snapshot(first.id, commonConversationId)).conversation.id, commonConversationId);
  for await (const event of client.events(first.id)) assert.equal(event.data.instanceId, instanceId);
});

test('forget only deletes desktop credentials; server revocation remains separate', async context => {
  const { client, pair, access, connections } = fixture(context);
  const first = await pair();
  await client.forget(first.id);
  assert.deepEqual(client.list(), []);
  assert.equal(access.view().devices.length, 1);
  assert.equal(connections[0].closed, true);
  await assert.rejects(client.status(first.id), /not found/);
  const second = await pair();
  access.revoke(access.view().devices.at(-1).id);
  await assert.rejects(client.status(second.id), /authentication required/);
});

test('artifact and archive client methods scope requests to device credentials and validate IDs', async context => {
  const { client, pair, calls, commonConversationId } = fixture(context);
  const device = await pair();
  await client.artifacts(device.id, commonConversationId, 100);
  assert.equal(calls.at(-1).endpoint, `/v1/conversations/${commonConversationId}/artifacts?offset=100`);
  const abort = new AbortController();
  assert.equal((await client.artifact(device.id, commonConversationId, 'a'.repeat(64), abort.signal)).fixtureStream, true);
  assert.equal(calls.at(-1).options.signal, abort.signal);
  assert.match(calls.at(-1).options.bearer, /^[A-Za-z0-9_-]{43}$/);
  await client.archived(device.id, 0);
  assert.equal(calls.at(-1).endpoint, '/v1/archived?offset=0');
  assert.throws(() => client.artifacts(device.id, '../escape'), /Invalid/);
  assert.throws(() => client.archived(device.id, -1), /Invalid/);
  await assert.rejects(client.artifact(device.id, commonConversationId, '../escape'), /Invalid/);
});

test('native settings client restricts engines and posts to the selected device only', async context => {
  const { client, pair, calls } = fixture(context);
  const device = await pair();
  await client.nativeSettings(device.id, 'codex');
  assert.equal(calls.at(-1).endpoint, '/v1/native-settings/codex');
  const payload = { engine: 'dsh', id: 'settings', confirmed: true, text: 'setting: true', revision: 'a'.repeat(64) };
  await client.saveNativeSettings(device.id, payload);
  assert.equal(calls.at(-1).endpoint, '/v1/native-settings/dsh');
  assert.deepEqual(calls.at(-1).options.body, payload);
  assert.throws(() => client.nativeSettings(device.id, '../auth'), /Invalid/);
});

test('pairing rejects plaintext storage, corrupted stores and duplicate targets', async context => {
  const { client, clients, pair, storage, file, network, access } = fixture(context);
  storage.getSelectedStorageBackend = () => 'basic_text';
  assert.throws(() => client.list(), /secure system storage/);
  storage.getSelectedStorageBackend = () => 'test-encrypted';
  await pair();
  const invitation = access.invite([], { allWorkspaces: true });
  await assert.rejects(client.pair({ address: 'http://100.80.1.2:43127', code: invitation.code, clientName: 'GUI', deviceName: 'Duplicate' }), /already saved/);
  fs.writeFileSync(file, '{"version":1,"encrypted":"broken"}');
  const restored = new DeviceClient({ file, safeStorage: storage, network }); clients.push(restored);
  assert.throws(() => restored.list(), /Cannot unlock/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"encrypted":"broken"}');
});

test('failed credential persistence leaves pairing retryable without re-requesting an invitation', async context => {
  const { client, access, storage, calls } = fixture(context);
  const invitation = access.invite([], { allWorkspaces: true });
  const pending = await client.pair({ address: 'http://100.80.1.2:43127', code: invitation.code, clientName: 'GUI', deviceName: 'Server' });
  access.approve(access.view().pending[0].id);
  const encrypt = storage.encryptString;
  storage.encryptString = () => { throw new Error('Keychain unavailable'); };
  await assert.rejects(client.claim(pending.id), /Keychain unavailable/);
  assert.deepEqual(client.list(), []);
  storage.encryptString = encrypt;
  assert.equal((await client.claim(pending.id)).state, 'approved');
  assert.equal(calls.filter(call => call.endpoint === '/v1/pair/request').length, 1);
});

test('closing during connect disposes the late transport and cannot save a device', async context => {
  const { client, network, access } = fixture(context);
  let release;
  const transport = { closed: false, async close() { this.closed = true; } };
  network.connect = () => new Promise(resolve => { release = () => resolve(transport); });
  const invitation = access.invite([], { allWorkspaces: true });
  const pairing = assert.rejects(client.pair({ address: 'http://100.80.1.2:43127', code: invitation.code, clientName: 'GUI', deviceName: 'Server' }), /cancelled/);
  const closing = client.close(); release(); await closing; await pairing;
  assert.equal(transport.closed, true);
  assert.throws(() => client.list(), /closed/);
});
