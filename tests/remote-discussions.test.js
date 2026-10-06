'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { RemoteDiscussions } = require('../src/main/remote/discussions');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { RemoteAccess } = require('../src/main/remote/access');
const { DiscussionService } = require('../src/engines/discussions/service');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const { removeTree } = require('./test-fs.cjs');
const tick = () => new Promise(setImmediate);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-discussions-'));
  let gateway;
  const access = new RemoteAccess({ file: path.join(dir, 'devices.json'), onRevoke: id => gateway?.revoke(id) });
  const invite = access.invite([], { allWorkspaces: true }), pending = access.request({ code: invite.code, name: 'Test phone' });
  access.approve(pending.id);
  const credential = access.claim(pending.id, pending.claim), device = access.authenticate(credential.token);
  const calls = [];
  const binding = { engine: 'codex', connection: 'subscription', model: 'fixture', accountRef: 'private-account-reference', thinking: '', contextWindow: 32000 };
  const adapter = { runtime: { version: 'test', policyVersion: 'test' }, evidence: value => ({ kind: 'real', reference: 'synthetic-test-only',
    bindingFingerprint: bindingFingerprint(value), runtimeVersion: 'test', policyVersion: 'test', mode: 'tool-free',
    checks: Object.fromEntries(['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'shellRestricted', 'mcpRestricted',
      'subagentsRestricted', 'escalationDisabled', 'conversationControlDisabled', 'toolsDisabled'].map(key => [key, true])) }),
    create(identity) { return { async execute({ plan, onEvent }) {
      calls.push(plan); onEvent({ ...identity, type: 'started', nativeId: randomUUID() });
      onEvent({ ...identity, type: 'answer', text: 'Reply from fixture' }); return { text: 'Reply from fixture' };
    }, async stop() { return { ...identity, stopped: true, released: true }; }, cancel() {} }; } };
  const service = new DiscussionService({ dataDir: dir, platform: 'win32', getCatalog: () => [{ binding, label: 'Fixture model' }],
    adapters: { codex: adapter }, onEvent: () => gateway?.publish() });
  const file = path.join(dir, 'receipts.json');
  const remote = new RemoteDiscussions({ file, getService: () => service, access, publish: () => gateway?.publish() });
  const reader = { manager: {}, workspaces: () => [], list: () => ({ conversations: [], nextOffset: null }), listSnapshot: () => ({ listVersion: 'ordinary-list-unchanged' }) };
  gateway = new RemoteGateway({ access, reader, discussions: remote, validateHost: host => host === '127.0.0.1' });
  gateway.instanceId = 'host-instance';
  const submit = (action, id, parameters = {}, requestId = randomUUID()) => {
    const payload = { requestId, instanceId: gateway.instanceId, action, ...(id ? { id } : {}), parameters };
    return { payload, result: remote.submit(device, payload, gateway.instanceId) };
  };
  const finish = async requestId => {
    for (let i = 0; i < 100; i++) {
      const result = remote.receipt(device, requestId);
      if (result.state !== 'pending') return result;
      await tick();
    }
    throw new Error('Command did not settle');
  };
  const execute = async (...args) => {
    const result = await finish(submit(...args).payload.requestId);
    assert.equal(result.state, 'completed', result.error); return result;
  };
  t.after(async () => { await gateway.stop(); await service.shutdown(); removeTree(dir); });
  return { dir, file, access, device, credential, service, remote, gateway, calls, binding, adapter, submit, finish, execute };
}

function request(gateway, token, route, payload) {
  return new Promise((resolve, reject) => {
    const source = payload ? JSON.stringify(payload) : null;
    const req = http.request(gateway.url + route, { method: source ? 'POST' : 'GET', agent: false, headers: {
      Authorization: 'Bearer ' + token, ...(source ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(source) } : {}) } }, response => {
      let value = ''; response.on('data', chunk => value += chunk);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(value) }));
    });
    req.on('error', reject); req.end(source);
  });
}

