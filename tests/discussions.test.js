'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiscussionStore } = require('../src/engines/discussions/store');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { writeJson } = require('../src/shared/json-store');
const { removeTree } = require('./test-fs.cjs');

test('native ownership spans groups and retired generations of the same member', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'first', text: 'Question', participantIds: [h.a.id] });
  const first = running(h, request.deliveryIds[0]);
  const nativeId = 'native-' + first.runtimeId;
  h.manager.fail(id, first.id, first.generation, 'failed', proof(first));
  const other = h.manager.create({ cwd: h.dir });
  const otherMember = h.manager.addMember(other.id, h.input);
  const next = h.manager.enqueue(other.id, { requestId: 'other', text: 'Question', participantIds: [otherMember.id] });
  const prepared = h.manager.prepare(other.id, next.deliveryIds[0]);
  saveInput(h, prepared, other.id);
  assert.throws(() => h.manager.start(other.id, prepared.id, prepared.generation, nativeId), /another member/);
  const again = h.manager.enqueue(id, { requestId: 'again', text: 'Question', participantIds: [h.a.id] });
  const fresh = h.manager.prepare(id, again.deliveryIds[0]);
  saveInput(h, fresh);
  assert.throws(() => h.manager.start(id, fresh.id, fresh.generation, nativeId), /another member/);
});

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-discussions-'));
  t.after(() => removeTree(dir));
  const store = new DiscussionStore({ dir, ...options });
  const manager = new DiscussionManager({ store });
  const group = manager.create({ cwd: dir });
  const input = { name: 'Reviewer', engine: 'codex', connection: 'subscription', model: 'configured-model', accountRef: 'account-1', contextWindow: 32000 };
  const a = manager.addMember(group.id, input), b = manager.addMember(group.id, input);
  return { dir, store, manager, group, a, b, input };
}
function running(h, deliveryId) {
  const delivery = h.manager.prepare(h.group.id, deliveryId);
  saveInput(h, delivery);
  h.manager.start(h.group.id, deliveryId, delivery.generation, 'native-' + delivery.runtimeId);
  return delivery;
}
function saveInput(h, delivery, id = h.group.id) {
  h.manager.saveInput(id, delivery.id, delivery.generation, { prompt: 'Synthetic persisted input', inputThroughSeq: delivery.inputThroughSeq });
}
// Trusted declarations in these unit tests are synthetic, not OS stop proof.
const proof = delivery => ({ runtimeId: delivery.runtimeId, deliveryId: delivery.id,
  generation: delivery.generation, stopped: true, released: true });

test('discussion members with identical bindings retain independent identities and snapshots', t => {
  const h = setup(t);
  assert.notEqual(h.a.id, h.b.id);
  assert.notEqual(h.a.session.runtimeId, h.b.session.runtimeId);
  h.a.session.nativeOwnMessageIds.push('outside-mutation');
  const reopened = new DiscussionManager({ dir: h.dir }).get(h.group.id);
  assert.equal(reopened.participants.length, 2);
  assert.deepEqual(reopened.participants[0].session.nativeOwnMessageIds, []);
  assert.equal(reopened.participants[1].contextWindow, 32000);
  const api = h.manager.addMember(h.group.id, { ...h.input, connection: 'api', accountRef: null, apiKey: 'not-to-store' });
  assert.equal(api.connection, 'api');
  assert.ok(!fs.readFileSync(h.store.file(h.group.id), 'utf8').includes('not-to-store'));
});

test('enqueue is atomic and idempotent, including messages without mentions', t => {
  const h = setup(t), id = h.group.id;
  const input = { requestId: 'request-1', text: 'Compare', participantIds: [h.a.id, h.b.id] };
  const first = h.manager.enqueue(id, input);
  assert.deepEqual(h.manager.enqueue(id, input), first);
  assert.throws(() => h.manager.enqueue(id, { ...input, text: 'Different' }), /different input/);
  assert.throws(() => h.manager.enqueue(id, { ...input, requestId: 'bad', participantIds: [h.a.id, 'missing'] }), /Member not found/);
  assert.equal(h.manager.get(id).seq, 1);
  assert.equal(h.manager.get(id).deliveries.length, 2);
  h.manager.enqueue(id, { requestId: 'note', text: 'Remember this' });
  assert.equal(h.manager.get(id).seq, 2);
  assert.equal(h.manager.get(id).deliveries.length, 2);
});

