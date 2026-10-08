'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { DiscussionStore } = require('../src/engines/discussions/store');
const { DiscussionScheduler } = require('../src/engines/discussions/scheduler');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const { LIMITS } = require('../src/engines/discussions/schema');
const { removeTree } = require('./test-fs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-scheduler-'));
  t.after(() => removeTree(dir));
  const manager = new DiscussionManager({ dir }), group = manager.create({ cwd: dir });
  const profile = { engine: 'codex', connection: 'subscription', model: 'fixture', accountRef: 'fixture-account', name: 'Member' };
  const a = manager.addMember(group.id, profile), b = manager.addMember(group.id, profile);
  const calls = [], events = [], errors = [];
  const adapter = {
    runtime: { version: 'fixture', policyVersion: 'fixture' },
    // Synthetic positive gate data, not a claim of real-service verification.
    evidence(binding) { return { kind: 'real', reference: 'synthetic-test-only',
      bindingFingerprint: bindingFingerprint(binding), runtimeVersion: 'fixture', policyVersion: 'fixture', mode: 'tool-free',
      checks: Object.fromEntries(['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'shellRestricted',
        'mcpRestricted', 'subagentsRestricted', 'escalationDisabled', 'conversationControlDisabled', 'toolsDisabled'].map(k => [k, true])) }; },
    create(identity) {
      const completion = deferred();
      const call = { identity, completion, proof: { runtimeId: identity.runtimeId, deliveryId: identity.deliveryId,
        generation: identity.generation, stopped: true, released: true },
        execute({ plan, signal, onEvent }) {
          call.plan = plan; call.signal = signal; call.emit = event => onEvent({ ...identity, ...event });
          assert.deepEqual(manager.get(group.id).deliveries.find(d => d.id === identity.deliveryId).inputPlan, plan);
          call.emit({ type: 'started', nativeId: 'native-' + identity.runtimeId });
          return completion.promise;
        },
        cancel() { call.cancels = (call.cancels || 0) + 1; completion.resolve({ text: 'Cancelled late result' }); },
        async stop() { call.stops = (call.stops || 0) + 1; return call.proof; }
      };
      calls.push(call); return call;
    }
  };
  const scheduler = new DiscussionScheduler({ manager, adapters: { codex: adapter },
    prepareInput: (state, d) => ({ prompt: JSON.stringify(state.messages.filter(m => m.seq <= d.inputThroughSeq)), inputThroughSeq: d.inputThroughSeq }),
    onEvent: event => events.push(event), onError: error => errors.push(error), ...options });
  const send = (requestId, targets = [a.id, b.id], mode = 'parallel') => scheduler.enqueue(group.id, { requestId, text: 'Question ' + requestId, participantIds: targets, mode });
  return { manager, group, a, b, adapter, scheduler, calls, events, errors, send };
}

test('scheduler denies unverified bindings before planning or launching', async t => {
  const h = setup(t, { adapters: {}, prepareInput() { assert.fail('must not plan'); } });
  h.send('blocked'); await tick();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.manager.get(h.group.id).deliveries.map(d => d.status), ['failed', 'failed']);
  assert.ok(h.manager.get(h.group.id).deliveries.every(d => d.unavailableReason === 'unknown-runtime-policy'));
  assert.deepEqual(h.events.map(e => e.reason), ['unknown-runtime-policy', 'unknown-runtime-policy']);
});

test('account suspension drains only affected members, cancels their queues and never replays on resume', async t => {
  const h = setup(t);
  h.manager.configureMember(h.group.id, h.b.id, { accountRef: 'other-account' });
  h.send('active'); h.send('queued'); await tick();
  const [a, b] = h.calls;
  a.proof = { ...a.proof, stopped: false };
  const token = h.scheduler.suspend({ reason: 'account-change', scope: { engine: 'codex', accountRef: 'fixture-account' } });
  assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, false);
  assert.throws(() => h.send('blocked', [h.a.id]), /suspended/);
  h.send('note', []);
  // An idempotent retry can retrieve the old request during suspension.
  assert.equal(h.send('active').id, 'active');
  const first = await h.scheduler.drainSuspension(token);
  assert.equal(first.stopped, false); assert.throws(() => h.scheduler.resume(token), /not confirmed/);
  assert.equal(h.manager.get(h.group.id).deliveries.filter(d => d.participantId === h.a.id).at(-1).status, 'cancelled');
  b.completion.resolve({ text: 'Unaffected answer' }); await tick();
  assert.equal(h.calls.length, 3); assert.equal(h.calls[2].identity.participantId, h.b.id);
  h.calls[2].completion.resolve({ text: 'Unaffected queued answer' }); await tick();
  a.proof.stopped = true;
  assert.equal((await h.scheduler.drainSuspension(token)).stopped, true);
  h.scheduler.resume(token); await tick();
  assert.equal(h.calls.length, 3);
  h.send('explicit-new', [h.a.id]); await tick();
  assert.equal(h.calls.length, 4);
  h.calls[3].completion.resolve({ text: 'New request' }); await tick();
});