test('remote attachments, questions, approval races and artifact downloads use the original host run', async t => {
  const h = fixture(t); let respond, aborted;
  h.adapter.evidence = value => ({ kind: 'real', reference: 'synthetic-rich-test-only', bindingFingerprint: bindingFingerprint(value), runtimeVersion: 'test', policyVersion: 'test', mode: 'native-tools', supportsImages: true,
    checks: Object.fromEntries(['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'permissionsRouted', 'workspaceQueue'].map(k => [k, true])) });
  const answers = [];
  h.adapter.create = identity => ({
    async execute({ plan, onEvent, signal }) {
      h.calls.push(plan); onEvent({ ...identity, type: 'started', nativeId: randomUUID() });
      const input = await new Promise(resolve => {
        respond = answer => { answers.push(answer); resolve(answer.input); return true; };
        aborted = () => resolve(null); signal.addEventListener('abort', aborted, { once: true });
        onEvent({ ...identity, type: 'permission', permission: { runId: 42, requestId: 'native-request', toolName: 'Ask', questions: [{ id: 'role', question: 'Role?' }] } });
      });
      signal.removeEventListener('abort', aborted);
      if (!input) return { text: 'Cancelled' };
      const target = path.join(h.service.manager.get(identity.discussionId).cwd, 'result.txt'); fs.writeFileSync(target, input.role);
      onEvent({ ...identity, type: 'tool', tool: { id: 'write', name: 'Write', input: { file_path: target }, output: 'Saved', status: 'completed' } });
      return { text: 'Created [result](result.txt)' };
    }, respond: answer => respond(answer), cancel() { aborted?.(); }, async stop() { aborted?.(); return { ...identity, stopped: true, released: true }; },
  });
  const id = (await h.execute('create')).groupId;
  await h.execute('add-member', id, { bindingId: bindingFingerprint(h.binding), name: 'Scientist' });
  const member = h.remote.snapshot(h.device, id).group.participants[0].id;
  const jpeg = Buffer.from([255,216,255,217]);
  const send = h.submit('send', id, { text: '', participantIds: [member], attachments: [
    { name: 'photo.jpg', isImage: true, data: jpeg.toString('base64') }, { name: 'notes.txt', isImage: false, data: Buffer.from('original bytes').toString('base64') }] });
  assert.equal((await h.finish(send.payload.requestId)).state, 'completed');
  for (let i = 0; i < 100 && !h.service.scheduler.permissions(id).length; i++) await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].attachments.length, 2);
  assert.deepEqual(fs.readFileSync(h.calls[0].attachments[0].path), jpeg);
  h.remote.submit(h.device, send.payload, h.gateway.instanceId); assert.equal(h.calls.length, 1);
  const permission = h.remote.snapshot(h.device, id).group.pendingApprovals[0]; assert.ok(permission.responseSupported);
  const parameters = { deliveryId: permission.deliveryId, runId: permission.runId, approvalId: permission.requestId, fingerprint: permission.fingerprint, allow: true };
  assert.equal((await h.finish(h.submit('permission-response', id, parameters).payload.requestId)).state, 'failed');
  assert.equal(answers.length, 0);
  await h.execute('permission-response', id, { ...parameters, input: { role: 'Scientist' } });
  for (let i = 0; i < 100 && h.service.active; i++) await tick();
  assert.equal(answers.length, 1);
  assert.equal((await h.finish(h.submit('permission-response', id, { ...parameters, input: { role: 'Duplicate' } }).payload.requestId)).state, 'failed');
  const files = h.remote.artifacts(h.device, id).artifacts;
  assert.ok(files.some(f => f.name === 'photo.jpg')); assert.ok(files.some(f => f.name === 'notes.txt'));
  const output = files.find(f => f.name === 'result.txt'); assert.ok(output); assert.equal(JSON.stringify(files).includes(h.dir.replaceAll('\\', '\\\\')), false);
  const file = await h.remote.openArtifact(h.device, id, output.id); assert.equal(await file.handle.readFile('utf8'), 'Scientist'); await file.handle.close();
  await h.gateway.start('127.0.0.1', 0);
  const catalog = await request(h.gateway, h.credential.token, '/v1/discussions/' + id + '/artifacts'); assert.equal(catalog.status, 200);
  const data = await new Promise((resolve, reject) => http.get(h.gateway.url + '/v1/discussions/' + id + '/artifacts/' + output.id,
    { headers: { Authorization: 'Bearer ' + h.credential.token } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks).toString())); }).on('error', reject));
  assert.equal(data, 'Scientist');
  fs.writeFileSync(file.canonical, 'changed content'); await assert.rejects(h.remote.openArtifact(h.device, id, output.id), /not found/);
  h.access.devices.find(d => d.id === h.device.id).allWorkspaces = false;
  assert.throws(() => h.remote.artifacts(h.device, id), /full-device/);
});

