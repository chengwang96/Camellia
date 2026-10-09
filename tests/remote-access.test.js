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
const { BAD_PORTS } = require('./bad-ports.cjs');

async function flushQueue() { for (let i = 0; i < 6; i++) await new Promise(setImmediate); }
function queuedRuns(manager, id) {
  const sent = [];
  let gen = 0;
  const finish = (extra = {}) => {
    const active = manager.active.get(id);
    assert.ok(active, 'Expected an active turn');
    manager.capture('codex', { type: 'result', conversationId: id, runId: active.session?.gen, result: 'Done', subtype: 'success', is_error: false, ...extra });
  };
  manager.drivers.codex.ensure = () => ({ gen: ++gen, sendUserMessage(prompt, attachments) { sent.push({ prompt, attachments }); return true; },
    interrupt() { finish({ subtype: 'stopped', result: '' }); } });
  return { sent, finish };
}

function fixture(context, { apiRoutes = null, apiImport = null, nativeSettings = null, management = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-remote-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  let clock = 1000, config = { sharedMeta: { workspaces: [{ id: 'allowed', name: 'Allowed', path: root }, { id: 'private', name: 'Private', path: root }] } }, gateway, reader;
  const events = [];
  const drivers = Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => ({ model: 'test', apiKey: 'must-not-leak' }), ensure() { throw new Error('Read-only access must not start engines'); } }]));
  const manager = new SharedConversations({ dir: path.join(root, 'conversations'), loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; }, drivers,
    onEvent: event => { events.push(event); reader?.observeCompaction(event); gateway?.publish(); },
    onStatus: status => { reader?.observeCompaction(status); gateway?.publish(); } });
  const access = new RemoteAccess({ file: path.join(root, 'devices.json'), now: () => clock, onRevoke: id => gateway?.revoke(id) });
  reader = new RemoteReadModel(manager);
  const commands = new RemoteCommands({ file: path.join(root, 'commands.json'), access, reader, publish: () => gateway.publish() });
  gateway = new RemoteGateway({ access, reader, commands, apiRoutes, apiImport, nativeSettings, management, validateHost: host => host === '127.0.0.1' });
  const start = gateway.start.bind(gateway);
  gateway.start = async (host, port, transport) => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const url = await start(host, port, transport);
      if (port !== 0 || !BAD_PORTS.has(gateway.server.address().port)) return url;
      await gateway.stop();
    }
    throw new Error('Could not allocate a Fetch-compatible loopback port');
  };
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
  return { root, manager, access, reader, gateway, commands, visible, hidden, unassigned, pair, events, advance: amount => { clock += amount; } };
}

async function request(gateway, endpoint, { token, method = 'GET', payload, headers = {} } = {}) {
  const response = await fetch(gateway.url + endpoint, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: payload ? JSON.stringify(payload) : undefined });
  return { status: response.status, body: await response.json() };
}

test('mobile queue accepts running turns, deduplicates and drains text and attachments in order without a phone connection', async context => {
  const { manager, commands, gateway, reader, access, pair, visible, hidden } = fixture(context);
  const credential = pair(), device = access.authenticate(credential.token);
  await gateway.start('127.0.0.1', 0);
  const runs = queuedRuns(manager, visible.id);
  await manager.send('codex', { sessionId: visible.id, prompt: 'Original task' });
  const payload = { action: 'send', queue: true, requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    expectedSeq: visible.seq, prompt: 'First queued request', attachments: [{ name: 'notes.txt', data: Buffer.from('Keep this file').toString('base64'), isImage: false }] };
  // Tool events can advance the history between a phone snapshot and its send.
  manager.append(visible, { role: 'tool', text: 'Progress' });
  const send = value => request(gateway, `/v1/conversations/${visible.id}/commands`, { token: credential.token, method: 'POST', payload: value });
  const first = (await send(payload)).body;
  assert.equal(first.state, 'queued'); assert.equal(first.ok, true);
  assert.equal((await send(payload)).body.queueId, first.queueId);
  const second = (await send({ ...payload, requestId: require('node:crypto').randomUUID(), prompt: 'Second queued request', attachments: undefined })).body;
  assert.equal(second.ok, true, second.error);
  assert.equal((await send({ ...payload, prompt: 'Changed request' })).status, 409);
  assert.equal((await send({ ...payload, requestId: require('node:crypto').randomUUID(), queue: false, expectedSeq: visible.seq })).body.ok, false);
  await assert.rejects(commands.execute(device, hidden.id, { ...payload, requestId: require('node:crypto').randomUUID() }, gateway.instanceId), /not found/);
  await flushQueue(); assert.equal(runs.sent.length, 1);
  const snapshot = reader.snapshot(device, visible.id);
  assert.deepEqual(snapshot.queue.map(entry => entry.text), ['First queued request', 'Second queued request']);
  assert.deepEqual(snapshot.queue[0].attachments, [{ name: 'notes.txt', isImage: false }]);
  assert.equal(JSON.stringify(snapshot.queue).includes('device-attachments'), false);
  assert.equal(JSON.stringify(commands.entries).includes('First queued request'), false, 'Command receipts must not duplicate message bodies');
  const connection = await stream(gateway, visible.id, credential.token);
  assert.equal((await connection.next()).queue.length, 2); connection.close();
  runs.finish(); await flushQueue();
  assert.equal(runs.sent.length, 2); assert.match(runs.sent[1].prompt, /First queued request/);
  assert.equal(fs.readFileSync(runs.sent[1].attachments[0].path, 'utf8'), 'Keep this file');
  assert.deepEqual(reader.snapshot(device, visible.id).queue.map(entry => entry.id), [second.queueId]);
  runs.finish(); await flushQueue();
  assert.equal(runs.sent.length, 3); assert.match(runs.sent[2].prompt, /Second queued request/);
  assert.equal((await send(payload)).body.queueId, first.queueId);
  runs.finish(); await flushQueue();
  assert.equal(runs.sent.length, 3);
  assert.deepEqual(commands.queue.view(visible.id), []);
  assert.equal(manager.rawRows(visible).filter(row => row.queueId === first.queueId).length, 1);
});

test('mobile queue supports remove, stop/pause and explicit resume with desktop visibility', async context => {
  const { manager, commands, gateway, access, pair, visible } = fixture(context);
  const device = access.authenticate(pair().token), runs = queuedRuns(manager, visible.id);
  const execute = (action, extra = {}) => commands.execute(device, visible.id, { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action, ...(action === 'send' ? { queue: true, prompt: 'Queued', expectedSeq: visible.seq } : {}), ...extra }, gateway.instanceId);
  const active = await manager.send('codex', { sessionId: visible.id, prompt: 'Original task' });
  const removed = await execute('send'), kept = await execute('send');
  assert.equal(manager.load('codex', visible.id).remoteQueue.queue.length, 2);
  assert.equal((await execute('queue-remove', { queueId: removed.queueId })).ok, true);
  assert.equal((await execute('queue-remove', { queueId: removed.queueId })).ok, false);
  assert.equal((await execute('stop', { runId: active.runId })).ok, true);
  assert.equal(manager.busy(visible.id), false);
  await flushQueue();
  assert.equal(runs.sent.length, 1);
  assert.equal(commands.queue.view(visible.id)[0].state, 'paused');
  const resumed = await manager.command('codex', 'remote-queue-resume', { sessionId: visible.id });
  assert.equal(resumed.ok, true); await flushQueue();
  assert.equal(runs.sent.length, 2);
  assert.equal(manager.rawRows(visible).filter(row => row.queueId === kept.queueId).length, 1);
  runs.finish(); await flushQueue();
});

test('queue waits through an armed goal and startup reservation, then advances once', async context => {
  const { manager, commands, gateway, access, pair, visible } = fixture(context);
  const device = access.authenticate(pair().token), runs = queuedRuns(manager, visible.id);
  const goal = manager.goalFor(visible.id); goal.armed = true;
  const queued = await commands.execute(device, visible.id, { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'send', queue: true, prompt: 'After goal', expectedSeq: visible.seq }, gateway.instanceId);
  assert.equal(queued.ok, true); await flushQueue(); assert.equal(runs.sent.length, 0);
  goal.armed = false; manager.controlStarts.set(visible.id, {}); manager.publishActivity(visible.id);
  await flushQueue(); assert.equal(runs.sent.length, 0);
  manager.controlStarts.delete(visible.id);
  for (let i = 0; i < 10; i++) manager.publishActivity(visible.id);
  await flushQueue(); assert.equal(runs.sent.length, 1);
  runs.finish(); await flushQueue();
});

test('revoked devices cannot execute queued messages or resume them from the desktop', async context => {
  const { manager, commands, gateway, access, pair, visible } = fixture(context);
  const credential = pair(), device = access.authenticate(credential.token), runs = queuedRuns(manager, visible.id);
  await manager.send('codex', { sessionId: visible.id, prompt: 'Original' });
  const result = await commands.execute(device, visible.id, { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'send', queue: true, prompt: 'Must not run', expectedSeq: visible.seq }, gateway.instanceId);
  access.revoke(credential.deviceId);
  runs.finish(); await flushQueue(); assert.equal(runs.sent.length, 1);
  assert.equal(commands.queue.view(visible.id)[0].state, 'paused');
  assert.throws(() => commands.queue.resume(visible.id), /Control permission/);
  assert.equal((await manager.command('codex', 'remote-queue-remove', { sessionId: visible.id, queueId: result.queueId })).ok, true);
  assert.equal(commands.queue.view(visible.id).length, 0);
});

test('failed queue startup never replays a committed user message and pauses following messages', async context => {
  const { manager, commands, gateway, access, pair, visible } = fixture(context);
  const device = access.authenticate(pair().token), runs = queuedRuns(manager, visible.id);
  await manager.send('codex', { sessionId: visible.id, prompt: 'Original' });
  const enqueue = prompt => commands.execute(device, visible.id, { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'send', queue: true, prompt, expectedSeq: visible.seq }, gateway.instanceId);
  const first = await enqueue('Fails during startup'); await enqueue('Wait for review');
  manager.prepare = async () => { throw new Error('Fixture startup failure'); };
  runs.finish(); await flushQueue();
  assert.equal(commands.queue.view(visible.id).length, 1);
  assert.equal(commands.queue.view(visible.id)[0].state, 'paused');
  assert.equal(manager.rawRows(visible).filter(row => row.queueId === first.queueId).length, 1);
  assert.equal(runs.sent.length, 1);
  for (let i = 0; i < 5; i++) manager.publishActivity(visible.id);
  await flushQueue(); assert.equal(runs.sent.length, 1);
});

test('a receipt persistence failure after dispatch cannot remove the following queued message', async context => {
  const { manager, commands, gateway, access, pair, visible } = fixture(context);
  const device = access.authenticate(pair().token), runs = queuedRuns(manager, visible.id);
  await manager.send('codex', { sessionId: visible.id, prompt: 'Original' });
  const enqueue = prompt => commands.execute(device, visible.id, { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'send', queue: true, prompt, expectedSeq: visible.seq }, gateway.instanceId);
  const first = await enqueue('First'), second = await enqueue('Must be retained');
  const save = commands.queue.save.bind(commands.queue); let writes = 0;
  context.mock.method(commands.queue, 'save', () => { if (++writes === 2) throw new Error('Fixture disk write failed'); save(); });
  runs.finish(); await flushQueue();
  assert.equal(runs.sent.length, 2);
  assert.equal(manager.rawRows(visible).filter(row => row.queueId === first.queueId).length, 1);
  assert.deepEqual(commands.queue.view(visible.id).map(entry => [entry.id, entry.state]), [[second.queueId, 'paused']]);
  runs.finish(); await flushQueue(); assert.equal(runs.sent.length, 2);
});

test('computer restart preserves pending queue and attachments, but requires explicit resume', async context => {
  const { manager, commands, gateway, access, pair, visible, root } = fixture(context);
  const device = access.authenticate(pair().token), runs = queuedRuns(manager, visible.id);
  await manager.send('codex', { sessionId: visible.id, prompt: 'Original' });
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', queue: true,
    prompt: 'After restart', expectedSeq: visible.seq, attachments: [{ name: 'notes.txt', data: Buffer.from('Persistent file').toString('base64'), isImage: false }] };
  const result = await commands.execute(device, visible.id, payload, gateway.instanceId);
  await gateway.stop(); manager.closeGoalTools();
  const restored = new SharedConversations({ dir: manager.dir, loadConfig: manager.loadConfig, saveConfig: manager.saveConfig, drivers: manager.drivers });
  try {
    const resumed = queuedRuns(restored, visible.id);
    const replacement = new RemoteCommands({ file: path.join(root, 'commands.json'), access, reader: new RemoteReadModel(restored) });
    assert.equal(replacement.queue.view(visible.id)[0].state, 'paused');
    assert.equal((await replacement.execute(device, visible.id, payload, 'new-instance')).queueId, result.queueId);
    await flushQueue(); assert.equal(resumed.sent.length, 0); assert.equal(runs.sent.length, 1);
    replacement.queue.resume(visible.id); await flushQueue();
    assert.equal(resumed.sent.length, 1);
    assert.equal(fs.readFileSync(resumed.sent[0].attachments[0].path, 'utf8'), 'Persistent file');
    resumed.finish(); await flushQueue();
  } finally { restored.closeGoalTools(); }
});

