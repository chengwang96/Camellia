'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DiscussionStore, readDiscussionRecords, validateDiscussion } = require('../src/engines/discussions/store');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { LIMITS } = require('../src/engines/discussions/schema');
const { writeJson } = require('../src/shared/json-store');
const { removeTree } = require('./test-fs.cjs');

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-store-'));
  t.after(() => removeTree(dir));
  const store = new DiscussionStore({ dir, ...options }), manager = new DiscussionManager({ store });
  const group = manager.create({ cwd: dir });
  const a = manager.addMember(group.id, { name: 'A', engine: 'codex', connection: 'subscription', model: 'fixture', accountRef: 'account', contextWindow: 32000 });
  const b = manager.addMember(group.id, { name: 'B', engine: 'antigravity', connection: 'api', model: 'fixture' });
  return { dir, store, manager, id: group.id, group, a, b };
}
const proof = d => ({ stopped: true, released: true, runtimeId: d.runtimeId, deliveryId: d.id, generation: d.generation });
function start(h, deliveryId, prompt = 'Fixed snapshot') {
  const d = h.manager.prepare(h.id, deliveryId);
  h.manager.saveInput(h.id, d.id, d.generation, { prompt, inputThroughSeq: d.inputThroughSeq });
  h.manager.start(h.id, d.id, d.generation, 'native-' + d.runtimeId);
  return d;
}
function populated(h) {
  const r = h.manager.enqueue(h.id, { requestId: 'request', text: 'Question', participantIds: [h.a.id, h.b.id] });
  const a = start(h, r.deliveryIds[0]);
  h.manager.recordSettlement(h.id, a.id, a.generation, { status: 'completed', text: 'Answer' });
  h.manager.complete(h.id, a.id, a.generation, 'Answer', proof(a));
  h.manager.configureMember(h.id, h.a.id, { model: 'next' });
  start(h, r.deliveryIds[1]);
  return h.store.read(h.id);
}
const bytes = state => Buffer.byteLength(JSON.stringify(state, null, 2) + '\n', 'utf8');
const largestReply = 'a'.repeat(LIMITS.messageBytes - 2);

const corruptions = [
  ['unknown version', s => { s.version++; }],
  ['unknown credential field', s => { s.participants[0].apiKey = 'must-not-persist'; }],
  ['foreign thread', s => { s.messages[0].threadId = randomUUID(); }],
  ['relative working directory', s => { s.cwd = 'relative'; }],
  ['non-object message', s => { s.messages[0] = null; }],
  ['duplicate public ID', s => { s.messages[1].id = s.messages[0].id; }],
  ['unknown author', s => { s.messages[1].speakerId = randomUUID(); }],
  ['other member attribution', s => { s.messages[1].speakerId = s.participants[1].id; }],
  ['mismatched public answer', s => { s.messages[1].text = 'Not the settled answer'; }],
  ['user delivery fields', s => { s.messages[0].deliveryId = s.deliveries[0].id; }],
  ['missing request', s => { s.requests = []; }],
  ['request points to an answer', s => { s.requests[0].messageId = s.messages[1].id; }],
  ['changed request identity', s => { s.requests[0].fingerprint = '{}'; }],
  ['duplicate delivery reference', s => { s.requests[0].deliveryIds.push(s.requests[0].deliveryIds[0]); }],
  ['unassigned delivery', s => { s.requests[0].deliveryIds.pop(); }],
  ['unknown binding', s => { s.participants[1].engine = 'unknown'; }],
  ['non-string model', s => { s.participants[1].model = {}; }],
  ['invalid context window', s => { s.participants[1].contextWindow = -1; }],
  ['invalid removed flag', s => { s.participants[1].removed = 'false'; }],
  ['activity after removal', s => { s.participants[1].removed = true; }],
  ['skipped generation', s => { s.participants[0].session.generation++; }],
  ['duplicate runtime ownership', s => { s.participants[1].session.runtimeId = s.participants[0].session.runtimeId; }],
  ['invalid native identity', s => { s.participants[1].session.nativeId = 42; }],
  ['unattributed native coverage', s => { s.participants[0].session.coveredThroughSeq = 1; }],
  ['lost retired own reply', s => { s.participants[0].retiredSessions[0].nativeOwnMessageIds = []; }],
  ['invented recovery proof', s => { s.participants[0].retiredSessions[0].resourcesReleased = true; }],
  ['changed delivery binding', s => { s.deliveries[1].profile.model = 'changed'; }],
  ['delivery runtime mismatch', s => { s.deliveries[1].runtimeId = randomUUID(); }],
  ['delivery generation mismatch', s => { s.deliveries[1].generation = null; }],
  ['delivery config mismatch', s => { s.deliveries[1].configVersion++; }],
  ['native session mismatch', s => { s.deliveries[1].nativeId = 'somebody-else'; }],
  ['future parallel input', s => { s.deliveries[1].inputThroughSeq++; s.deliveries[1].inputPlan.inputThroughSeq++; }],
  ['missing fixed input', s => { delete s.deliveries[1].inputPlan; }],
  ['invalid input attachments', s => { s.deliveries[1].inputPlan.attachments = [{}]; }],
  ['invented result', s => { s.deliveries[1].resultId = s.messages[1].id; }],
  ['conflicting settlement', s => { s.deliveries[0].settlement.status = 'failed'; }],
  ['changed settled partial', s => { s.deliveries[0].partialText = 'Other'; }],
  ['phase after completion', s => { s.deliveries[0].phase = 'answer'; }],
  ['invalid running phase', s => { s.deliveries[1].phase = 'summary'; }],
  ['retry without a serial predecessor', s => { s.deliveries[1].retryOf = s.deliveries[0].id; }],
  ['unresolved retry pointer', s => { s.deliveries[0].retryDeliveryId = s.deliveries[1].id; }],
];
test('complete schema rejects damaged attribution, snapshots, requests and ownership on every read path', t => {
  const h = setup(t), original = populated(h), file = h.store.file(h.id);
  for (const [label, mutate] of corruptions) {
    const damaged = structuredClone(original); mutate(damaged); writeJson(file, damaged);
    assert.throws(() => h.store.read(h.id), /Invalid/, label + ': single read');
    assert.throws(() => h.store.list(), /Invalid/, label + ': inventory');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), damaged, 'Never repair implicitly: ' + label);
  }
  writeJson(file, original); assert.deepEqual(h.store.read(h.id), original);
});

