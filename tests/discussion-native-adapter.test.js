'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NativeDiscussionAdapter } = require('../src/engines/discussions/native-adapter');
const { NativeSessionOwnership } = require('../src/engines/discussions/native-ownership');
const { createDiscussionBoundary } = require('../src/engines/discussions/native-boundary');
const { getDiscussionLaunch } = require('../src/engines/discussions/native-launch');
const { SessionPool } = require('../src/engines/session-pool');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CodexSession } = require('../src/engines/codex-session');
const { AcpSession } = require('../src/engines/acp-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { DiscussionScheduler } = require('../src/engines/discussions/scheduler');
const { removeTree } = require('./test-fs.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(engine = 'codex') {
  const profile = { engine, connection: engine === 'antigravity' ? 'api' : 'subscription', model: 'fixture-model',
    accountRef: engine === 'antigravity' ? null : 'fixture-account', thinking: '', contextWindow: 0 };
  const input = { discussionId: randomUUID(), threadId: randomUUID(), participantId: randomUUID(), requestId: 'request', deliveryId: randomUUID(),
    runtimeId: randomUUID(), generation: 1, bindingFingerprint: bindingFingerprint(profile), profile, nativeId: null, cwd: process.cwd() };
  const sessions = new SessionPool(), calls = [], events = [], owners = [];
  const ownership = new NativeSessionOwnership({ readOwners: () => owners });
  let adapter, nativeGen = 0;
  const driver = { sessions, ensure(opts) {
    const session = { gen: ++nativeGen, opts, settings: opts.settings, running: false, dead: false, seq: 0, sends: 0, shutdowns: 0,
      async open() { session.sessionId = opts.sessionId || randomUUID(); },
      async prepareNativeStorage() { return (session.storageId ||= randomUUID().replaceAll('-', '')); },
      sendUserMessage(prompt, attachments) { session.sends++; session.prompt = prompt; session.attachments = attachments; session.running = true; return true; },
      interrupt() { session.interrupts = (session.interrupts || 0) + 1; },
      async shutdown() { session.shutdowns++; session.running = false; session.dead = true; },
      answerPermission(id, allow) { session.permission = { id, allow }; },
      emit(event) { return adapter.capture(engine, { conversationId: opts.conversationId, runId: session.gen, eventSeq: ++session.seq, ...event }); }
    };
    calls.push(session); sessions.set(opts, session); return session;
  } };
  const policy = {
    async prepare({ profile: binding }) { return { settings: { model: binding.model, connection: binding.connection,
      permissionMode: 'plan', thinkingBudget: binding.thinking, proxyUrl: '', contextWindow: binding.contextWindow,
      ...(binding.connection === 'subscription' ? { subscriptionId: binding.accountRef } : {}) },
      launch: { buildSpec() { throw new Error('Fixture driver supplies its own in-memory transport'); },
        spawn() { throw new Error('Fixture driver cannot launch a process'); } } }; },
    async verify() { return true; },
    async confirmStopped({ identity }) { return { ...identity, stopped: true }; }
  };
  adapter = new NativeDiscussionAdapter({ engine, driver, runtime: { version: 'fixture', policyVersion: 'fixture' }, policy, ownership,
    // Tests exercise the gate with synthetic evidence, never production proof.
    evidence(binding) { return { kind: 'real', reference: 'synthetic-test-only', bindingFingerprint: bindingFingerprint(binding),
      runtimeVersion: 'fixture', policyVersion: 'fixture', mode: 'tool-free', checks: Object.fromEntries([
        'isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'shellRestricted', 'mcpRestricted',
        'subagentsRestricted', 'escalationDisabled', 'conversationControlDisabled', 'toolsDisabled'].map(key => [key, true])) }; }
  });
  const start = (value = input, onEvent = event => { events.push(event); return true; }) => {
    const handle = adapter.create(value), abort = new AbortController();
    const done = handle.execute({ plan: { prompt: 'Persisted input', inputThroughSeq: 1 }, signal: abort.signal, onEvent });
    done.catch(() => {});
    return { handle, done, abort };
  };
  return { input, adapter, driver, calls, events, policy, start, ownership, owners };
}

test('native adapter is inert on allocation and cannot launch without policy or reviewed evidence', async () => {
  const h = setup(); h.adapter.create(h.input); assert.equal(h.calls.length, 0);
  h.adapter.policy = null;
  const run = h.start(); await assert.rejects(run.done, /unavailable/);
  assert.equal(h.calls.length, 0); await run.handle.stop();
  h.adapter.policy = h.policy; h.adapter.reviewedEvidence = () => null;
  const next = h.start(); await assert.rejects(next.done, /unavailable/); assert.equal(h.calls.length, 0);
});

test('missing runtime identity cannot fall back to the ordinary-chat legacy pool slot', () => {
  const h = setup();
  for (const key of ['discussionId', 'threadId', 'participantId', 'deliveryId', 'runtimeId']) {
    assert.throws(() => h.adapter.create({ ...h.input, [key]: undefined }), /Invalid.*identity/);
  }
  assert.throws(() => h.adapter.create({ ...h.input, nativeId: '../unsafe' }), /Invalid.*identity/);
  assert.equal(h.driver.sessions.sessions.size, 0);
});

test('Antigravity cannot dispatch before native storage is known, even with positive synthetic capability evidence', async () => {
  const h = setup('antigravity'); let confirmed = 0;
  h.policy.confirmStopped = async ({ identity }) => { confirmed++; return { ...identity, stopped: true }; };
  const run = h.start(); await assert.rejects(run.done, /Verified native storage/);
  assert.equal(h.calls[0].sends, 0); assert.equal(h.events.length, 0);
  await run.handle.stop(); assert.equal(confirmed, 1); assert.equal(h.driver.sessions.sessions.size, 0);
});

test('Antigravity native storage is acknowledged before input and retained if durable start is rejected', async () => {
  const h = setup('antigravity'), storage = { connection: 'api', storageDir: path.join(process.cwd(), 'fixture-native'), conversationId: randomUUID().replaceAll('-', '') };
  h.policy.verify = async ({ session }) => {
    storage.conversationId = session.storageId;
    h.owners.push({ engine: 'antigravity', nativeId: session.sessionId, runtimeId: h.input.runtimeId,
      ownerId: `discussion/${h.input.discussionId}/${h.input.participantId}/1`, nativeStorage: storage, storageVerified: true }); return true;
  };
  const run = h.start(h.input, event => {
    assert.equal(event.type, 'started'); assert.deepEqual(event.nativeStorage, storage); assert.equal(h.calls[0].sends, 0);
    return false;
  });
  await assert.rejects(run.done, /start was rejected/); assert.equal(h.calls[0].sends, 0); await run.handle.stop();
  assert.deepEqual(h.ownership.listClaims()[0].nativeStorage, storage);
});

test('Antigravity continuation requires a persisted storage identity for the selected connection', () => {
  const h = setup('antigravity'), input = { ...h.input, nativeId: randomUUID() };
  assert.throws(() => h.adapter.create(input), /persisted native storage/);
  assert.throws(() => h.adapter.create({ ...input, nativeStorage: { connection: 'subscription', storageDir: process.cwd(), conversationId: randomUUID() } }), /storage/);
  assert.equal(h.calls.length, 0);
});

test('Antigravity preparation cancellation sends no input and still requires drain', async () => {
  const h = setup('antigravity'), ready = deferred();
  const ensure = h.driver.ensure;
  h.driver.ensure = opts => { const session = ensure(opts); session.prepareNativeStorage = () => ready.promise; return session; };
  const run = h.start(); await tick(); run.abort.abort(); ready.resolve(randomUUID().replaceAll('-', ''));
  await assert.rejects(run.done, /cancelled/); await run.handle.stop();
  assert.equal(h.calls[0].sends, 0); assert.equal(h.events.length, 0); assert.equal(h.calls[0].dead, true);
});

test('Antigravity preparation result cannot override the verified storage identity', async () => {
  const h = setup('antigravity');
  h.policy.verify = async ({ session }) => {
    h.owners.push({ engine: 'antigravity', nativeId: session.sessionId, runtimeId: h.input.runtimeId,
      ownerId: `discussion/${h.input.discussionId}/${h.input.participantId}/1`, storageVerified: true,
      nativeStorage: { connection: 'api', storageDir: process.cwd(), conversationId: randomUUID().replaceAll('-', '') } }); return true;
  };
  const run = h.start(); await assert.rejects(run.done, /Prepared native identity/); await run.handle.stop();
  assert.equal(h.calls[0].sends, 0); assert.equal(h.events.length, 0);
});

test('native adapter pins settings, opens before dispatch and publishes only public text', async () => {
  const h = setup(), run = h.start(h.input, event => {
    if (event.type === 'started') assert.equal(h.calls[0].sends, 0);
    h.events.push(event); return true;
  });
  await tick(); const session = h.calls[0];
  assert.equal(session.opts.conversationId, h.input.runtimeId);
  assert.equal(session.opts.goalBridge, undefined);
  assert.equal(session.settings.subscriptionId, h.input.profile.accountRef);
  assert.equal(session.prompt, 'Persisted input');
  session.emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private' } } });
  session.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'also private' } } });
  session.emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
  session.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Public' } } });
  session.emit({ type: 'result', subtype: 'success', result: 'do not trust mixed text', outputBlocks: [
    { type: 'thinking', text: 'private' }, { type: 'text', phase: 'commentary', text: 'Progress' }, { type: 'text', phase: 'final_answer', text: 'Answer' }] });
  assert.deepEqual(await run.done, { text: 'Answer' });
  assert.ok(!JSON.stringify(h.events).includes('private'));
  assert.equal(h.events.at(-1).text, 'Public');
  const proof = await run.handle.stop(); assert.equal(proof.released, true);
  assert.equal(h.driver.sessions.get(session.opts), null);
});

