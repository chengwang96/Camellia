'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteReadModel } = require('../src/main/remote/read-model');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { RemoteCommands } = require('../src/main/remote/commands');
const { tailscaleAddress, isTailscaleIPv4 } = require('../src/main/remote/tailscale');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');
const { removeTree } = require('./test-fs.cjs');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-remote-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  let clock = 1000, config = { sharedMeta: { workspaces: [{ id: 'allowed', name: 'Allowed', path: root }, { id: 'private', name: 'Private', path: root }] } }, gateway;
  const drivers = Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => ({ model: 'test', apiKey: 'must-not-leak' }), ensure() { throw new Error('Read-only access must not start engines'); } }]));
  const manager = new SharedConversations({ dir: path.join(root, 'conversations'), loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; }, drivers,
    onEvent: () => gateway?.publish() });
  const access = new RemoteAccess({ file: path.join(root, 'devices.json'), now: () => clock, onRevoke: id => gateway?.revoke(id) });
  const reader = new RemoteReadModel(manager);
  const commands = new RemoteCommands({ file: path.join(root, 'commands.json'), access, reader, publish: () => gateway.publish() });
  gateway = new RemoteGateway({ access, reader, commands, validateHost: host => host === '127.0.0.1' });
  context.after(async () => { await gateway.stop(); manager.closeGoalTools(); manager.pauseGoals(); removeTree(root); });
  const visible = manager.create('codex', 'allowed', 'Visible');
  const hidden = manager.create('kimi', 'private', 'Secret');
  const unassigned = manager.create('codex', undefined, 'Unassigned', root);
  manager.append(visible, { role: 'user', text: 'Hello', attachments: [{ path: 'private/file' }] });
  manager.append(visible, { role: 'assistant', text: 'World', artifacts: [{ path: 'secret/file' }] });
  function pair() {
    const invitation = access.invite(['allowed']);
    const request = access.request({ code: invitation.code, name: 'Android' });
    access.approve(request.id);
    return access.claim(request.id, request.claim);
  }
  return { root, manager, access, reader, gateway, commands, visible, hidden, unassigned, pair, advance: amount => { clock += amount; } };
}

async function request(gateway, endpoint, { token, method = 'GET', payload, headers = {} } = {}) {
  const response = await fetch(gateway.url + endpoint, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: payload ? JSON.stringify(payload) : undefined });
  return { status: response.status, body: await response.json() };
}