test('invalid updates, asynchronous callbacks and uncloneable results never commit', async t => {
  let writes = 0;
  const h = setup(t, { write(file, state) { writes++; writeJson(file, state); } });
  const before = fs.readFileSync(h.store.file(h.id), 'utf8'), count = writes;
  assert.throws(() => h.store.update(h.id, state => { state.credentials = { secret: 'never write' }; }), /record fields/);
  assert.throws(() => h.store.update(h.id, state => { state.title = 'changed'; return () => {}; }), /clone/);
  assert.throws(() => h.store.update(h.id, async state => { await Promise.resolve(); state.title = 'late'; throw new Error('contained'); }), /synchronous/);
  assert.throws(() => h.store.update(h.id, state => { Object.defineProperty(state, 'title', { get() { throw new Error('getter must not run'); }, enumerable: true }); }), /record fields/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, count); assert.equal(fs.readFileSync(h.store.file(h.id), 'utf8'), before);
});

test('public history and request identity cannot be rewritten even into another schema-valid snapshot', t => {
  const h = setup(t);
  h.manager.enqueue(h.id, { requestId: 'note', text: 'Original' });
  const before = h.store.read(h.id);
  for (const mutate of [
    s => { s.messages[0].text = 'Rewritten'; s.requests[0].fingerprint = JSON.stringify({ text: 'Rewritten', participantIds: [], mode: 'parallel' }); },
    s => { s.messages = []; s.requests = []; s.seq = 0; },
    s => { s.cwd = path.join(h.dir, 'elsewhere'); },
    s => { s.revision += 20; },
  ]) {
    assert.throws(() => h.store.update(h.id, mutate), /immutable/); assert.deepEqual(h.store.read(h.id), before);
  }
});

test('idempotent request retrieval consumes neither disk writes nor new admission capacity', t => {
  const h = setup(t), input = { requestId: 'once', text: 'Accepted', participantIds: [h.a.id] };
  const request = h.manager.enqueue(h.id, input), before = h.store.read(h.id);
  h.manager.store = new DiscussionStore({ dir: h.dir, maxRecordBytes: bytes(before), write() { assert.fail('Replay must not write'); } });
  assert.deepEqual(h.manager.enqueue(h.id, input), request); assert.deepEqual(h.manager.get(h.id), before);
});

