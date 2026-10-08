'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiscussionStore, readDiscussionRecord } = require('../src/engines/discussions/store');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { DiscussionPayloads, payloadReferences, logicalBytes } = require('../src/engines/discussions/payloads');
const { LIMITS } = require('../src/engines/discussions/schema');
const { writeJson } = require('../src/shared/json-store');
const { removeTree } = require('./test-fs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const raw = h => JSON.parse(fs.readFileSync(h.store.file(h.id), 'utf8'));
const proof = d => ({ stopped: true, released: true, runtimeId: d.runtimeId, deliveryId: d.id, generation: d.generation });
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-storage-'));
  const store = new DiscussionStore({ dir, ...options }), manager = new DiscussionManager({ store });
  t.after(() => {
    for (const entry of store.drafts.entries.values()) clearTimeout(entry.timer);
    store.drafts.entries.clear(); removeTree(dir);
  });
  const group = manager.create({ cwd: dir });
  const a = manager.addMember(group.id, { name: 'A', engine: 'codex', connection: 'subscription', model: 'fixture', accountRef: 'account', contextWindow: 1000000 });
  const b = manager.addMember(group.id, { name: 'B', engine: 'codex', connection: 'subscription', model: 'fixture', accountRef: 'account', contextWindow: 1000000 });
  return { dir, store, manager, id: group.id, a, b };
}
function start(h, targets = [h.a.id], prompt = 'Frozen input') {
  const request = h.manager.enqueue(h.id, { requestId: 'turn', text: 'Question', participantIds: targets });
  return request.deliveryIds.map(id => {
    const d = h.manager.prepare(h.id, id);
    h.manager.saveInput(h.id, id, d.generation, { prompt, inputThroughSeq: d.inputThroughSeq });
    h.manager.start(h.id, id, d.generation, 'native-' + d.runtimeId); return d;
  });
}

test('large text is immutable shared payload data; small text and arbitrary tool JSON stay inline', t => {
  const h = setup(t), text = ('中文\uD800\n\\"'.repeat(3000));
  const [d] = start(h, undefined, text);
  h.manager.tool(h.id, d.id, d.generation, { id: 'tool', name: 'fixture', input: { $text: 'a'.repeat(64), bytes: 42 }, output: '', status: 'completed' });
  h.manager.recordSettlement(h.id, d.id, d.generation, { status: 'completed', text });
  h.manager.complete(h.id, d.id, d.generation, text, proof(d));
  const encoded = raw(h), decoded = h.manager.get(h.id);
  assert.equal(encoded.storageVersion, 1);
  assert.equal(encoded.messages[0].text, 'Question');
  assert.deepEqual(encoded.messages[1].text, encoded.deliveries[0].inputPlan.prompt);
  assert.equal(payloadReferences(encoded).size, 1);
  assert.equal(fs.readdirSync(path.join(h.dir, h.id + '.payloads')).length, 1);
  assert.equal(decoded.messages[1].text, text); assert.equal(decoded.deliveries[0].inputPlan.prompt, text);
  assert.deepEqual(decoded.deliveries[0].tools[0].input, { $text: 'a'.repeat(64), bytes: 42 });
  assert.equal(decoded.deliveries[0].partialText, undefined);
  assert.equal(decoded.deliveries[0].settlement.text, undefined);
  assert.equal(decoded.deliveries[0].settlement.resultId, decoded.messages[1].id);
  assert.equal(logicalBytes(encoded), Buffer.byteLength(JSON.stringify(decoded, null, 2) + '\n'));
  assert.equal(decoded.participants[0].session.nativeId, 'native-' + d.runtimeId);
  assert.deepEqual(decoded.participants[0].session.nativeOwnMessageIds, [decoded.messages[1].id]);
  assert.equal(decoded.participants[0].session.coveredThroughSeq, d.inputThroughSeq);
});