async function stream(gateway, conversationId, token) {
  const controller = new AbortController();
  const endpoint = conversationId ? `/v1/conversations/${conversationId}/events` : '/v1/conversations/events';
  const response = await fetch(gateway.url + endpoint, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  return { close: () => controller.abort(), reader, async next() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = event.split('\n').find(line => line.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
      } else {
        const chunk = await reader.read();
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  } };
}

test('embedded gateway requires private transport authentication and preserves device authorization', async context => {
  const { gateway, pair } = fixture(context);
  const credential = pair();
  const token = 'a'.repeat(64);
  await assert.rejects(gateway.start('0.0.0.0', 0, { address: '100.80.1.2', token }), /Invalid embedded/);
  await assert.rejects(gateway.start('127.0.0.1', 0, { address: '127.0.0.1', token }), /Invalid embedded/);
  await gateway.start('127.0.0.1', 0, { address: '100.80.1.2', token });
  assert.equal(gateway.url, 'http://100.80.1.2:43127');
  assert.equal(gateway.server.address().address, '127.0.0.1');
  const local = `http://127.0.0.1:${gateway.server.address().port}/v1/conversations`;
  const localRequest = headers => new Promise((resolve, reject) => {
    const outgoing = http.get(local, { headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    outgoing.on('error', reject);
  });
  const headers = { Host: '100.80.1.2:43127', Authorization: `Bearer ${credential.token}` };
  assert.equal(await localRequest(headers), 403);
  assert.equal(await localRequest({ ...headers, 'X-Camellia-Transport': 'b'.repeat(64) }), 403);
  const trusted = { ...headers, 'X-Camellia-Transport': token, 'X-Camellia-Peer': '100.90.1.2' };
  assert.equal(await localRequest(trusted), 200);
  assert.ok(gateway.rate.has('100.90.1.2:read'));
  assert.equal(await localRequest({ ...trusted, Authorization: 'Bearer invalid' }), 401);
  assert.equal(await localRequest({ ...trusted, Origin: 'https://evil.test' }), 403);
  assert.equal(await localRequest({ ...trusted, Host: '127.0.0.1' }), 403);
});

test('list streams immediately notify desktop creation and deletion and resync after reconnect', { timeout: 8000 }, async context => {
  const { manager, gateway, access, reader, pair } = fixture(context);
  const credential = pair(), device = access.authenticate(credential.token);
  await gateway.start('127.0.0.1', 0);
  const events = await stream(gateway, null, credential.token);
  context.after(() => events.close());
  const initial = await events.next();
  assert.deepEqual(initial, { ...reader.listSnapshot(device), ...gateway.stamp() });
  const created = manager.create('codex', 'allowed', 'Created on desktop');
  const added = await events.next();
  assert.notEqual(added.listVersion, initial.listVersion);
  assert.ok(added.cursor > initial.cursor);
  assert.ok((await request(gateway, '/v1/conversations', { token: credential.token })).body.conversations.some(entry => entry.id === created.id));
  manager.purge(created.id);
  const removed = await events.next();
  assert.equal(removed.listVersion, initial.listVersion);
  assert.ok(removed.cursor > added.cursor);
  assert.ok(!(await request(gateway, '/v1/conversations', { token: credential.token })).body.conversations.some(entry => entry.id === created.id));
  events.close();
  manager.create('codex', 'allowed', 'Created while disconnected');
  const reconnected = await stream(gateway, null, credential.token);
  context.after(() => reconnected.close());
  assert.notEqual((await reconnected.next()).listVersion, removed.listVersion);
  access.revoke(credential.deviceId);
  assert.equal(await reconnected.next(), null);
});

test('list versions include later pages, exclude unauthorized changes, and suppress duplicate pushes', { timeout: 8000 }, async context => {
  const { manager, gateway, access, reader, hidden, pair } = fixture(context);
  const credential = pair(), device = access.authenticate(credential.token);
  for (let index = 0; index < 101; index++) manager.create('codex', 'allowed', `Conversation ${index}`);
  await gateway.start('127.0.0.1', 0);
  const events = await stream(gateway, null, credential.token);
  context.after(() => events.close());
  const initial = await events.next();
  const connected = [...gateway.streams][0];
  let writes = 0;
  const write = connected.response.write.bind(connected.response);
  connected.response.write = (...args) => { writes++; return write(...args); };
  gateway.publish();
  manager.purge(hidden.id);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(writes, 0);
  assert.equal(reader.listSnapshot(device).listVersion, initial.listVersion);
  const later = reader.list(device, 100).conversations[0];
  manager.purge(later.id);
  assert.notEqual((await events.next()).listVersion, initial.listVersion);
  assert.equal(writes, 1);
});

test('pairing requires local approval, is one-time, expires, and stores only token digests', context => {
  const { access, root, advance } = fixture(context);
  const invitation = access.invite(['allowed']);
  assert.throws(() => access.request({ code: 'wrong', name: 'Phone' }), /Invalid/);
  const pending = access.request({ code: invitation.code, name: '手机' });
  assert.throws(() => access.request({ code: invitation.code, name: 'Replay' }), /Invalid/);
  assert.deepEqual(access.claim(pending.id, pending.claim), { state: 'pending' });
  assert.throws(() => access.claim(pending.id, 'wrong'), /Invalid/);
  access.approve(pending.id);
  const credential = access.claim(pending.id, pending.claim);
  assert.equal(access.claim(pending.id, pending.claim).token, credential.token);
  const stored = fs.readFileSync(path.join(root, 'devices.json'), 'utf8');
  assert.ok(!stored.includes(credential.token));
  assert.ok(!JSON.stringify(access.view()).includes(credential.token));
  const restored = new RemoteAccess({ file: path.join(root, 'devices.json') });
  assert.equal(restored.authenticate(credential.token).name, '手机');
  access.authenticate(credential.token);
  assert.throws(() => access.claim(pending.id, pending.claim), /Invalid/);
  access.revoke(credential.deviceId);
  assert.throws(() => access.authenticate(credential.token), /authentication/);
  const expired = access.invite(['allowed']); advance(300_001);
  assert.throws(() => access.request({ code: expired.code, name: 'Phone' }), /expired/);
});

test('failed credential persistence does not authorize the device', context => {
  const { access, root } = fixture(context);
  const invitation = access.invite(['allowed']);
  const pending = access.request({ code: invitation.code, name: 'Phone' });
  access.approve(pending.id);
  access.file = root;
  assert.throws(() => access.claim(pending.id, pending.claim));
  assert.equal(access.devices.length, 0);
  assert.equal(access.pending.get(pending.id).token, undefined);
});

test('legacy read-only and permissionless devices retain tokens and scopes while migrating to control', context => {
  const { root, pair, access } = fixture(context);
  const credential = pair();
  const file = path.join(root, 'devices.json');
  for (const permission of ['read', undefined]) {
    const legacy = { ...access.devices[0], permission };
    fs.writeFileSync(file, JSON.stringify({ devices: [legacy] }));
    const restored = new RemoteAccess({ file });
    const device = restored.authenticate(credential.token);
    assert.equal(device.permission, 'control');
    assert.equal(device.id, credential.deviceId);
    assert.deepEqual(device.workspaceIds, ['allowed']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).devices, [{ ...legacy, permission: 'control' }]);
    assert.equal(new RemoteAccess({ file }).authenticate(credential.token).permission, 'control');
    restored.revoke(device.id);
    assert.throws(() => restored.authenticate(credential.token), /authentication/);
  }
});

test('read model isolates workspace scope and strips paths, credentials and native metadata', context => {
  const { access, reader, manager, visible, hidden, unassigned, pair } = fixture(context);
  const credential = pair(), device = access.authenticate(credential.token);
  assert.deepEqual(reader.list(device).conversations.map(conversation => conversation.id), [visible.id]);
  assert.throws(() => reader.snapshot(device, hidden.id), /not found/);
  assert.throws(() => reader.snapshot(device, unassigned.id), /not found/);
  const snapshot = reader.snapshot(device, visible.id);
  assert.equal(snapshot.messages.length, 2);
  for (const field of ['apiKey', 'attachments', 'artifacts', 'segments', 'cwd']) assert.ok(!JSON.stringify(snapshot).includes(`"${field}"`));
  assert.deepEqual(Object.keys(snapshot.settings).sort(), ['editable', 'engine', 'model', 'models', 'permissionLevels', 'permissionMode', 'thinking', 'version']);
  manager.workspaces.archiveSession(visible.id, true);
  assert.throws(() => reader.snapshot(device, visible.id), /not found/);
  manager.workspaces.archiveSession(visible.id, false);
  manager.workspaces.recordContext(visible.id, 'private', visible.cwd);
  assert.equal(reader.list(device).conversations.length, 0);
  assert.throws(() => reader.snapshot(device, visible.id), /not found/);
});

test('remote settings use desktop models and persistence, reject stale or unsafe changes and deduplicate retries', async context => {
  const { manager, gateway, access, reader, visible, hidden, pair } = fixture(context);
  const { randomUUID } = require('node:crypto');
  const device = access.authenticate(pair().token);
  let saves = 0;
  await gateway.start('127.0.0.1', 0);
  manager.drivers.codex.saveSettings = patch => { saves++; return patch; };
  manager.conversationModels = () => [{ id: 'test', name: 'Test model', thinking: ['high'], apiKey: 'secret' },
    { id: 'second', thinking: ['low'], contextWindow: 64000 }];
  const commands = gateway.commands;
  const snapshot = () => reader.snapshot(device, visible.id).settings;
  const payload = changes => ({ action: 'configure', requestId: randomUUID(), instanceId: gateway.instanceId, expectedSettings: snapshot().version, settings: changes });
  const initial = snapshot();
  assert.equal(initial.permissionMode, 'ask');
  assert.equal(JSON.stringify(initial).includes('secret'), false);
  assert.equal(reader.snapshot({ ...device, permission: 'read' }, visible.id).settings, undefined);
  const selected = payload({ model: 'second', permissionMode: 'full', thinking: 'low' });
  const result = await commands.execute(device, visible.id, selected, gateway.instanceId);
  assert.equal(result.ok, true);
  assert.equal(snapshot().model, 'second');
  assert.equal(snapshot().thinking, 'low');
  assert.equal(manager.settings('codex', visible.id).permissionMode, 'full');
  assert.deepEqual(await commands.execute(device, visible.id, selected, gateway.instanceId), result);
  assert.equal(saves, 1);
  assert.match((await commands.execute(device, visible.id, { ...selected, requestId: randomUUID() }, gateway.instanceId)).error, /Settings changed/);
  for (const changes of [{ model: 'missing' }, { thinking: 'high' }, { permissionMode: 'yolo' }, { connection: 'subscription' }, {}, { model: 3 }]) {
    assert.equal((await commands.execute(device, visible.id, payload(changes), gateway.instanceId)).ok, false);
  }
  await assert.rejects(commands.execute(device, hidden.id, payload({ permissionMode: 'ask' }), gateway.instanceId), /not found/);
  manager.controlStarts.set(visible.id, {});
  assert.equal(snapshot().editable, false);
  assert.match((await commands.execute(device, visible.id, payload({ permissionMode: 'ask' }), gateway.instanceId)).error, /busy/);
  manager.controlStarts.delete(visible.id);
  assert.equal((await commands.execute(device, visible.id, payload({ model: 'test' }), gateway.instanceId)).ok, true);
  assert.equal(snapshot().thinking, '');
  assert.equal(manager.settings('codex', visible.id).contextWindow, 0);
  device.permission = 'read';
  await assert.rejects(commands.execute(device, visible.id, { ...selected, requestId: randomUUID() }, gateway.instanceId), /Control permission/);
});

test('history pagination and text bounds are explicit', context => {
  const { access, reader, manager, visible, pair } = fixture(context);
  const device = access.authenticate(pair().token);
  for (let index = 0; index < 110; index++) manager.append(visible, { role: 'assistant', text: String(index) });
  const page = reader.snapshot(device, visible.id);
  assert.equal(page.messages.length, 100);
  const older = reader.snapshot(device, visible.id, page.nextBefore);
  assert.equal(older.messages.length, 12);
  assert.equal(older.nextBefore, null);
  manager.append(visible, { role: 'assistant', text: 'x'.repeat(300_000) });
  const latest = reader.snapshot(device, visible.id).messages.at(-1);
  assert.equal(latest.textTruncated, true);
  assert.equal(latest.text.length, 256 * 1024);
});

test('explicit dynamic scope persists, includes new workspaces and independent conversations, and can be restricted', async context => {
  const { access, reader, manager, root, unassigned, visible, hidden, pair } = fixture(context);
  const legacy = access.authenticate(pair().token);
  assert.equal(reader.allowed(legacy, unassigned), false);
  const invitation = access.invite([], { allWorkspaces: true });
  const pending = access.request({ code: invitation.code, name: 'All access', allWorkspaces: false });
  assert.equal(access.view().pending[0].allWorkspaces, true);
  access.approve(pending.id);
  const credential = access.claim(pending.id, pending.claim);
  const restored = new RemoteAccess({ file: path.join(root, 'devices.json') });
  const device = restored.authenticate(credential.token);
  assert.equal(device.permission, 'control');
  assert.equal(reader.list(device).conversations.length, 3);
  const folder = path.join(root, 'new-workspace'); fs.mkdirSync(folder);
  const created = manager.workspaces.metaOp({ op: 'create-workspace', name: 'New workspace', path: folder });
  assert.equal(created.ok, true);
  const fresh = manager.create('codex', created.workspace.id, 'New conversation');
  assert.equal(reader.allowed(device, fresh), true);
  assert.equal(reader.allowed(legacy, fresh), false);
  assert.equal(reader.snapshot(device, fresh.id).conversation.workspaceName, 'New workspace');
  assert.equal(reader.snapshot(device, unassigned.id).conversation.workspaceId, null);
  manager.workspaces.archiveSession(fresh.id, true);
  assert.equal(reader.allowed(device, fresh), false);
  manager.workspaces.recordContext(hidden.id, 'missing-workspace', root);
  assert.equal(reader.allowed(device, hidden), false);
  access.setScope(device.id, [], { includeUnassigned: true });
  const limited = access.authenticate(credential.token);
  assert.equal(reader.allowed(limited, unassigned), true);
  assert.equal(reader.allowed(limited, visible), false);
  assert.throws(() => access.invite([], { allWorkspaces: 'true' }), /Select/);
  const fixed = access.invite(['allowed']);
  const forged = access.request({ code: fixed.code, name: 'Forged', allWorkspaces: true, includeUnassigned: true });
  assert.equal(access.pending.get(forged.id).allWorkspaces, false);
  assert.equal(access.pending.get(forged.id).includeUnassigned, false);
});

test('HTTP pairing, authentication, endpoint allowlist and browser-origin rejection', async context => {
  const { access, gateway, visible, hidden } = fixture(context);
  assert.equal(gateway.server, null);
  await gateway.start('127.0.0.1', 0);
  assert.equal((await request(gateway, '/v1/status')).status, 401);
  const invitation = access.invite(['allowed']);
  const pending = await request(gateway, '/v1/pair/request', { method: 'POST', payload: { code: invitation.code, name: 'Phone' } });
  assert.equal(pending.status, 200);
  const claim = { id: pending.body.id, claim: pending.body.claim };
  assert.equal((await request(gateway, '/v1/pair/claim', { method: 'POST', payload: claim })).body.state, 'pending');
  access.approve(claim.id);
  const credential = (await request(gateway, '/v1/pair/claim', { method: 'POST', payload: claim })).body;
  const token = credential.token;
  assert.equal(credential.permission, 'control');
  assert.equal((await request(gateway, '/v1/status', { token })).body.permission, 'control');
  assert.equal((await request(gateway, '/v1/status', { token, headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request(gateway, '/v1/status', { token, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request(gateway, '/v1/conversations', { token })).body.conversations.length, 1);
  assert.equal((await request(gateway, `/v1/conversations/${visible.id}`, { token })).body.messages.length, 2);
  assert.equal((await request(gateway, `/v1/conversations/${hidden.id}`, { token })).status, 404);
  assert.equal((await request(gateway, '/v1/conversations?offset=-1', { token })).status, 400);
  assert.equal((await request(gateway, '/v1/status?token=secret', { token })).status, 400);
  assert.equal((await request(gateway, '/v1/command', { token, method: 'POST', payload: { action: 'send' } })).status, 405);
  assert.equal((await request(gateway, '/v1/files', { token })).status, 404);
  const badHost = await new Promise((resolve, reject) => {
    http.get(gateway.url + '/v1/status', { headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  access.revoke(credential.deviceId);
  assert.equal((await request(gateway, '/v1/status', { token })).status, 401);
});

test('SSE snapshots catch up after disconnect and close immediately on revocation', { timeout: 8000 }, async context => {
  const { gateway, manager, access, visible, pair } = fixture(context);
  const credential = pair(); await gateway.start('127.0.0.1', 0);
  const first = await stream(gateway, visible.id, credential.token);
  const initial = await first.next(); assert.equal(initial.messages.at(-1).text, 'World');
  manager.append(visible, { role: 'assistant', text: 'Live update' }); gateway.publish();
  const update = await first.next(); assert.equal(update.messages.at(-1).text, 'Live update');
  assert.ok(update.cursor > initial.cursor); first.close();
  manager.append(visible, { role: 'assistant', text: 'While offline' }); gateway.publish();
  const second = await stream(gateway, visible.id, credential.token);
  assert.equal((await second.next()).messages.at(-1).text, 'While offline');
  access.revoke(credential.deviceId);
  assert.equal(await second.next(), null);
  const previousInstance = gateway.instanceId;
  await gateway.stop(); await gateway.start('127.0.0.1', 0);
  assert.notEqual(gateway.instanceId, previousInstance);
});

test('remote projection carries bounded folded process for live and persisted replies', context => {
  const { reader, manager, visible, access, pair } = fixture(context);
  const device = access.authenticate(pair().token);
  manager.append(visible, { role: 'assistant', text: 'Progress\nFinal', outputBlocks: [
    { type: 'text', phase: 'commentary', text: 'Progress' }, { type: 'text', phase: 'final_answer', text: 'Final' }] });
  let snapshot = reader.snapshot(device, visible.id);
  assert.equal(snapshot.messages.at(-1).text, 'Final'); assert.equal(snapshot.messages.at(-1).process[0].text, 'Progress');
  manager.append(visible, { role: 'tool', text: JSON.stringify({ type: 'gui:tool', id: 'test', name: 'Shell', input: { command: 'echo test', secret: 'hidden' }, output: 'ok', status: 'completed' }) });
  snapshot = reader.snapshot(device, visible.id);
  assert.equal(snapshot.messages.at(-1).text, ''); assert.equal(snapshot.messages.at(-1).process[0].input, 'echo test');
  assert.ok(!JSON.stringify(snapshot).includes('hidden'));
  manager.active.set(visible.id, { facade: { gen: 6 }, text: 'ProgressFinal', assistant: [], permissions: new Map(), events: [
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', phase: 'commentary', text: 'Progress' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', phase: 'final_answer', text: 'Final' } } }] });
  snapshot = reader.snapshot(device, visible.id);
  assert.equal(snapshot.live.text, 'Final'); assert.equal(snapshot.live.process[0].text, 'Progress');
});

test('SSE scope changes end access and live snapshots include ongoing text', { timeout: 8000 }, async context => {
  const { gateway, manager, visible, pair } = fixture(context);
  const credential = pair();
  manager.active.set(visible.id, { facade: { gen: 5 }, eventSeq: 9, startedAt: 1, userSeq: 1, text: 'Partial reply', assistant: [], permissions: new Map() });
  await gateway.start('127.0.0.1', 0);
  const connection = await stream(gateway, visible.id, credential.token);
  assert.equal((await connection.next()).live.text, 'Partial reply');
  manager.workspaces.recordContext(visible.id, 'private', visible.cwd); gateway.publish();
  assert.equal(await connection.next(), null);
});

test('scope edits terminate existing streams and restrict control without changing permission', { timeout: 8000 }, async context => {
  const { gateway, access, commands, visible, unassigned, pair } = fixture(context);
  const credential = pair();
  access.setScope(credential.deviceId, [], { allWorkspaces: true });
  await gateway.start('127.0.0.1', 0);
  const connection = await stream(gateway, unassigned.id, credential.token);
  assert.equal((await connection.next()).conversation.workspaceId, null);
  assert.equal(commands.authorize(credential.deviceId, unassigned.id).id, unassigned.id);
  access.setScope(credential.deviceId, ['allowed'], {});
  assert.equal(await connection.next(), null);
  assert.equal(access.authenticate(credential.token).permission, 'control');
  assert.throws(() => commands.authorize(credential.deviceId, unassigned.id), /not found/);
  assert.equal(commands.authorize(credential.deviceId, visible.id).id, visible.id);
  assert.equal((await request(gateway, `/v1/conversations/${unassigned.id}`, { token: credential.token })).status, 404);
});

test('large SSE snapshots survive socket backpressure without truncation', { timeout: 8000 }, async context => {
  const { gateway, manager, visible, pair } = fixture(context);
  const credential = pair();
  const content = 'Long reply '.repeat(20_000);
  manager.append(visible, { role: 'assistant', text: content });
  await gateway.start('127.0.0.1', 0);
  const connection = await stream(gateway, visible.id, credential.token);
  assert.equal((await connection.next()).messages.at(-1).text, content);
  manager.append(visible, { role: 'assistant', text: 'After the large reply' }); gateway.publish();
  assert.equal((await connection.next()).messages.at(-1).text, 'After the large reply');
  connection.close();
});

test('pairing is rate limited and malformed payloads are rejected', async context => {
  const { gateway } = fixture(context); await gateway.start('127.0.0.1', 0);
  const wrongType = await fetch(gateway.url + '/v1/pair/request', { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415); await wrongType.text();
  const oversized = await request(gateway, '/v1/pair/request', { method: 'POST', payload: { code: 'x'.repeat(5000) } });
  assert.equal(oversized.status, 413);
  for (let index = 0; index < 28; index++) await request(gateway, '/v1/pair/request', { method: 'POST', payload: { code: 'wrong' } });
  assert.equal((await request(gateway, '/v1/pair/request', { method: 'POST', payload: {} })).status, 429);
});

test('binding fails closed unless Tailscale is online with an assigned local address', async () => {
  for (const address of ['0.0.0.0', '127.0.0.1', '192.168.1.3', '100.128.0.1', '100.64.0.999']) assert.equal(isTailscaleIPv4(address), false);
  assert.equal(isTailscaleIPv4('100.64.0.1'), true);
  const status = { BackendState: 'Running', Self: { Online: true }, TailscaleIPs: ['100.80.1.2'] };
  const run = async () => ({ stdout: JSON.stringify(status) });
  const interfaces = () => ({ tailscale: [{ address: '100.80.1.2' }] });
  assert.equal(await tailscaleAddress({ run, interfaces }), '100.80.1.2');
  await assert.rejects(tailscaleAddress({ run, interfaces: () => ({}) }), /No local/);
  status.Self.Online = false;
  await assert.rejects(tailscaleAddress({ run, interfaces }), /not online/);
  await assert.rejects(tailscaleAddress({ run: async () => { throw new Error('missing'); }, interfaces }), /unavailable/);
  const gateway = new RemoteGateway({ access: {}, reader: {} });
  await assert.rejects(gateway.start('0.0.0.0'), /Tailscale/);
});

test('control operations are scoped, deduplicated, run-bound and retain desktop permissions', async context => {
  const { gateway, manager, access, reader, visible, hidden, pair, commands, root } = fixture(context);
  const credential = pair(); const token = credential.token;
  await gateway.start('127.0.0.1', 0);
  let sent = 0, answered = 0;
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage() { sent++; return true; }, interrupt() {},
    answerPermission() { answered++; return true; } });
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', prompt: 'Test instruction', expectedSeq: visible.seq };
  const endpoint = `/v1/conversations/${visible.id}/commands`;
  const send = value => request(gateway, endpoint, { token, method: 'POST', payload: value });
  assert.equal(credential.permission, 'control');
  assert.equal((await request(gateway, `/v1/conversations/${hidden.id}/commands`, { token, method: 'POST', payload })).status, 404);
  const responses = await Promise.all([send(payload), send(payload)]);
  assert.ok(responses.every(response => response.body.ok)); assert.equal(sent, 1);
  assert.equal((await send({ ...payload, prompt: 'different' })).status, 409);
  const resumed = new RemoteCommands({ file: path.join(root, 'commands.json'), reader, access });
  assert.equal((await resumed.execute(access.authenticate(token), visible.id, payload, 'different-instance')).ok, true);
  assert.equal(sent, 1);
  const active = manager.active.get(visible.id), runId = active.facade.gen;
  const event = { requestId: 'permission', toolName: 'Shell', input: { command: 'echo test' }, options: [
    { optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }, { optionId: 'always', kind: 'allow_always' }] };
  active.permissions.set(event.requestId, event);
  const approval = reader.snapshot(access.authenticate(token), visible.id).live.approvals[0];
  assert.equal(approval.options.length, 2);
  const approve = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'approve', runId,
    approvalId: event.requestId, fingerprint: approval.fingerprint, allow: true };
  assert.equal((await send(approve)).body.ok, true);
  assert.equal((await send(approve)).body.ok, true); assert.equal(answered, 1);
  assert.equal((await send({ ...approve, requestId: require('node:crypto').randomUUID() })).body.ok, false);
  const stop = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'stop', runId };
  assert.equal((await send({ ...stop, requestId: require('node:crypto').randomUUID(), runId: runId + 1 })).body.ok, false);
  assert.equal((await send(stop)).body.ok, true); assert.equal(active.cancelled, true);
  access.revoke(credential.deviceId);
  assert.equal((await send(stop)).status, 401);
  assert.equal(commands.entries.filter(entry => entry.result?.state === 'accepted').length, 1);
});

test('mobile creation is scoped, deduplicated and does not start engines', async context => {
  const { gateway, manager, access, pair } = fixture(context);
  const credential = pair(); const token = credential.token;
  await gateway.start('127.0.0.1', 0);
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'create', workspaceId: 'allowed', engine: 'codex' };
  const create = value => request(gateway, '/v1/commands', { token, method: 'POST', payload: value });
  assert.equal(credential.permission, 'control');
  assert.equal((await create({ ...payload, workspaceId: 'private' })).status, 403);
  assert.equal((await create({ ...payload, workspaceId: null })).status, 403);
  const count = manager.items.size;
  const first = await create(payload), second = await create(payload);
  assert.equal(first.body.ok, true); assert.equal(first.body.conversation.id, second.body.conversation.id);
  assert.equal(manager.items.size, count + 1); assert.equal(manager.active.size, 0);
  const status = (await request(gateway, '/v1/status', { token })).body;
  assert.deepEqual(status.workspaces, [{ id: 'allowed', name: 'Allowed' }]);
  assert.ok(status.capabilities.includes('image'));
  access.setScope(credential.deviceId, ['allowed'], { includeUnassigned: true });
  const independent = await create({ ...payload, requestId: require('node:crypto').randomUUID(), workspaceId: null });
  assert.equal(independent.body.ok, true); assert.equal(independent.body.conversation.workspaceId, null);
});

test('mobile workspace creation requires full control, deduplicates and updates scoped list versions', async context => {
  const { gateway, manager, access, reader, pair, root } = fixture(context);
  const credential = pair(), token = credential.token;
  await gateway.start('127.0.0.1', 0);
  const folder = path.join(root, 'mobile-workspace'); fs.mkdirSync(folder);
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'create-workspace', name: 'Mobile research', path: folder };
  const create = value => request(gateway, '/v1/commands', { token, method: 'POST', payload: value });
  assert.equal((await create(payload)).status, 403);
  assert.equal((await request(gateway, '/v1/status', { token })).body.capabilities.includes('create-workspace'), false);
  const scoped = { workspaceIds: ['allowed'] }, scopedVersion = reader.listSnapshot(scoped);
  access.setScope(credential.deviceId, [], { allWorkspaces: true });
  const device = access.devices.find(item => item.id === credential.deviceId), before = reader.listSnapshot(device);
  assert.ok((await request(gateway, '/v1/status', { token })).body.capabilities.includes('create-workspace'));
  device.permission = 'read'; assert.equal((await create(payload)).status, 403); device.permission = 'control';
  const first = await create(payload), repeat = await create(payload);
  assert.equal(first.body.ok, true); assert.deepEqual(repeat.body, first.body);
  assert.deepEqual(Object.keys(first.body.workspace).sort(), ['id', 'name']);
  assert.equal(first.body.workspace.name, 'Mobile research');
  assert.equal(manager.workspaces.sessionMeta().workspaces.length, 3);
  assert.equal(manager.active.size, 0); assert.equal(manager.items.size, 3);
  assert.notDeepEqual(reader.listSnapshot(device), before); assert.deepEqual(reader.listSnapshot(scoped), scopedVersion);
  assert.equal(JSON.stringify(first.body).includes(folder), false);
  assert.equal((await create({ ...payload, name: 'Changed' })).status, 409);
  for (const patch of [{}, { path: 'relative' }, { path: path.join(root, 'missing') }, { path: path.join(root, 'devices.json') }, { name: '' }, { name: 'bad\nname' }, { name: 'x'.repeat(201) }, { path: 42 }]) {
    const result = await create({ ...payload, ...patch, requestId: require('node:crypto').randomUUID() });
    assert.equal(result.body.ok, false);
  }
  assert.equal(manager.workspaces.sessionMeta().workspaces.length, 3);
  access.setScope(credential.deviceId, ['allowed']);
  assert.equal((await create(payload)).status, 403);
});

test('mobile moves enforce both workspace scopes, persist order, update list versions and deduplicate', async context => {
  const { gateway, manager, access, reader, visible, hidden, pair } = fixture(context);
  const credential = pair(), token = credential.token;
  await gateway.start('127.0.0.1', 0);
  const device = access.devices.find(item => item.id === credential.deviceId);
  const second = manager.create('codex', 'allowed', 'Second');
  const move = patch => ({ requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'move', workspaceId: 'allowed', targetSessionId: second.id, placement: 'before', ...patch });
  const send = payload => request(gateway, `/v1/conversations/${visible.id}/commands`, { token, method: 'POST', payload });
  device.permission = 'read';
  assert.equal((await send(move())).status, 403);
  device.permission = 'control';
  const before = reader.listSnapshot(device), cwd = visible.cwd;
  const payload = move();
  const first = await send(payload);
  assert.equal(first.body.ok, true);
  assert.deepEqual((await send(payload)).body, first.body);
  assert.deepEqual(reader.list(device).conversations.map(entry => entry.id), [visible.id, second.id]);
  assert.notDeepEqual(reader.listSnapshot(device), before);
  assert.equal((await send(move({ workspaceId: 'private', targetSessionId: hidden.id }))).body.ok, false);
  assert.equal((await send(move({ workspaceId: null, targetSessionId: null }))).body.ok, false);
  assert.equal((await send(move({ targetSessionId: hidden.id }))).body.ok, false);
  access.setScope(device.id, ['allowed', 'private']);
  const moved = await send(move({ workspaceId: 'private', targetSessionId: hidden.id }));
  assert.equal(moved.body.ok, true);
  assert.equal(visible.workspaceId, 'private');
  assert.equal(visible.cwd, cwd);
  assert.equal(JSON.stringify(moved.body).includes(cwd), false);
  assert.equal(manager.workspaces.sessionMeta().sessionOrder.private[0], visible.id);
});

test('mobile images use bounded server-owned paths and retry sends only once', async context => {
  const { gateway, manager, access, visible, pair, root } = fixture(context);
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  let sent = 0, images;
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage(prompt, attachments) { sent++; images = attachments; return true; }, interrupt() {} });
  const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]).toString('base64');
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', expectedSeq: visible.seq, prompt: 'Describe image', image };
  const send = value => request(gateway, `/v1/conversations/${visible.id}/commands`, { token: credential.token, method: 'POST', payload: value });
  assert.equal((await send({ ...payload, requestId: require('node:crypto').randomUUID(), image: '../private.png' })).body.ok, false);
  assert.equal((await send(payload)).body.ok, true); assert.equal((await send(payload)).body.ok, true); assert.equal(sent, 1);
  assert.equal(images[0].isImage, true); assert.equal(path.dirname(images[0].path), path.join(root, 'mobile-images'));
  assert.deepEqual(fs.readFileSync(images[0].path), Buffer.from(image, 'base64'));
});