test('persisted input cannot reuse a native generation containing a future public answer', t => {
  const h = setup(t);
  const one = h.manager.enqueue(h.id, { requestId: 'one', text: 'One', participantIds: [h.a.id] });
  const two = h.manager.enqueue(h.id, { requestId: 'two', text: 'Two', participantIds: [h.a.id] });
  const first = start(h, one.deliveryIds[0]); h.manager.complete(h.id, first.id, first.generation, 'Later answer', proof(first));
  const second = h.manager.prepare(h.id, two.deliveryIds[0]); assert.equal(second.generation, 2);
  const damaged = h.store.read(h.id), p = damaged.participants[0], d = damaged.deliveries[1];
  const { profile, reason, recoveryRequired, ...previous } = p.retiredSessions[0];
  p.session = previous; p.retiredSessions = []; d.generation = previous.generation; d.runtimeId = previous.runtimeId;
  writeJson(h.store.file(h.id), damaged);
  assert.throws(() => h.store.read(h.id), /native future context/);
});

test('reads and writes share the exact pretty UTF-8 byte bound and preserve the old snapshot on overflow', t => {
  const h = setup(t), expected = h.store.read(h.id); expected.title = '中\\\n'.repeat(120); expected.revision++;
  const limit = bytes(expected), store = new DiscussionStore({ dir: h.dir, maxRecordBytes: limit });
  store.update(h.id, state => { state.title = expected.title; });
  assert.equal(fs.statSync(store.file(h.id)).size, limit); assert.deepEqual(store.read(h.id), expected); assert.deepEqual(store.list(), [expected]);
  assert.throws(() => store.update(h.id, state => { state.title += '中'; }), /byte limit/);
  assert.deepEqual(store.read(h.id), expected);
  const smaller = new DiscussionStore({ dir: h.dir, maxRecordBytes: limit - 1 });
  assert.throws(() => smaller.read(h.id), /oversized/); assert.throws(() => smaller.list(), /oversized/);
  let writes = 0;
  const tiny = new DiscussionStore({ dir: path.join(h.dir, 'tiny'), maxRecordBytes: 64, write() { writes++; } });
  assert.throws(() => tiny.create(h.group), /byte limit/); assert.equal(writes, 0);
  assert.throws(() => new DiscussionStore({ dir: h.dir, maxRecordBytes: LIMITS.recordBytes + 1 }), /byte limit/);
});

test('the hard cap bounds source reads before parsing without changing the oversized file', t => {
  const h = setup(t), file = h.store.file(h.id);
  fs.appendFileSync(file, ' '.repeat(LIMITS.recordBytes)); const size = fs.statSync(file).size;
  assert.throws(() => h.store.read(h.id), /oversized/); assert.throws(() => h.store.list(), /oversized/);
  assert.equal(fs.statSync(file).size, size);
});

test('JSON errors and malformed UTF-8 cannot leak record contents', t => {
  const h = setup(t), file = h.store.file(h.id);
  for (const content of [Buffer.from('{"secret":"private-token",broken'), Buffer.from([0x22, 0xc0, 0xaf, 0x22])]) {
    fs.writeFileSync(file, content);
    assert.throws(() => h.store.read(h.id), error => /Invalid JSON or UTF-8/.test(error.message) && !String(error).includes('private-token'));
  }
});

test('file growth during an open read is rejected instead of reading unbounded bytes', t => {
  const h = setup(t), file = h.store.file(h.id), read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', function(...args) {
    if (!changed) { changed = true; fs.appendFileSync(file, ' '); }
    return read.apply(fs, args);
  });
  assert.throws(() => h.store.read(h.id), /changed while reading/); assert.equal(changed, true);
});

test('replacement between lstat and open cannot publish another file as the recorded snapshot', t => {
  const h = setup(t), file = h.store.file(h.id), open = fs.openSync;
  const replacement = path.join(h.dir, 'replacement.tmp'); fs.copyFileSync(file, replacement);
  let changed = false;
  t.mock.method(fs, 'openSync', function(...args) {
    if (args[0] === file && !changed) { changed = true; fs.renameSync(replacement, file); }
    return open.apply(fs, args);
  });
  assert.throws(() => h.store.read(h.id), /changed while opening/); assert.equal(changed, true);
});

test('new discussion files appearing mid-scan invalidate the entire ownership inventory', t => {
  const h = setup(t), read = fs.readSync, lstat = fs.lstatSync;
  const directoryStat = lstat(h.dir);
  // Windows may not update directory timestamps before a second stat. The
  // inventory must still notice a new record without relying on that signal.
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    return file === h.dir ? directoryStat : lstat.call(fs, file, ...args);
  });
  let created = false;
  t.mock.method(fs, 'readSync', function(...args) {
    if (!created) {
      created = true; const id = randomUUID();
      writeJson(path.join(h.dir, id + '.json'), { ...h.group, id, threadId: randomUUID() });
    }
    return read.apply(fs, args);
  });
  assert.throws(() => h.store.list(), /inventory changed/); assert.equal(created, true);
});