test('network suspension covers pending context preparation and overlapping holds release independently', async t => {
  const pending = deferred();
  const h = setup(t, { prepareInput: () => pending.promise });
  h.send('preparing', [h.a.id]); await tick();
  const first = h.scheduler.suspend({ reason: 'network-change' });
  const second = h.scheduler.suspend({ reason: 'runtime-change', scope: { engine: 'codex' } });
  let drained = false;
  const stopping = h.scheduler.drainSuspension(first).then(result => { drained = true; return result; });
  await tick(); assert.equal(drained, false); assert.equal(h.calls.length, 0);
  pending.resolve({ prompt: 'Prepared after stop', inputThroughSeq: 1 });
  assert.equal((await stopping).stopped, true); h.scheduler.resume(first);
  assert.throws(() => h.send('still-blocked'), /suspended/);
  assert.equal((await h.scheduler.drainSuspension(second)).stopped, true); h.scheduler.resume(second);
  await tick(); assert.equal(h.calls.length, 0);
  assert.equal(h.manager.get(h.group.id).deliveries[0].status, 'cancelled');
});

test('lifecycle inventory failure still cancels known runs and prevents resume until an explicit successful drain', async t => {
  const h = setup(t); h.send('one', [h.a.id]); h.send('two', [h.a.id]); await tick();
  const list = h.manager.list.bind(h.manager);
  h.manager.list = () => { throw new Error('inventory read failed'); };
  const token = h.scheduler.suspend({ reason: 'network-change' });
  assert.equal(h.calls[0].signal.aborted, true);
  const failed = await h.scheduler.drainSuspension(token);
  assert.equal(failed.stopped, false); assert.ok(failed.errors.some(error => /inventory read failed/.test(error.message)));
  assert.throws(() => h.scheduler.resume(token), /not confirmed/);
  assert.throws(() => h.send('denied'), /suspended/);
  h.manager.list = list;
  assert.equal((await h.scheduler.drainSuspension(token)).stopped, true); h.scheduler.resume(token);
  assert.equal(h.calls.length, 1);
  assert.ok(h.manager.get(h.group.id).deliveries.every(d => d.status === 'cancelled'));
});

test('lifecycle drain after restart requires the interrupted activity proof and cannot release on an old turn proof', async t => {
  const h = setup(t);
  const request = h.manager.enqueue(h.group.id, { requestId: 'one', text: 'Interrupted input', participantIds: [h.a.id] });
  const delivery = h.manager.prepare(h.group.id, request.deliveryIds[0]);
  h.manager.saveInput(h.group.id, delivery.id, delivery.generation, { prompt: 'Saved input', inputThroughSeq: 1 });
  h.manager.start(h.group.id, delivery.id, delivery.generation, 'native-before-restart');
  const reopened = new DiscussionManager({ dir: h.manager.store.dir }); reopened.recover();
  const scheduler = new DiscussionScheduler({ manager: reopened });
  const proof = { runtimeId: delivery.runtimeId, deliveryId: delivery.id, generation: delivery.generation, stopped: true, released: true };
  const token = scheduler.suspend({ reason: 'network-change' });
  assert.equal((await scheduler.drainSuspension(token)).stopped, false);
  assert.throws(() => scheduler.resume(token), /not confirmed/);
  assert.throws(() => reopened.confirmRetiredStop(h.group.id, h.a.id, delivery.runtimeId,
    { ...proof, deliveryId: 'old' }), /not confirmed/);
  reopened.confirmRetiredStop(h.group.id, h.a.id, delivery.runtimeId, proof);
  assert.equal((await scheduler.drainSuspension(token)).stopped, true); scheduler.resume(token);
  assert.equal(h.calls.length, 0);
});