test('parallel answers only commit their input snapshot and replaying completion cannot duplicate replies', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'parallel', text: 'Question', participantIds: [h.a.id, h.b.id] });
  const a = running(h, request.deliveryIds[0]), b = running(h, request.deliveryIds[1]);
  h.manager.enqueue(id, { requestId: 'later', text: 'Later note' });
  const reply = h.manager.complete(id, a.id, a.generation, 'A answer', proof(a));
  h.manager.complete(id, b.id, b.generation, 'B answer', proof(b));
  assert.deepEqual(h.manager.complete(id, a.id, a.generation, 'A answer'), reply);
  assert.throws(() => h.manager.complete(id, a.id, a.generation, 'Changed answer'), /Conflicting/);
  const state = new DiscussionManager({ dir: h.dir }).get(id);
  assert.equal(state.seq, 4);
  assert.deepEqual(state.participants.map(p => p.session.coveredThroughSeq), [1, 1]);
  assert.deepEqual(state.participants[0].session.nativeOwnMessageIds, [reply.id]);
  assert.equal(state.messages[3].speakerId, h.b.id);
});

test('serial input boundary is fixed after prior completion, while failure leaves later deliveries queued', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'serial', text: 'Review in order', participantIds: [h.a.id, h.b.id], mode: 'serial' });
  assert.throws(() => h.manager.prepare(id, request.deliveryIds[1]), /Previous serial/);
  const a = running(h, request.deliveryIds[0]);
  h.manager.complete(id, a.id, a.generation, 'First result', proof(a));
  const b = running(h, request.deliveryIds[1]);
  assert.equal(b.inputThroughSeq, 2);
  h.manager.fail(id, b.id, b.generation, 'failed', proof(b));
  const again = h.manager.enqueue(id, { requestId: 'serial-failure', text: 'Try', participantIds: [h.a.id, h.b.id], mode: 'serial' });
  const failed = running(h, again.deliveryIds[0]);
  h.manager.fail(id, failed.id, failed.generation, 'failed', proof(failed));
  assert.throws(() => h.manager.prepare(id, again.deliveryIds[1]), /Previous serial/);
});

test('same-member requests are ordered and old parallel snapshots rebuild future native context', t => {
  const h = setup(t), id = h.group.id;
  const one = h.manager.enqueue(id, { requestId: 'one', text: 'One', participantIds: [h.a.id] });
  const two = h.manager.enqueue(id, { requestId: 'two', text: 'Two', participantIds: [h.a.id] });
  assert.throws(() => h.manager.prepare(id, two.deliveryIds[0]), /Earlier member/);
  const first = running(h, one.deliveryIds[0]);
  assert.throws(() => h.manager.prepare(id, two.deliveryIds[0]), /busy/);
  h.manager.complete(id, first.id, first.generation, 'Arrived after second question', proof(first));
  const second = h.manager.prepare(id, two.deliveryIds[0]);
  assert.equal(second.inputThroughSeq, 2);
  assert.equal(second.generation, first.generation + 1);
  assert.notEqual(second.runtimeId, first.runtimeId);
  const session = h.manager.get(id).participants[0].session;
  assert.equal(session.coveredThroughSeq, 0);
  assert.equal(session.nativeId, null);
});

test('failed requests retire uncertain native state and reject late completions', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'fail', text: 'Question', participantIds: [h.a.id] });
  const delivery = running(h, request.deliveryIds[0]);
  h.manager.fail(id, delivery.id, delivery.generation, 'cancelled', proof(delivery));
  assert.throws(() => h.manager.complete(id, delivery.id, delivery.generation, 'Late'), /Stale/);
  const state = h.manager.get(id);
  assert.equal(state.seq, 1);
  assert.equal(state.participants[0].session.coveredThroughSeq, 0);
  assert.equal(state.participants[0].retiredSessions[0].reason, 'cancelled');
});