test('startup reservation excludes desktop sends and revocation prevents deferred engine execution', async context => {
  const { manager, gateway, access, visible, pair } = fixture(context);
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  let release, prepared;
  const preparing = new Promise(resolve => { prepared = resolve; });
  manager.prepare = () => { prepared(); return new Promise(resolve => { release = resolve; }); };
  let executed = false;
  manager.drivers.codex.ensure = () => { executed = true; throw new Error('must not run'); };
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', prompt: 'Delayed', expectedSeq: visible.seq };
  const pending = request(gateway, `/v1/conversations/${visible.id}/commands`, { token: credential.token, method: 'POST', payload });
  await preparing;
  await assert.rejects(manager.send('codex', { sessionId: visible.id, prompt: 'Desktop competing message' }), /starting|finish/);
  access.revoke(credential.deviceId); release();
  await pending;
  assert.equal(executed, false);
  assert.equal(manager.controlStarts.has(visible.id), false);
});

test('slow mobile startup acknowledges pending requests without repeating or losing the operation', async context => {
  const { manager, gateway, commands, access, visible, pair } = fixture(context);
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  let release, prepared, starts = 0;
  const preparing = new Promise(resolve => { prepared = resolve; });
  manager.prepare = () => { prepared(); return new Promise(resolve => { release = resolve; }); };
  manager.drivers.codex.ensure = () => ({ gen: 92, sendUserMessage() { starts++; return true; }, interrupt() {} });
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', prompt: 'Slow mobile startup', expectedSeq: visible.seq };
  const send = () => request(gateway, `/v1/conversations/${visible.id}/commands`, { token: credential.token, method: 'POST', payload });
  try {
    const first = send();
    await preparing;
    const result = await first;
    assert.equal(result.status, 200);
    assert.equal(result.body.state, 'pending');
    assert.equal((await send()).body.state, 'pending');
    assert.equal(commands.entries.length, 1);
    assert.equal(commands.entries[0].result, undefined);
    assert.equal(starts, 0);
    const operation = commands.pending.get(credential.deviceId + ':' + payload.requestId);
    release();
    const accepted = await operation;
    assert.equal(accepted.ok, true);
    assert.deepEqual((await send()).body, accepted);
    const reopened = new RemoteCommands({ file: commands.file, access, reader: commands.reader, publish() {} });
    assert.deepEqual(await reopened.execute(access.authenticate(credential.token), visible.id, payload, gateway.instanceId), accepted);
    assert.equal(starts, 1);
  } finally { release?.(); }
});