test('app exit is a permanent global barrier and malformed lifecycle scopes are rejected', async t => {
  const h = setup(t);
  for (const scope of [{ engine: undefined }, { engine: 'unknown' }, { connection: undefined }, { accountRef: 'account' },
    { permission: 'full' }, { engine: 'codex', accountRef: '' }]) {
    assert.throws(() => h.scheduler.suspend({ reason: 'account-change', scope }), /Invalid/);
  }
  assert.throws(() => h.scheduler.suspend({ reason: 'app-exit', scope: { engine: 'codex' } }), /Invalid/);
  const token = h.scheduler.suspend({ reason: 'app-exit' });
  assert.throws(() => h.send('exit'), /suspended/);
  assert.equal((await h.scheduler.drainSuspension(token)).stopped, true);
  assert.throws(() => h.scheduler.resume(token), /cannot be resumed/);
  assert.throws(() => h.scheduler.resume({}), /Unknown/);
  assert.equal(h.manager.get(h.group.id).messages.length, 0);
});

test('dispatch rejects invalid attachment descriptors instead of silently dropping input', async t => {
  for (const attachments of [[{ name: 'evidence.txt', text: 'Important material' }], { text: 'Malformed attachment list' }]) {
    const h = setup(t, { prepareInput: (state, d) => ({ prompt: 'Read the attachment', inputThroughSeq: d.inputThroughSeq, attachments }) });
    h.send('attachments', [h.a.id]); await tick();
    assert.equal(h.calls.length, 0);
    const delivery = h.manager.get(h.group.id).deliveries[0];
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.inputPlan, undefined);
    assert.match(h.errors[0].message, /attachment/);
  }
});

test('oversized final answers fail before freezing success, drain once and leave a usable member', async t => {
  const h = setup(t); h.send('too-large', [h.a.id]); await tick();
  h.calls[0].completion.resolve({ text: 'a'.repeat(LIMITS.messageBytes) }); await tick();
  const state = h.manager.get(h.group.id), delivery = state.deliveries[0];
  assert.equal(delivery.status, 'failed'); assert.deepEqual(delivery.settlement, { status: 'failed' });
  assert.equal(state.messages.length, 1); assert.equal(h.calls[0].stops, 1);
  assert.equal(h.scheduler.hasRuns(h.group.id), false); assert.match(h.errors[0].message, /text size/);
  h.send('explicit-next', [h.a.id]); await tick();
  assert.equal(h.calls.length, 2); h.calls[1].completion.resolve({ text: 'Fits' }); await tick();
  assert.equal(h.manager.get(h.group.id).deliveries[1].status, 'completed');
});

test('oversized fixed input fails before opening a native session or advancing coverage', async t => {
  const h = setup(t, { prepareInput: (state, d) => ({ prompt: 'a'.repeat(LIMITS.promptBytes), inputThroughSeq: d.inputThroughSeq }) });
  h.send('input-too-large', [h.a.id]); await tick();
  const state = h.manager.get(h.group.id);
  assert.equal(h.calls.length, 0); assert.equal(h.scheduler.hasRuns(h.group.id), false);
  assert.equal(state.deliveries[0].status, 'failed'); assert.equal(state.deliveries[0].inputPlan, undefined);
  assert.equal(state.participants[0].session.coveredThroughSeq, 0); assert.match(h.errors[0].message, /text size/);
});

test('a queued turn with no capacity to start fails explicitly and is never replayed when capacity returns', async t => {
  const h = setup(t), store = h.manager.store;
  h.manager.store = new DiscussionStore({ dir: store.dir, maxRecordBytes: 128 * 1024 });
  h.send('no-capacity', [h.a.id]); await tick();
  const delivery = h.manager.get(h.group.id).deliveries[0];
  assert.equal(delivery.status, 'failed'); assert.equal(delivery.unavailableReason, 'discussion-capacity-exceeded');
  assert.equal(delivery.generation, null); assert.equal(h.calls.length, 0); assert.equal(h.scheduler.hasRuns(h.group.id), false);
  assert.equal(h.events.at(-1).reason, 'discussion-capacity-exceeded');
  h.manager.store = store; h.scheduler.pump(h.group.id); await tick(); assert.equal(h.calls.length, 0);
  h.send('explicit-next', [h.a.id]); await tick();
  h.calls[0].completion.resolve({ text: 'Explicit new request fits' }); await tick();
  assert.equal(h.manager.get(h.group.id).deliveries[1].status, 'completed');
});