test('startup recovery interrupts active and queued work without replay, preserving completed records', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'recover', text: 'Question', participantIds: [h.a.id, h.b.id] });
  const a = running(h, request.deliveryIds[0]);
  h.manager.complete(id, a.id, a.generation, 'Committed', proof(a));
  running(h, request.deliveryIds[1]);
  h.manager.enqueue(id, { requestId: 'queued', text: 'Queued', participantIds: [h.a.id] });
  const reopened = new DiscussionManager({ dir: h.dir });
  reopened.recover();
  const state = reopened.get(id);
  assert.deepEqual(state.deliveries.map(d => d.status), ['completed', 'interrupted', 'interrupted']);
  assert.equal(state.participants[0].session.generation, 1);
  assert.equal(state.participants[1].session.generation, 2);
  reopened.recover();
  assert.deepEqual(reopened.get(id), state);
  assert.throws(() => reopened.prepare(id, state.deliveries[2].id), /not queued/);
});

test('failed snapshot write cannot split result, status and cursor; incomplete temporary is ignored on restart', t => {
  let fail = false;
  const h = setup(t, { write(file, value) {
    if (fail) { fs.writeFileSync(file + '.partial.tmp', '{"partial":'); throw new Error('Simulated disk failure'); }
    writeJson(file, value);
  } });
  const id = h.group.id, request = h.manager.enqueue(id, { requestId: 'atomic', text: 'Question', participantIds: [h.a.id] });
  const delivery = running(h, request.deliveryIds[0]);
  const before = h.manager.get(id);
  fail = true;
  assert.throws(() => h.manager.complete(id, delivery.id, delivery.generation, 'Answer', proof(delivery)), /disk failure/);
  const reopened = new DiscussionManager({ dir: h.dir });
  assert.deepEqual(reopened.get(id), before);
  assert.equal(reopened.list().length, 1);
  fail = false;
  h.manager.complete(id, delivery.id, delivery.generation, 'Answer', proof(delivery));
  const after = reopened.get(id);
  assert.equal(after.seq, 2);
  assert.equal(after.deliveries[0].status, 'completed');
  assert.equal(after.participants[0].session.coveredThroughSeq, 1);
});

test('member changes cannot bypass pending work and removed authors remain in history', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'member', text: 'Question', participantIds: [h.a.id, h.b.id] });
  assert.throws(() => h.manager.configureMember(id, h.a.id, { model: 'other' }), /pending/);
  const a = running(h, request.deliveryIds[0]);
  assert.throws(() => h.manager.removeMember(id, h.a.id), /Stop/);
  h.manager.complete(id, a.id, a.generation, 'Keep my attribution', proof(a));
  const updated = h.manager.configureMember(id, h.a.id, { connection: 'api', accountRef: null, model: 'other' });
  assert.equal(updated.session.generation, 2);
  h.manager.removeMember(id, h.a.id);
  h.manager.removeMember(id, h.b.id);
  assert.equal(h.manager.get(id).messages[1].speakerId, h.a.id);
  assert.equal(h.manager.get(id).deliveries[1].status, 'cancelled');
  assert.throws(() => h.manager.enqueue(id, { requestId: 'removed', text: 'No', participantIds: [h.a.id] }), /not found/);
});

test('corrupt or unsupported persisted state is not replaced with an empty discussion', t => {
  const h = setup(t), file = h.store.file(h.group.id);
  assert.throws(() => h.store.read('../escape'), /Invalid discussion ID/);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => h.manager.list(), /Invalid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, JSON.stringify({ ...h.group, version: 999 }));
  assert.throws(() => h.manager.get(h.group.id), /Invalid discussion records: state version or identity/);
});