test('restart drops a committed queue entry even if the visible transcript was subsequently edited', async context => {
  const { manager, commands, gateway, access, pair, visible, reader, root } = fixture(context);
  const device = access.authenticate(pair().token);
  manager.controlStarts.set(visible.id, {});
  const result = await commands.execute(device, visible.id, { action: 'send', queue: true, prompt: 'Once only', expectedSeq: visible.seq,
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId }, gateway.instanceId);
  const row = manager.append(visible, { role: 'user', text: 'Once only', queueId: result.queueId });
  manager.append(visible, { role: 'revision', replacesSeq: row.seq, text: 'Edited after sending' });
  commands.queue.entries[0].state = 'starting'; commands.queue.save(); commands.queue.close();
  const replacement = new RemoteCommands({ file: path.join(root, 'commands.json'), access, reader });
  assert.deepEqual(replacement.queue.view(visible.id), []);
  manager.controlStarts.delete(visible.id); await flushQueue(); replacement.queue.close();
});

test('conversation pages include scoped connection metadata in one round trip', async context => {
  const { gateway, pair, visible, hidden } = fixture(context);
  const { token } = pair();
  await gateway.start('127.0.0.1', 0);
  const status = (await request(gateway, '/v1/status', { token })).body;
  const page = (await request(gateway, '/v1/conversations?offset=0', { token })).body;
  for (const key of ['protocol', 'permission', 'capabilities', 'workspaces', 'includeUnassigned', 'instanceId', 'cursor']) {
    assert.deepEqual(page[key], status[key], key);
  }
  assert.deepEqual(page.workspaces.map(workspace => workspace.id), ['allowed']);
  assert.ok(page.conversations.some(conversation => conversation.id === visible.id));
  assert.ok(!page.conversations.some(conversation => conversation.id === hidden.id));
});

test('remote fork preserves workspace scope and rejects stale or out-of-scope sources', async context => {
  const { gateway, pair, visible, hidden, manager } = fixture(context);
  const { token } = pair();
  await gateway.start('127.0.0.1', 0);
  const payload = { action: 'fork', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, expectedSeq: visible.seq };
  const endpoint = `/v1/conversations/${visible.id}/commands`;
  const result = await request(gateway, endpoint, { token, method: 'POST', payload });
  assert.equal(result.body.ok, true);
  assert.notEqual(result.body.conversation.id, visible.id);
  assert.equal(result.body.conversation.workspaceId, 'allowed');
  assert.equal(manager.messages(manager.get(result.body.conversation.id)).length, manager.messages(visible).length);
  assert.deepEqual((await request(gateway, endpoint, { token, method: 'POST', payload })).body, result.body);
  assert.equal((await request(gateway, `/v1/conversations/${hidden.id}/commands`, { token, method: 'POST', payload: { ...payload, requestId: require('node:crypto').randomUUID() } })).status, 404);
  const stale = await request(gateway, endpoint, { token, method: 'POST', payload: { ...payload, requestId: require('node:crypto').randomUUID(), expectedSeq: -1 } });
  assert.equal(stale.body.ok, false);
});

test('remote automation controls are scoped, explicit and cannot create tasks through control payloads', async context => {
  const { gateway, pair, visible, hidden, manager } = fixture(context);
  const { token } = pair(); await gateway.start('127.0.0.1', 0);
  const goal = manager.goalFor(visible.id);
  goal.goal = { objective: 'Test only; never run', phase: 'active', armed: true, roundsStarted: 3, runToken: 'must-not-leak' };
  goal.armed = true;
  const snapshot = (await request(gateway, `/v1/conversations/${visible.id}`, { token })).body;
  // The phone renders this payload as its automation bar, so the fields it needs
  // must survive the projection while the run token never leaves the computer.
  assert.equal(snapshot.automation.goal.phase, 'active');
  assert.equal(snapshot.automation.goal.objective, 'Test only; never run');
  assert.equal(snapshot.automation.goal.armed, true);
  assert.equal(snapshot.automation.goal.roundsStarted, 3);
  assert.equal(JSON.stringify(snapshot).includes('must-not-leak'), false);
  // Pausing and resuming from the phone is the same command the UI issues.
  const pause = { action: 'goal-control', operation: 'pause', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId };
  assert.equal((await request(gateway, `/v1/conversations/${visible.id}/commands`, { token, method: 'POST', payload: pause })).body.ok, true);
  assert.equal((await request(gateway, `/v1/conversations/${visible.id}`, { token })).body.automation.goal.phase, 'paused');
  const payload = { action: 'goal-control', operation: 'clear', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId };
  assert.equal((await request(gateway, `/v1/conversations/${hidden.id}/commands`, { token, method: 'POST', payload })).status, 404);
  assert.equal((await request(gateway, `/v1/conversations/${visible.id}/commands`, { token, method: 'POST', payload })).body.ok, true);
  assert.equal(goal.view(), null);
  const invalid = await request(gateway, `/v1/conversations/${visible.id}/commands`, { token, method: 'POST', payload: { ...payload, action: 'task-control', taskId: 'anything', operation: 'create', requestId: require('node:crypto').randomUUID() } });
  assert.equal(invalid.body.ok, false);
});
test('remote live fork tolerates tool updates inside the same turn but excludes that whole turn', async context => {
  const { gateway, pair, visible, manager } = fixture(context), { token } = pair();
  await gateway.start('127.0.0.1', 0); const runs = queuedRuns(manager, visible.id);
  const stable = manager.messages(visible).map(row => row.text);
  await manager.send('codex', { sessionId: visible.id, prompt: 'Live request' }); const expectedSeq = visible.seq;
  manager.append(visible, { role: 'tool', text: 'Live tool output' });
  const result = await request(gateway, `/v1/conversations/${visible.id}/commands`, { token, method: 'POST', payload: {
    action: 'fork', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, expectedSeq } });
  assert.equal(result.body.ok, true);
  assert.deepEqual(manager.messages(manager.get(result.body.conversation.id)).map(row => row.text), stable);
  assert.equal(manager.active.has(visible.id), true); runs.finish();
});
test('remote child controls are scoped, persisted and withheld from read-only snapshots', async context => {
  const { manager, pair, access, reader, commands, gateway, visible, hidden } = fixture(context);
  const { token } = pair(), device = access.authenticate(token); const requests = [];
  await gateway.start('127.0.0.1', 0); const runs = queuedRuns(manager, visible.id);
  await manager.send('codex', { sessionId: visible.id, prompt: 'Parent work' });
  const active = manager.active.get(visible.id);
  active.session.children = new Map([['child', {}]]);
  active.session.controlChild = async (id, payload) => requests.push({ id, payload });
  manager.capture('codex', { type: 'gui:subagent', conversationId: visible.id, runId: active.session.gen,
    task: { id: 'child', title: 'Inspect files', goal: 'Find the regression', status: 'running', canStop: true, turnId: 'child-turn' } });
  const snapshot = reader.snapshot(device, visible.id);
  assert.equal(snapshot.subagents[0].userSeq, active.userSeq); assert.equal(snapshot.subagents[0].canStop, true);
  const payload = { action: 'subagent-command', operation: 'stop', taskId: 'child', engine: 'codex', expectedTurnId: 'child-turn', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId };
  assert.equal((await commands.execute(device, visible.id, payload, gateway.instanceId)).ok, true);
  assert.equal(requests[0].id, 'child'); assert.equal(manager.active.has(visible.id), true);
  assert.equal(reader.snapshot({ ...device, permission: 'read' }, visible.id).subagents[0].canStop, false);
  await assert.rejects(commands.execute(device, hidden.id, { ...payload, requestId: require('node:crypto').randomUUID() }, gateway.instanceId), /not found/);
  runs.finish(); assert.equal(manager.get(visible.id).subagents[0].status, 'running');
  assert.equal(manager.load('codex', visible.id).subagents[0].id, 'child');
  active.session.children.set('grandchild', {});
  manager.capture('codex', { type: 'gui:subagent', conversationId: visible.id, runId: active.session.gen,
    task: { id: 'grandchild', parentId: 'child', status: 'running' } });
  assert.equal(manager.get(visible.id).subagents.find(task => task.id === 'grandchild').userSeq, active.userSeq,
    'a nested child started after the parent result stays attached to the initiating turn');
});

test('many child tasks keep their identities and attention counts in a bounded mobile snapshot', context => {
  const { manager, visible, pair, access, reader } = fixture(context);
  const device = access.authenticate(pair().token);
  visible.subagents = Array.from({ length: 128 }, (_, i) => ({ id: 'child-' + i, engine: 'codex', userSeq: 1,
    title: 'Review ' + i, status: 'completed', goal: '测'.repeat(16000), result: '试'.repeat(16000),
    history: Array.from({ length: 40 }, () => ({ type: 'commandExecution', text: '数'.repeat(1800) })) }));
  const tasks = reader.snapshot(device, visible.id).subagents;
  assert.equal(tasks.length, 128);
  assert.ok(Buffer.byteLength(JSON.stringify(tasks)) < 520 * 1024);
  assert.equal(tasks.at(-1).id, 'child-127'); assert.equal(tasks[0].detailsTruncated, true);
});

test('mobile clients receive child state in full and incremental snapshots with fresh permissions', context => {
  const { manager, visible, pair, access, reader, gateway } = fixture(context);
  const device = access.authenticate(pair().token);
  const child = { id: 'child', engine: 'codex', userSeq: 1, title: 'Review', status: 'waiting', turnId: 'child-turn',
    canReply: true, canStop: true, history: [], artifacts: [{ path: 'private-child-file' }],
    approvals: [{ requestId: 'child-approval', fingerprint: 'child-fingerprint', responseSupported: true }] };
  context.mock.method(manager, 'subagentView', () => [child]);
  const full = reader.snapshot(device, visible.id);
  const delta = reader.snapshot(device, visible.id, undefined, full.historyVersion);
  assert.ok(Array.isArray(full.messages), 'clients that do not request incremental updates receive full history');
  assert.equal(delta.messages, undefined); assert.equal(delta.subagents[0].status, 'waiting');
  assert.equal(delta.subagents[0].approvals[0].fingerprint, 'child-fingerprint');
  assert.equal(delta.subagents[0].artifacts, undefined, 'raw child file paths never enter mobile snapshots');
  child.status = 'running'; child.approvals = [];
  assert.equal(reader.snapshot(device, visible.id, undefined, full.historyVersion).subagents[0].status, 'running');
  child.approvals = [{ requestId: 'child-approval', fingerprint: 'child-fingerprint' }];
  const read = reader.snapshot({ ...device, permission: 'read' }, visible.id, undefined, full.historyVersion);
  assert.equal(read.permission, 'read'); assert.equal(read.subagents[0].pendingApprovals, 1);
  assert.deepEqual(read.subagents[0].approvals, []); assert.equal(read.subagents[0].canReply, false); assert.equal(read.subagents[0].canStop, false);
  const oldClient = gateway.streamSnapshot({ device, id: visible.id, kind: 'conversations', incremental: false, historyVersion: full.historyVersion });
  assert.ok(Array.isArray(oldClient.messages), 'legacy SSE clients keep complete transcript frames');
});

test('completed goal notices end with the next user turn without clearing the saved goal', context => {
  const { manager, visible, pair, access, reader } = fixture(context);
  const device = access.authenticate(pair().token);
  let now = Date.now() + 1000;
  context.mock.method(Date, 'now', () => now);
  const goal = manager.goalFor(visible.id);
  goal.goal = { id: 'goal-1', objective: 'Finish the report', phase: 'complete', roundsStarted: 2,
    verified: { at: now, evidence: 'private verification evidence' }, updatedAt: now, runToken: 'private-run-token' };
  const saved = JSON.stringify(goal.view());
  let projected = reader.snapshot(device, visible.id).automation.goal;
  assert.equal(projected.id, 'goal-1');
  assert.equal(projected.completedAt, now);
  assert.equal(JSON.stringify(projected).includes('private'), false);
  now += 100;
  manager.append(visible, { role: 'assistant', text: 'Completion details' });
  manager.append(visible, { role: 'user', text: 'Internal check', internal: true });
  assert.equal(reader.snapshot(device, visible.id).automation.goal.phase, 'complete');
  const nextUser = manager.append(visible, { role: 'user', text: '', attachments: [{ name: 'next-task.txt' }] });
  assert.equal(reader.snapshot(device, visible.id).automation.goal, null);
  // Pagination and opening the same conversation through a new reader cannot
  // resurrect the notice, even when the new user turn is outside the page.
  assert.equal(reader.snapshot(device, visible.id, nextUser.seq).automation.goal, null);
  for (let index = 0; index < 201; index++) manager.append(visible, { role: 'assistant', text: 'Progress' });
  assert.equal(new RemoteReadModel(manager).snapshot(device, visible.id).automation.goal, null);
  assert.equal(JSON.stringify(goal.view()), saved);
  for (const phase of ['active', 'paused', 'blocked']) {
    goal.goal.phase = phase;
    assert.equal(reader.snapshot(device, visible.id).automation.goal.phase, phase);
  }
  goal.goal = { ...goal.goal, id: 'goal-2', phase: 'complete', verified: { at: now + 100 }, updatedAt: now + 100 };
  assert.equal(reader.snapshot(device, visible.id).automation.goal.id, 'goal-2');
});