test('parallel routing persists exact input, rejects identity mismatches and filters private events', async t => {
  const h = setup(t); h.send('parallel'); await tick();
  assert.equal(h.calls.length, 2);
  const [a, b] = h.calls;
  assert.notEqual(a.identity.runtimeId, b.identity.runtimeId);
  for (const key of ['discussionId', 'participantId', 'requestId', 'generation', 'runtimeId', 'bindingFingerprint', 'deliveryId', 'threadId']) {
    assert.equal(a.emit({ type: 'answer', text: 'wrong', [key]: 'wrong' }), false);
  }
  assert.equal(a.emit({ type: 'reasoning', text: 'private' }), false);
  a.emit({ type: 'answer', text: 'partial A' });
  b.completion.resolve({ text: 'B' }); a.completion.resolve({ text: 'A' }); await tick();
  const state = h.manager.get(h.group.id);
  assert.deepEqual(state.participants.map(p => p.session.coveredThroughSeq), [1, 1]);
  assert.equal(state.messages.length, 3);
  assert.equal(a.emit({ type: 'answer', text: 'late' }), false);
  assert.ok(!JSON.stringify(h.events).includes('private'));
  assert.equal(h.errors.length, 0);
});

test('same-member FIFO holds through drain and late events cannot affect the next attempt', async t => {
  const h = setup(t); h.send('one', [h.a.id]); h.send('two', [h.a.id]); await tick();
  assert.equal(h.calls.length, 1);
  const first = h.calls[0], drain = deferred(); first.stop = () => drain.promise;
  first.completion.resolve({ text: 'First' }); await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(first.emit({ type: 'answer', text: 'after result' }), false);
  drain.resolve(first.proof); await tick();
  assert.equal(h.calls.length, 2);
  assert.notEqual(first.identity.runtimeId, h.calls[1].identity.runtimeId);
  assert.equal(first.emit({ type: 'answer', text: 'late' }), false);
  h.calls[1].completion.resolve({ text: 'Second' }); await tick();
  assert.equal(h.manager.get(h.group.id).messages.length, 4);
});

test('serial failure pauses successors; explicit retry starts once without duplicating user history', async t => {
  const h = setup(t), request = h.send('serial', undefined, 'serial'); await tick();
  assert.equal(h.calls.length, 1);
  h.calls[0].completion.reject(new Error('provider failure')); await tick();
  assert.equal(h.calls.length, 1);
  const retry = h.scheduler.resolveSerial(h.group.id, request.deliveryIds[0], 'retry', 'retry-1');
  h.scheduler.resolveSerial(h.group.id, request.deliveryIds[0], 'retry', 'retry-1'); await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].identity.deliveryId, retry.id);
  h.calls[1].completion.resolve({ text: 'Retried answer' }); await tick();
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[2].plan.prompt, /Retried answer/);
  h.calls[2].completion.resolve({ text: 'Follow-up' }); await tick();
  assert.equal(h.manager.get(h.group.id).messages.filter(m => m.role === 'user').length, 1);
});

test('stop-all cancels queued work and waits for every active drain', async t => {
  const h = setup(t); h.send('active'); h.send('queued'); await tick();
  const drain = deferred(); h.calls[0].stop = () => drain.promise;
  h.calls[0].emit({ type: 'answer', text: 'Keep partial' });
  const stopping = h.scheduler.stopAll(h.group.id); await tick();
  assert.equal(h.manager.get(h.group.id).deliveries[0].status, 'stopping');
  assert.equal(h.calls.length, 2);
  drain.resolve(h.calls[0].proof); await stopping;
  const state = h.manager.get(h.group.id);
  assert.ok(state.deliveries.every(d => d.status === 'cancelled'));
  assert.equal(state.deliveries[0].partialText, 'Keep partial');
  assert.equal(state.messages.length, 2);
});

test('cancellation during input planning prevents dispatch and retains slot until planning returns', async t => {
  const planning = deferred(); const h = setup(t, { prepareInput: () => planning.promise });
  const request = h.send('planning', [h.a.id]); await tick();
  const stopping = h.scheduler.stop(h.group.id, request.deliveryIds[0]); await tick();
  assert.equal(h.manager.get(h.group.id).deliveries[0].status, 'stopping');
  planning.resolve({ prompt: 'late plan', inputThroughSeq: 1 }); await stopping;
  assert.equal(h.calls.length, 0);
  assert.equal(h.manager.get(h.group.id).deliveries[0].status, 'cancelled');
});

