'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DiscussionService } = require('../src/engines/discussions/service');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const { registerDiscussionIpc } = require('../src/main/discussion-ipc');
const { pathToFileURL } = require('node:url');
const { removeTree } = require('./test-fs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, enabled = true) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-service-'));
  t.after(() => removeTree(dataDir));
  const binding = { engine: 'codex', connection: 'subscription', model: 'test-model', accountRef: 'test-account', thinking: '', contextWindow: 32000 };
  const calls = [];
  const adapter = { runtime: { version: 'test', policyVersion: 'test' },
    evidence: value => ({ kind: 'real', reference: 'synthetic-test-only', bindingFingerprint: bindingFingerprint(value),
      runtimeVersion: 'test', policyVersion: 'test', mode: 'tool-free', checks: Object.fromEntries(['isolatedSession',
        'pinnedBinding', 'continuation', 'stopConfirmed', 'shellRestricted', 'mcpRestricted', 'subagentsRestricted',
        'escalationDisabled', 'conversationControlDisabled', 'toolsDisabled'].map(key => [key, true])) }),
    create(identity) { return {
      async execute({ plan, onEvent }) {
        calls.push({ identity, plan });
        onEvent({ ...identity, type: 'started', nativeId: identity.nativeId || randomUUID() });
        onEvent({ ...identity, type: 'answer', text: 'Test reply' });
        return { text: 'Test reply' };
      },
      async stop() { return { ...identity, stopped: true, released: true }; }, cancel() {},
    }; },
  };
  const options = { dataDir, platform: 'win32', getCatalog: () => [{ binding, label: 'Test model' }], adapters: enabled ? { codex: adapter } : {} };
  const service = new DiscussionService(options);
  return { service, options, binding, calls };
}
async function createMembers(service, count = 2) {
  const { group } = await service.call('create', { title: 'Research discussion' });
  const { bindings } = await service.call('catalog');
  for (let i = 0; i < count; i++) await service.call('add-member', { id: group.id, bindingId: bindings[0].id, name: 'Member ' + i });
  return (await service.call('load', { id: group.id })).group;
}

test('public discussion workflow persists notes, bounds members, and rejects forged bindings and attachments', async t => {
  const { service, calls } = setup(t);
  const group = await createMembers(service, 4), catalog = await service.call('catalog');
  await assert.rejects(service.call('add-member', { id: group.id, bindingId: catalog.bindings[0].id }), /4 members/);
  await service.call('send', { id: group.id, requestId: 'note', text: 'A note', participantIds: [] });
  assert.equal(calls.length, 0);
  await assert.rejects(service.call('send', { id: group.id, text: 'Do not drop this file', attachments: [{}] }), /attachment/);
  const other = (await service.call('create', { title: 'Other' })).group;
  await assert.rejects(service.call('add-member', { id: other.id, bindingId: 'forged' }), /no longer available/);
  assert.equal((await service.call('list')).groups.length, 2);
  assert.equal((await service.call('load', { id: group.id })).group.messages[0].text, 'A note');
});

test('serial discussion sends attributed prior replies, resumes after restart, and keeps native details out of IPC', async t => {
  const h = setup(t), group = await createMembers(h.service);
  await h.service.call('send', { id: group.id, requestId: 'first', text: 'Compare these designs', participantIds: group.participants.map(p => p.id), mode: 'serial' });
  for (let i = 0; i < 10 && h.service.active; i++) await tick();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].plan.prompt, /Member 0/);
  assert.match(h.calls[1].plan.prompt, /Test reply/);
  const resumed = new DiscussionService(h.options), view = (await resumed.call('load', { id: group.id })).group;
  assert.equal(view.messages.length, 3);
  assert.ok(view.deliveries.every(d => d.status === 'completed'));
  const json = JSON.stringify(view);
  for (const secret of ['runtimeId', 'nativeId', 'inputPlan', 'bindingFingerprint', 'test-account']) assert.ok(!json.includes(secret), secret);
});