test('remote group CRUD, identity and serial replies use the host discussion store', async t => {
  const h = fixture(t);
  const id = (await h.execute('create', null, { title: 'Mobile group' })).groupId;
  const catalog = await h.remote.catalog(h.device);
  assert.ok(!JSON.stringify(catalog).includes('private-account-reference'));
  for (const name of ['Scientist', 'Developer']) await h.execute('add-member', id, { bindingId: catalog.bindings[0].id, name });
  let group = h.remote.snapshot(h.device, id).group;
  await h.execute('set-identity', id, { participantId: group.participants[0].id, identityPrompt: 'You are a scientist.' });
  const send = h.submit('send', id, { text: 'Discuss this design', participantIds: group.participants.map(p => p.id), mode: 'serial' });
  assert.deepEqual(h.remote.submit(h.device, send.payload, h.gateway.instanceId), send.result);
  assert.equal((await h.finish(send.payload.requestId)).state, 'completed');
  for (let i = 0; i < 30 && h.service.active; i++) await tick();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].prompt, /You are a scientist/);
  assert.match(h.calls[1].prompt, /Scientist/);
  assert.doesNotMatch(h.calls[1].prompt, /You are a scientist/);
  assert.equal(h.remote.snapshot(h.device, id).group.messages.length, 3);
  await h.execute('rename', id, { title: 'Renamed on phone' });
  await h.execute('pin', id, { pinned: true });
  assert.equal(h.service.list()[0].title, 'Renamed on phone');
  assert.equal(h.service.list()[0].pinned, true);
  const json = JSON.stringify(h.remote.snapshot(h.device, id));
  for (const privateField of ['private-account-reference', 'cwd', 'nativeId', 'inputPlan']) assert.ok(!json.includes(privateField), privateField);
  await h.execute('delete', id);
  assert.equal(h.service.list().length, 0);
});

test('durable receipts deduplicate creation, reject changed payloads and survive restart', async t => {
  const h = fixture(t), command = h.submit('create', null, { title: 'One group' });
  await h.finish(command.payload.requestId);
  const remote = new RemoteDiscussions({ file: h.file, getService: () => h.service, access: h.access });
  assert.equal(remote.submit(h.device, command.payload, 'new-instance').state, 'completed');
  assert.equal(h.service.list().length, 1);
  assert.throws(() => remote.submit(h.device, { ...command.payload, parameters: { title: 'Changed' } }, 'new-instance'), /already used/);
  assert.throws(() => remote.submit(h.device, { ...command.payload, requestId: randomUUID() }, 'new-instance'), /restarted/);
  assert.throws(() => remote.receipt({ id: 'different-device' }, command.payload.requestId), /control/);
  const entries = JSON.parse(fs.readFileSync(h.file)); entries[0].state = 'pending'; fs.writeFileSync(h.file, JSON.stringify(entries));
  assert.equal(new RemoteDiscussions({ file: h.file, getService: () => h.service, access: h.access }).receipt(h.device, command.payload.requestId).state, 'interrupted');
});

test('a receipt write failure never starts an untracked operation or claims a durable completion', async t => {
  const h = fixture(t), save = h.remote.save.bind(h.remote);
  h.remote.save = () => { throw new Error('Disk unavailable'); };
  assert.throws(() => h.submit('create'), /no action was started/);
  assert.equal(h.remote.entries.length, 0); assert.equal(h.service.list().length, 0);
  let writes = 0;
  h.remote.save = () => { if (++writes > 1) throw new Error('Disk unavailable'); save(); };
  const submitted = h.submit('create', null, { title: 'Committed, unconfirmed' });
  assert.equal((await h.finish(submitted.payload.requestId)).state, 'interrupted');
  assert.equal(h.service.list().length, 1);
});