test('unverified legacy completions use their saved update time but verified completions keep their original boundary', context => {
  const { manager, visible, pair, access, reader } = fixture(context);
  const device = access.authenticate(pair().token);
  let now = Date.now() + 1000;
  context.mock.method(Date, 'now', () => now);
  const goal = manager.goalFor(visible.id);
  goal.goal = { objective: 'Legacy completion', phase: 'complete', updatedAt: now };
  assert.equal(reader.snapshot(device, visible.id).automation.goal.completedAt, now);
  now += 100;
  manager.append(visible, { role: 'user', text: 'The next task' });
  assert.equal(reader.snapshot(device, visible.id).automation.goal, null);
  goal.goal.verified = { at: now - 100 };
  goal.goal.updatedAt = now + 100; // A later workspace update is not a new completion.
  assert.equal(reader.snapshot(device, visible.id).automation.goal, null);
});

test('resuming a goal from the phone starts the turn the same way the desktop does', async context => {
  const { gateway, pair, visible, manager } = fixture(context);
  const { token } = pair(); await gateway.start('127.0.0.1', 0);
  // Resume dispatches a real goal turn, so the engine has to accept it.
  let starts = 0;
  manager.drivers.codex.ensure = () => ({ gen: 88, sendUserMessage() { starts++; return true; }, interrupt() {} });
  const goal = manager.goalFor(visible.id);
  // A real goal always knows its conversation; without it the resume path
  // cannot look the conversation up.
  goal.goal = { objective: 'Finish the report', phase: 'paused', roundsStarted: 1, sessionId: visible.id };
  goal.armed = false;
  const resume = { action: 'goal-control', operation: 'resume', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId };
  // The phone path is what matters: the same command the automation bar sends.
  const resumed = await request(gateway, `/v1/conversations/${visible.id}/commands`, { token, method: 'POST', payload: resume });
  assert.equal(resumed.body.ok, true, resumed.body.error);
  // Resuming arms the goal and schedules the next round rather than sending
  // inline, so the turn starts once that timer fires.
  assert.equal(goal.armed, true);
  assert.equal(goal.goal.phase, 'active');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(starts, 1, 'the resumed goal must dispatch exactly one turn');
});

test('a phone send carries the goal and task tools, and its own words authorize them', async context => {
  const { gateway, pair, visible, manager, access, commands } = fixture(context);
  const credential = pair(); await gateway.start('127.0.0.1', 0);
  // Goal/task tools only exist when a bridge is configured, exactly as on the
  // desktop; without it a send cannot offer them at all.
  manager.createGoalBridge = async options => ({ call: options.call, close() {} });
  // The phone sends an ordinary message; the model is expected to notice the
  // goal request inside it. Capture the bridge the send was given.
  const enginePrompts = [];
  manager.drivers.codex.ensure = () => ({ gen: 71, sendUserMessage(prompt) { enginePrompts.push(prompt); return true; }, interrupt() {} });
  const device = access.authenticate(credential.token);
  const sent = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send',
    prompt: '帮我把这份报告写完，设定一个目标直到完成', expectedSeq: manager.get(visible.id).seq };
  const accepted = await commands.execute(device, visible.id, sent, gateway.instanceId);
  assert.equal(accepted.ok, true);
  const active = manager.active.get(visible.id);
  // The tools are offered on a remote send, and the run token is bound to it.
  assert.ok(active.goalRunToken, 'remote send must expose the goal tools');
  assert.equal(active.goalContinuation, false);
  // The user_request quote is checked against what the phone actually said,
  // so a natural-language goal request from the phone is authorized.
  const created = await manager.callGoalTool(visible.id, 'camellia_create_goal',
    { run_token: active.goalRunToken, objective: '完成报告', user_request: '设定一个目标直到完成' });
  assert.equal(created.ok, true, created.error);
  // A quote the user never sent is still refused.
  const forged = await manager.callGoalTool(visible.id, 'camellia_create_goal',
    { run_token: active.goalRunToken, objective: '别的目标', user_request: '这句话我没说过' });
  assert.equal(forged.ok, false);

  // A scheduled task is offered and authorized the same way, checked on a
  // second conversation so the goal above cannot hold the turn.
  const other = manager.create('codex', 'allowed', '定时任务');
  const taskRun = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send',
    prompt: '训练已经启动了。\n能每十分钟帮我看一下日志吗？', expectedSeq: manager.get(other.id).seq };
  assert.equal((await commands.execute(device, other.id, taskRun, gateway.instanceId)).ok, true);
  const taskActive = manager.active.get(other.id);
  const task = await manager.callGoalTool(other.id, 'camellia_task_create',
    { run_token: taskActive.goalRunToken, user_request: '能每十分钟帮我看一下日志吗？', instruction: 'Inspect logs', intervalMinutes: 10 });
  assert.equal(task.ok, true, task.error);
  // Recovery still needs explicit authorization, on the phone as on the desktop.
  const sneaky = await manager.callGoalTool(other.id, 'camellia_task_create',
    { run_token: taskActive.goalRunToken, user_request: '能每十分钟帮我看一下日志吗？', instruction: 'Inspect logs', intervalMinutes: 10, maxRepairs: 2 });
  assert.equal(sneaky.ok, false);

  // A phone has no slash menu, so "/goal" reaches the computer as ordinary
  // text. The engine still receives the tool instructions and a run token, so
  // the model can read the request and act on it; the desktop, by contrast,
  // never sends "/goal" as a message at all.
  const third = manager.create('codex', 'allowed', '斜杠目标');
  const slash = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send',
    prompt: '/goal 把季度报告写完', expectedSeq: manager.get(third.id).seq };
  const slashResult = await commands.execute(device, third.id, slash, gateway.instanceId);
  assert.equal(slashResult.ok, true, slashResult.error || JSON.stringify(slashResult));
  const promptText = enginePrompts.at(-1);
  assert.match(promptText, /camellia_create_goal/);
  assert.match(promptText, /\/goal 把季度报告写完/);
  assert.match(promptText, /Camellia goal run token/);
});

test('workspace-scoped control cannot install runtimes or read management results', async context => {
  const management = { submit: () => assert.fail('Scoped device cannot manage server'), get: () => assert.fail('Scoped device cannot read operations') };
  const { gateway, pair } = fixture(context, { management });
  const { token } = pair(); await gateway.start('127.0.0.1', 0);
  const requestId = require('node:crypto').randomUUID();
  assert.equal((await request(gateway, '/v1/server-management', { token, method: 'POST', payload: { requestId, action: 'runtime-install', payload: { engine: 'codex', confirmed: true } } })).status, 403);
  assert.equal((await request(gateway, '/v1/server-management/' + requestId, { token })).status, 403);
});

test('remote summaries expose reply markers and invalidate list versions when activity or replies change', context => {
  const { reader, manager, visible } = fixture(context);
  const device = { workspaceIds: ['allowed'] };
  assert.equal(reader.summary(visible).lastReplyAt, 0);
  const initial = reader.listSnapshot(device).listVersion;
  manager.controlStarts.set(visible.id, {});
  assert.equal(reader.list(device).conversations[0].activity, 'running');
  assert.notEqual(reader.listSnapshot(device).listVersion, initial);
  manager.controlStarts.delete(visible.id);
  assert.equal(reader.listSnapshot(device).listVersion, initial);
  visible.lastReplyAt = 1234;
  assert.equal(reader.list(device).conversations[0].lastReplyAt, 1234);
  assert.equal(reader.snapshot(device, visible.id).conversation.lastReplyAt, 1234);
  assert.notEqual(reader.listSnapshot(device).listVersion, initial);
  assert.equal(reader.summary(visible).activity, null);
});

test('mobile and desktop share scoped read acknowledgements without consuming newer replies', async context => {
  const { gateway, manager, reader, access, visible, hidden, pair } = fixture(context);
  const { token } = pair();
  await gateway.start('127.0.0.1', 0);
  visible.lastReplyAt = 1000;
  manager.save(visible);
  const events = await stream(gateway, null, token);
  context.after(() => events.close());
  const initial = await events.next();
  const device = { workspaceIds: ['allowed'] };
  const version = reader.listSnapshot(device).listVersion;
  const route = `/v1/conversations/${visible.id}/read`;
  const options = { token, method: 'POST', payload: { lastReplyAt: 1000 } };
  assert.equal((await request(gateway, route, { ...options, token: undefined })).status, 401);
  assert.equal((await request(gateway, `/v1/conversations/${hidden.id}/read`, options)).status, 404);
  assert.equal((await request(gateway, route, { ...options, payload: { lastReplyAt: -1 } })).status, 400);
  assert.equal((await request(gateway, route, options)).body.replyReadAt, 1000);
  assert.notEqual((await events.next()).listVersion, initial.listVersion);
  assert.equal(manager.load('codex', visible.id).replyReadAt, 1000);
  assert.notEqual(reader.listSnapshot(device).listVersion, version);
  visible.lastReplyAt = 2000;
  await request(gateway, route, options);
  assert.equal(reader.summary(visible).replyReadAt, 1000);
  access.authenticate(token).permission = 'read';
  assert.equal((await request(gateway, route, { ...options, payload: { lastReplyAt: 1500 } })).body.replyReadAt, 1500);
  await manager.command('codex', 'mark-reply-read', { id: visible.id, at: 2000 });
  const page = (await request(gateway, '/v1/conversations', { token })).body;
  assert.equal(page.conversations.find(conversation => conversation.id === visible.id).replyReadAt, 2000);
});

test('artifact listing and streaming expose only authorized workspace deliverables', async context => {
  const { root, manager, gateway, access, visible, hidden, pair } = fixture(context);
  const filename = '报告 #1.pdf', contents = Buffer.from([0, 255, 13, 10, 128, 42]);
  fs.writeFileSync(path.join(root, filename), contents);
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET');
  fs.writeFileSync(path.join(root, 'unmentioned.pdf'), 'private');
  manager.append(visible, { role: 'assistant', text: '', artifacts: [{ path: filename }, { path: '.env' }] });
  manager.append(visible, { role: 'assistant', text: '`empty.txt`' });
  manager.append(visible, { role: 'assistant', text: '`unmentioned.pdf`', internal: true });
  manager.append(visible, { role: 'user', text: '`unmentioned.pdf`' });
  const { token, deviceId } = pair();
  await gateway.start('127.0.0.1', 0);
  const route = `/v1/conversations/${visible.id}/artifacts`;
  assert.equal((await request(gateway, route)).status, 401);
  assert.equal((await request(gateway, `/v1/conversations/${hidden.id}/artifacts`, { token })).status, 404);
  const listing = await request(gateway, route, { token });
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.artifacts.map(file => file.name), ['empty.txt', filename]);
  assert.equal(listing.body.nextOffset, null);
  assert.ok(!JSON.stringify(listing.body).includes(root));
  const file = listing.body.artifacts.find(file => file.name === filename);
  assert.equal(file.size, contents.length);
  assert.equal((await request(gateway, route + '?path=unmentioned.pdf', { token })).status, 400);
  assert.equal((await request(gateway, route + '/' + '0'.repeat(64), { token })).status, 404);
  const response = await fetch(gateway.url + route + '/' + file.id, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent(filename)));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
  const empty = await fetch(gateway.url + route + '/' + listing.body.artifacts[0].id, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(empty.status, 200); assert.equal((await empty.arrayBuffer()).byteLength, 0);
  fs.writeFileSync(path.join(root, filename), 'changed');
  assert.equal((await request(gateway, route + '/' + file.id, { token })).status, 404);
  const updated = (await request(gateway, route, { token })).body.artifacts.find(entry => entry.name === filename);
  manager.workspaces.archiveSession(visible.id, true);
  assert.equal((await request(gateway, route + '/' + updated.id, { token })).status, 404);
  manager.workspaces.archiveSession(visible.id, false);
  fs.unlinkSync(path.join(root, filename));
  assert.equal((await request(gateway, route + '/' + updated.id, { token })).status, 404);
  access.revoke(deviceId);
  assert.equal((await request(gateway, route, { token })).status, 401);
});