test('drain proof is required independently of result, dead flag and process shutdown', async () => {
  const h = setup(), run = h.start(); await tick(); const session = h.calls[0];
  session.emit({ type: 'result', subtype: 'success', result: 'Answer' }); await run.done;
  h.policy.confirmStopped = async ({ identity }) => ({ ...identity, stopped: false });
  await assert.rejects(run.handle.stop(), /not confirmed/);
  assert.equal(session.dead, true); assert.equal(h.driver.sessions.get(session.opts), session);
  assert.ok(getDiscussionLaunch(session.opts, 'codex'));
  h.policy.confirmStopped = async ({ identity }) => ({ ...identity, stopped: true });
  await run.handle.stop(); assert.equal(h.driver.sessions.get(session.opts), null);
  assert.throws(() => getDiscussionLaunch(session.opts, 'codex'), /expired discussion launch/);
  assert.equal(session.sends, 1);
});

test('continuation creates a new process and swallows late events from the released process', async () => {
  const h = setup(), first = h.start(); await tick(); const old = h.calls[0];
  old.emit({ type: 'result', subtype: 'success', result: 'One' }); await first.done; await first.handle.stop();
  const second = h.start({ ...h.input, requestId: 'second', deliveryId: randomUUID(), nativeId: old.sessionId }); await tick();
  const current = h.calls[1]; assert.equal(current.sessionId, old.sessionId); assert.notEqual(current.gen, old.gen);
  const before = h.events.length;
  assert.equal(old.emit({ type: 'result', subtype: 'success', result: 'Late' }), true);
  assert.equal(h.events.length, before);
  current.emit({ type: 'result', subtype: 'success', result: 'Two' }); assert.equal((await second.done).text, 'Two'); await second.handle.stop();
  assert.equal(h.adapter.capture('codex', { conversationId: randomUUID() }), false);
  assert.equal(h.adapter.capture('antigravity', { conversationId: h.input.runtimeId }), false);
});