test('native sessions cannot be shared by two members and dispatch retains the exact profile', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'native', text: 'Question', participantIds: [h.a.id, h.b.id] });
  const a = running(h, request.deliveryIds[0]);
  const b = h.manager.prepare(id, request.deliveryIds[1]);
  saveInput(h, b);
  assert.throws(() => h.manager.start(id, b.id, b.generation, 'native-' + a.runtimeId), /another member/);
  assert.deepEqual(b.profile, { engine: h.input.engine, connection: h.input.connection, model: h.input.model,
    accountRef: h.input.accountRef, thinking: '', contextWindow: h.input.contextWindow });
  const state = h.manager.get(id);
  state.participants[0].session.coveredThroughSeq = state.seq + 1;
  fs.writeFileSync(h.store.file(id), JSON.stringify(state));
  assert.throws(() => h.manager.get(id), /Invalid discussion records/);
});

test('summary, approval and stopping retain the member slot until matching stop confirmation', t => {
  const h = setup(t), id = h.group.id;
  const first = h.manager.enqueue(id, { requestId: 'active', text: 'Question', participantIds: [h.a.id] });
  const second = h.manager.enqueue(id, { requestId: 'next', text: 'Next', participantIds: [h.a.id] });
  const d = h.manager.prepare(id, first.deliveryIds[0]);
  h.manager.activity(id, d.id, d.generation, 'summary');
  assert.throws(() => h.manager.prepare(id, second.deliveryIds[0]), /busy/);
  saveInput(h, d);
  h.manager.start(id, d.id, d.generation, 'native');
  h.manager.activity(id, d.id, d.generation, 'approval');
  h.manager.partial(id, d.id, d.generation, 'Unfinished public text');
  h.manager.stop(id, d.id);
  assert.throws(() => h.manager.prepare(id, second.deliveryIds[0]), /busy/);
  assert.throws(() => h.manager.removeMember(id, h.a.id), /Stop/);
  assert.throws(() => h.manager.configureMember(id, h.a.id, { model: 'other' }), /pending/);
  assert.throws(() => h.manager.complete(id, d.id, d.generation, 'Late answer'), /not running/);
  assert.throws(() => h.manager.partial(id, d.id, d.generation, 'Late text'), /not running/);
  assert.throws(() => h.manager.activity(id, d.id, d.generation, 'answer'), /Invalid activity/);
  assert.throws(() => h.manager.fail(id, d.id, d.generation), /not confirmed/);
  assert.throws(() => h.manager.confirmStop(id, d.id, d.generation, { runtimeId: d.runtimeId, stopped: false }), /not confirmed/);
  assert.throws(() => h.manager.confirmStop(id, d.id, d.generation, { runtimeId: h.b.session.runtimeId, stopped: true }), /Stale/);
  assert.equal(new DiscussionManager({ dir: h.dir }).get(id).deliveries[0].status, 'stopping');
  h.manager.confirmStop(id, d.id, d.generation, proof(d));
  const next = h.manager.prepare(id, second.deliveryIds[0]);
  assert.equal(next.generation, d.generation + 1);
  assert.equal(h.manager.get(id).seq, 2);
  assert.equal(h.manager.get(id).deliveries[0].partialText, 'Unfinished public text');
  assert.throws(() => h.manager.confirmStop(id, d.id, d.generation, { runtimeId: d.runtimeId, stopped: true }), /Stale/);
});

test('restart interrupts summary and stopping activities without publishing partial answers', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'restart-phases', text: 'Question', participantIds: [h.a.id, h.b.id] });
  const a = running(h, request.deliveryIds[0]);
  h.manager.partial(id, a.id, a.generation, 'Partial');
  h.manager.stop(id, a.id);
  const b = h.manager.prepare(id, request.deliveryIds[1]);
  h.manager.activity(id, b.id, b.generation, 'summary');
  const reopened = new DiscussionManager({ dir: h.dir });
  reopened.recover();
  const state = reopened.get(id);
  assert.deepEqual(state.deliveries.map(d => d.status), ['interrupted', 'interrupted']);
  assert.deepEqual(state.participants.map(p => p.session.generation), [2, 2]);
  assert.equal(state.deliveries[0].partialText, 'Partial');
  assert.equal(state.messages.length, 1);
});