test('hard-linked records and linked storage roots are not accepted as discussion storage', t => {
  const h = setup(t), file = h.store.file(h.id), alias = path.join(h.dir, 'alias.tmp');
  fs.linkSync(file, alias);
  assert.throws(() => h.store.read(h.id), /record file/); assert.throws(() => h.store.list(), /record file/);
  fs.unlinkSync(alias);
  const link = path.join(h.dir, 'linked'); fs.symlinkSync(h.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readDiscussionRecords(link), /directory/);
  fs.unlinkSync(link);
});

test('history and queue bounds reject admission atomically without discarding accepted work', t => {
  const h = setup(t);
  for (let i = 0; i < LIMITS.pending; i++) h.manager.enqueue(h.id, { requestId: String(i), text: 'Queued', participantIds: [h.a.id] });
  const before = h.store.read(h.id);
  assert.throws(() => h.manager.enqueue(h.id, { requestId: 'extra', text: 'Rejected', participantIds: [h.a.id] }), /pending delivery count/);
  assert.deepEqual(h.store.read(h.id), before);
  h.manager.beginStopAll(h.id); h.manager.finishStopAll(h.id);
  assert.ok(h.store.read(h.id).deliveries.every(d => d.status === 'cancelled'));
  const state = h.store.read(h.id);
  for (let i = state.messages.length; i < LIMITS.requests; i++) {
    const requestId = 'note-' + i, messageId = randomUUID();
    state.messages.push({ id: messageId, seq: ++state.seq, threadId: state.threadId, role: 'user', speakerId: null, requestId, text: 'Note' });
    state.requests.push({ id: requestId, fingerprint: JSON.stringify({ text: 'Note', participantIds: [], mode: 'parallel' }), messageId, mode: 'parallel', deliveryIds: [] });
  }
  writeJson(h.store.file(h.id), validateDiscussion(state, h.id));
  assert.throws(() => h.manager.enqueue(h.id, { requestId: 'history-full', text: 'Rejected' }), /record count/);
  assert.equal(h.store.read(h.id).requests.length, LIMITS.requests);
});

test('text limits count escaped UTF-8 and reject input and answer without partial commits', t => {
  const h = setup(t);
  h.manager.enqueue(h.id, { requestId: 'boundary', text: largestReply });
  for (const text of [largestReply + 'x', '中'.repeat(Math.ceil(LIMITS.messageBytes / 3)), '\0'.repeat(Math.ceil(LIMITS.messageBytes / 6))]) {
    assert.throws(() => h.manager.enqueue(h.id, { requestId: 'too-large', text }), /text size/);
  }
  const r = h.manager.enqueue(h.id, { requestId: 'turn', text: 'Question', participantIds: [h.a.id] });
  const d = h.manager.prepare(h.id, r.deliveryIds[0]);
  assert.throws(() => h.manager.saveInput(h.id, d.id, d.generation, { prompt: 'x'.repeat(LIMITS.promptBytes), inputThroughSeq: d.inputThroughSeq }), /text size/);
  assert.equal(h.store.read(h.id).deliveries[0].inputPlan, undefined);
  h.manager.saveInput(h.id, d.id, d.generation, { prompt: 'Valid', inputThroughSeq: d.inputThroughSeq });
  h.manager.start(h.id, d.id, d.generation, 'native-' + d.runtimeId);
  assert.throws(() => h.manager.partial(h.id, d.id, d.generation, largestReply + 'x'), /text size/);
  assert.throws(() => h.manager.recordSettlement(h.id, d.id, d.generation, { status: 'completed', text: largestReply + 'x' }), /text size/);
  h.manager.fail(h.id, d.id, d.generation, 'failed', proof(d));
  assert.equal(h.store.read(h.id).messages.length, 2);
});