test('unconfirmed termination prevents removal; explicit stop can recheck without resending', async t => {
  const h = setup(t), request = h.send('uncertain', [h.a.id]); await tick();
  h.calls[0].proof.stopped = false;
  await assert.rejects(h.scheduler.removeMember(h.group.id, h.a.id), /Stop member/);
  assert.equal(h.manager.get(h.group.id).participants[0].removed, false);
  h.calls[0].proof.stopped = true;
  await h.scheduler.stop(h.group.id, request.deliveryIds[0]);
  await h.scheduler.removeMember(h.group.id, h.a.id);
  assert.equal(h.manager.get(h.group.id).participants[0].removed, true);
  assert.equal(h.calls.length, 1);
});

test('capability revoked during planning blocks execution after await', async t => {
  const planning = deferred(), h = setup(t, { prepareInput: () => planning.promise });
  h.send('revoke', [h.a.id]); await tick();
  h.adapter.evidence = () => null;
  planning.resolve({ prompt: 'input', inputThroughSeq: 1 }); await tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.manager.get(h.group.id).deliveries[0].status, 'failed');
});

test('parallel failure does not cancel peers or resend and successful continuation pins native ID', async t => {
  const h = setup(t); h.send('first'); await tick();
  h.calls[0].completion.reject(new Error('one member failed'));
  h.calls[1].completion.resolve({ text: 'Peer success' }); await tick();
  assert.deepEqual(h.manager.get(h.group.id).deliveries.map(d => d.status), ['failed', 'completed']);
  h.send('next', [h.b.id]); await tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].identity.nativeId, 'native-' + h.calls[1].identity.runtimeId);
  assert.equal(h.calls[2].identity.runtimeId, h.calls[1].identity.runtimeId);
  assert.equal(h.calls[1].emit({ type: 'answer', text: 'late previous turn' }), false);
  h.calls[2].completion.resolve({ text: 'Continued' }); await tick();
});

test('removal intent is durable and rejects new mentions while the old activity drains', async t => {
  const h = setup(t); h.send('remove', [h.a.id]); await tick();
  const drain = deferred(); h.calls[0].stop = () => drain.promise;
  const removing = h.scheduler.removeMember(h.group.id, h.a.id); await tick();
  assert.equal(h.manager.get(h.group.id).participants[0].removalPending, true);
  assert.throws(() => h.send('too-late', [h.a.id]), /being removed/);
  assert.throws(() => h.manager.configureMember(h.group.id, h.a.id, { name: 'Other' }), /being removed/);
  assert.equal(h.manager.get(h.group.id).requests.length, 1);
  drain.resolve(h.calls[0].proof); await removing;
  assert.equal(h.manager.get(h.group.id).participants[0].removed, true);
  assert.equal(h.calls.length, 1);
});

test('stop-all blocks new inference until every member is confirmed stopped and preserves plain notes', async t => {
  const h = setup(t); h.send('stop'); await tick();
  const drain = deferred(); h.calls[0].stop = () => drain.promise;
  const stopping = h.scheduler.stopAll(h.group.id); await tick();
  assert.throws(() => h.send('new', [h.b.id]), /Discussion is stopping/);
  h.send('note', []); assert.equal(h.manager.get(h.group.id).requests.length, 2);
  drain.resolve(h.calls[0].proof); await stopping;
  assert.equal(h.manager.get(h.group.id).stopPending, undefined);
  h.send('explicit-new', [h.b.id]); await tick();
  assert.equal(h.calls.length, 3); h.calls[2].completion.resolve({ text: 'After stop' }); await tick();
});

test('a failing evidence lookup cannot prevent an independent peer from running', async t => {
  const h = setup(t), evidence = h.adapter.evidence;
  h.adapter.evidence = binding => { if (binding.id === h.a.id) throw new Error('catalog unavailable'); return evidence(binding); };
  h.send('gate-failure'); await tick(); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].identity.participantId, h.b.id);
  h.calls[0].completion.resolve({ text: 'Peer answer' }); await tick();
  assert.deepEqual(h.manager.get(h.group.id).deliveries.map(d => d.status), ['failed', 'completed']);
  assert.equal(h.manager.get(h.group.id).deliveries[0].unavailableReason, 'capability-check-failed');
});