test('explicit serial skip preserves failed attribution and unlocks the successor', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'skip', text: 'Question', participantIds: [h.a.id, h.b.id], mode: 'serial' });
  const a = running(h, request.deliveryIds[0]);
  h.manager.fail(id, a.id, a.generation, 'failed', proof(a));
  assert.throws(() => h.manager.prepare(id, request.deliveryIds[1]), /Previous serial/);
  const resolved = h.manager.resolveSerial(id, a.id, 'skip', 'skip-action');
  assert.equal(resolved.status, 'failed');
  assert.deepEqual(h.manager.resolveSerial(id, a.id, 'skip', 'skip-action'), resolved);
  assert.throws(() => h.manager.resolveSerial(id, a.id, 'retry', 'retry-action'), /already resolved/);
  running(h, request.deliveryIds[1]);
  assert.equal(h.manager.get(id).messages.length, 1);
});

test('explicit serial retry persists a new attempt and keeps later members paused until success', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'retry', text: 'Question', participantIds: [h.a.id, h.b.id], mode: 'serial' });
  const a = running(h, request.deliveryIds[0]);
  h.manager.partial(id, a.id, a.generation, 'Old partial');
  h.manager.fail(id, a.id, a.generation, 'failed', proof(a));
  const retry = h.manager.resolveSerial(id, a.id, 'retry', 'retry-action');
  assert.deepEqual(h.manager.resolveSerial(id, a.id, 'retry', 'retry-action'), retry);
  assert.throws(() => h.manager.prepare(id, request.deliveryIds[1]), /Previous serial/);
  const attempt = running(h, retry.id);
  assert.equal(attempt.generation, a.generation + 1);
  assert.throws(() => h.manager.complete(id, a.id, a.generation, 'Old result'), /Stale/);
  h.manager.complete(id, attempt.id, attempt.generation, 'Retried result', proof(attempt));
  const b = running(h, request.deliveryIds[1]);
  assert.equal(b.inputThroughSeq, 2);
  const state = h.manager.get(id);
  assert.equal(state.requests.length, 1);
  assert.equal(state.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(state.deliveries[0].partialText, 'Old partial');
  assert.equal(state.deliveries[0].status, 'failed');
});

test('serial retry refuses changed bindings and queued cancellation never starts a generation', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'binding', text: 'Question', participantIds: [h.a.id, h.b.id], mode: 'serial' });
  const a = running(h, request.deliveryIds[0]);
  h.manager.fail(id, a.id, a.generation, 'failed', proof(a));
  h.manager.configureMember(id, h.a.id, { accountRef: 'other-account' });
  assert.throws(() => h.manager.resolveSerial(id, a.id, 'retry', 'retry-action'), /binding changed/);
  h.manager.stop(id, request.deliveryIds[1]);
  assert.equal(h.manager.get(id).participants[1].session.generation, 1);
  assert.equal(h.manager.get(id).deliveries[1].status, 'cancelled');
});

for (const changedRoute of [false, true]) test(`serial API retry ${changedRoute ? 'rejects a changed route' : 'accepts migration from an individual key to its provider'}`, t => {
  const h = setup(t), id = h.group.id;
  const reference = { providerId: 'ollama', route: 'original-route' };
  h.manager.configureMember(id, h.a.id, { connection: 'api', accountRef: JSON.stringify({ ...reference, keyId: 'old-key' }) });
  const request = h.manager.enqueue(id, { requestId: 'binding', text: 'Question', participantIds: [h.a.id, h.b.id], mode: 'serial' });
  const first = running(h, request.deliveryIds[0]);
  h.manager.fail(id, first.id, first.generation, 'failed', proof(first));
  h.manager.configureMember(id, h.a.id, { accountRef: JSON.stringify({ ...reference, route: changedRoute ? 'new-route' : reference.route }) });
  if (changedRoute) assert.throws(() => h.manager.resolveSerial(id, first.id, 'retry', 'retry-action'), /binding changed/);
  else {
    const retry = h.manager.resolveSerial(id, first.id, 'retry', 'retry-action');
    const attempt = running(h, retry.id);
    assert.equal(attempt.profile.accountRef, JSON.stringify(reference));
    h.manager.complete(id, attempt.id, attempt.generation, 'Retried result', proof(attempt));
    assert.equal(running(h, request.deliveryIds[1]).inputThroughSeq, 2);
  }
});