test('artifact downloads accept Windows workspace aliases with different path casing', { skip: process.platform !== 'win32' }, async context => {
  const { root, manager, reader, access, visible, pair } = fixture(context);
  const { listArtifacts, openArtifact } = require('../src/main/remote/artifacts');
  const filename = 'Case-Sensitive-Report.pdf', contents = 'artifact casing fixture';
  fs.writeFileSync(path.join(root, filename), contents);
  manager.append(visible, { role: 'assistant', text: '`' + filename + '`' });
  const credential = pair(), device = access.authenticate(credential.token);
  const original = listArtifacts(reader, device, visible.id).artifacts[0];
  visible.cwd = root.toUpperCase();
  const aliased = listArtifacts(reader, device, visible.id).artifacts[0];
  assert.equal(aliased.id, original.id);
  const opened = await openArtifact(reader, device, visible.id, aliased.id);
  try { assert.equal(await opened.handle.readFile('utf8'), contents); }
  finally { await opened.handle.close(); }
});

test('APK links with leading Windows slashes appear in the phone list and download', { skip: process.platform !== 'win32' }, async context => {
  const { root, manager, gateway, visible, pair } = fixture(context);
  const folder = path.join(root, 'dist', '安装 包');
  fs.mkdirSync(folder, { recursive: true });
  const filename = 'Camellia-Android-0.3.63-debug.apk';
  const contents = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(1024, 63)]);
  const apk = path.join(folder, filename);
  fs.writeFileSync(apk, contents);
  fs.writeFileSync(path.join(folder, 'unmentioned.apk'), 'not referenced by this conversation');
  fs.writeFileSync(path.join(root, 'README.md'), 'Updated version');
  const text = `[下载 Android 安装包](${encodeURI('/' + apk.replace(/\\/g, '/'))})`;
  manager.append(visible, { role: 'user', text: '升级一个小版本' });
  // An older collector persisted only the edited README. The listing must
  // recover the APK from the saved reply without requiring a new build/turn.
  manager.append(visible, { role: 'assistant', text, artifacts: [{ path: 'README.md' }],
    outputBlocks: [{ phase: 'final_answer', text }] });
  const { token } = pair();
  await gateway.start('127.0.0.1', 0);
  const route = `/v1/conversations/${visible.id}/artifacts`;
  const listing = await request(gateway, route, { token });
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.artifacts.map(file => file.name).sort(), [filename, 'README.md'].sort());
  assert.ok(!JSON.stringify(listing.body).includes(root));
  const file = listing.body.artifacts.find(entry => entry.name === filename);
  assert.equal(file.kind, 'package');
  assert.equal(file.extension, 'APK');
  assert.equal(file.size, contents.length);
  const response = await fetch(`${gateway.url}${route}/${file.id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
});

test('artifact listing resolves the same roots as the desktop and paginates without duplicates', async context => {
  const { root, manager, reader, access, visible, pair } = fixture(context);
  const { listArtifacts, openArtifact } = require('../src/main/remote/artifacts');
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  visible.cwd = workspace;
  fs.writeFileSync(path.join(root, 'outside.pdf'), 'private');
  const project = path.join(root, 'project'); fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.writeFileSync(path.join(project, 'out', 'deck.pptx'), 'deck');
  // A turn that ran in another directory, and a reply that names its folder.
  manager.append(visible, { role: 'user', text: 'Build the deck' });
  manager.append(visible, { role: 'tool', text: JSON.stringify({ type: 'gui:tool', id: 'one', name: 'commandExecution',
    input: { command: 'node build.js', cwd: project }, status: 'completed' }) });
  manager.append(visible, { role: 'tool', text: JSON.stringify({ type: 'gui:tool', id: 'one', status: 'completed' }) });
  manager.append(visible, { role: 'assistant', text: `- \`out${path.sep}deck.pptx\`` });
  fs.writeFileSync(path.join(workspace, '表格.doc'), 'doc');
  manager.append(visible, { role: 'user', text: 'Fill the forms' });
  manager.append(visible, { role: 'assistant', text: `**生成的文件**（\`${workspace}${path.sep}\`）\n- \`表格.doc\`` });
  const credential = pair(), device = access.authenticate(credential.token);
  const resolved = listArtifacts(reader, device, visible.id).artifacts;
  assert.deepEqual(resolved.map(file => file.name), ['表格.doc', 'deck.pptx']);
  assert.equal(resolved.find(file => file.name === '表格.doc').kind, 'document');
  // Files outside the conversation workspace are readable too, matching the
  // desktop's cross-directory deliverables; nothing is browsable but the paths
  // the conversation itself referenced.
  assert.equal(resolved.find(file => file.name === 'deck.pptx').seq, 6);
  assert.ok(!JSON.stringify(resolved).includes(root));
  for (let index = 0; index < 102; index++) {
    const name = `report-${index}.pdf`; fs.writeFileSync(path.join(workspace, name), String(index));
    manager.append(visible, { role: 'assistant', text: '`' + name + '`', artifacts: [{ path: name }] });
  }
  const first = listArtifacts(reader, device, visible.id);
  const second = listArtifacts(reader, device, visible.id, first.nextOffset);
  assert.equal(first.artifacts.length, 100); assert.equal(second.artifacts.length, 4); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.artifacts, ...second.artifacts].map(file => file.id)).size, 104);
  const file = first.artifacts[0];
  manager.workspaces.recordContext(visible.id, 'private', workspace);
  await assert.rejects(openArtifact(reader, device, visible.id, file.id), /not found/);
});

test('revocation interrupts in-flight artifact downloads and releases their handles', async context => {
  const { root, manager, gateway, access, visible, pair } = fixture(context);
  const filename = path.join(root, 'large.pdf');
  const descriptor = fs.openSync(filename, 'w'); fs.ftruncateSync(descriptor, 32 * 1024 * 1024); fs.closeSync(descriptor);
  manager.append(visible, { role: 'assistant', text: '`large.pdf`' });
  const { token, deviceId } = pair(); await gateway.start('127.0.0.1', 0);
  const route = `/v1/conversations/${visible.id}/artifacts`;
  const file = (await request(gateway, route, { token })).body.artifacts[0];
  const response = await fetch(gateway.url + route + '/' + file.id, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); assert.equal(gateway.downloads.size, 1);
  access.revoke(deviceId);
  await assert.rejects(response.arrayBuffer());
  for (let attempt = 0; attempt < 100 && gateway.downloads.size; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(gateway.downloads.size, 0);
  fs.unlinkSync(filename);
});

test('every artifact the phone is offered can actually be downloaded', async context => {
  const { root, manager, gateway, access, visible, pair } = fixture(context);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  visible.cwd = workspace;
  // One file per artifact kind the panel renders, including the presentation
  // format a reply about PPT conversion produces, plus names that stress the
  // download headers: spaces, non-ASCII and characters needing percent-encoding.
  const names = ['面试 材料.pdf', '表单.docx', '课程试讲_v4.pptx', '成绩.xlsx', 'figure.png', 'demo.mp4',
    'audio.mp3', 'Camellia-debug.apk', '旧版表格.doc', 'notes.md', 'data.csv', "带(括号)'引号.pptx"];
  const bodies = new Map();
  for (const name of names) {
    const body = Buffer.concat([Buffer.from(name), Buffer.alloc(1024, 5)]);
    bodies.set(name, body);
    fs.writeFileSync(path.join(workspace, name), body);
  }
  manager.append(visible, { role: 'user', text: 'Make the deliverables' });
  manager.append(visible, { role: 'assistant', text: names.map(name => '`' + name + '`').join('\n') });

  const { token } = pair();
  await gateway.start('127.0.0.1', 0);
  const route = `/v1/conversations/${visible.id}/artifacts`;
  const listing = await request(gateway, route, { token });
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.artifacts.map(file => file.name).sort(), [...names].sort());
  // Listing and downloading must agree: anything the panel shows the phone, the
  // same id must serve byte for byte. A format the list cannot hand over must
  // never be listed in the first place.
  for (const file of listing.body.artifacts) {
    assert.ok(['document', 'word', 'presentation', 'spreadsheet', 'image', 'video', 'audio', 'package', 'pdf', 'text'].includes(file.kind), file.kind);
    const response = await fetch(`${gateway.url}${route}/${file.id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, file.name);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    // The header is RFC 5987 encoded, so `'`, `(` and `)` are escaped too.
    const encoded = encodeURIComponent(file.name).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16));
    assert.ok(response.headers.get('content-disposition').includes(encoded), file.name);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, file.size, file.name);
    assert.deepEqual(body, bodies.get(file.name), file.name);
  }
});

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
    const restored = new RemoteAccess({ file, now: () => 1000 });
    const device = restored.authenticate(credential.token);
    assert.equal(device.permission, 'control');
    assert.equal(device.id, credential.deviceId);
    assert.deepEqual(device.workspaceIds, ['allowed']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).devices, [{ ...legacy, permission: 'control' }]);
    assert.equal(new RemoteAccess({ file, now: () => 1000 }).authenticate(credential.token).permission, 'control');
    restored.revoke(device.id);
    assert.throws(() => restored.authenticate(credential.token), /authentication/);
  }
});

test('authenticated device activity is live immediately and persisted at most once a minute', context => {
  const { root, access, pair, advance } = fixture(context);
  const credential = pair(), file = path.join(root, 'devices.json');
  const savedDevice = () => JSON.parse(fs.readFileSync(file, 'utf8')).devices[0];
  assert.equal(savedDevice().lastSeenAt, 1000);
  advance(20000);
  assert.throws(() => access.authenticate('invalid-token'), /authentication/);
  assert.equal(access.view().devices[0].lastSeenAt, 1000);
  access.authenticate(credential.token);
  assert.equal(access.view().devices[0].lastSeenAt, 21000);
  assert.equal(savedDevice().lastSeenAt, 1000);
  advance(40000);
  access.authenticate(credential.token);
  assert.equal(savedDevice().lastSeenAt, 61000);
  const restored = new RemoteAccess({ file, now: () => 61000 });
  assert.equal(restored.view().devices[0].lastSeenAt, 61000);
  assert.equal(restored.authenticate(credential.token).id, credential.deviceId);
  assert.deepEqual(savedDevice().workspaceIds, ['allowed']);
  access.revoke(credential.deviceId);
  assert.equal(access.lastSeenAt.has(credential.deviceId), false);
  assert.equal(access.lastSeenPersistedAt.has(credential.deviceId), false);
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
  assert.deepEqual(Object.keys(snapshot.settings).sort(), ['appliesNextTurn', 'connection', 'editable', 'engine', 'fastMode', 'model', 'modelEditable', 'models', 'permissionLevels', 'permissionMode', 'quickSwitch', 'supportsFast', 'thinking', 'version']);
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
  assert.match((await commands.execute(device, visible.id, payload({ permissionMode: 'ask' }), gateway.instanceId)).error, /Stop/);
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
  for (let index = 0; index < 210; index++) manager.append(visible, { role: 'assistant', text: String(index) });
  const page = reader.snapshot(device, visible.id);
  assert.equal(page.messages.length, 200);
  const older = reader.snapshot(device, visible.id, page.nextBefore);
  assert.equal(older.messages.length, 12);
  assert.equal(older.nextBefore, null);
  manager.append(visible, { role: 'assistant', text: 'x'.repeat(300_000) });
  const latest = reader.snapshot(device, visible.id).messages.at(-1);
  assert.equal(latest.textTruncated, true);
  assert.equal(latest.text.length, 256 * 1024);
});