test('ownership rejection and native fallback both prevent user input from being sent', async () => {
  const h = setup(), run = h.start(h.input, () => { throw new Error('Native ID belongs to another member'); }); await tick();
  await assert.rejects(run.done, /another member/); assert.equal(h.calls[0].sends, 0); await run.handle.stop();
  h.policy.verify = async ({ session }) => { session.sessionId = 'unexpected-new-native'; return true; };
  const input = { ...h.input, runtimeId: randomUUID(), generation: 2, nativeId: 'expected-native' };
  h.owners.push({ engine: 'codex', runtimeId: input.runtimeId, nativeId: input.nativeId,
    ownerId: `discussion/${input.discussionId}/${input.participantId}/${input.generation}` });
  const next = h.start(input);
  await assert.rejects(next.done, /continuation changed/); assert.equal(h.calls[1].sends, 0); await next.handle.stop();
});

test('asynchronous event acknowledgement cannot dispatch and its rejection is contained', async () => {
  const h = setup(), run = h.start(h.input, async () => { throw new Error('async sink failure'); });
  await assert.rejects(run.done, /start was rejected/);
  assert.equal(h.calls[0].sends, 0);
  await run.handle.stop(); await tick();
  assert.equal(h.driver.sessions.sessions.size, 0);
});

test('a launch exception without a returned session still requires independent stop proof', async () => {
  const h = setup();
  h.driver.ensure = () => { throw new Error('launch failed before returning a handle'); };
  const seen = [];
  let confirmed = false;
  h.policy.confirmStopped = async ({ session, identity }) => {
    seen.push(session); return { ...identity, stopped: confirmed };
  };
  const run = h.start(); await assert.rejects(run.done, /launch failed/);
  await assert.rejects(run.handle.stop(), /not confirmed/);
  assert.equal(h.adapter.active.size, 1);
  assert.deepEqual(seen, [null]);
  confirmed = true;
  const proof = await run.handle.stop();
  assert.equal(proof.released, true); assert.equal(h.adapter.active.size, 0);
  assert.deepEqual(seen, [null, null]);
});