test('changing an author harness cannot expose its retired native session to another member', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'historical-engine', text: 'Question', participantIds: [h.a.id, h.b.id] });
  const a = running(h, request.deliveryIds[0]);
  h.manager.complete(id, a.id, a.generation, 'Answer', proof(a));
  h.manager.configureMember(id, h.a.id, { engine: 'kimi' });
  const b = h.manager.prepare(id, request.deliveryIds[1]);
  saveInput(h, b);
  assert.throws(() => h.manager.start(id, b.id, b.generation, 'native-' + a.runtimeId), /another member/);
});

test('restart retains removal and stop intent and requires proof before clearing uncertain native work', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'recover-stop', text: 'Question', participantIds: [h.a.id] });
  const active = running(h, request.deliveryIds[0]);
  h.manager.beginRemoval(id, h.a.id); h.manager.beginStopAll(id);
  const reopened = new DiscussionManager({ dir: h.dir }); reopened.recover();
  const state = reopened.get(id);
  assert.equal(state.stopPending, true); assert.equal(state.participants[0].removalPending, true);
  assert.equal(state.participants[0].retiredSessions[0].recoveryRequired, true);
  assert.throws(() => reopened.finishStopAll(id), /recovery/);
  assert.throws(() => reopened.removeMember(id, h.a.id), /recovery/);
  assert.throws(() => reopened.confirmRetiredStop(id, h.a.id, active.runtimeId, { runtimeId: active.runtimeId, stopped: true }), /not confirmed/);
  reopened.confirmRetiredStop(id, h.a.id, active.runtimeId, proof(active));
  reopened.finishStopAll(id); reopened.removeMember(id, h.a.id);
  assert.equal(reopened.get(id).messages.length, 1);
});

test('restart recovery rejects stop proof from an earlier turn of the same runtime', t => {
  const h = setup(t), id = h.group.id;
  const first = h.manager.enqueue(id, { requestId: 'before', text: 'One', participantIds: [h.a.id] });
  const old = running(h, first.deliveryIds[0]);
  h.manager.complete(id, old.id, old.generation, 'Answer', proof(old));
  const next = h.manager.enqueue(id, { requestId: 'interrupted', text: 'Two', participantIds: [h.a.id] });
  const current = running(h, next.deliveryIds[0]);
  assert.equal(current.runtimeId, old.runtimeId);
  const reopened = new DiscussionManager({ dir: h.dir }); reopened.recover();
  assert.throws(() => reopened.confirmRetiredStop(id, h.a.id, current.runtimeId, proof(old)), /not confirmed/);
  assert.equal(reopened.get(id).participants[0].retiredSessions[0].recoveryRequired, true);
  reopened.confirmRetiredStop(id, h.a.id, current.runtimeId, proof(current));
  assert.equal(reopened.get(id).participants[0].retiredSessions[0].recoveryRequired, false);
});

test('restart identifies an interrupted serial retry even when its record precedes a later completed request', t => {
  const h = setup(t), id = h.group.id;
  const serial = h.manager.enqueue(id, { requestId: 'serial', text: 'First', participantIds: [h.a.id, h.b.id], mode: 'serial' });
  const failed = running(h, serial.deliveryIds[0]);
  h.manager.fail(id, failed.id, failed.generation, 'failed', proof(failed));
  const next = h.manager.enqueue(id, { requestId: 'later', text: 'Second', participantIds: [h.a.id] });
  const completed = running(h, next.deliveryIds[0]);
  h.manager.complete(id, completed.id, completed.generation, 'Completed later request', proof(completed));
  const retry = h.manager.resolveSerial(id, failed.id, 'retry', 'explicit-retry');
  const interrupted = running(h, retry.id);
  assert.equal(interrupted.runtimeId, completed.runtimeId);
  const state = h.manager.get(id);
  assert.ok(state.deliveries.findIndex(d => d.id === interrupted.id) < state.deliveries.findIndex(d => d.id === completed.id));
  const reopened = new DiscussionManager({ dir: h.dir }); reopened.recover();
  assert.throws(() => reopened.confirmRetiredStop(id, h.a.id, interrupted.runtimeId, proof(completed)), /not confirmed/);
  reopened.confirmRetiredStop(id, h.a.id, interrupted.runtimeId, proof(interrupted));
  assert.equal(reopened.get(id).participants[0].retiredSessions.at(-1).recoveryRequired, false);
});