test('history pages include more long replies while retaining a bounded payload', context => {
  const { access, reader, manager, visible, pair } = fixture(context);
  const device = access.authenticate(pair().token);
  for (let index = 0; index < 12; index++) manager.append(visible, { role: 'assistant', text: 'x'.repeat(100_000) });
  const page = reader.snapshot(device, visible.id);
  assert.equal(page.messages.length, 10);
  assert.ok(page.messages.reduce((size, row) => size + row.text.length, 0) <= 1024 * 1024);
  assert.ok(page.nextBefore);
  const older = reader.snapshot(device, visible.id, page.nextBefore);
  assert.equal(older.nextBefore, null);
  assert.ok(older.messages.every(row => row.seq < page.messages[0].seq));
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

test('the desktop name travels with the invitation and authorized devices can be renamed', async context => {
  const { access } = fixture(context);
  const invitation = access.invite(['allowed'], { computerName: '  Work PC  ' });
  assert.equal(invitation.computerName, 'Work PC');
  const request = access.request({ code: invitation.code, name: 'Phone' });
  assert.equal(request.computerName, 'Work PC');
  assert.equal(access.view().pending[0].computerName, 'Work PC');
  access.approve(request.id);
  const claimed = access.claim(request.id, request.claim);
  assert.equal(claimed.state, 'approved');
  access.rename(claimed.deviceId, '  Living room PC  ');
  assert.equal(access.view().devices[0].name, 'Living room PC');
  // The one-time code stays bound to the request; renaming must not touch it.
  assert.throws(() => access.rename('00000000-0000-0000-0000-000000000000', 'Other'), /Invalid device/);
  assert.throws(() => access.rename(claimed.deviceId, '   '), /1–80 characters/);
  assert.throws(() => access.rename(claimed.deviceId, 'x'.repeat(81)), /1–80 printable characters/);
  // An absent name is allowed and simply omits the field instead of failing.
  const unnamed = access.invite(['allowed']);
  assert.equal(unnamed.computerName, null);
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

test('API key import needs full-device control and returns the desktop export bundle', async context => {
  const bundle = { format: 'camellia-api-routes', version: 2, exportedAt: '2026-01-01T00:00:00.000Z',
    config: { enabled: true, port: 8788, providers: [{ id: 'primary', type: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'dual', models: [{ id: 'chat', upstream: 'chat' }], keys: [{ id: 'key-1', name: 'Main', key: 'sk-fixture-secret', enabled: true }] }] } };
  const { gateway, access, pair } = fixture(context, { apiRoutes: () => structuredClone(bundle) });
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  const scoped = access.authenticate(credential.token);
  assert.equal((await request(gateway, '/v1/status', { token: credential.token })).body.capabilities.includes('api-keys'), false);
  assert.equal((await request(gateway, '/v1/api-keys', { token: credential.token })).status, 403);
  access.setScope(scoped.id, [], { allWorkspaces: true, includeUnassigned: true });
  const full = access.authenticate(credential.token);
  assert.ok((await request(gateway, '/v1/status', { token: credential.token })).body.capabilities.includes('api-keys'));
  const exported = await request(gateway, '/v1/api-keys', { token: credential.token });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.format, 'camellia-api-routes');
  assert.equal(exported.body.version, 2);
  assert.equal(exported.body.config.providers[0].keys[0].key, 'sk-fixture-secret');
  assert.equal(exported.body.instanceId, gateway.instanceId);
  assert.equal((await request(gateway, '/v1/api-keys?offset=1', { token: credential.token })).status, 400);
  assert.equal((await request(gateway, '/v1/api-keys', { token: credential.token, method: 'POST', payload: {} })).status, 405);
  access.setScope(full.id, ['allowed']);
  assert.equal((await request(gateway, '/v1/api-keys', { token: credential.token })).status, 403);
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

test('remote compaction states survive coalescing and completed notices retain only display metadata', async context => {
  const { reader, manager, visible, hidden, access, pair } = fixture(context);
  const device = access.authenticate(pair().token), runs = queuedRuns(manager, visible.id);
  await manager.send('codex', { sessionId: visible.id, prompt: 'Work' });
  const capture = value => manager.capture('codex', { ...value, conversationId: visible.id, runId: manager.active.get(visible.id).session.gen });
  capture({ type: 'gui:compaction', state: 'running' });
  assert.equal(reader.snapshot(device, visible.id).compaction.state, 'running');
  capture({ type: 'gui:compaction', state: 'completed', durationMs: 42000 });
  let snapshot = reader.snapshot(device, visible.id);
  assert.equal(snapshot.compaction.state, 'completed');
  const notice = snapshot.messages.find(row => row.compaction);
  assert.deepEqual(notice.compaction, { state: 'completed', native: true, engine: 'codex', seq: notice.seq, durationMs: 42000 });
  assert.equal(snapshot.compaction.seq, notice.seq, 'Phone can deduplicate the live and persisted completion');
  runs.finish();
  assert.equal(reader.snapshot(device, visible.id).compaction.state, 'completed');
  const otherReader = new RemoteReadModel(manager);
  assert.equal(otherReader.snapshot(device, visible.id).messages.find(row => row.compaction).compaction.state, 'completed');
  manager.append(visible, { role: 'user', text: 'Continue' });
  assert.equal(reader.snapshot(device, visible.id).compaction, null);
  manager.append(visible, { role: 'notice', text: 'Context compacted: summary saved', compaction: { durationMs: 1000, used: 123456, cap: 32000, summary: 'private diagnostic' } });
  assert.deepEqual(reader.snapshot(device, visible.id).messages.at(-1).compaction, { state: 'completed', native: false, seq: visible.seq, durationMs: 1000 });
  assert.throws(() => reader.snapshot(device, hidden.id), /not found/);
});

test('remote compaction progress streams without usage data and keeps failure distinct from completion', { timeout: 8000 }, async context => {
  const { gateway, reader, manager, visible, pair } = fixture(context);
  manager.contextPressure = () => null;
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  const connection = await stream(gateway, visible.id, credential.token);
  await connection.next();
  const compaction = { state: 'running', stage: 'summarizing', chunk: 2, finalChunk: true };
  manager.switching.set(visible.id, { target: 'codex', compaction });
  manager.onStatus({ sessionId: visible.id, compaction });
  let snapshot = await connection.next();
  assert.equal(snapshot.context, undefined);
  assert.deepEqual(snapshot.compaction, { ...compaction, native: false, afterSeq: visible.seq });
  assert.equal(reader.snapshot(gateway.access.authenticate(credential.token), visible.id, visible.seq).compaction, null);
  manager.switching.delete(visible.id);
  manager.onStatus({ sessionId: visible.id, compaction: { state: 'failed' } });
  manager.onStatus({ sessionId: visible.id, text: '' });
  snapshot = await connection.next();
  assert.equal(snapshot.compaction.state, 'failed');
  manager.onStatus({ sessionId: visible.id, compaction: { state: 'cancelled' } });
  snapshot = await connection.next();
  assert.equal(snapshot.compaction.state, 'cancelled');
  connection.close();
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

test('remote projection retains terminal errors alongside structured output', context => {
  const { reader, manager, visible, access, pair } = fixture(context);
  const device = access.authenticate(pair().token);
  manager.append(visible, { role: 'assistant', text: '', outputBlocks: [{ phase: 'commentary', text: 'Working' }],
    runResult: { subtype: 'error', is_error: true, result: 'Provider unavailable' }, mobileText: 'Provider unavailable' });
  let snapshot = reader.snapshot(device, visible.id);
  assert.equal(snapshot.messages.at(-1).text, 'Provider unavailable');
  assert.equal(snapshot.messages.at(-1).process[0].text, 'Working');
  manager.append(visible, { role: 'assistant', text: 'Partial answer', outputBlocks: [{ phase: 'final_answer', text: 'Partial answer' }],
    runResult: { subtype: 'error', is_error: true, result: 'Provider unavailable' } });
  snapshot = reader.snapshot(device, visible.id);
  assert.equal(snapshot.messages.at(-1).text, 'Partial answer\n\nProvider unavailable');
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
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage() { sent++; return true; },
    interrupt() { manager.capture('codex', { type: 'result', conversationId: visible.id, runId: this.gen, subtype: 'stopped', result: '' }); },
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
  assert.equal(manager.busy(visible.id), false);
  access.revoke(credential.deviceId);
  assert.equal((await send(stop)).status, 401);
  assert.equal(commands.entries.filter(entry => entry.result?.state === 'accepted').length, 1);
});

test('a slow native stop stays pending until confirmation and duplicate requests interrupt only once', async context => {
  const { manager, commands, gateway, access, pair, visible } = fixture(context);
  const device = access.authenticate(pair().token);
  let interrupted = 0;
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage() { return true; }, interrupt() { interrupted++; } });
  const run = await manager.send('codex', { sessionId: visible.id, prompt: 'Work until interrupted' });
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'stop', runId: run.runId };
  const execute = () => commands.execute(device, visible.id, payload, gateway.instanceId);
  assert.equal((await execute()).state, 'pending');
  assert.equal(manager.busy(visible.id), true);
  assert.equal(interrupted, 1);
  const repeated = execute();
  manager.capture('codex', { type: 'result', conversationId: visible.id, runId: 42, subtype: 'stopped', result: '' });
  assert.equal((await repeated).ok, true);
  assert.equal((await execute()).ok, true);
  assert.equal(manager.busy(visible.id), false);
  assert.equal(interrupted, 1);
  assert.equal((await run.done).subtype, 'stopped');
});

test('ordinary remote questions deliver native answers once and reject stale requests', async context => {
  const { gateway, manager, access, reader, visible, pair, root } = fixture(context);
  const { token } = pair(), answers = [];
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage() { return true; }, interrupt() {},
    answerPermission(...args) { answers.push(args); return true; } });
  await gateway.start('127.0.0.1', 0);
  const route = `/v1/conversations/${visible.id}/commands`;
  const send = payload => request(gateway, route, { token, method: 'POST', payload: {
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, ...payload } });
  assert.equal((await send({ action: 'send', prompt: 'Ask questions', expectedSeq: visible.seq })).body.ok, true);
  const active = manager.active.get(visible.id);
  const event = { requestId: 'questions', toolName: 'AskUserQuestion', input: {}, questions: [
    { id: 'role', question: 'Role?', options: [{ label: 'Scientist' }] },
    { id: 'inputs', question: 'Inputs?', multiSelect: true, options: [{ label: 'Image' }, { label: 'Text' }] },
    { id: 'note', question: 'Private note?', isSecret: true, options: [] },
  ] };
  active.permissions.set(event.requestId, event);
  const projected = reader.snapshot(access.authenticate(token), visible.id).live.approvals[0];
  assert.equal(projected.actionable, false); assert.equal(projected.responseSupported, true);
  const response = { requestId: require('node:crypto').randomUUID(), action: 'approve', runId: active.facade.gen,
    approvalId: event.requestId, fingerprint: projected.fingerprint, allow: true,
    input: { role: 'Scientist', inputs: ['Image', 'Text'], note: 'private-answer-marker' } };
  assert.equal((await send({ ...response, requestId: require('node:crypto').randomUUID(), input: { role: 'Scientist' } })).body.ok, false);
  assert.equal(answers.length, 0);
  assert.equal((await send(response)).body.ok, true);
  assert.equal((await send(response)).body.ok, true);
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].slice(0, 3), [event.requestId, true, response.input]);
  assert.ok(!fs.readFileSync(path.join(root, 'commands.json'), 'utf8').includes('private-answer-marker'));
  active.permissions.set(event.requestId, { ...event, questions: [{ id: 'changed', question: 'Changed question?' }] });
  assert.equal((await send({ ...response, requestId: require('node:crypto').randomUUID() })).body.ok, false);
  assert.equal(answers.length, 1);
  await send({ action: 'stop', runId: active.facade.gen });
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
  assert.ok(status.engines.includes('pi'));
  const pi = await create({ ...payload, requestId: require('node:crypto').randomUUID(), engine: 'pi' });
  assert.equal(pi.body.ok, true);
  assert.equal(pi.body.conversation.engine, 'pi');
  assert.equal(manager.get(pi.body.conversation.id).currentEngine, 'pi');
  access.setScope(credential.deviceId, ['allowed'], { includeUnassigned: true });
  const independent = await create({ ...payload, requestId: require('node:crypto').randomUUID(), workspaceId: null });
  assert.equal(independent.body.ok, true); assert.equal(independent.body.conversation.workspaceId, null);
});

test('mobile create then send generates a title visible in snapshots and lists', async context => {
  const { gateway, manager, pair } = fixture(context);
  const { token } = pair();
  const calls = [];
  manager.generateTitle = async message => { calls.push(message); return 'Remote title'; };
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage() { return true; }, interrupt() {} });
  await gateway.start('127.0.0.1', 0);
  const created = await request(gateway, '/v1/commands', { token, method: 'POST', payload: {
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'create', workspaceId: 'allowed', engine: 'codex',
  } });
  assert.equal(created.body.ok, true);
  assert.deepEqual(calls, []);
  const conversation = created.body.conversation;
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'send', expectedSeq: conversation.seq, prompt: 'Name this remote conversation' };
  const endpoint = `/v1/conversations/${conversation.id}/commands`;
  assert.equal((await request(gateway, endpoint, { token, method: 'POST', payload })).body.ok, true);
  assert.equal((await request(gateway, endpoint, { token, method: 'POST', payload })).body.ok, true);
  assert.deepEqual(calls, [payload.prompt]);
  const snapshot = await request(gateway, `/v1/conversations/${conversation.id}`, { token });
  assert.equal(snapshot.body.conversation.title, 'Remote tit');
  const list = await request(gateway, '/v1/conversations', { token });
  assert.equal(list.body.conversations.find(item => item.id === conversation.id).title, 'Remote tit');
});

