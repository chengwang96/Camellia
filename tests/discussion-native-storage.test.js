'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { nativeStorage, storageKey, projectAntigravityStorage } = require('../src/engines/discussions/native-storage');
const { NativeSessionOwnership, collectNativeOwners } = require('../src/engines/discussions/native-ownership');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { SessionPool } = require('../src/engines/session-pool');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { installDiscussionGuards } = require('../src/engines/discussions/native-access');
const { createDiscussionBoundary } = require('../src/engines/discussions/native-boundary');
const { removeTree } = require('./test-fs.cjs');

const identity = () => ({ engine: 'antigravity', discussionId: randomUUID(), participantId: randomUUID(), runtimeId: randomUUID(), generation: 1, nativeId: null });
const owner = (input, nativeId = input.nativeId) => ({ engine: input.engine, runtimeId: input.runtimeId, nativeId,
  ownerId: `discussion/${input.discussionId}/${input.participantId}/${input.generation}` });
const storage = (dir, connection = 'api') => ({ connection, storageDir: path.join(dir, 'native'), conversationId: connection === 'api' ? randomUUID().replaceAll('-', '') : randomUUID() });
// Positive fixtures explicitly attest a synthetic database read, not just a
// bridge metadata record. Production receives this fact from the raw reader.
const bridge = (nativeId, value) => ({ nativeId, ...value, databaseVerified: value.conversationId !== null });
function sources() {
  const state = { owners: [], topology: { bridges: [], histories: [] } };
  const ownership = new NativeSessionOwnership({ readOwners: () => projectAntigravityStorage(state.owners, state.topology) });
  return { state, ownership };
}
function disk(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-storage-test-'));
  t.after(() => removeTree(root));
  const manager = new DiscussionManager({ dir: path.join(root, 'discussions') }), group = manager.create({ cwd: root });
  const profile = { engine: 'antigravity', connection: 'api', model: 'fixture', name: 'Reviewer' };
  const member = manager.addMember(group.id, profile);
  const start = (who = member, groupId = group.id, nativeId = randomUUID(), value = storage(root)) => {
    const request = manager.enqueue(groupId, { requestId: randomUUID(), text: 'Input', participantIds: [who.id] });
    const delivery = manager.prepare(groupId, request.deliveryIds[0]);
    manager.saveInput(groupId, delivery.id, delivery.generation, { prompt: 'Input', inputThroughSeq: delivery.inputThroughSeq });
    manager.start(groupId, delivery.id, delivery.generation, nativeId, value);
    return { ...delivery, nativeId, nativeStorage: value };
  };
  const proof = delivery => ({ runtimeId: delivery.runtimeId, deliveryId: delivery.id, generation: delivery.generation, stopped: true, released: true });
  return { root, manager, group, member, profile, start, proof };
}

test('SDK storage scopes remain independent even when the native conversation ID is copied', () => {
  const h = sources(), a = identity(), b = identity(), sa = storage(process.cwd()), sb = { ...sa, storageDir: path.join(process.cwd(), 'other-native') };
  a.nativeId = randomUUID(); b.nativeId = randomUUID(); h.state.owners = [owner(a), owner(b)];
  h.state.topology.bridges = [bridge(a.nativeId, sa), bridge(b.nativeId, sb)];
  const first = h.ownership.reserve(a), second = h.ownership.reserve(b);
  assert.deepEqual(h.ownership.claimNative(first, a.nativeId), sa);
  assert.deepEqual(h.ownership.claimNative(second, b.nativeId), sb);
  h.ownership.release(first); h.ownership.release(second);
});

test('two CLI bridge IDs cannot give different logical owners the same native history', () => {
  const h = sources(), a = identity(), sa = storage(process.cwd(), 'subscription'); a.nativeId = 'agy-' + randomUUID();
  h.state.owners = [owner(a), { engine: 'antigravity', nativeId: 'agy-' + randomUUID(), ownerId: 'conversation/ordinary' }];
  h.state.topology.bridges = h.state.owners.map(row => bridge(row.nativeId, sa));
  assert.throws(() => h.ownership.reserve(a), /storage belongs to another/);
});