test('a final public answer remains recoverable when stop proof fails after a successful result', async t => {
  const h = setup(t); h.send('answer', [h.a.id]); await tick(); h.calls[0].proof.stopped = false;
  h.calls[0].completion.resolve({ text: 'Save this answer' }); await tick();
  const state = h.manager.get(h.group.id);
  assert.equal(state.deliveries[0].partialText, 'Save this answer');
  assert.equal(state.deliveries[0].status, 'stopping'); assert.equal(state.messages.length, 1);
  h.calls[0].proof.stopped = true; await h.scheduler.stopAll(h.group.id);
  const recovered = h.manager.get(h.group.id);
  assert.equal(recovered.deliveries[0].status, 'completed');
  assert.equal(recovered.messages[1].text, 'Save this answer');
  assert.equal(recovered.participants[0].session.coveredThroughSeq, 1);
  assert.equal(h.calls.length, 1);
});

test('explicit final member stop clears a previously unconfirmed stop-all barrier', async t => {
  const h = setup(t), request = h.send('uncertain-stop-all'); await tick();
  h.calls[0].proof.stopped = false; await h.scheduler.stopAll(h.group.id);
  assert.equal(h.manager.get(h.group.id).stopPending, true);
  h.calls[0].proof.stopped = true; await h.scheduler.stop(h.group.id, request.deliveryIds[0]);
  assert.equal(h.manager.get(h.group.id).stopPending, undefined);
  assert.equal(h.calls.length, 2);
});

test('failed completion and stop writes retain the recovery handle for explicit stop without resending', async t => {
  const h = setup(t), request = h.send('disk', [h.a.id]); await tick();
  const complete = h.manager.complete.bind(h.manager), stop = h.manager.stop.bind(h.manager);
  h.manager.complete = () => { throw new Error('disk unavailable'); };
  h.manager.stop = () => { throw new Error('disk unavailable'); };
  h.calls[0].completion.resolve({ text: 'Preserved before final write' }); await tick();
  assert.equal(h.scheduler.runs.size, 1);
  h.manager.complete = complete; h.manager.stop = stop;
  await h.scheduler.stop(h.group.id, request.deliveryIds[0]);
  assert.equal(h.scheduler.runs.size, 0); assert.equal(h.calls.length, 1);
  assert.equal(h.manager.get(h.group.id).deliveries[0].partialText, undefined);
  assert.equal(h.manager.get(h.group.id).deliveries[0].status, 'completed');
  assert.equal(h.manager.get(h.group.id).messages[1].text, 'Preserved before final write');
});

test('missing resource release holds the member and concurrent stop retries preserve successful intent', async t => {
  const h = setup(t), request = h.send('release', [h.a.id]); await tick();
  h.calls[0].proof.released = false;
  h.calls[0].completion.resolve({ text: 'Finished response' }); await tick();
  h.send('queued', [h.a.id]); await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.manager.get(h.group.id).messages.filter(m => m.role === 'assistant').length, 0);
  const retryDrain = deferred(); h.calls[0].stop = () => retryDrain.promise;
  const one = h.scheduler.stop(h.group.id, request.deliveryIds[0]);
  const two = h.scheduler.stopAll(h.group.id);
  h.calls[0].proof.released = true; retryDrain.resolve(h.calls[0].proof);
  await Promise.all([one, two]);
  const state = h.manager.get(h.group.id);
  assert.deepEqual(state.deliveries.map(d => d.status), ['completed', 'cancelled']);
  assert.deepEqual(state.messages.filter(m => m.role === 'assistant').map(m => m.text), ['Finished response']);
  assert.equal(state.participants[0].session.coveredThroughSeq, 1);
  assert.equal(h.scheduler.runs.size, 0); assert.equal(h.calls.length, 1);
});

test('a prior delivery stop proof cannot settle a new turn sharing the same native session', async t => {
  const h = setup(t); h.send('first-proof', [h.a.id]); await tick();
  h.calls[0].completion.resolve({ text: 'First answer' }); await tick();
  const request = h.send('second-proof', [h.a.id]); await tick();
  const currentProof = h.calls[1].proof;
  assert.equal(h.calls[1].identity.runtimeId, h.calls[0].identity.runtimeId);
  h.calls[1].proof = h.calls[0].proof;
  h.calls[1].completion.resolve({ text: 'Second answer' }); await tick();
  let state = h.manager.get(h.group.id);
  assert.equal(state.deliveries[1].status, 'stopping');
  assert.equal(state.participants[0].session.coveredThroughSeq, 1);
  h.calls[1].proof = currentProof;
  await h.scheduler.stop(h.group.id, request.deliveryIds[0]);
  state = h.manager.get(h.group.id);
  assert.equal(state.deliveries[1].status, 'completed');
  assert.equal(state.participants[0].session.coveredThroughSeq, 3);
  assert.equal(h.calls.length, 2);
});