test('native stop proof must name the current delivery even when its runtime is reused', async () => {
  const h = setup(), first = h.start(); await tick();
  const old = h.calls[0];
  old.emit({ type: 'result', subtype: 'success', result: 'One' }); await first.done;
  const stale = await first.handle.stop();
  const second = h.start({ ...h.input, deliveryId: randomUUID(), nativeId: old.sessionId }); await tick();
  h.calls[1].emit({ type: 'result', subtype: 'success', result: 'Two' }); await second.done;
  const confirmStopped = h.policy.confirmStopped;
  h.policy.confirmStopped = async () => stale;
  await assert.rejects(second.handle.stop(), /not confirmed/);
  assert.equal(h.driver.sessions.sessions.size, 1);
  h.policy.confirmStopped = confirmStopped;
  await second.handle.stop();
  assert.equal(h.driver.sessions.sessions.size, 0);
});

test('binding changes and revoked policy after an async preparation never send input', async () => {
  const h = setup();
  h.policy.prepare = async () => ({ settings: { model: 'wrong', connection: 'subscription' } });
  const wrong = h.start(); await assert.rejects(wrong.done, /changed.*binding/); assert.equal(h.calls.length, 0);
  await wrong.handle.stop();
  const pending = deferred(); h.policy.prepare = () => pending.promise;
  const revoked = h.start(); h.adapter.reviewedEvidence = () => null;
  pending.resolve({ settings: {} }); await assert.rejects(revoked.done, /unavailable/); assert.equal(h.calls.length, 0);
  await revoked.handle.stop();
});

test('external ownership prevents opening a continuation and is rechecked after preparation', async () => {
  const h = setup();
  h.owners.push({ engine: 'codex', nativeId: 'ordinary', ownerId: 'conversation/ordinary' });
  const foreign = h.start({ ...h.input, nativeId: 'ordinary' });
  await assert.rejects(foreign.done, /another.*owner/); await foreign.handle.stop();
  assert.equal(h.calls.length, 0);
  const pending = deferred(), prepare = h.policy.prepare; h.policy.prepare = () => pending.promise;
  const preparing = h.start();
  h.owners.push({ engine: 'codex', runtimeId: h.input.runtimeId, ownerId: 'external/raced' });
  pending.resolve(await prepare({ profile: h.input.profile }));
  await assert.rejects(preparing.done, /another.*owner/); await preparing.handle.stop();
  assert.equal(h.calls.length, 0); assert.equal(h.ownership.active.size, 0);
});

test('a fresh native collision discovered during verification cannot dispatch or lose its drain obligation', async () => {
  const h = setup();
  h.policy.verify = async ({ session }) => {
    h.owners.push({ engine: 'codex', nativeId: session.sessionId, ownerId: 'external/collision' });
    return true;
  };
  const run = h.start(); await assert.rejects(run.done, /another.*owner/);
  assert.equal(h.calls[0].sends, 0);
  h.policy.confirmStopped = async ({ identity }) => ({ ...identity, stopped: false });
  await assert.rejects(run.handle.stop(), /not confirmed/);
  assert.equal(h.ownership.active.size, 1); assert.equal(h.adapter.activities.size, 1);
  h.policy.confirmStopped = async ({ identity }) => ({ ...identity, stopped: true });
  await run.handle.stop(); assert.equal(h.ownership.active.size, 0); assert.equal(h.adapter.activities.size, 0);
});