test('local filesystem actions, forged bindings and a fifth member are not admitted', async t => {
  const h = fixture(t), id = (await h.execute('create')).groupId;
  assert.throws(() => h.submit('import-attachments', id, { paths: ['C:/private'] }), /Invalid/);
  assert.throws(() => h.submit('create', null, { cwd: 'C:/private' }), /Invalid/);
  const invalid = h.submit('send', id, { text: 'Hello', attachments: ['C:/private'] });
  assert.match((await h.finish(invalid.payload.requestId)).error, /Invalid/);
  const bad = h.submit('add-member', id, { bindingId: 'forged', name: 'Bad' });
  assert.equal((await h.finish(bad.payload.requestId)).state, 'failed');
  const { bindings } = await h.remote.catalog(h.device);
  for (let i = 0; i < 4; i++) await h.execute('add-member', id, { bindingId: bindings[0].id, name: 'Member ' + i });
  const fifth = h.submit('add-member', id, { bindingId: bindings[0].id });
  assert.match((await h.finish(fifth.payload.requestId)).error, /4 members/);
});

test('scope is rechecked after an asynchronous catalog lookup', async t => {
  const h = fixture(t), id = (await h.execute('create')).groupId;
  const { bindings } = await h.remote.catalog(h.device);
  let release;
  h.service.getCatalog = () => new Promise(resolve => { release = () => resolve([{ binding: h.binding }]); });
  const command = h.submit('add-member', id, { bindingId: bindings[0].id });
  await tick();
  h.access.revoke(h.device.id); release(); await tick(); await tick();
  assert.equal(h.service.manager.get(id).participants.length, 0);
  assert.equal(h.remote.entries.find(e => e.requestId === command.payload.requestId).state, 'failed');
});

test('adding members starts host verification and reports its result without duplicating members', async t => {
  const h = fixture(t), id = (await h.execute('create')).groupId;
  let release, verified = false, checks = 0;
  const evidence = h.adapter.evidence; h.adapter.evidence = value => verified ? evidence(value) : null;
  h.service.production = { refresh() {}, reason: () => 'Verify connection', canVerify: () => true, checks: new Map(),
    verify: () => { checks++; return new Promise(resolve => { release = () => { verified = true; resolve(); }; }); } };
  const { bindings } = await h.remote.catalog(h.device);
  const add = h.submit('add-member', id, { bindingId: bindings[0].id, name: 'Auto checked' });
  await h.finish(add.payload.requestId);
  assert.equal(h.remote.snapshot(h.device, id).group.participants[0].verifying, true);
  h.remote.submit(h.device, add.payload, h.gateway.instanceId);
  release(); await tick();
  assert.equal(checks, 1);
  assert.equal(h.remote.snapshot(h.device, id).group.participants[0].verifying, false);
  h.service.production = null;
});

test('turn submission is cancelled when remote access stops during connection verification', async t => {
  const h = fixture(t), id = (await h.execute('create')).groupId;
  const { bindings } = await h.remote.catalog(h.device);
  await h.execute('add-member', id, { bindingId: bindings[0].id, name: 'Checked' });
  const participantId = h.service.manager.get(id).participants[0].id;
  let release;
  h.adapter.evidence = () => null;
  h.service.production = { refresh() {}, reason: () => 'Needs verification', canVerify: () => true, checks: new Map(),
    verify: () => new Promise(resolve => { release = resolve; }) };
  const send = h.submit('send', id, { text: 'Must not start later', participantIds: [participantId], mode: 'parallel' });
  await tick(); h.remote.cancelPending(); release();
  assert.match((await h.finish(send.payload.requestId)).error, /Remote access stopped/);
  assert.equal(h.calls.length, 0); assert.equal(h.service.manager.get(id).messages.length, 0);
  h.service.production = null;
});

test('tool-heavy discussion pages fit the mobile response budget and retain newest output', async t => {
  const h = fixture(t), id = (await h.execute('create', undefined, { title: 'Long tool history' })).groupId;
  const view = h.service.view(h.service.manager.get(id)), large = '长工具记录'.repeat(3000);
  const requests = Array.from({ length: 40 }, (_, i) => ({ id: 'request-' + i }));
  h.service.view = () => ({ ...view, requests,
    messages: requests.map((r, i) => ({ id: 'message-' + i, seq: i + 1, requestId: r.id, role: 'assistant', text: 'Answer', attachments: [] })),
    deliveries: requests.map((r, i) => ({ id: 'delivery-' + i, requestId: r.id, status: i === 39 ? 'running' : 'completed',
      partialText: i === 39 ? 'Latest live answer' : large,
      tools: Array.from({ length: 30 }, (_, j) => ({ id: 'tool-' + j, name: 'Write', status: 'completed', input: { text: large }, output: large + 'LATEST' })) })),
  });
  const result = h.remote.snapshot(h.device, id), deliveries = result.group.deliveries;
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024, 'All tool data shares a page-wide budget');
  assert.equal(deliveries.at(-1).partialText, 'Latest live answer');
  assert.ok(deliveries.slice(0, -1).every(d => d.partialText === ''), 'Do not repeat completed answers in each delivery');
  assert.match(deliveries.at(-1).tools.at(-1).output, /LATEST$/);
  assert.equal(deliveries[0].tools[0].output, '');
  assert.equal(deliveries[0].tools[0].detailsTruncated, true);
  assert.equal(deliveries[0].toolsTruncated, true);
});