test('disk failure during each stop action still aborts promptly and blocks admission until recovery', async t => {
  for (const action of ['stop', 'stopAll', 'removeMember']) {
    const h = setup(t), targets = action === 'stopAll' ? [h.a.id, h.b.id] : [h.a.id];
    const request = h.send('active', targets); h.send('queued', targets); await tick();
    const write = h.manager.store.write;
    h.manager.store.write = () => { throw new Error('disk offline'); };
    const stopping = action === 'stop' ? h.scheduler.stop(h.group.id, request.deliveryIds[0])
      : action === 'stopAll' ? h.scheduler.stopAll(h.group.id) : h.scheduler.removeMember(h.group.id, h.a.id);
    const observed = stopping.catch(error => error);
    assert.ok(h.calls.every(call => call.signal.aborted));
    assert.ok(h.calls.every(call => call.cancels === 1));
    await observed;
    assert.ok(h.calls.every(call => call.stops === 1));
    assert.equal(h.scheduler.runs.size, targets.length);
    assert.ok(h.manager.get(h.group.id).deliveries.slice(0, targets.length).every(d => d.status === 'running'));
    h.manager.store.write = write;
    if (action === 'stopAll') {
      assert.throws(() => h.send('too-soon'), /Discussion is stopping/);
      h.send('plain-note', []);
    } else if (action === 'removeMember') {
      assert.throws(() => h.send('too-soon', [h.a.id]), /being removed/);
      assert.throws(() => h.manager.configureMember(h.group.id, h.a.id, { name: 'Other' }), /being removed/);
    }
    h.scheduler.pump(h.group.id); await tick();
    assert.equal(h.calls.length, targets.length);
    if (action === 'stop') {
      await h.scheduler.stop(h.group.id, request.deliveryIds[0]); await tick();
      assert.equal(h.calls.length, 2);
      h.calls[1].completion.resolve({ text: 'Explicitly queued successor' }); await tick();
    } else if (action === 'stopAll') {
      await h.scheduler.stopAll(h.group.id);
      assert.ok(h.manager.get(h.group.id).deliveries.every(d => d.status === 'cancelled'));
      assert.equal(h.manager.isStopping(h.group.id), false);
    } else {
      await h.scheduler.removeMember(h.group.id, h.a.id);
      assert.equal(h.manager.get(h.group.id).participants[0].removed, true);
      assert.ok(h.manager.get(h.group.id).deliveries.every(d => d.status === 'cancelled'));
    }
    assert.equal(h.scheduler.runs.size, 0);
    assert.ok(h.errors.some(error => /disk offline/.test(error.message)));
  }
});

test('a failed result-intent write still drains and preserves success for explicit recovery', async t => {
  const h = setup(t), request = h.send('intent', [h.a.id]); await tick();
  const write = h.manager.store.write;
  h.manager.store.write = () => { throw new Error('disk offline'); };
  h.calls[0].completion.resolve({ text: 'Keep exact final result' }); await tick();
  assert.equal(h.calls[0].stops, 1);
  assert.equal(h.scheduler.runs.size, 1);
  assert.equal(h.manager.get(h.group.id).deliveries[0].settlement, undefined);
  h.manager.store.write = write;
  await h.scheduler.stop(h.group.id, request.deliveryIds[0]);
  const state = h.manager.get(h.group.id);
  assert.equal(state.deliveries[0].status, 'completed');
  assert.equal(state.deliveries[0].partialText, undefined);
  assert.equal(state.messages[1].text, 'Keep exact final result');
  assert.equal(h.calls.length, 1);
});

test('a commit that reports failure after writing retains the in-memory slot without duplicating the result', async t => {
  const h = setup(t), request = h.send('commit', [h.a.id]); h.send('next', [h.a.id]); await tick();
  const complete = h.manager.complete.bind(h.manager);
  h.manager.complete = (...args) => { complete(...args); throw new Error('commit acknowledgement lost'); };
  h.calls[0].completion.resolve({ text: 'Committed once' }); await tick();
  assert.equal(h.manager.get(h.group.id).deliveries[0].status, 'completed');
  assert.equal(h.scheduler.runs.size, 1);
  h.scheduler.pump(h.group.id); await tick();
  assert.equal(h.calls.length, 1);
  h.manager.complete = complete;
  await h.scheduler.stop(h.group.id, request.deliveryIds[0]); await tick();
  assert.equal(h.calls.length, 2);
  h.calls[1].completion.resolve({ text: 'Next result' }); await tick();
  assert.deepEqual(h.manager.get(h.group.id).messages.filter(m => m.role === 'assistant').map(m => m.text), ['Committed once', 'Next result']);
  assert.equal(h.scheduler.runs.size, 0);
});