test('a history created during preparation cannot be adopted or receive input through the application boundary', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-prepare-inventory-'));
  t.after(() => removeTree(dir));
  const h = setup(), manager = new DiscussionManager({ dir: path.join(dir, 'discussions') });
  const group = manager.create({ cwd: dir }), member = manager.addMember(group.id, { ...h.input.profile, name: 'Member' });
  h.driver.history = new ClaudeHistory(path.join(dir, 'history'));
  const { registry } = createDiscussionBoundary({ dataDir: dir, drivers: { codex: h.driver }, conversations: () => [],
    external: () => ({ complete: true, histories: [], activities: [] }) });
  const prepare = h.policy.prepare, ensure = h.driver.ensure;
  h.policy.prepare = async args => {
    const project = path.join(h.driver.history.root, 'project'); fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'foreign-during-prepare.jsonl'), 'external history');
    return prepare(args);
  };
  h.driver.ensure = opts => {
    const session = ensure(opts);
    session.open = async () => { session.sessionId = 'foreign-during-prepare'; };
    return session;
  };
  const adapter = registry.register({ engine: 'codex', driver: h.driver, policy: h.policy, runtime: h.adapter.runtime,
    bindings: [{ binding: member, evidence: h.adapter.reviewedEvidence(member) }] });
  const activity = adapter.create({ ...h.input, discussionId: group.id, threadId: group.threadId,
    participantId: member.id, runtimeId: member.session.runtimeId, cwd: dir });
  await assert.rejects(activity.execute({ plan: { prompt: 'Saved prompt' }, signal: new AbortController().signal,
    onEvent: () => true }), /another owner before launch/);
  assert.equal(h.calls[0].sends, 0); assert.equal(h.driver.sessions.sessions.size, 1);
  await activity.stop(); assert.equal(h.driver.sessions.sessions.size, 0);
});

test('native policy evidence alone cannot enable an adapter without the ownership boundary', async () => {
  const h = setup(); h.adapter.ownership = null;
  const run = h.start(); await assert.rejects(run.done, /unavailable/); await run.handle.stop();
  assert.equal(h.calls.length, 0);
});

test('a policy missing its scoped launcher cannot fall back to the ordinary driver configuration', async () => {
  const h = setup(), prepare = h.policy.prepare;
  h.policy.prepare = async args => { const prepared = await prepare(args); delete prepared.launch; return prepared; };
  const run = h.start(); await assert.rejects(run.done, /scoped process launcher/); await run.handle.stop();
  assert.equal(h.calls.length, 0); assert.equal(h.ownership.active.size, 0);
});

test('failed preparation retains its ownership and resources until preparation stop is confirmed', async () => {
  const h = setup();
  h.policy.prepare = async () => { throw new Error('Preparation failed after allocating resources'); };
  let confirmed = false;
  h.policy.confirmStopped = async ({ session, identity }) => {
    assert.equal(session, null); return { ...identity, stopped: confirmed };
  };
  const run = h.start(); await assert.rejects(run.done, /Preparation failed/);
  await assert.rejects(run.handle.stop(), /not confirmed/);
  assert.equal(h.calls.length, 0); assert.equal(h.ownership.active.size, 1); assert.equal(h.adapter.activities.size, 1);
  confirmed = true; await run.handle.stop();
  assert.equal(h.ownership.active.size, 0); assert.equal(h.adapter.activities.size, 0);
});

test('cancel during preparation prevents launch; cancel without a result drains the session', async () => {
  const h = setup(), prepare = h.policy.prepare, pending = deferred(); h.policy.prepare = () => pending.promise;
  const planning = h.start(); planning.abort.abort(); pending.resolve(await prepare({ profile: h.input.profile }));
  await assert.rejects(planning.done, /cancelled/); await planning.handle.stop(); assert.equal(h.calls.length, 0);
  h.policy.prepare = prepare;
  const active = h.start(); await tick(); active.abort.abort();
  await assert.rejects(active.done, /cancelled/); await active.handle.stop();
  assert.equal(h.calls[0].interrupts, 1); assert.equal(h.driver.sessions.get(h.calls[0].opts), null);
});

test('direct stop during preparation waits for it to finish and can never be followed by dispatch', async () => {
  const h = setup(), pending = deferred(), prepare = h.policy.prepare; h.policy.prepare = () => pending.promise;
  const run = h.start(); let confirmed = false;
  const stopping = run.handle.stop().then(proof => { confirmed = true; return proof; });
  await tick(); assert.equal(confirmed, false);
  pending.resolve(await prepare({ profile: h.input.profile })); await assert.rejects(run.done, /cancelled/);
  await stopping; assert.equal(h.calls.length, 0);
  await assert.rejects(run.handle.execute({ plan: { prompt: 'Too late' } }), /already.*stopped/);
  const idle = h.adapter.create(h.input); await idle.stop();
  await assert.rejects(idle.execute({ plan: { prompt: 'Too late' } }), /already.*stopped/);
});