test('unverified connections fail visibly without dispatch or implicit retries', async t => {
  const h = setup(t, false), group = await createMembers(h.service, 1);
  const payload = { id: group.id, requestId: 'request', text: 'Hello', participantIds: [group.participants[0].id] };
  await h.service.call('send', payload); await h.service.call('send', payload);
  const view = (await h.service.call('load', { id: group.id })).group;
  assert.equal(view.messages.length, 1); assert.equal(view.deliveries.length, 1);
  assert.equal(view.deliveries[0].status, 'failed'); assert.equal(view.deliveries[0].reason, 'unknown-runtime-policy');
  assert.equal(h.calls.length, 0);
});

test('context preparation failure survives an application restart without calling an engine', async t => {
  const h = setup(t);
  h.binding.contextWindow = 0;
  const group = await createMembers(h.service, 1);
  await h.service.call('send', { id: group.id, requestId: 'unknown-context', text: 'Keep this error.', participantIds: [group.participants[0].id] });
  for (let i = 0; i < 10 && h.service.active; i++) await tick();
  const restarted = new DiscussionService(h.options);
  const view = (await restarted.call('load', { id: group.id })).group;
  assert.equal(view.deliveries[0].status, 'failed');
  assert.match(view.deliveries[0].reason, /context window/);
  assert.equal(h.calls.length, 0);
});