test('gateway advertises discussions only to authorized devices and serves paginated snapshots', async t => {
  const h = fixture(t); await h.gateway.start('127.0.0.1', 0);
  const json = (route, payload) => request(h.gateway, h.credential.token, route, payload);
  assert.ok((await json('/v1/status')).body.capabilities.includes('discussions'));
  const command = { requestId: randomUUID(), instanceId: h.gateway.instanceId, action: 'create', parameters: { title: 'HTTP group' } };
  assert.equal((await json('/v1/discussions/commands', command)).status, 200);
  const id = (await h.finish(command.requestId)).groupId;
  assert.equal((await json('/v1/discussions')).body.groups[0].id, id);
  const navigation = (await json('/v1/conversations')).body;
  assert.equal(navigation.discussionGroups[0].id, id);
  assert.deepEqual(navigation.conversations, []);
  const before = h.gateway.streamSnapshot({ device: h.device }).listVersion;
  await h.service.call('rename', { id, title: 'Navigation renamed' });
  assert.notEqual(h.gateway.streamSnapshot({ device: h.device }).listVersion, before);
  assert.equal((await json('/v1/conversations')).body.discussionGroups[0].title, 'Navigation renamed');
  assert.equal((await json('/v1/discussions/catalog')).body.bindings.length, 1);
  for (let i = 0; i < 85; i++) await h.service.call('send', { id, requestId: randomUUID(), text: 'Note ' + i, participantIds: [] });
  const page = await json('/v1/discussions/' + id);
  assert.equal(page.body.group.messages.length, 80);
  assert.equal((await json('/v1/discussions/' + id + '?before=' + page.body.nextBefore)).body.group.messages.length, 5);
  assert.equal((await json('/v1/discussions/catalog?path=private')).status, 404);
  h.access.save(h.access.devices.map(d => ({ ...d, allWorkspaces: false, includeUnassigned: true })));
  assert.ok(!(await json('/v1/status')).body.capabilities.includes('discussions'));
  assert.equal((await json('/v1/conversations')).body.discussionGroups, undefined);
  assert.equal((await json('/v1/discussions')).status, 403);
  assert.equal((await json('/v1/discussions/commands/' + command.requestId)).status, 403);
});

test('discussion streams carry host changes, deletion and revoked scope without starting a second session', async t => {
  const h = fixture(t); await h.gateway.start('127.0.0.1', 0);
  const id = (await h.execute('create', null, { title: 'Streamed' })).groupId;
  const snapshots = [];
  const connected = new Promise((resolve, reject) => {
    const req = http.get(h.gateway.url + '/v1/discussions/' + id + '/events', { headers: { Authorization: 'Bearer ' + h.credential.token } }, response => {
      assert.equal(response.statusCode, 200);
      let pending = '';
      response.on('data', chunk => {
        pending += chunk;
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (data) { snapshots.push(JSON.parse(data.slice(6))); resolve(); }
        }
      });
    });
    req.on('error', reject); t.after(() => req.destroy());
  });
  await connected;
  const changed = condition => new Promise((resolve, reject) => {
    const until = Date.now() + 3000;
    const check = () => condition() ? resolve() : Date.now() > until ? reject(new Error('Missing stream update')) : setTimeout(check, 25);
    check();
  });
  await h.service.call('rename', { id, title: 'Changed on desktop' });
  await changed(() => snapshots.some(s => s.group?.title === 'Changed on desktop'));
  await h.service.call('delete', { id });
  await changed(() => snapshots.some(s => s.deleted && s.id === id));
  assert.ok(snapshots.every(s => s.instanceId === h.gateway.instanceId));
  h.access.revoke(h.device.id);
  await changed(() => h.gateway.streams.size === 0);
  assert.equal(h.calls.length, 0);
});