test('an unmanaged bridge alias cannot disappear merely because another alias is attributed', () => {
  const h = sources(), a = identity(), sa = storage(process.cwd(), 'subscription'); a.nativeId = 'agy-' + randomUUID();
  h.state.owners = [owner(a)]; h.state.topology.bridges = [bridge(a.nativeId, sa), bridge('agy-' + randomUUID(), sa)];
  h.state.topology.histories = [sa];
  assert.throws(() => h.ownership.reserve(a), /storage belongs to another/);
});

test('a new bridge cannot launder preexisting orphan native storage into a new member', () => {
  const h = sources(), a = identity(), sa = storage(process.cwd()), id = randomUUID(); h.state.owners = [owner(a)];
  h.state.topology.histories = [sa]; const lease = h.ownership.reserve(a);
  h.state.owners[0].nativeId = id; h.state.topology.bridges = [bridge(id, sa)];
  assert.throws(() => h.ownership.claimNative(lease, id), /storage belongs to another/);
  h.ownership.release(lease);
});

test('foreign storage observed during preparation remains reserved after a later remapping', () => {
  const h = sources(), a = identity(), sa = storage(process.cwd()), id = randomUUID(); h.state.owners = [owner(a)];
  const lease = h.ownership.reserve(a); h.state.topology.histories = [sa]; h.ownership.assert(lease);
  h.state.owners[0].nativeId = id; h.state.topology.bridges = [bridge(id, sa)];
  assert.throws(() => h.ownership.claimNative(lease, id), /storage belongs to another/); h.ownership.release(lease);
});

test('storage tombstones survive release and block a different bridge even when original indexes disappear', () => {
  const h = sources(), a = identity(), sa = storage(process.cwd()), id = randomUUID();
  h.state.owners = [owner(a)]; const lease = h.ownership.reserve(a);
  h.state.owners[0].nativeId = id; h.state.topology.bridges = [bridge(id, sa)];
  h.ownership.claimNative(lease, id); h.ownership.release(lease);
  const claims = h.ownership.listClaims(); claims[0].nativeStorage.storageDir = path.join(process.cwd(), 'mutated');
  assert.deepEqual(h.ownership.listClaims()[0].nativeStorage, sa);
  const b = identity(); b.nativeId = randomUUID(); h.state.owners = [owner(b)]; h.state.topology.bridges = [bridge(b.nativeId, sa)];
  assert.throws(() => h.ownership.reserve(b), /storage belongs to another/);
});

test('missing, pending or unverified mappings cannot authorize Antigravity input', () => {
  const h = sources(), a = identity(), sa = storage(process.cwd()), id = randomUUID(); h.state.owners = [owner(a)];
  const lease = h.ownership.reserve(a); h.state.owners[0].nativeId = id;
  assert.throws(() => h.ownership.claimNative(lease, id), /Verified native storage/);
  h.state.topology.bridges = [bridge(id, { ...sa, conversationId: null })];
  assert.throws(() => h.ownership.claimNative(lease, id), /Verified native storage/);
  h.state.owners[0].nativeStorage = sa;
  assert.throws(() => h.ownership.claimNative(lease, id), /Verified native storage/);
  h.ownership.release(lease);
});

test('a native mapping must remain current and immutable across claim and dispatch', () => {
  const h = sources(), a = identity(), sa = storage(process.cwd()), id = randomUUID(); h.state.owners = [owner(a)];
  const lease = h.ownership.reserve(a); h.state.owners[0].nativeId = id; h.state.topology.bridges = [bridge(id, sa)];
  h.ownership.claimNative(lease, id); h.ownership.assert(lease);
  h.state.topology.bridges[0] = bridge(id, { ...sa, conversationId: null }); assert.throws(() => h.ownership.assert(lease), /mapping is unavailable/);
  h.state.topology.bridges = [bridge(id, storage(process.cwd()))]; assert.throws(() => h.ownership.assert(lease), /mapping changed/);
  h.ownership.release(lease);
});