test('serial successors wait for explicit recovery of an uncertain predecessor commit', async t => {
  const h = setup(t), request = h.send('serial-commit', undefined, 'serial'); await tick();
  const complete = h.manager.complete.bind(h.manager);
  h.manager.complete = (...args) => { complete(...args); throw new Error('commit acknowledgement lost'); };
  h.calls[0].completion.resolve({ text: 'Predecessor' }); await tick();
  h.scheduler.pump(h.group.id); await tick();
  assert.equal(h.calls.length, 1);
  h.manager.complete = complete;
  await h.scheduler.stop(h.group.id, request.deliveryIds[0]); await tick();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].plan.prompt, /Predecessor/);
  h.calls[1].completion.resolve({ text: 'Successor' }); await tick();
  assert.deepEqual(h.manager.get(h.group.id).deliveries.map(d => d.status), ['completed', 'completed']);
});

test('event persistence failure is latched even when a driver ignores callback rejection and resolves success', async t => {
  for (const failedEvent of ['started', 'answer', 'phase']) {
    const h = setup(t);
    const operation = failedEvent === 'started' ? 'start' : failedEvent === 'answer' ? 'partial' : 'activity';
    const original = h.manager[operation].bind(h.manager);
    h.manager[operation] = () => { throw new Error('event write lost'); };
    h.send('events', [h.a.id]); await tick();
    const call = h.calls[0];
    if (failedEvent !== 'started') {
      assert.equal(call.emit({ type: failedEvent, text: 'Uncommitted', phase: 'approval' }), false);
    }
    // This fake deliberately ignores false from started/answer/phase callbacks.
    call.completion.resolve({ text: 'Driver falsely reports success' }); await tick();
    h.manager[operation] = original;
    const state = h.manager.get(h.group.id);
    assert.equal(call.signal.aborted, true);
    assert.equal(state.deliveries[0].status, 'failed');
    assert.equal(state.participants[0].session.coveredThroughSeq, 0);
    assert.equal(state.messages.length, 1);
    assert.ok(h.errors.some(error => /event write lost/.test(error.message)));
    assert.equal(h.scheduler.runs.size, 0);
  }
});

test('asynchronous observer rejections are reported and cannot change a committed lifecycle', async t => {
  const errors = [];
  const h = setup(t, {
    async onEvent() { throw new Error('observer failed'); },
    async onError(error) { errors.push(error); throw new Error('error observer also failed'); }
  });
  h.send('observers', [h.a.id]); await tick();
  h.calls[0].completion.resolve({ text: 'Successful answer' }); await tick();
  assert.equal(h.manager.get(h.group.id).deliveries[0].status, 'completed');
  assert.ok(errors.length >= 2);
  assert.ok(errors.every(error => /observer failed/.test(error.message)));
  assert.equal(h.scheduler.runs.size, 0);
});

test('unavailable serial targets pause successors and restored evidence never silently replays them', async t => {
  const h = setup(t), evidence = h.adapter.evidence;
  h.adapter.evidence = () => null;
  const request = h.send('unavailable', undefined, 'serial'); await tick();
  const state = h.manager.get(h.group.id);
  assert.deepEqual(state.deliveries.map(d => d.status), ['failed', 'queued']);
  assert.equal(state.deliveries[0].unavailableReason, 'unverified-connection');
  assert.equal(state.participants[0].session.generation, 1);
  h.adapter.evidence = evidence; h.scheduler.pump(h.group.id); await tick();
  assert.equal(h.calls.length, 0);
  h.scheduler.resolveSerial(h.group.id, request.deliveryIds[0], 'retry', 'explicit-retry'); await tick();
  assert.equal(h.calls.length, 1);
  h.calls[0].completion.resolve({ text: 'Retried after verification' }); await tick();
  assert.equal(h.calls.length, 2);
  h.calls[1].completion.resolve({ text: 'Serial successor' }); await tick();
  assert.equal(h.manager.get(h.group.id).messages.filter(m => m.role === 'user').length, 1);
});