for (const workspaceId of ['allowed', null]) test('mobile new conversation keeps a readable title while the API is offline in workspace ' + workspaceId, async context => {
  const { gateway, manager, access, pair } = fixture(context);
  const credential = pair(), token = credential.token;
  access.setScope(credential.deviceId, ['allowed'], { includeUnassigned: true });
  manager.generateTitle = async () => { throw new Error('API router is offline'); };
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage() { return true; }, interrupt() {} });
  await gateway.start('127.0.0.1', 0);
  const created = await request(gateway, '/v1/commands', { token, method: 'POST', payload: {
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'create', workspaceId, engine: 'codex',
  } });
  assert.equal(created.body.ok, true);
  const id = created.body.conversation.id;
  const sent = await request(gateway, `/v1/conversations/${id}/commands`, { token, method: 'POST', payload: {
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'send', expectedSeq: created.body.conversation.seq, prompt: '请帮我修复远程会话命名失败',
  } });
  assert.equal(sent.body.ok, true);
  await flushQueue();
  const snapshot = await request(gateway, `/v1/conversations/${id}`, { token });
  const list = await request(gateway, '/v1/conversations', { token });
  assert.equal(snapshot.body.conversation.title, '修复远程会话命名失败');
  assert.equal(list.body.conversations.find(item => item.id === id).title, snapshot.body.conversation.title);
  assert.equal(JSON.parse(fs.readFileSync(manager.file(id))).title, snapshot.body.conversation.title);
  assert.equal(manager.get(id).titleSource, 'message');
});

test('mobile event streams show a provisional title and then the background model title', async context => {
  const { gateway, manager, pair } = fixture(context), { token } = pair();
  let resolveTitle;
  manager.generateTitle = () => new Promise(resolve => { resolveTitle = resolve; });
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage() { return true; }, interrupt() {} });
  await gateway.start('127.0.0.1', 0);
  const created = await request(gateway, '/v1/commands', { token, method: 'POST', payload: {
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'create', workspaceId: 'allowed', engine: 'codex',
  } });
  assert.equal(created.body.ok, true);
  const id = created.body.conversation.id, events = await stream(gateway, id, token);
  context.after(() => events.close());
  assert.equal((await events.next()).conversation.title, 'New session');
  const sent = await request(gateway, `/v1/conversations/${id}/commands`, { token, method: 'POST', payload: {
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'send', expectedSeq: created.body.conversation.seq, prompt: 'First visible request',
  } });
  assert.equal(sent.body.ok, true);
  assert.equal((await events.next()).conversation.title, 'First visi');
  resolveTitle('远程命名修复');
  // The send also publishes activity snapshots; drain them until the title
  // changes, with a finite read deadline so a missing update fails the test.
  const deadline = setTimeout(() => events.close(), 3000);
  try {
    let snapshot;
    do { snapshot = await events.next(); } while (snapshot && snapshot.conversation.title !== '远程命名修复');
    assert.equal(snapshot?.conversation.title, '远程命名修复');
  } finally { clearTimeout(deadline); events.close(); }
});

test('mobile resend rewrites the latest user message through editSeq', async context => {
  const { gateway, manager, pair, visible } = fixture(context);
  const { token } = pair();
  manager.generateTitle = async () => 'Title';
  manager.drivers.codex.ensure = () => ({ gen: 42, sessionId: 'native-session',
    sendUserMessage() { manager.capture('codex', { type: 'result', subtype: 'success', result: 'Reply', session_id: 'native-session', runId: 42 }); return true; },
    interrupt() {}, resume() { return { gen: 42, sendUserMessage() { return true; }, interrupt() {} }; } });
  await gateway.start('127.0.0.1', 0);
  const created = await request(gateway, '/v1/commands', { token, method: 'POST', payload: {
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'create', workspaceId: 'allowed', engine: 'codex',
  } });
  assert.equal(created.body.ok, true);
  const conversation = created.body.conversation;
  const endpoint = `/v1/conversations/${conversation.id}/commands`;
  const post = payload => request(gateway, endpoint, { token, method: 'POST', payload });
  const sent = await post({ requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'send', expectedSeq: conversation.seq, prompt: 'Original request' });
  assert.equal(sent.body.ok, true);
  await manager.active.get(conversation.id)?.done;
  const snapshot = await request(gateway, `/v1/conversations/${conversation.id}`, { token });
  const latestUser = snapshot.body.messages.filter(row => row.role === 'user').at(-1);
  const resendSnapshot = await request(gateway, `/v1/conversations/${conversation.id}`, { token });
  const resend = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'resend', expectedSeq: resendSnapshot.body.conversation.seq, editSeq: latestUser.seq, prompt: 'Revised request' };
  assert.equal((await post(resend)).body.ok, true);
  await manager.active.get(conversation.id)?.done;
  const rows = manager.messages(manager.get(conversation.id)).filter(row => row.role === 'user' || row.role === 'revision');
  assert.deepEqual(rows.map(row => row.text), ['Revised request']);
  const fresh = await request(gateway, `/v1/conversations/${conversation.id}`, { token });
  const freshSeq = fresh.body.conversation.seq;
  const stale = { ...resend, requestId: require('node:crypto').randomUUID(), expectedSeq: freshSeq, editSeq: latestUser.seq };
  const staleResponse = await post(stale);
  assert.equal(staleResponse.status, 200);
  assert.equal(staleResponse.body.ok, false);
  const wrongSeq = { ...resend, requestId: require('node:crypto').randomUUID(), expectedSeq: freshSeq + 1 };
  assert.equal((await post(wrongSeq)).body.ok, false);
  const missingSeq = { ...resend, requestId: require('node:crypto').randomUUID(), expectedSeq: freshSeq };
  delete missingSeq.editSeq;
  assert.equal((await post(missingSeq)).body.ok, false);
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

test('mobile archive hides the conversation, deduplicates and rejects stale state', async context => {
  const { gateway, manager, access, reader, visible, pair, events } = fixture(context);
  const credential = pair(), token = credential.token;
  await gateway.start('127.0.0.1', 0);
  const device = access.devices.find(item => item.id === credential.deviceId);
  const archive = patch => ({ requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId,
    action: 'archive', conversationId: visible.id, expectedSeq: visible.seq, ...patch });
  const send = value => request(gateway, '/v1/commands', { token, method: 'POST', payload: value });
  assert.ok((await request(gateway, '/v1/status', { token })).body.capabilities.includes('archive'));
  const before = reader.listSnapshot(device).listVersion;
  device.permission = 'read';
  assert.equal((await send(archive())).status, 403);
  device.permission = 'control';
  assert.equal((await send(archive({ expectedSeq: visible.seq + 1 }))).body.ok, false);
  assert.equal(manager.workspaces.sessionMeta().archived[visible.id], undefined);
  assert.equal(events.some(event => event.type === 'conversation:archived'), false);
  const payload = archive();
  const archived = await send(payload);
  assert.equal(archived.body.ok, true);
  assert.deepEqual((await send(payload)).body, archived.body);
  assert.ok(manager.workspaces.sessionMeta().archived[visible.id] > 0);
  assert.equal(reader.list(device).conversations.some(conversation => conversation.id === visible.id), false);
  assert.notEqual(reader.listSnapshot(device).listVersion, before);
  assert.deepEqual(events.filter(event => event.type === 'conversation:archived'), [
    { type: 'conversation:archived', session_id: visible.id, engine: 'codex', archived: true },
  ]);
});

test('mobile conversation actions rename, pin and delete with scoped deduplicated requests', async context => {
  const { gateway, manager, reader, access, visible, hidden, pair } = fixture(context);
  const credential = pair(), device = access.devices.find(item => item.id === credential.deviceId);
  await gateway.start('127.0.0.1', 0);
  const send = payload => request(gateway, '/v1/commands', { token: credential.token, method: 'POST', payload });
  const command = (action, targets, extra = {}) => ({ requestId: require('node:crypto').randomUUID(),
    instanceId: gateway.instanceId, action, targets: targets.map(item => ({ id: item.id, seq: item.seq })), ...extra });
  assert.ok((await request(gateway, '/v1/status', { token: credential.token })).body.capabilities.includes('conversation-actions'));
  const rename = command('rename', [visible], { title: 'Renamed on phone' });
  const before = reader.listSnapshot(device).listVersion;
  assert.equal((await send(rename)).body.ok, true);
  assert.equal(reader.summary(visible).title, 'Renamed on phone');
  assert.notEqual(reader.listSnapshot(device).listVersion, before);
  assert.equal((await send(command('rename', [visible], { title: '  ' }))).body.ok, false);
  const pin = command('pin', [visible], { pinned: true });
  assert.equal((await send(pin)).body.ok, true);
  assert.equal((await send(pin)).body.ok, true);
  assert.equal(reader.summary(visible).pinned, true);
  assert.equal(reader.list(device).conversations[0].id, visible.id);
  assert.equal((await send(command('pin', [visible], { pinned: false }))).body.ok, true);
  assert.equal(reader.summary(visible).pinned, false);
  assert.equal((await send(command('delete', [visible, hidden]))).status, 404);
  assert.ok(manager.items.has(visible.id));
  const another = manager.create('codex', 'allowed');
  manager.controlStarts.set(another.id, {});
  assert.equal((await send(command('delete', [visible, another]))).body.ok, false);
  assert.ok(manager.items.has(visible.id)); manager.controlStarts.delete(another.id);
  const stale = command('delete', [visible]); stale.targets[0].seq++;
  assert.equal((await send(stale)).body.ok, false);
  device.permission = 'read';
  assert.equal((await send(command('pin', [visible], { pinned: true }))).status, 403);
  device.permission = 'control';
  const deletion = command('delete', [visible, another]);
  assert.equal((await send(deletion)).body.ok, true);
  assert.equal(manager.items.has(visible.id), false); assert.equal(manager.items.has(another.id), false);
  assert.equal((await send(deletion)).body.ok, true);
  assert.equal((await send({ ...deletion, targets: [{ id: hidden.id, seq: hidden.seq }] })).status, 404);
  device.workspaceIds = [];
  assert.equal((await send(deletion)).status, 403);
});

test('native settings endpoints require full control, matching engine and explicit service validation', async context => {
  const calls = [];
  const { gateway, access, pair } = fixture(context, { nativeSettings: { get: engine => ({ engine, files: [] }), save: payload => { calls.push(payload); return { ok: true }; } } });
  const credential = pair(); await gateway.start('127.0.0.1', 0);
  assert.equal((await request(gateway, '/v1/native-settings/claude', { token: credential.token })).status, 403);
  access.setScope(credential.deviceId, [], { allWorkspaces: true });
  assert.equal((await request(gateway, '/v1/native-settings/claude', { token: credential.token })).body.engine, 'claude');
  assert.ok((await request(gateway, '/v1/status', { token: credential.token })).body.capabilities.includes('native-settings'));
  assert.equal((await request(gateway, '/v1/native-settings/claude', { token: credential.token, method: 'POST', payload: { engine: 'codex' } })).status, 400);
  assert.equal((await request(gateway, '/v1/native-settings/claude', { token: credential.token, method: 'POST', payload: { engine: 'claude', confirmed: true } })).body.ok, true);
  // Every engine the status endpoint advertises must also be routable here;
  // Pi was listed in /v1/status but rejected by this allow-list.
  for (const engine of (await request(gateway, '/v1/status', { token: credential.token })).body.engines) {
    assert.equal((await request(gateway, `/v1/native-settings/${engine}`, { token: credential.token })).body.engine, engine, engine);
  }
  access.revoke(credential.deviceId);
  assert.equal((await request(gateway, '/v1/native-settings/claude', { token: credential.token, method: 'POST', payload: { engine: 'claude' } })).status, 401);
  assert.equal(calls.length, 1);
});

test('API import HTTP endpoints require full-device control and do not expose raw keys', async context => {
  let applied = 0;
  const { gateway, access, pair } = fixture(context, { apiImport: { state: () => ({ revision: 'a'.repeat(64), policy: 'keep-server' }), apply: () => { applied++; return { ok: true }; } } });
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  assert.equal((await request(gateway, '/v1/api-import', { token: credential.token })).status, 403);
  assert.equal((await request(gateway, '/v1/api-import', { token: credential.token, method: 'POST', payload: {} })).status, 403);
  access.setScope(credential.deviceId, [], { allWorkspaces: true, includeUnassigned: true });
  assert.equal((await request(gateway, '/v1/api-import', { token: credential.token })).body.policy, 'keep-server');
  assert.ok((await request(gateway, '/v1/status', { token: credential.token })).body.capabilities.includes('api-import'));
  assert.equal((await request(gateway, '/v1/api-import', { token: credential.token, method: 'POST', payload: {} })).body.ok, true);
  assert.equal((await request(gateway, '/v1/api-import?secret=x', { token: credential.token })).status, 400);
  access.revoke(credential.deviceId);
  assert.equal((await request(gateway, '/v1/api-import', { token: credential.token, method: 'POST', payload: {} })).status, 401);
  assert.equal(applied, 1);
});

test('remote workspace removal requires full control, checks busy state, retains files and deduplicates', async context => {
  const { gateway, manager, access, visible, pair, root } = fixture(context);
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  const payload = { action: 'delete-workspace', workspaceId: 'allowed', expectedName: 'Allowed', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId };
  const send = value => request(gateway, '/v1/commands', { token: credential.token, method: 'POST', payload: value });
  assert.equal((await send(payload)).status, 403);
  access.setScope(credential.deviceId, [], { allWorkspaces: true, includeUnassigned: true });
  manager.controlStarts.set(visible.id, {});
  assert.equal((await send({ ...payload, requestId: require('node:crypto').randomUUID() })).body.ok, false);
  manager.controlStarts.delete(visible.id);
  assert.equal((await send({ ...payload, expectedName: 'stale', requestId: require('node:crypto').randomUUID() })).body.ok, false);
  assert.equal((await send(payload)).body.ok, true);
  assert.equal((await send(payload)).body.ok, true);
  assert.equal(fs.existsSync(root), true);
  assert.equal(manager.workspaces.sessionMeta().sessionWorkspace[visible.id], null);
  assert.equal(visible.cwd, root);
});

test('workspace rename is scoped, checks old name and deduplicates retries', async context => {
  const { gateway, access, pair, manager } = fixture(context);
  const credential = pair(); await gateway.start('127.0.0.1', 0);
  const payload = { action: 'rename-workspace', workspaceId: 'allowed', expectedName: 'Allowed', name: 'Renamed', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId };
  const send = value => request(gateway, '/v1/commands', { token: credential.token, method: 'POST', payload: value });
  assert.equal((await send(payload)).status, 403);
  access.setScope(credential.deviceId, [], { allWorkspaces: true, includeUnassigned: true });
  assert.equal((await send(payload)).body.ok, true);
  assert.equal((await send(payload)).body.ok, true);
  assert.equal(manager.workspaces.sessionMeta().workspaces.find(entry => entry.id === 'allowed').name, 'Renamed');
  assert.equal((await send({ ...payload, requestId: require('node:crypto').randomUUID() })).body.ok, false);
});

test('batch deletion supports 100 targets through the HTTP command limit', async context => {
  const { gateway, manager, pair } = fixture(context);
  const credential = pair(); await gateway.start('127.0.0.1', 0);
  const targets = Array.from({ length: 100 }, () => { const conversation = manager.create('codex', 'allowed'); return { id: conversation.id, seq: conversation.seq }; });
  const payload = { action: 'delete', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, targets };
  assert.ok(JSON.stringify(payload).length > 4096);
  const reply = await request(gateway, '/v1/commands', { token: credential.token, method: 'POST', payload });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.ok(targets.every(target => !manager.items.has(target.id)));
});

test('archived listing and restore obey workspace scopes and reject stale sequences', async context => {
  const { gateway, manager, visible, hidden, pair, events } = fixture(context);
  const credential = pair(); await gateway.start('127.0.0.1', 0);
  await manager.command('codex', 'archive-session', { id: visible.id, archived: true });
  await manager.command('kimi', 'archive-session', { id: hidden.id, archived: true });
  const archived = await request(gateway, '/v1/archived?offset=0', { token: credential.token });
  assert.deepEqual(archived.body.conversations.map(entry => entry.id), [visible.id]);
  assert.equal((await request(gateway, `/v1/conversations/${visible.id}`, { token: credential.token })).status, 404);
  const payload = { action: 'restore', conversationId: visible.id, expectedSeq: visible.seq, requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId };
  const send = value => request(gateway, '/v1/commands', { token: credential.token, method: 'POST', payload: value });
  assert.equal((await send({ ...payload, conversationId: hidden.id })).status, 404);
  assert.equal((await send({ ...payload, requestId: require('node:crypto').randomUUID(), expectedSeq: -1 })).body.ok, false);
  assert.equal((await send(payload)).body.ok, true);
  assert.equal((await send(payload)).body.ok, true);
  assert.equal((await request(gateway, `/v1/conversations/${visible.id}`, { token: credential.token })).status, 200);
  assert.equal((await request(gateway, '/v1/archived', { token: credential.token })).body.conversations.length, 0);
  assert.deepEqual(events.filter(event => event.type === 'conversation:archived'), [
    { type: 'conversation:archived', session_id: visible.id, engine: 'codex', archived: false },
  ]);
});

test('desktop attachments are scoped, bounded and deduplicated without accepting client filesystem paths', async context => {
  const { gateway, manager, visible, pair, root } = fixture(context);
  const credential = pair(); await gateway.start('127.0.0.1', 0);
  let sent = 0, files, prompt;
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage(text, attachments) { sent++; files = attachments; prompt = text; return true; }, interrupt() {} });
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', expectedSeq: visible.seq, prompt: 'Read notes',
    attachments: [{ name: 'notes.txt', data: Buffer.from('Only fixture data').toString('base64'), isImage: false }] };
  const send = value => request(gateway, `/v1/conversations/${visible.id}/commands`, { token: credential.token, method: 'POST', payload: value });
  assert.equal((await send({ ...payload, requestId: require('node:crypto').randomUUID(), attachments: [{ ...payload.attachments[0], path: '/etc/passwd' }] })).body.ok, false);
  assert.equal((await send({ ...payload, requestId: require('node:crypto').randomUUID(), image: 'bad' })).body.ok, false);
  assert.equal((await send(payload)).body.ok, true);
  assert.equal((await send(payload)).body.ok, true);
  assert.equal(sent, 1); assert.equal(files[0].name, 'notes.txt');
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'Only fixture data');
  assert.equal(path.dirname(files[0].path), path.join(root, 'device-attachments'));
  assert.ok(prompt.includes(files[0].path.replace(/\\/g, '\\\\')));
  const snapshot = await request(gateway, `/v1/conversations/${visible.id}`, { token: credential.token });
  assert.equal(snapshot.body.messages.at(-1).text, 'Read notes');
  assert.deepEqual(snapshot.body.messages.at(-1).attachedFiles, [{ name: 'notes.txt', isImage: false }]);
  assert.equal(JSON.stringify(snapshot.body.messages).includes('device-attachments'), false);
});