test('bridge metadata without a checked database reserves storage but cannot authorize input', () => {
  const h = sources(), a = identity(), sa = storage(process.cwd()), id = randomUUID(); h.state.owners = [owner(a)];
  const lease = h.ownership.reserve(a); h.state.owners[0].nativeId = id;
  for (const databaseVerified of [undefined, false]) {
    h.state.topology.bridges = [{ nativeId: id, ...sa, databaseVerified }];
    assert.throws(() => h.ownership.claimNative(lease, id), /Verified native storage/);
    const mapped = projectAntigravityStorage(h.state.owners, h.state.topology)[0];
    assert.deepEqual(mapped.nativeStorage, sa); assert.equal(mapped.storageVerified, false);
  }
  h.state.topology.bridges[0].databaseVerified = true; h.ownership.claimNative(lease, id);
  h.state.topology.bridges[0].databaseVerified = false;
  assert.throws(() => h.ownership.assert(lease), /mapping is unavailable/); h.ownership.release(lease);
  const b = identity(); b.nativeId = randomUUID(); h.state.owners = [owner(b)];
  h.state.topology.bridges = [{ nativeId: b.nativeId, ...sa, databaseVerified: false }];
  assert.throws(() => h.ownership.reserve(b), /storage belongs to another/);
});

test('projection cannot silently replace a persisted native storage identity', () => {
  const a = identity(); a.nativeId = randomUUID(); const sa = storage(process.cwd());
  assert.throws(() => projectAntigravityStorage([{ ...owner(a), nativeStorage: sa }],
    { bridges: [bridge(a.nativeId, storage(process.cwd()))], histories: [] }), /mapping changed/);
  const projected = projectAntigravityStorage([{ ...owner(a), nativeStorage: sa }], { bridges: [], histories: [] });
  assert.deepEqual(projected[0].nativeStorage, sa); assert.equal(projected[0].storageVerified, false);
});

test('invalid storage IDs, relative paths, secret fields, duplicate bridges and oversized topology reject', () => {
  const sa = storage(process.cwd()), id = randomUUID();
  for (const value of [null, {}, { ...sa, storageDir: 'relative' }, { ...sa, conversationId: [sa.conversationId] },
    { ...sa, token: 'must-not-be-persisted' }, { ...sa, connection: 'other' }]) assert.throws(() => nativeStorage(value), /Invalid/);
  const topology = { bridges: [bridge(id, sa), bridge(id, sa)], histories: [] };
  assert.throws(() => projectAntigravityStorage([], topology), /Ambiguous/);
  assert.throws(() => projectAntigravityStorage([], topology, 1), /oversized/);
  for (const databaseVerified of ['true', 1, {}, null]) assert.throws(() => projectAntigravityStorage([], {
    bridges: [{ ...bridge(id, sa), databaseVerified }], histories: [] }), /Invalid native storage bridge/);
  if (process.platform === 'win32') assert.equal(storageKey(sa), storageKey({ ...sa, storageDir: sa.storageDir.toUpperCase() }));
});

test('an asynchronous topology cannot authorize a mapping or leak its rejection', async () => {
  assert.throws(() => projectAntigravityStorage([], Promise.reject(new Error('late native source'))), /synchronous/);
  await new Promise(resolve => setImmediate(resolve));
});

test('manager persists storage before running and preserves it in retired history on restart', t => {
  const h = disk(t), first = h.start();
  assert.deepEqual(h.manager.get(h.group.id).participants[0].session.nativeStorage, first.nativeStorage);
  assert.deepEqual(h.manager.get(h.group.id).deliveries[0].nativeStorage, first.nativeStorage);
  h.manager.fail(h.group.id, first.id, first.generation, 'failed', h.proof(first));
  const restarted = new DiscussionManager({ dir: path.join(h.root, 'discussions') });
  const retired = restarted.get(h.group.id).participants[0].retiredSessions[0];
  assert.deepEqual(retired.nativeStorage, first.nativeStorage);
  assert.deepEqual(collectNativeOwners({ discussions: restarted.list() }).find(row => row.nativeId === first.nativeId).nativeStorage, first.nativeStorage);
});

test('different bridge IDs cannot bypass current, removed or retired manager ownership', t => {
  const h = disk(t), first = h.start(), other = h.manager.create({ cwd: h.root }), member = h.manager.addMember(other.id, h.profile);
  assert.throws(() => h.start(member, other.id, randomUUID(), first.nativeStorage), /another member/);
  h.manager.fail(h.group.id, first.id, first.generation, 'failed', h.proof(first)); h.manager.removeMember(h.group.id, h.member.id);
  const third = h.manager.addMember(other.id, h.profile);
  assert.throws(() => h.start(third, other.id, randomUUID(), first.nativeStorage), /another member/);
});