test('member limit holds across concurrent additions and removal frees a product slot without erasing history', async t => {
  const { service } = setup(t), group = await createMembers(service, 3), bindingId = (await service.call('catalog')).bindings[0].id;
  const results = await Promise.allSettled([1, 2].map(i => service.call('add-member', { id: group.id, bindingId, name: 'Extra ' + i })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await service.call('remove-member', { id: group.id, participantId: group.participants[0].id });
  const next = await service.call('add-member', { id: group.id, bindingId, name: 'Replacement' });
  assert.equal(next.group.participants.filter(p => !p.removed).length, 4);
  assert.equal(next.group.participants.length, 5);
});

test('discussion IPC rejects another window, iframe, and non-discussion pages before reaching the service', async () => {
  let handler, calls = 0;
  const page = path.resolve('src/renderer/discussions/discussions.html'), frame = { url: pathToFileURL(page).href };
  const sender = { mainFrame: frame }, window = { isDestroyed: () => false, webContents: sender };
  registerDiscussionIpc({ ipcMain: { handle(name, fn) { assert.equal(name, 'dsh:discussion'); handler = fn; } },
    service: { call() { calls++; return { groups: [] }; } }, page, getWindow: () => window });
  assert.equal((await handler({ sender, senderFrame: frame }, { action: 'list' })).ok, true);
  assert.equal((await handler({ sender: {}, senderFrame: frame }, { action: 'list' })).ok, false);
  assert.equal((await handler({ sender, senderFrame: { ...frame } }, { action: 'list' })).ok, false);
  frame.url = 'https://example.com'; assert.equal((await handler({ sender, senderFrame: frame }, { action: 'list' })).ok, false);
  assert.equal(calls, 1);
});

test('unsupported discussion actions cross IPC with an actionable code and leave history untouched', async t => {
  const { service, calls } = setup(t), group = await createMembers(service, 1);
  let handler;
  const page = path.resolve('src/renderer/discussions/discussions.html'), frame = { url: pathToFileURL(page).href };
  const sender = { mainFrame: frame }, window = { isDestroyed: () => false, webContents: sender };
  registerDiscussionIpc({ ipcMain: { handle(_name, fn) { handler = fn; } }, service, page, getWindow: () => window });
  const before = (await service.call('load', { id: group.id })).group;
  const result = await handler({ sender, senderFrame: frame }, { action: 'future-action', payload: { id: group.id, text: 'Private draft' } });
  assert.deepEqual(result, { ok: false, error: 'Unknown discussion action', code: 'DISCUSSION_ACTION_UNSUPPORTED', action: 'future-action' });
  assert.deepEqual((await service.call('load', { id: group.id })).group, before);
  assert.equal(calls.length, 0);
});

test('group rename, pin and permanent removal survive restart and leave the neighboring history intact', async t => {
  const h = setup(t), first = await createMembers(h.service, 1);
  const second = (await h.service.call('create', { title: 'Neighbor' })).group;
  await h.service.call('send', { id: first.id, requestId: 'note', text: 'Keep until deleted', participantIds: [] });
  await h.service.call('rename', { id: first.id, title: '  Renamed research  ' });
  await h.service.call('pin', { id: second.id, pinned: true });
  const restarted = new DiscussionService(h.options);
  assert.equal((await restarted.call('list')).groups[0].id, second.id);
  assert.equal((await restarted.call('load', { id: first.id })).group.title, 'Renamed research');
  assert.equal((await restarted.call('load', { id: first.id })).group.messages[0].text, 'Keep until deleted');
  await assert.rejects(restarted.call('rename', { id: first.id, title: ' ' }), /title/);
  await assert.rejects(restarted.call('pin', { id: first.id, pinned: 'yes' }), /pinned/);
  const result = await restarted.call('delete', { id: first.id });
  assert.equal(result.deletedId, first.id);
  assert.deepEqual(result.groups.map(s => s.id), [second.id]);
  assert.equal(fs.existsSync(restarted.manager.store.file(first.id)), false);
  assert.equal(new DiscussionService(h.options).list()[0].pinned, true);
  await restarted.call('pin', { id: second.id, pinned: false });
  assert.equal(new DiscussionService(h.options).list()[0].pinned, false);
});

function autoVerification(h, verify) {
  const adapter = h.options.adapters.codex, evidence = adapter.evidence, admitted = new Set(), checks = new Map();
  adapter.evidence = binding => admitted.has(bindingFingerprint(binding)) ? evidence(binding) : null;
  h.service.production = { checks, refresh() {}, canVerify: binding => binding.engine === 'codex',
    reason: () => 'Unsupported test connection', cancel: key => checks.get(key)?.abort(),
    async verify(binding) {
      const key = bindingFingerprint(binding);
      if (checks.has(key)) return checks.get(key).promise;
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => verify(binding, controller.signal)).then(() => admitted.add(key)).finally(() => checks.delete(key));
      checks.set(key, { promise, abort: () => controller.abort() });
      return promise;
    },
    async shutdown() {
      for (const check of checks.values()) check.abort();
      await Promise.allSettled([...checks.values()].map(check => check.promise));
    },
  };
}

test('adding members starts background verification and shares it with manual verification and first send', async t => {
  const h = setup(t); let checks = 0, finish;
  autoVerification(h, () => { checks++; return new Promise(resolve => { finish = resolve; }); });
  const { group } = await h.service.call('create', { title: 'Automatic member checks' });
  const { bindings } = await h.service.call('catalog');
  const added = await h.service.call('add-member', { id: group.id, bindingId: bindings[0].id, name: 'First' });
  const first = added.group.participants[0];
  assert.equal(added.group.verifying, true); assert.equal(first.verifying, true);
  assert.equal(first.capability.available, false); assert.equal(first.verificationError, null);
  assert.equal(h.service.manager.get(group.id).participants.length, 1);
  assert.deepEqual(added.group.messages, []); assert.equal(h.calls.length, 0);
  await h.service.call('add-member', { id: group.id, bindingId: bindings[0].id, name: 'Second' });
  const manual = h.service.call('verify-member', { id: group.id, participantId: first.id });
  const send = h.service.call('send', { id: group.id, requestId: 'send-during-check', text: 'Ready when checked', participantIds: [first.id] });
  await tick(); assert.equal(checks, 1); assert.equal(h.calls.length, 0);
  finish(); await Promise.all([manual, send]);
  for (let i = 0; i < 20 && h.service.active; i++) await tick();
  const loaded = (await h.service.call('load', { id: group.id })).group;
  assert.equal(loaded.verifying, false);
  assert.ok(loaded.participants.every(member => member.capability.available && !member.verifying && !member.verificationError));
  assert.equal(h.calls.length, 1); assert.equal(loaded.messages.at(-1).text, 'Test reply');
  await h.service.call('catalog'); await h.service.call('load', { id: group.id });
  await h.service.call('add-member', { id: group.id, bindingId: bindings[0].id, name: 'Already verified' });
  assert.equal(checks, 1, 'verified connections and reopening groups do not trigger more checks');
});

test('an automatic verification failure preserves the member and error until an explicit retry', async t => {
  const h = setup(t); let checks = 0;
  autoVerification(h, async () => { if (++checks === 1) throw new Error('Selected account quota is exhausted.'); });
  const group = await createMembers(h.service, 1);
  for (let i = 0; i < 10 && h.service.active; i++) await tick();
  const loaded = (await h.service.call('load', { id: group.id })).group, member = loaded.participants[0];
  assert.equal(loaded.participants.length, 1); assert.equal(loaded.verifying, false);
  assert.equal(member.capability.available, false); assert.equal(member.verificationError, 'Selected account quota is exhausted.');
  assert.deepEqual(loaded.messages, []); assert.equal(h.calls.length, 0);
  await h.service.call('catalog'); await h.service.call('load', { id: group.id });
  assert.equal(checks, 1, 'failure never causes a background retry loop');
  const retried = (await h.service.call('verify-member', { id: group.id, participantId: member.id })).group;
  assert.equal(checks, 2); assert.equal(retried.participants[0].capability.available, true);
  assert.equal(retried.participants[0].verificationError, null);
});

test('automatic member checks can be cancelled, removed and drained on shutdown', async t => {
  for (const action of ['cancel-member-verification', 'remove-member', 'shutdown']) {
    const h = setup(t); let started;
    const ready = new Promise(resolve => { started = resolve; });
    autoVerification(h, (_binding, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Discussion cancelled')), { once: true }); started();
    }));
    const group = await createMembers(h.service, 1), participantId = group.participants[0].id;
    await ready;
    if (action === 'shutdown') await h.service.shutdown();
    else await h.service.call(action, { id: group.id, participantId });
    for (let i = 0; i < 10 && h.service.active; i++) await tick();
    assert.equal(h.service.active, false, action); assert.equal(h.calls.length, 0);
    const loaded = (await h.service.call('load', { id: group.id })).group;
    assert.equal(loaded.verifying, false); assert.equal(loaded.participants[0].verifying, false);
    assert.equal(loaded.participants[0].removed, action === 'remove-member');
    if (action === 'remove-member') assert.equal(loaded.participants[0].verificationError, null);
  }
});