test('100 streaming updates never rewrite the group and checkpoints preserve latest text and monotonic revisions', async t => {
  let writes = 0, drafts = 0, draftBytes = 0;
  const h = setup(t, { checkpointMs: 30,
    write(file, state) { writes++; writeJson(file, state); },
    writeDraft(file, row) { drafts++; draftBytes += Buffer.byteLength(JSON.stringify(row, null, 2) + '\n'); writeJson(file, row); } });
  for (let i = 0; i < 16; i++) h.manager.enqueue(h.id, { requestId: 'note-' + i, text: 'n'.repeat(96 * 1024) + i });
  const [d] = start(h), before = fs.readFileSync(h.store.file(h.id)), count = writes;
  let revision = h.manager.get(h.id).revision;
  const streamingStarted = performance.now();
  for (let i = 1; i <= 100; i++) h.manager.partial(h.id, d.id, d.generation, 'answer '.repeat(i * 12));
  const streamingMs = performance.now() - streamingStarted;
  assert.equal(writes, count); assert.deepEqual(fs.readFileSync(h.store.file(h.id)), before);
  const latest = h.manager.get(h.id);
  assert.ok(latest.revision > revision); revision = latest.revision;
  assert.equal(latest.deliveries[0].partialText, 'answer '.repeat(1200));
  assert.equal(latest.messages.length, 17); assert.equal(latest.participants[0].session.coveredThroughSeq, 0);
  await delay(60);
  assert.equal(drafts, 2); assert.ok(draftBytes < 16 * 1024);
  const restarted = new DiscussionManager({ dir: h.dir }).get(h.id);
  assert.equal(restarted.deliveries[0].partialText, latest.deliveries[0].partialText);
  assert.equal(restarted.revision, revision);
  h.manager.activity(h.id, d.id, d.generation, 'approval');
  assert.ok(h.manager.get(h.id).revision > revision);
  if (process.env.CAMELLIA_STORAGE_BENCHMARK === '1') {
    // Same data and text updates, with the former full-snapshot write pattern.
    // This measures persistence only, without native models or their logs.
    const snapshot = structuredClone(latest), legacyFile = path.join(h.dir, 'full-write-control.snapshot');
    let fullBytes = 0;
    const fullStarted = performance.now();
    for (let i = 1; i <= 100; i++) {
      snapshot.deliveries[0].partialText = 'answer '.repeat(i * 12);
      fullBytes += Buffer.byteLength(JSON.stringify(snapshot, null, 2) + '\n');
      writeJson(legacyFile, snapshot);
    }
    t.diagnostic(JSON.stringify({ updates: 100, fullSnapshotWrites: 100, fullSnapshotMiB: +(fullBytes / 1048576).toFixed(3),
      fullWriteMs: +(performance.now() - fullStarted).toFixed(2), newSnapshotWrites: count === writes - 1 ? 0 : 'unexpected',
      newCheckpoints: drafts, newCheckpointKiB: +(draftBytes / 1024).toFixed(2), newStreamingMs: +streamingMs.toFixed(2) }));
  }
});

test('independent members keep their own drafts and native sessions, and a stale generation cannot inject text', t => {
  const h = setup(t), [a, b] = start(h, [h.a.id, h.b.id]);
  h.manager.partial(h.id, a.id, a.generation, 'A draft');
  h.manager.partial(h.id, b.id, b.generation, 'B draft');
  const state = h.manager.get(h.id);
  assert.deepEqual(state.deliveries.map(d => d.partialText), ['A draft', 'B draft']);
  assert.notEqual(state.participants[0].session.nativeId, state.participants[1].session.nativeId);
  assert.throws(() => h.manager.partial(h.id, a.id, a.generation + 1, 'wrong member'), /Stale/);
  assert.equal(h.manager.get(h.id).deliveries[0].partialText, 'A draft');
});

test('terminal commit retains the latest draft on cancellation and cancels all later checkpoint writes', async t => {
  let drafts = 0;
  const h = setup(t, { checkpointMs: 30, writeDraft(file, row) { drafts++; writeJson(file, row); } });
  const [d] = start(h);
  h.manager.partial(h.id, d.id, d.generation, 'first');
  h.manager.partial(h.id, d.id, d.generation, 'latest before stop');
  h.manager.stop(h.id, d.id);
  h.manager.fail(h.id, d.id, d.generation, 'cancelled', proof(d));
  const count = drafts; await delay(60);
  assert.equal(drafts, count);
  assert.equal(fs.existsSync(path.join(h.dir, h.id + '.drafts')), false);
  assert.equal(new DiscussionManager({ dir: h.dir }).get(h.id).deliveries[0].partialText, 'latest before stop');
  assert.throws(() => h.manager.partial(h.id, d.id, d.generation, 'late'), /not running/);
});