test('restart never starts a replacement for an unresolved retired native activity', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'crash', text: 'Question', participantIds: [h.a.id] });
  running(h, request.deliveryIds[0]); h.manager.recover();
  assert.throws(() => h.manager.enqueue(id, { requestId: 'new', text: 'Again', participantIds: [h.a.id] }), /recovery/);
  assert.throws(() => h.manager.configureMember(id, h.a.id, { model: 'other' }), /recovery/);
  const note = h.manager.enqueue(id, { requestId: 'note-after-crash', text: 'Keep note' });
  assert.deepEqual(note.deliveryIds, []);
});

test('dispatch requires the saved input and every active failure needs stop and release proof', t => {
  for (const phase of ['preparing', 'running', 'stopping']) {
    const h = setup(t), id = h.group.id;
    const first = h.manager.enqueue(id, { requestId: phase, text: 'Question', participantIds: [h.a.id] });
    const next = h.manager.enqueue(id, { requestId: 'next', text: 'Next', participantIds: [h.a.id] });
    const d = h.manager.prepare(id, first.deliveryIds[0]);
    assert.throws(() => h.manager.start(id, d.id, d.generation, 'native'), /Input plan must be saved/);
    assert.equal(h.manager.get(id).participants[0].session.nativeId, null);
    if (phase !== 'preparing') {
      saveInput(h, d); h.manager.start(id, d.id, d.generation, 'native');
    }
    if (phase === 'stopping') h.manager.stop(id, d.id);
    const before = h.manager.get(id);
    for (const invalid of [null, { ...proof(d), released: false }, { ...proof(d), stopped: false },
      { ...proof(d), runtimeId: h.b.session.runtimeId }, { ...proof(d), deliveryId: next.deliveryIds[0] }, { ...proof(d), generation: d.generation + 1 }]) {
      assert.throws(() => h.manager.fail(id, d.id, d.generation, 'failed', invalid), /not confirmed/);
      if (phase === 'running') assert.throws(() => h.manager.complete(id, d.id, d.generation, 'Answer', invalid), /not confirmed/);
      assert.deepEqual(h.manager.get(id), before);
      assert.throws(() => h.manager.prepare(id, next.deliveryIds[0]), /busy/);
    }
    h.manager.fail(id, d.id, d.generation, 'failed', proof(d));
    h.manager.prepare(id, next.deliveryIds[0]);
  }
});

test('a staged successful result survives stopping and restart without automatic publication', t => {
  const h = setup(t), id = h.group.id;
  const request = h.manager.enqueue(id, { requestId: 'settlement', text: 'Question', participantIds: [h.a.id] });
  const d = running(h, request.deliveryIds[0]);
  h.manager.recordSettlement(id, d.id, d.generation, { status: 'completed', text: 'Awaiting stop proof' });
  h.manager.stop(id, d.id);
  assert.throws(() => h.manager.recordSettlement(id, d.id, d.generation, { status: 'cancelled' }), /Conflicting settlement/);
  assert.throws(() => h.manager.fail(id, d.id, d.generation, 'cancelled', proof(d)), /Conflicting settlement/);
  assert.throws(() => h.manager.complete(id, d.id, d.generation, 'Changed', proof(d)), /Conflicting settlement/);
  const reopened = new DiscussionManager({ dir: h.dir }); reopened.recover();
  const state = reopened.get(id);
  assert.equal(state.deliveries[0].status, 'interrupted');
  assert.deepEqual(state.deliveries[0].settlement, { status: 'completed', text: 'Awaiting stop proof' });
  assert.equal(state.participants[0].retiredSessions[0].recoveryRequired, true);
  assert.equal(state.messages.length, 1);
  assert.equal(state.participants[0].session.coveredThroughSeq, 0);
});