test('capacity reserved at admission lets an active maximum-size answer settle after new notes fill the available space', t => {
  const h = setup(t, { maxRecordBytes: 3 * 1024 * 1024 });
  const r = h.manager.enqueue(h.id, { requestId: 'turn', text: 'Question', participantIds: [h.a.id] });
  const d = h.manager.prepare(h.id, r.deliveryIds[0]);
  let admitted = 0;
  for (; admitted < 10; admitted++) {
    try { h.manager.enqueue(h.id, { requestId: 'note-' + admitted, text: largestReply }); }
    catch (error) { assert.match(error.message, /reserved capacity/); break; }
  }
  assert.ok(admitted > 0 && admitted < 10);
  h.manager.saveInput(h.id, d.id, d.generation, { prompt: 'p'.repeat(LIMITS.promptBytes - 2), inputThroughSeq: d.inputThroughSeq });
  h.manager.start(h.id, d.id, d.generation, 'native-' + d.runtimeId);
  h.manager.partial(h.id, d.id, d.generation, largestReply);
  h.manager.recordSettlement(h.id, d.id, d.generation, { status: 'completed', text: largestReply });
  h.manager.beginStopAll(h.id);
  h.manager.complete(h.id, d.id, d.generation, largestReply, proof(d));
  h.manager.finishStopAll(h.id);
  const saved = h.store.read(h.id);
  assert.equal(saved.deliveries[0].status, 'completed'); assert.equal(saved.messages.at(-1).text, largestReply);
  assert.deepEqual(h.store.list(), [saved]);
});

test('queued rejection and active restart recovery can consume reserved capacity', t => {
  const h = setup(t, { maxRecordBytes: 2.5 * 1024 * 1024 });
  const r = h.manager.enqueue(h.id, { requestId: 'turn', text: 'Question', participantIds: [h.a.id, h.b.id] });
  start(h, r.deliveryIds[0]);
  let count = 0;
  for (; count < 100; count++) {
    try { h.manager.enqueue(h.id, { requestId: 'note-' + count, text: 'n'.repeat(4096) }); }
    catch (error) { assert.match(error.message, /reserved capacity/); break; }
  }
  assert.ok(count > 0 && count < 100);
  h.manager.rejectQueued(h.id, r.deliveryIds[1], 'r'.repeat(4094));
  new DiscussionManager({ store: h.store }).recover();
  const state = h.store.read(h.id);
  assert.equal(state.deliveries[0].status, 'interrupted'); assert.equal(state.deliveries[1].status, 'failed');
  assert.equal(state.participants[0].retiredSessions[0].recoveryRequired, true);
});

test('the last retirement slot remains available for stopping and cannot admit another native turn', t => {
  const h = setup(t), state = h.store.read(h.id), p = state.participants[0];
  const { engine, connection, model, accountRef, thinking, contextWindow } = p;
  for (let i = 0; i < LIMITS.retiredSessions - 1; i++) p.retiredSessions.push({
    ...structuredClone(p.session), runtimeId: randomUUID(), generation: i + 1,
    profile: { engine, connection, model: model + '-' + i, accountRef, thinking, contextWindow }, reason: 'configuration', recoveryRequired: false,
  });
  p.session.generation = LIMITS.retiredSessions; p.configVersion = LIMITS.retiredSessions;
  writeJson(h.store.file(h.id), validateDiscussion(state, h.id));
  const r = h.manager.enqueue(h.id, { requestId: 'last-slot', text: 'Question', participantIds: [h.a.id] });
  const d = start(h, r.deliveryIds[0]); h.manager.stop(h.id, d.id); h.manager.fail(h.id, d.id, d.generation, 'cancelled', proof(d));
  assert.equal(h.store.read(h.id).participants[0].retiredSessions.length, LIMITS.retiredSessions);
  const next = h.manager.enqueue(h.id, { requestId: 'no-slot', text: 'Question', participantIds: [h.a.id] });
  assert.throws(() => h.manager.prepare(h.id, next.deliveryIds[0]), /reserved session count/);
  h.manager.rejectQueued(h.id, next.deliveryIds[0], 'discussion-capacity-exceeded');
  assert.equal(h.store.read(h.id).deliveries[1].status, 'failed');
});

test('too many groups or directory entries cannot be written or silently omitted from ownership inventory', t => {
  const h = setup(t), empty = h.group;
  for (let i = 1; i < LIMITS.records; i++) {
    const id = randomUUID(); writeJson(path.join(h.dir, id + '.json'), { ...empty, id, threadId: randomUUID() });
  }
  assert.equal(h.store.list().length, LIMITS.records);
  assert.throws(() => h.manager.create({ cwd: h.dir }), /record limit/);
  const extraId = randomUUID(), extra = path.join(h.dir, extraId + '.json'); writeJson(extra, { ...empty, id: extraId });
  assert.throws(() => h.store.list(), /Too many discussion records/); fs.unlinkSync(extra);
  for (let i = LIMITS.records; i <= LIMITS.directoryEntries; i++) fs.writeFileSync(path.join(h.dir, 'orphan-' + i + '.tmp'), '');
  assert.throws(() => h.store.list(), /directory entries/);
});