test('settlement is fully recoverable until commit; completion drops duplicate text and keeps frozen inputs', async t => {
  let drafts = 0;
  const h = setup(t, { checkpointMs: 30, writeDraft(file, row) { drafts++; writeJson(file, row); } });
  const frozen = 'original input '.repeat(2000), answer = 'final answer '.repeat(2500);
  const [d] = start(h, undefined, frozen);
  h.manager.partial(h.id, d.id, d.generation, 'first'); h.manager.partial(h.id, d.id, d.generation, 'last draft');
  h.manager.recordSettlement(h.id, d.id, d.generation, { status: 'completed', text: answer });
  const before = new DiscussionManager({ dir: h.dir }).get(h.id);
  assert.equal(before.deliveries[0].partialText, answer); assert.equal(before.deliveries[0].settlement.text, answer);
  const count = drafts; await delay(60); assert.equal(drafts, count);
  h.manager.complete(h.id, d.id, d.generation, answer, proof(d));
  const after = new DiscussionManager({ dir: h.dir }).get(h.id);
  assert.equal(after.messages[1].text, answer); assert.equal(after.deliveries[0].partialText, undefined);
  assert.equal(after.deliveries[0].settlement.text, undefined); assert.equal(after.deliveries[0].inputPlan.prompt, frozen);
  assert.equal(payloadReferences(raw(h)).size, 2);
  assert.deepEqual(h.manager.recordSettlement(h.id, d.id, d.generation, { status: 'completed', text: answer }), { status: 'completed', text: answer });
  assert.throws(() => h.manager.recordSettlement(h.id, d.id, d.generation, { status: 'completed', text: 'different' }), /Conflicting/);
});

test('failed manifests release uncommitted payloads; a writer reporting failure after commit retains committed payloads', t => {
  for (const afterCommit of [false, true]) {
    const h = setup(t), [d] = start(h), saved = fs.readFileSync(h.store.file(h.id)), write = h.store.write;
    h.store.write = (file, state) => { if (afterCommit) writeJson(file, state); throw new Error('disk failed'); };
    const answer = 'new text '.repeat(3000);
    assert.throws(() => h.manager.recordSettlement(h.id, d.id, d.generation, { status: 'completed', text: answer }), /disk failed/);
    h.store.write = write;
    const files = fs.readdirSync(path.join(h.dir, h.id + '.payloads'));
    if (afterCommit) {
      assert.equal(files.length, 1);
      assert.equal(new DiscussionManager({ dir: h.dir }).get(h.id).deliveries[0].settlement.text, answer);
    } else {
      assert.equal(files.length, 0); assert.deepEqual(fs.readFileSync(h.store.file(h.id)), saved);
    }
  }
});

test('corrupt or missing payloads cannot bypass validation, including through a warmed cache', t => {
  const h = setup(t), [d] = start(h, undefined, 'private '.repeat(3000));
  h.manager.get(h.id);
  const ref = raw(h).deliveries[0].inputPlan.prompt, file = path.join(h.dir, h.id + '.payloads', ref.$text + '.text');
  const bytes = fs.readFileSync(file); fs.writeFileSync(file, Buffer.alloc(bytes.length, 32));
  assert.throws(() => h.manager.get(h.id), /Invalid discussion payload storage/);
  fs.writeFileSync(file, bytes); assert.equal(h.manager.get(h.id).deliveries[0].inputPlan.prompt, 'private '.repeat(3000));
  fs.unlinkSync(file); assert.throws(() => h.manager.get(h.id), /Invalid discussion payload storage/);
  assert.equal(d.generation, 1);
});

test('expanded record limits are enforced before attempting oversized payload reads', t => {
  const h = setup(t), [d] = start(h), state = raw(h);
  state.deliveries[0].inputPlan.prompt = { $text: '0'.repeat(64), bytes: LIMITS.promptBytes };
  writeJson(h.store.file(h.id), state);
  assert.throws(() => readDiscussionRecord(h.store.file(h.id), h.id, { maxRecordBytes: 65536 }), /oversized/);
  assert.equal(d.generation, 1);
});