test('unexpected permission escalation is denied and tool-free violations stop the turn', async () => {
  for (const type of ['gui:permission', 'gui:tool']) {
    const h = setup(), run = h.start(); await tick();
    h.calls[0].emit({ type, requestId: 'approval', input: { private: true } });
    await assert.rejects(run.done, /Unexpected native/); await run.handle.stop();
    if (type === 'gui:permission') assert.deepEqual(h.calls[0].permission, { id: 'approval', allow: false });
    assert.equal(h.events.length, 1);
  }
});

test('existing pool slots and replacement sessions are never killed or released by another activity', async () => {
  const h = setup(), foreign = { running: false };
  h.driver.sessions.set({ conversationId: h.input.runtimeId }, foreign);
  const rejected = h.start(); await assert.rejects(rejected.done, /occupied/); await rejected.handle.stop();
  assert.equal(h.driver.sessions.get({ conversationId: h.input.runtimeId }), foreign);
  h.driver.sessions.set({ conversationId: h.input.runtimeId }, null);
  const active = h.start(); await tick(); h.calls[0].emit({ type: 'result', subtype: 'success', result: 'Answer' }); await active.done;
  assert.throws(() => h.driver.sessions.set({ conversationId: h.input.runtimeId }, foreign), /replaced by their owner/);
  // Corrupt the backing map deliberately: the adapter must still refuse to
  // release somebody else's process even if trusted application code bypasses
  // the guarded pool API.
  h.driver.sessions.sessions.set(h.input.runtimeId, foreign);
  await assert.rejects(active.handle.stop(), /ownership changed/);
  assert.equal(h.driver.sessions.get({ conversationId: h.input.runtimeId }), foreign);
});

// Real repository session classes with in-memory protocol peers. No installed
// CLI, model service or account is used, and these are NOT runtime evidence.
function transport(engine, answer) {
  const proc = new EventEmitter(), messages = [];
  Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  let buffer = '', nativeId;
  const send = value => proc.stdout.write(JSON.stringify(value) + '\n');
  proc.stdin.on('data', data => {
    buffer += data;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); messages.push(message);
      if (!message.method || message.id === undefined) continue;
      let result = {};
      if (message.method === 'thread/start' || message.method === 'thread/resume') {
        nativeId = message.params.threadId || randomUUID(); result = { thread: { id: nativeId, turns: [] } };
      } else if (message.method === 'session/new' || message.method === 'session/resume') {
        nativeId = message.params.sessionId || randomUUID(); result = { sessionId: nativeId };
      } else if (message.method === 'session/camellia_prepare') {
        result = { sessionId: nativeId, conversationId: nativeId.replaceAll('-', '') };
      } else if (message.method === 'turn/start') {
        const turnId = randomUUID(); result = { turn: { id: turnId } };
        queueMicrotask(() => {
          send({ method: 'item/started', params: { threadId: nativeId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } } });
          send({ method: 'item/agentMessage/delta', params: { threadId: nativeId, itemId: 'answer', delta: answer } });
          send({ method: 'item/completed', params: { threadId: nativeId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
          send({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: turnId, status: 'completed' } } });
        });
      } else if (message.method === 'session/prompt') {
        send({ method: 'session/update', params: { sessionId: nativeId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private-thought' } } } });
        send({ method: 'session/update', params: { sessionId: nativeId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } } });
        result = { stopReason: 'end_turn' };
      }
      send({ id: message.id, result });
    }
  });
  const close = () => { if (proc.exitCode !== null) return; proc.exitCode = 0; proc.stdout.end(); proc.stderr.end(); proc.emit('close', 0); };
  proc.kill = close; proc.stdin.on('finish', close);
  return { proc, messages, engine, get nativeId() { return nativeId; } };
}