test('unknown journal outcomes never repeat and changed approval content cannot be approved', async context => {
  const { manager, gateway, access, commands, visible, pair } = fixture(context);
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  let starts = 0, approvals = 0;
  manager.drivers.codex.ensure = () => ({ gen: 91, sendUserMessage() { starts++; return true; }, answerPermission() { approvals++; return true; } });
  const send = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', prompt: 'journal fixture', expectedSeq: visible.seq };
  const device = access.authenticate(credential.token);
  await assert.rejects(commands.execute(device, visible.id, { ...send, instanceId: 'old-instance' }, gateway.instanceId), /restarted/);
  const result = await commands.execute(device, visible.id, send, gateway.instanceId);
  delete commands.entries[0].result; commands.save();
  assert.equal((await commands.execute(device, visible.id, send, gateway.instanceId)).state, 'unknown');
  assert.equal(starts, 1);
  const active = manager.active.get(visible.id);
  const event = { requestId: 'request', toolName: 'Shell', input: { command: 'echo safe' } };
  active.permissions.set('request', event);
  const fingerprint = require('../src/main/remote/commands').approval(event).fingerprint;
  event.input.command = 'changed command';
  const approve = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'approve', runId: result.runId, approvalId: 'request', fingerprint, allow: true };
  assert.equal((await commands.execute(device, visible.id, approve, gateway.instanceId)).ok, false);
  assert.equal(approvals, 0);
  const deny = { ...approve, requestId: require('node:crypto').randomUUID(), fingerprint: require('../src/main/remote/commands').approval(event).fingerprint, allow: false };
  assert.equal((await commands.execute(device, visible.id, deny, gateway.instanceId)).ok, true);
  assert.equal(approvals, 1);
});