test('independent SDK storage can reuse a native ID while continuation cannot switch storage', t => {
  const h = disk(t), first = h.start(), other = h.manager.addMember(h.group.id, h.profile);
  h.start(other, h.group.id, randomUUID(), { ...first.nativeStorage, storageDir: path.join(h.root, 'fork-native') });
  h.manager.complete(h.group.id, first.id, first.generation, 'Answer', h.proof(first));
  assert.throws(() => h.start(h.member, h.group.id, first.nativeId, storage(h.root)), /storage changed/);
});

test('damaged or mismatched persisted storage cannot disappear from the restart inventory', t => {
  const h = disk(t), first = h.start();
  const file = path.join(h.root, 'discussions', h.group.id + '.json'), original = fs.readFileSync(file, 'utf8');
  for (const edit of [state => { state.participants[0].session.nativeStorage.storageDir = 'relative'; },
    state => { state.deliveries[0].nativeStorage.conversationId = randomUUID().replaceAll('-', ''); },
    state => { delete state.deliveries[0].nativeStorage; },
    state => { state.participants[0].session.nativeStorage = { ...first.nativeStorage, secret: 'not-allowed' }; }]) {
    const state = JSON.parse(original); edit(state); fs.writeFileSync(file, JSON.stringify(state));
    assert.throws(() => new DiscussionManager({ dir: path.dirname(file) }).get(h.group.id), /storage/);
  }
});

test('reverse guards preserve saved storage after restart even when its original bridge is absent', t => {
  const h = disk(t), first = h.start(), alias = randomUUID(), unrelated = randomUUID();
  h.manager.fail(h.group.id, first.id, first.generation, 'failed', h.proof(first)); h.manager.removeMember(h.group.id, h.member.id);
  const topology = { bridges: [bridge(alias, first.nativeStorage), bridge(unrelated, { ...first.nativeStorage, storageDir: path.join(h.root, 'independent-native') })], histories: [] };
  const drivers = { antigravity: { sessions: new SessionPool(), history: new ClaudeHistory(path.join(h.root, 'mirror')) } };
  installDiscussionGuards({ dataDir: h.root, drivers, nativeStorage: () => topology });
  assert.throws(() => drivers.antigravity.sessions.assertAccess({ sessionId: alias }), /owned by a discussion/);
  assert.throws(() => drivers.antigravity.history.remove(alias), /owned by a discussion/);
  drivers.antigravity.sessions.assertAccess({ sessionId: unrelated });
  drivers.antigravity.sessions.assertAccess({ conversationId: randomUUID() });
  const file = path.join(h.root, 'mirror/project', unrelated + '.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}\n');
  assert.equal(drivers.antigravity.history.remove(unrelated), true);
});

test('missing or asynchronous reverse storage sources reject aliases without blocking new ordinary chats', async t => {
  const h = disk(t); h.start();
  for (const source of [undefined, async () => { throw new Error('late'); }]) {
    const drivers = { antigravity: { sessions: new SessionPool() } };
    installDiscussionGuards({ dataDir: h.root, drivers, nativeStorage: source });
    assert.throws(() => drivers.antigravity.sessions.assertAccess({ sessionId: randomUUID() }), /coverage/);
    drivers.antigravity.sessions.assertAccess({ conversationId: randomUUID() });
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('application inventory projects aliases but topology alone does not make external coverage complete', t => {
  const h = disk(t), first = h.start(), alias = randomUUID();
  const topology = { bridges: [bridge(first.nativeId, first.nativeStorage), bridge(alias, first.nativeStorage)], histories: [first.nativeStorage] };
  const state = { complete: false, histories: [], activities: [], antigravity: topology };
  const boundary = createDiscussionBoundary({ dataDir: h.root, drivers: {}, conversations: () => [], external: () => state });
  assert.throws(() => boundary.inventory.read(), /Complete external/); state.complete = true;
  const current = h.manager.get(h.group.id).participants[0].session;
  assert.throws(() => boundary.ownership.reserve({ engine: 'antigravity', discussionId: h.group.id, participantId: h.member.id,
    runtimeId: current.runtimeId, generation: current.generation, nativeId: current.nativeId }), /storage belongs to another/);
});