test('first send verifies once, repairs missing old context metadata, and retry obtains real dispatch readiness', async t => {
  const h = setup(t), group = await createMembers(h.service, 2); let verifications = 0;
  h.service.manager.configureMember(group.id, group.participants[0].id, { contextWindow: 0 });
  autoVerification(h, async binding => { verifications++; assert.equal(binding.contextWindow, h.binding.contextWindow); });
  // Reproduce a failure saved by the older send path before automatic checks.
  h.service.scheduler.enqueue(group.id, { requestId: 'old', text: 'First attempt', participantIds: [group.participants[0].id] });
  const old = h.service.manager.get(group.id).deliveries[0]; assert.equal(old.status, 'failed');
  await h.service.call('retry', { id: group.id, deliveryId: old.id, actionId: 'retry' });
  for (let i = 0; i < 10 && h.service.active; i++) await tick();
  assert.equal(h.calls.length, 1);
  await h.service.call('send', { id: group.id, requestId: 'both', text: 'Answer together', participantIds: group.participants.map(p => p.id), mode: 'serial' });
  for (let i = 0; i < 20 && h.service.active; i++) await tick();
  assert.equal(verifications, 1); assert.equal(h.calls.length, 3);
  const saved = (await h.service.call('load', { id: group.id })).group;
  assert.equal(saved.participants[0].contextWindow, h.binding.contextWindow);
  assert.equal(saved.messages.at(-1).text, 'Test reply'); assert.equal(saved.verifying, false);
});