test('application boundary runs duplicate and mixed Codex/ACP members, retaining ownership after pools release', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-native-protocol-'));
  t.after(() => removeTree(dir));
  const manager = new DiscussionManager({ dir: path.join(dir, 'discussions') }), group = manager.create({ cwd: dir });
  const adapters = {}, drivers = {}, registrations = [], wires = [], events = [], errors = [];
  for (const engine of ['codex', 'antigravity']) {
    const h = setup(), driver = h.driver;
    let generation = 0;
    const history = new ClaudeHistory(path.join(dir, engine));
    driver.history = history; drivers[engine] = driver;
    driver.ensure = opts => {
      const wire = transport(engine, engine + ' public answer'); wires.push(wire);
      const options = { gen: ++generation, settings: { ...opts.settings, cwd: dir }, opts,
        exe: 'unused-fixture', spec: { args: [], env: {}, noModes: true, modeEngine: engine }, spawn: () => wire.proc, history,
        log() {}, onSessionId() {}, onResult() {}, onEvent: event => registry.capture(engine, { ...event, conversationId: opts.conversationId }) };
      const session = engine === 'codex' ? new CodexSession(options) : new AcpSession(options);
      driver.sessions.set(opts, session); session.start(); return session;
    };
    const policy = { ...h.policy, confirmStopped: async ({ session, identity }) => ({ ...identity,
      stopped: (session.client?.proc || session.proc).exitCode === 0 }) };
    const binding = manager.addMember(group.id, { ...h.input.profile, engine, name: engine, connection: engine === 'codex' ? 'subscription' : 'api' });
    if (engine === 'codex') manager.addMember(group.id, { ...binding, name: 'Second Codex' });
    registrations.push({ engine, driver, policy, runtime: h.adapter.runtime,
      bindings: [{ binding, evidence: h.adapter.reviewedEvidence(binding) }] });
  }
  const nativeStorage = () => {
    const ids = [...new Set(wires.filter(w => w.engine === 'antigravity' && w.nativeId).map(w => w.nativeId))];
    const bridges = ids.map(nativeId => ({ nativeId, connection: 'api', storageDir: path.join(dir, 'native', nativeId), conversationId: nativeId.replaceAll('-', ''), databaseVerified: true }));
    return { bridges, histories: bridges.map(({ nativeId, databaseVerified, ...storage }) => storage) };
  };
  const { registry } = createDiscussionBoundary({ dataDir: dir, drivers, conversations: () => [], nativeStorage,
    // This explicitly complete fixture exercises the real application inventory
    // and reverse guards, without asserting coverage of any installed CLI.
    external: () => ({ complete: true, histories: [], activities: [], antigravity: nativeStorage() }) });
  for (const registration of registrations) adapters[registration.engine] = registry.register(registration);
  const scheduler = new DiscussionScheduler({ manager, registry, onEvent: event => events.push(event), onError: error => errors.push(error),
    prepareInput: (state, delivery) => ({ prompt: state.messages.filter(m => m.seq <= delivery.inputThroughSeq).map(m => m.text).join('\n'), inputThroughSeq: delivery.inputThroughSeq }) });
  const targets = manager.get(group.id).participants.map(p => p.id);
  scheduler.enqueue(group.id, { requestId: 'mixed', text: 'Compare', participantIds: targets });
  await Promise.all([...scheduler.runs.values()].map(run => run.done));
  assert.equal(errors.length, 0); assert.equal(manager.get(group.id).messages.length, targets.length + 1);
  const first = manager.get(group.id).participants.map(p => p.session.nativeId);
  assert.equal(new Set(first).size, targets.length);
  assert.ok(Object.values(adapters).every(adapter => adapter.driver.sessions.sessions.size === 0));
  scheduler.enqueue(group.id, { requestId: 'continue', text: 'Continue', participantIds: targets });
  await Promise.all([...scheduler.runs.values()].map(run => run.done));
  const state = manager.get(group.id);
  assert.equal(errors.length, 0); assert.deepEqual(state.participants.map(p => p.session.nativeId), first);
  assert.deepEqual(state.messages.filter(m => m.role === 'assistant').map(m => m.speakerId).sort(), [...targets, ...targets].sort());
  assert.equal(wires.filter(w => w.messages.some(m => ['thread/resume', 'session/resume'].includes(m.method))).length, targets.length);
  assert.ok(wires.every(w => w.proc.exitCode === 0));
  assert.ok(!JSON.stringify(events).includes('private-thought'));
  for (const member of state.participants) {
    assert.throws(() => drivers[member.engine].sessions.assertAccess({ sessionId: member.session.nativeId }), /owned by a discussion/);
    assert.equal(registry.capture(member.engine, { conversationId: member.session.runtimeId, runId: -1, type: 'result' }), true);
  }
});