test('remote PDF and mainstream office attachments reach the computer unchanged', async context => {
  const { gateway, manager, visible, pair } = fixture(context);
  const credential = pair(); await gateway.start('127.0.0.1', 0);
  let sent = 0, files;
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage(prompt, attachments) { sent++; files = attachments; return true; }, interrupt() {} });
  const names = ['paper.pdf', 'notes.doc', 'notes.docx', 'data.xls', 'data.xlsx', 'slides.ppt', 'slides.pptx',
    'notes.rtf', 'notes.odt', 'data.ods', 'slides.odp', 'notes.txt', 'notes.md', 'data.csv'];
  const originals = new Map(names.map(name => [name, Buffer.from(name.endsWith('.pdf') ? '%PDF-1.7\n%%EOF\n' : `Original bytes: ${name}`)]));
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', expectedSeq: visible.seq, prompt: 'Read these documents',
    attachments: names.map(name => ({ name, data: originals.get(name).toString('base64'), isImage: false })) };
  const endpoint = `/v1/conversations/${visible.id}/commands`;
  const first = await request(gateway, endpoint, { token: credential.token, method: 'POST', payload });
  assert.equal(first.body.ok, true, first.body.error);
  assert.equal((await request(gateway, endpoint, { token: credential.token, method: 'POST', payload })).body.ok, true);
  assert.equal(sent, 1);
  assert.deepEqual(files.map(file => file.name), names);
  for (const file of files) {
    assert.equal(file.isImage, false);
    assert.equal(path.extname(file.path), path.extname(file.name));
    assert.deepEqual(fs.readFileSync(file.path), originals.get(file.name));
  }
  const snapshot = await request(gateway, `/v1/conversations/${visible.id}`, { token: credential.token });
  assert.deepEqual(snapshot.body.messages.at(-1).attachedFiles, names.map(name => ({ name, isImage: false })));
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

test('mobile multi-image batches validate every item before writing and retry only once', async context => {
  const { gateway, manager, visible, pair, root } = fixture(context);
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  let sent = 0, attachments;
  manager.drivers.codex.ensure = () => ({ gen: 42, sendUserMessage(prompt, images) { sent++; attachments = images; return true; }, interrupt() {} });
  const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]).toString('base64');
  const payload = { requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, action: 'send', expectedSeq: visible.seq, prompt: 'Describe images', images: [image, image] };
  const send = value => request(gateway, `/v1/conversations/${visible.id}/commands`, { token: credential.token, method: 'POST', payload: value });
  for (const invalid of [{ images: [image, '../private.png'] }, { images: [] }, { images: null }, { images: image }, { images: Array(21).fill(image) }, { image }]) {
    assert.equal((await send({ ...payload, ...invalid, requestId: require('node:crypto').randomUUID() })).body.ok, false);
    assert.equal(fs.existsSync(path.join(root, 'mobile-images')), false);
  }
  const largeImage = Buffer.alloc(1024 * 1024, 0);
  largeImage.set([255, 216, 255]); largeImage.set([255, 217], largeImage.length - 2);
  payload.images = Array(20).fill(largeImage.toString('base64'));
  assert.equal((await send(payload)).body.ok, true);
  assert.equal((await send(payload)).body.ok, true);
  assert.equal(sent, 1); assert.equal(attachments.length, 20);
  assert.equal(new Set(attachments.map(attachment => attachment.path)).size, 20);
  for (const attachment of attachments) {
    assert.equal(attachment.isImage, true);
    assert.equal(path.dirname(attachment.path), path.join(root, 'mobile-images'));
    assert.deepEqual(fs.readFileSync(attachment.path), largeImage);
  }
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
    const receipt = (await send()).body;
    const { current, instanceId, cursor, ...recorded } = receipt;
    assert.deepEqual(recorded, accepted);
    assert.equal(current.conversation.id, visible.id);
    assert.equal(instanceId, gateway.instanceId);
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

test('a phone can search the computer for files and download the result', async context => {
  const { manager, gateway, access, commands, visible, pair, root } = fixture(context);
  const credential = pair();
  await gateway.start('127.0.0.1', 0);
  const { randomUUID } = require('node:crypto');
  fs.writeFileSync(path.join(root, '面试试讲材料.pptx'), 'deck');
  fs.writeFileSync(path.join(root, '面试试讲材料.pdf'), 'pdf');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '面试试讲材料.js'), 'noise');
  const device = access.authenticate(credential.token);
  assert.ok((await request(gateway, '/v1/status', { token: credential.token })).body.capabilities.includes('find'));

  // An older client that only knows "send" still gets the search answered,
  // because the desktop recognizes the typed command before an engine runs.
  const typed = { requestId: randomUUID(), instanceId: gateway.instanceId, action: 'send', prompt: '/find 面试试讲', expectedSeq: visible.seq };
  const sent = await commands.execute(device, visible.id, typed, gateway.instanceId);
  assert.equal(sent.ok, true);
  assert.equal(sent.count, 2);
  assert.ok(sent.userSeq > 0);
  assert.equal(manager.active.size, 0);
  assert.equal(manager.busy(visible.id), false);
  const rows = manager.rows(manager.get(visible.id));
  assert.equal(rows.at(-2).role, 'user');
  assert.equal(rows.at(-2).text, '/find 面试试讲');
  assert.equal(rows.at(-1).role, 'assistant');
  assert.deepEqual(rows.at(-1).artifacts.map(file => file.name).sort(), ['面试试讲材料.pdf', '面试试讲材料.pptx']);

  // Both files are listed as ordinary conversation artifacts and download.
  const listing = (await request(gateway, `/v1/conversations/${visible.id}/artifacts`, { token: credential.token })).body;
  assert.deepEqual(listing.artifacts.filter(file => file.name.startsWith('面试试讲')).map(file => file.name).sort(),
    ['面试试讲材料.pdf', '面试试讲材料.pptx']);
  const deck = listing.artifacts.find(file => file.name === '面试试讲材料.pptx');
  const download = await fetch(`${gateway.url}/v1/conversations/${visible.id}/artifacts/${deck.id}`, { headers: { Authorization: `Bearer ${credential.token}` } });
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), 'deck');

  // The dedicated action does the same and rejects an empty or oversized query.
  const searched = { requestId: randomUUID(), instanceId: gateway.instanceId, action: 'find', query: '.pdf', expectedSeq: manager.get(visible.id).seq };
  const found = await commands.execute(device, visible.id, searched, gateway.instanceId);
  assert.equal(found.state, 'accepted');
  assert.deepEqual(found.files.map(file => file.name), ['面试试讲材料.pdf']);
  assert.equal(found.roots, undefined);
  assert.ok(!found.files.some(file => 'path' in file));
  const currentSeq = manager.get(visible.id).seq;
  // An empty query is a real request now: it lists recent work, which is what a
  // phone user wants when they cannot name the file. Only an oversized one is
  // refused.
  const recent = await commands.execute(device, visible.id, { ...searched, requestId: randomUUID(), expectedSeq: currentSeq, query: '  ' }, gateway.instanceId);
  assert.equal(recent.ok, true);
  assert.equal(recent.query, '');
  const oversized = await commands.execute(device, visible.id, { ...searched, requestId: randomUUID(), expectedSeq: manager.get(visible.id).seq, query: 'x'.repeat(501) }, gateway.instanceId);
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /Describe the file|too long/);
  await assert.rejects(commands.execute(device, visible.id, { ...searched, requestId: randomUUID(), expectedSeq: currentSeq, action: 'find', extra: 1 }, gateway.instanceId), /Unsupported command field/);

  // The phone can also search inside documents for a file it cannot name.
  fs.writeFileSync(path.join(root, '会议纪要-a1.md'), '# 供应商谈判\n\n三条谈判原则。\n');
  const inside = { requestId: randomUUID(), instanceId: gateway.instanceId, action: 'send',
    prompt: '/find inside: 供应商谈判', expectedSeq: manager.get(visible.id).seq };
  const contents = await commands.execute(device, visible.id, inside, gateway.instanceId);
  assert.equal(contents.ok, true);
  assert.deepEqual(contents.files.map(file => file.name), ['会议纪要-a1.md']);
  // The snippet belongs to the conversation text, which the phone renders; the
  // command reply carries the downloadable artifacts.
  const reply = manager.rows(manager.get(visible.id)).filter(row => row.role === 'assistant' && !row.internal).at(-1);
  assert.match(reply.text, /供应商谈判/);
  assert.match(reply.text, /Found files containing|找到了包含/);

  // A bare "/find" from the phone lists the newest file a conversation actually
  // produced. A file that merely exists on disk is not recent work, so the
  // search above is first recorded as a normal turn that wrote the file.
  manager.append(manager.get(visible.id), { role: 'tool', text: JSON.stringify({ type: 'gui:tool', id: 'recent-write',
    name: 'Write', status: 'completed', input: { file_path: '会议纪要-a1.md' } }) });
  manager.append(manager.get(visible.id), { role: 'assistant', text: '会议纪要已生成。' });
  const bare = { requestId: randomUUID(), instanceId: gateway.instanceId, action: 'send',
    prompt: '/find', expectedSeq: manager.get(visible.id).seq };
  const listedRecent = await commands.execute(device, visible.id, bare, gateway.instanceId);
  assert.equal(listedRecent.ok, true);
  assert.equal(listedRecent.query, '');
  assert.deepEqual(listedRecent.files.map(file => file.name), ['会议纪要-a1.md']);
  const recentRow = manager.rows(manager.get(visible.id)).filter(row => row.role === 'assistant' && !row.internal).at(-1);
  assert.match(recentRow.text, /most recently|最近编辑/);
});