test('existing API members migrate from a key to the same provider without losing public history', async t => {
  const h = setup(t);
  const ref = { providerId: 'ollama', route: 'same-route' };
  Object.assign(h.binding, { connection: 'api', accountRef: JSON.stringify({ ...ref, keyId: 'old-key' }) });
  h.service.getCatalog = () => [{ binding: h.binding, accountLabel: 'Ollama Cloud · weekly-2' }];
  const group = await createMembers(h.service, 1), memberId = group.participants[0].id;
  await h.service.call('send', { id: group.id, requestId: 'old', text: 'Remember our discussion', participantIds: [memberId] });
  for (let i = 0; i < 10 && h.service.active; i++) await tick();
  const old = h.service.manager.get(group.id);
  assert.ok(old.participants[0].session.nativeId);
  h.binding.accountRef = JSON.stringify(ref);
  h.service.getCatalog = () => [{ binding: h.binding, accountLabel: 'Ollama Cloud' }];
  const loaded = (await h.service.call('load', { id: group.id })).group;
  assert.equal(loaded.participants[0].accountLabel, 'Ollama Cloud');
  const migrated = h.service.manager.get(group.id);
  assert.deepEqual(migrated.messages, old.messages);
  assert.equal(migrated.participants[0].accountRef, h.binding.accountRef);
  assert.equal(migrated.participants[0].session.nativeId, null);
  assert.equal(migrated.participants[0].retiredSessions.at(-1).nativeId, old.participants[0].session.nativeId);
  assert.equal(h.calls.length, 1, 'opening an old group does not call a model');
  autoVerification(h, async binding => assert.equal(binding.accountRef, JSON.stringify(ref)));
  await h.service.call('send', { id: group.id, requestId: 'new', text: 'Continue', participantIds: [memberId] });
  for (let i = 0; i < 10 && h.service.active; i++) await tick();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].plan.prompt, /Remember our discussion/);
  assert.equal((await h.service.call('load', { id: group.id })).group.messages.at(-1).text, 'Test reply');
});

test('optional member identity survives restart, reaches only its own input and can be changed or cleared', async t => {
  const h = setup(t), { group } = await h.service.call('create', { title: 'Identity prompts' });
  const { bindings } = await h.service.call('catalog');
  await h.service.call('add-member', { id: group.id, bindingId: bindings[0].id, name: 'Scientist', identityPrompt: '  You are a scientist. Evaluate evidence.  ' });
  await h.service.call('add-member', { id: group.id, bindingId: bindings[0].id, name: 'Default member' });
  let state = h.service.manager.get(group.id); const memberId = state.participants[0].id;
  assert.equal(state.participants[0].identityPrompt, 'You are a scientist. Evaluate evidence.');
  assert.equal(state.participants[1].identityPrompt, '');
  await h.service.call('send', { id: group.id, requestId: 'first', text: 'Discuss the plan', participantIds: state.participants.map(p => p.id) });
  for (let i = 0; i < 15 && h.service.active; i++) await tick();
  assert.match(h.calls[0].plan.prompt, /You are a scientist/);
  assert.ok(!h.calls[1].plan.prompt.includes('You are a scientist'));
  const old = h.service.manager.get(group.id);
  const changed = await h.service.call('set-identity', { id: group.id, participantId: memberId, identityPrompt: 'You are a programmer.' });
  state = h.service.manager.get(group.id);
  assert.equal(changed.group.participants[0].identityPrompt, 'You are a programmer.');
  assert.deepEqual(state.messages, old.messages);
  assert.equal(state.participants[0].session.generation, old.participants[0].session.generation + 1);
  assert.equal(state.participants[0].session.nativeId, null);
  const restarted = new DiscussionService(h.options);
  assert.equal((await restarted.call('load', { id: group.id })).group.participants[0].identityPrompt, 'You are a programmer.');
  await restarted.call('send', { id: group.id, requestId: 'edited', text: 'Review the implementation', participantIds: [memberId] });
  for (let i = 0; i < 15 && restarted.active; i++) await tick();
  assert.match(h.calls.at(-1).plan.prompt, /You are a programmer/);
  assert.ok(!h.calls.at(-1).plan.prompt.includes('You are a scientist'));
  assert.match(h.calls.at(-1).plan.prompt, /Discuss the plan/);
  await restarted.call('set-identity', { id: group.id, participantId: memberId, identityPrompt: ' \n ' });
  assert.equal(restarted.manager.get(group.id).participants[0].identityPrompt, '');
  const before = restarted.manager.get(group.id);
  await assert.rejects(restarted.call('set-identity', { id: group.id, participantId: memberId, identityPrompt: 'x'.repeat(4097) }), /4096/);
  await assert.rejects(restarted.call('set-identity', { id: group.id, participantId: memberId, identityPrompt: { text: 'wrong' } }), /4096/);
  assert.deepEqual(restarted.manager.get(group.id), before);
});