test('startup converts legacy snapshots and reclaims only unreferenced discussion payloads', t => {
  const h = setup(t), [d] = start(h), answer = 'legacy answer '.repeat(2000);
  h.manager.complete(h.id, d.id, d.generation, answer, proof(d));
  const legacy = h.manager.get(h.id);
  legacy.deliveries[0].partialText = answer;
  legacy.deliveries[0].settlement = { status: 'completed', text: answer };
  writeJson(h.store.file(h.id), legacy);
  const dir = path.join(h.dir, h.id + '.payloads'), orphan = path.join(dir, '0'.repeat(64) + '.text');
  fs.writeFileSync(orphan, '"orphan"'); fs.writeFileSync(path.join(dir, 'unknown-file'), 'keep');
  const restarted = new DiscussionManager({ dir: h.dir }); restarted.recover();
  const state = restarted.get(h.id);
  assert.equal(raw(h).storageVersion, 1); assert.equal(state.deliveries[0].partialText, undefined);
  assert.equal(state.messages[1].text, answer); assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.readFileSync(path.join(dir, 'unknown-file'), 'utf8'), 'keep');
  assert.equal(state.participants[0].session.nativeId, legacy.participants[0].session.nativeId);
});

test('closing flushes all latest drafts, including ones waiting for their checkpoint interval', t => {
  const h = setup(t), [a, b] = start(h, [h.a.id, h.b.id]);
  h.manager.partial(h.id, a.id, a.generation, 'first A'); h.manager.partial(h.id, b.id, b.generation, 'first B');
  h.manager.partial(h.id, a.id, a.generation, 'latest A'); h.manager.partial(h.id, b.id, b.generation, 'latest B');
  h.store.close();
  assert.equal(h.store.drafts.entries.size, 0);
  assert.deepEqual(new DiscussionManager({ dir: h.dir }).get(h.id).deliveries.map(d => d.partialText), ['latest A', 'latest B']);
});

test('background checkpoint failure is reported without losing the final durable answer', async t => {
  const errors = []; let fail = false;
  const h = setup(t, { checkpointMs: 20, onError: error => errors.push(error),
    writeDraft(file, row) { if (fail) throw new Error('draft disk failed'); writeJson(file, row); } });
  const [d] = start(h); h.manager.partial(h.id, d.id, d.generation, 'first');
  fail = true; h.manager.partial(h.id, d.id, d.generation, 'latest'); await delay(50);
  assert.equal(errors.length, 1); assert.match(errors[0].message, /draft disk failed/);
  assert.equal(h.manager.get(h.id).deliveries[0].partialText, 'latest');
  h.manager.recordSettlement(h.id, d.id, d.generation, { status: 'completed', text: 'final' });
  h.manager.complete(h.id, d.id, d.generation, 'final', proof(d));
  assert.equal(new DiscussionManager({ dir: h.dir }).get(h.id).messages[1].text, 'final');
});

test('failed optional storage conversion preserves readable legacy context and reports the failure', t => {
  const errors = [], h = setup(t, { onError: error => errors.push(error) }), [d] = start(h);
  h.manager.complete(h.id, d.id, d.generation, 'answer', proof(d));
  const legacy = h.manager.get(h.id);
  legacy.deliveries[0].partialText = 'answer'; legacy.deliveries[0].settlement = { status: 'completed', text: 'answer' };
  writeJson(h.store.file(h.id), legacy); const saved = fs.readFileSync(h.store.file(h.id));
  h.store.write = () => { throw new Error('upgrade disk failed'); };
  h.manager.recover();
  assert.deepEqual(fs.readFileSync(h.store.file(h.id)), saved);
  assert.deepEqual(h.manager.get(h.id), legacy);
  assert.ok(errors.some(error => /upgrade disk failed/.test(error.message)));
});

test('decoded payload cache evicts old text within its byte budget', t => {
  const h = setup(t);
  for (let i = 0; i < 4; i++) h.manager.enqueue(h.id, { requestId: 'note-' + i, text: 'body '.repeat(7000) + i });
  const payloads = new DiscussionPayloads(h.dir, { cacheBytes: 64 * 1024 });
  const state = readDiscussionRecord(h.store.file(h.id), h.id, { payloads });
  assert.equal(state.messages.length, 4);
  assert.ok(payloads.cache.size > 0 && payloads.cache.size <= 2);
  assert.ok(payloads.cacheBytes <= 64 * 1024);
});