test('receipt GET queries a pending send without uploading it again and remains device scoped', async context => {
  const { gateway, commands, manager, visible, pair, access } = fixture(context);
  const phone = pair(), other = pair(); await gateway.start('127.0.0.1', 0);
  let release, entered, starts = 0; const preparing = new Promise(resolve => entered = resolve);
  manager.prepare = () => { entered(); return new Promise(resolve => release = resolve); };
  manager.drivers.codex.ensure = () => ({ gen: 91, sendUserMessage() { starts++; return true; } });
  const payload = { action: 'send', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, expectedSeq: visible.seq, prompt: 'once' };
  const sending = request(gateway, `/v1/conversations/${visible.id}/commands`, { token: phone.token, method: 'POST', payload });
  try {
    await preparing; assert.equal((await sending).body.state, 'pending');
    const endpoint = '/v1/commands/' + payload.requestId;
    assert.equal((await request(gateway, endpoint, { token: phone.token })).body.state, 'pending');
    assert.equal((await request(gateway, endpoint, { token: other.token })).status, 404);
    assert.equal(commands.entries.length, 1); release();
    await commands.pending.get(phone.deviceId + ':' + payload.requestId);
    assert.equal((await request(gateway, endpoint, { token: phone.token })).body.ok, true);
    assert.equal(starts, 1);
    access.devices.find(item => item.id === phone.deviceId).permission = 'read';
    assert.equal((await request(gateway, endpoint, { token: phone.token })).status, 403);
  } finally { release?.(); }
});

test('configure receipts include current settings for the next immediate action', async context => {
  const { gateway, manager, reader, visible, pair, access } = fixture(context);
  const phone = pair(), device = access.authenticate(phone.token); await gateway.start('127.0.0.1', 0);
  manager.drivers.codex.saveSettings = patch => patch;
  manager.conversationModels = () => [{ id: 'test', thinking: ['high'] }, { id: 'second', thinking: ['low'] }];
  const old = reader.snapshot(device, visible.id).settings;
  const command = (settings, version) => request(gateway, `/v1/conversations/${visible.id}/commands`, { token: phone.token, method: 'POST',
    payload: { action: 'configure', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, expectedSettings: version, settings } });
  const first = await command({ model: 'second' }, old.version);
  assert.equal(first.body.ok, true); assert.equal(first.body.current.settings.model, 'second');
  assert.notEqual(first.body.current.settings.version, old.version);
  assert.equal(first.body.current.messages, undefined);
  const second = await command({ thinking: 'low' }, first.body.current.settings.version);
  assert.equal(second.body.ok, true); assert.equal(second.body.current.settings.thinking, 'low');
});

test('managed child visibility and controls follow the child workspace authorization', async context => {
  const { manager, reader, access, pair, gateway, commands, visible, hidden } = fixture(context);
  const credential = pair(), device = access.authenticate(credential.token);
  hidden.controlParentId = visible.id; hidden.controlUserSeq = 1; hidden.controlHistoryBoundary = 0;
  manager.append(hidden, { role: 'user', text: 'Private child request' });
  manager.save(hidden);
  assert.deepEqual(reader.snapshot(device, visible.id).subagents, []);
  const task = manager.subagentView(visible.id)[0];
  await assert.rejects(commands.execute(device, visible.id, { action: 'subagent-command', operation: 'reply',
    taskId: task.id, engine: task.engine, expectedTurnId: task.turnId, prompt: 'Do not dispatch',
    requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId }, gateway.instanceId), /not found/i);
  await manager.workspaces.metaOp({ op: 'move-session', sessionId: hidden.id, group: 'allowed' });
  assert.equal(reader.snapshot(device, visible.id).subagents[0].id, task.id);
});

test('incremental snapshots omit stable history and send replacements after history changes', async context => {
  const { gateway, manager, reader, visible, pair, access } = fixture(context);
  const device = access.authenticate(pair().token);
  const first = reader.snapshot(device, visible.id);
  manager.active.set(visible.id, { facade: { gen: 7 }, eventSeq: 1, text: 'streaming', assistant: [], permissions: new Map() });
  const delta = reader.snapshot(device, visible.id, undefined, first.historyVersion);
  assert.equal(delta.messages, undefined); assert.equal(delta.nextBefore, undefined);
  assert.equal(delta.live.text, 'streaming'); assert.equal(delta.historyVersion, first.historyVersion);
  manager.append(visible, { role: 'assistant', text: 'finished' });
  const changed = reader.snapshot(device, visible.id, undefined, first.historyVersion);
  assert.notEqual(changed.historyVersion, first.historyVersion); assert.ok(changed.messages.some(row => row.text === 'finished'));
  assert.ok(reader.snapshot(device, visible.id).messages, 'legacy snapshots remain complete');
  const frames = [];
  const stream = { device, id: visible.id, kind: 'conversations', incremental: true, response: { write: value => { frames.push(value); return true; } } };
  gateway.instanceId = require('node:crypto').randomUUID();
  gateway.writeSnapshot(stream, gateway.streamSnapshot(stream));
  gateway.writeSnapshot(stream, gateway.streamSnapshot(stream));
  assert.ok(JSON.parse(frames[0].split('data: ')[1]).messages);
  assert.equal(JSON.parse(frames[1].split('data: ')[1]).messages, undefined);
});

test('startup can be cancelled by its own ID without cancelling a later startup', async context => {
  const { manager, gateway, reader, commands, visible, pair, access } = fixture(context);
  const device = access.authenticate(pair().token); await gateway.start('127.0.0.1', 0);
  let release, entered, starts = 0; const preparing = new Promise(resolve => entered = resolve);
  manager.usesNativeCompaction = () => false;
  manager.contextPressure = () => ({ cap: 1000000, used: 900000, source: 'estimate' });
  manager.compact = () => { entered(); return new Promise(resolve => release = () => { manager.contextPressure = () => ({ cap: 1000000, used: 0, source: 'estimate' }); resolve(); }); };
  manager.drivers.codex.ensure = () => ({ gen: 92, sendUserMessage() { starts++; return true; }, interrupt() {} });
  try {
    await commands.execute(device, visible.id, { action: 'send', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, expectedSeq: visible.seq, prompt: 'startup', queue: true }, gateway.instanceId);
    await preparing; const snapshot = reader.snapshot(device, visible.id);
    assert.equal(snapshot.live, null); assert.ok(snapshot.preparation.startId);
    const stop = startId => commands.execute(device, visible.id, { action: 'stop-start', requestId: require('node:crypto').randomUUID(), instanceId: gateway.instanceId, startId }, gateway.instanceId);
    assert.equal((await stop(snapshot.preparation.startId)).ok, true);
    release(); await flushQueue(); assert.equal(starts, 0);
    const later = { startId: require('node:crypto').randomUUID(), cancelled: false }; manager.controlStarts.set(visible.id, later);
    assert.equal((await stop(snapshot.preparation.startId)).state, 'failed'); assert.equal(later.cancelled, false);
    manager.controlStarts.delete(visible.id);
  } finally { release?.(); await flushQueue(); }
});

test('read rate limits do not starve command receipt checks', async context => {
  const { gateway, commands, visible, pair } = fixture(context);
  const phone = pair(); await gateway.start('127.0.0.1', 0);
  const id = require('node:crypto').randomUUID();
  commands.entries.push({ key: phone.deviceId + ':' + id, at: Date.now(), conversationId: visible.id, scopes: { [visible.id]: 'allowed' }, result: { ok: true } });
  gateway.rate.set('127.0.0.1:read', { until: Date.now() + 60_000, count: 300 });
  const read = await fetch(gateway.url + '/v1/status', { headers: { Authorization: 'Bearer ' + phone.token } });
  assert.equal(read.status, 429); assert.equal(read.headers.get('retry-after'), '60');
  assert.equal((await request(gateway, '/v1/commands/' + id, { token: phone.token })).status, 200);
});

test('journal rollover bounds retained receipts and rejects expired requests instead of replaying', async context => {
  const { gateway, commands, visible, hidden, pair, access } = fixture(context);
  const device = access.authenticate(pair().token); await gateway.start('127.0.0.1', 0);
  const oldInstance = gateway.instanceId;
  const payload = { action: 'configure', requestId: require('node:crypto').randomUUID(), instanceId: oldInstance, settings: {} };
  commands.entries = Array.from({ length: 4001 }, (_, index) => ({ key: device.id + ':' + (index ? require('node:crypto').randomUUID() : payload.requestId), at: Date.now(), result: { ok: true } }));
  const otherStream = { id: hidden.id, historyVersion: 'cached', dirty: false, response: { destroy() {} } };
  gateway.streams.add(otherStream);
  gateway.publish({ sessionId: visible.id });
  assert.equal(commands.entries.length, 2000); assert.notEqual(gateway.instanceId, oldInstance);
  assert.equal(otherStream.dirty, true); assert.equal(otherStream.historyVersion, undefined);
  await assert.rejects(commands.execute(device, visible.id, payload, gateway.instanceId), /Server restarted/);
  assert.equal(JSON.parse(fs.readFileSync(commands.file)).length, 2000);
});

test('server-side list queries page matching authorized titles and enforce a bounded range', async context => {
  const { gateway, manager, visible, hidden, pair, access } = fixture(context);
  const phone = pair(); await gateway.start('127.0.0.1', 0);
  visible.title = 'Search fixture'; hidden.title = 'Search private';
  Object.assign(access.devices.find(item => item.id === phone.deviceId), { allWorkspaces: false, workspaceIds: ['allowed'], includeUnassigned: false });
  const result = await request(gateway, '/v1/conversations?limit=1000&query=search', { token: phone.token });
  assert.equal(result.status, 200); assert.equal(result.body.query, 'search');
  assert.deepEqual(result.body.conversations.map(item => item.id), [visible.id]);
  assert.equal((await request(gateway, '/v1/conversations?limit=1001', { token: phone.token })).status, 400);
  assert.equal((await request(gateway, '/v1/conversations?limit=0', { token: phone.token })).status, 400);
});