test('identity edits cannot change an active or queued member input', async t => {
  const h = setup(t), group = await createMembers(h.service, 1), memberId = group.participants[0].id;
  h.service.manager.setIdentityPrompt(group.id, memberId, 'Scientist');
  const request = h.service.manager.enqueue(group.id, { requestId: 'queued', text: 'Keep this identity', participantIds: [memberId] });
  await assert.rejects(h.service.call('set-identity', { id: group.id, participantId: memberId, identityPrompt: 'Programmer' }), /finish replying/);
  h.service.manager.prepare(group.id, request.deliveryIds[0]);
  await assert.rejects(h.service.call('set-identity', { id: group.id, participantId: memberId, identityPrompt: 'Programmer' }), /finish replying/);
  assert.equal(h.service.manager.get(group.id).deliveries[0].identityPrompt, 'Scientist');
});

test('stop cancels first-send checks without storing the question or dispatching; deletion waits for cancellation', async t => {
  const h = setup(t), group = await createMembers(h.service, 1);
  let started; const ready = new Promise(resolve => { started = resolve; });
  autoVerification(h, (_binding, signal) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(new Error('Discussion cancelled')), { once: true });
  }));
  const send = h.service.call('send', { id: group.id, requestId: 'cancel', text: 'Keep in composer', participantIds: [group.participants[0].id] });
  const rejected = assert.rejects(send, /cancelled/); await ready;
  assert.equal((await h.service.call('load', { id: group.id })).group.verifying, true);
  await assert.rejects(h.service.call('delete', { id: group.id }), /Stop all/);
  await h.service.call('stop', { id: group.id }); await rejected;
  assert.equal(h.calls.length, 0); assert.equal(h.service.manager.get(group.id).messages.length, 0);
  assert.equal(h.service.active, false);
  await h.service.call('delete', { id: group.id }); assert.equal(h.service.list().length, 0);
});

test('unsupported saved members are rejected before verification, history changes or any model call', async t => {
  const h = setup(t), group = await createMembers(h.service, 2); let checked = 0;
  h.service.manager.configureMember(group.id, group.participants[1].id, { engine: 'antigravity' });
  autoVerification(h, async () => { checked++; });
  await assert.rejects(h.service.call('send', { id: group.id, requestId: 'unavailable', text: 'Preserve this draft', participantIds: group.participants.map(p => p.id) }), /Unsupported/);
  assert.equal(checked, 0); assert.equal(h.calls.length, 0); assert.equal(h.service.manager.get(group.id).messages.length, 0);
  assert.equal((await h.service.call('load', { id: group.id })).group.participants[1].capability.supported, false);
});

test('cancel member verification while catalog is loading prevents a late check from starting', async t => {
  const h = setup(t), group = await createMembers(h.service, 1); let checked = 0, release;
  autoVerification(h, async () => { checked++; });
  h.service.getCatalog = () => new Promise(resolve => { release = resolve; });
  const verification = h.service.call('verify-member', { id: group.id, participantId: group.participants[0].id });
  const rejected = assert.rejects(verification, /cancelled/);
  await h.service.call('cancel-member-verification', { id: group.id, participantId: group.participants[0].id });
  release([{ binding: h.binding }]); await rejected;
  assert.equal(checked, 0); assert.equal(h.service.active, false);
});
