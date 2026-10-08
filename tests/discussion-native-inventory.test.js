'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { createDiscussionBoundary } = require('../src/engines/discussions/native-boundary');
const { createDiscussionLaunch } = require('../src/engines/discussions/native-launch');
const { SessionPool } = require('../src/engines/session-pool');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { SharedConversations } = require('../src/engines/shared-conversations');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { removeTree } = require('./test-fs.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-inventory-'));
  t.after(() => removeTree(root));
  const manager = new DiscussionManager({ dir: path.join(root, 'discussions') }), group = manager.create({ cwd: root });
  const drivers = Object.fromEntries(['codex', 'antigravity', 'claude', 'kimi', 'dsh', 'pi'].map(engine => [engine, {
    sessions: new SessionPool(), history: new ClaudeHistory(path.join(root, engine + '-history')),
  }]));
  const state = { memory: [], external: { complete: true, histories: [], activities: [] } };
  // The external fixture explicitly declares synthetic coverage. No production
  // source, CLI, account, OS ownership proof or model connection is used here.
  const boundary = createDiscussionBoundary({ dataDir: root, drivers, conversations: () => state.memory, external: () => state.external });
  const add = (engine = 'codex') => {
    const p = manager.addMember(group.id, { name: 'Member', engine, connection: 'api', model: 'fixture' });
    return { ...p.session, engine: p.engine, discussionId: group.id, participantId: p.id };
  };
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const ordinary = (nativeId, extra = {}) => {
    const record = { id: randomUUID(), origin: 'codex', currentEngine: 'codex', segments: { codex: { nativeId } }, ...extra };
    write(path.join(root, 'conversations', record.id + '.json'), record); return record;
  };
  const mirror = (nativeId, engine = 'codex') => write(path.join(drivers[engine].history.root, 'project', nativeId + '.jsonl'), 'not read as ownership authority');
  const opened = (identity, nativeId) => {
    const settings = { model: 'fixture', connection: 'api', permissionMode: 'plan', thinkingBudget: '', proxyUrl: '', contextWindow: 12000 };
    const opts = { conversationId: identity.runtimeId, sessionId: identity.nativeId, cwd: root, settings };
    opts.discussionLaunch = createDiscussionLaunch({ engine: identity.engine, identity, cwd: root, nativeId: identity.nativeId,
      settings, launch: { buildSpec() {}, spawn() {} } });
    const session = { opts, sessionId: nativeId, shutdown: async () => {} };
    drivers[identity.engine].sessions.set(opts, session); return session;
  };
  return { root, manager, group, drivers, state, ...boundary, add, write, ordinary, mirror, opened };
}

test('disk and memory ownership form a union of ordinary current, parked and retired segments', t => {
  const h = setup(t), ordinary = h.ordinary('disk-current', {
    modelSessions: { parked: { engine: 'codex', nativeId: 'parked' } }, retiredSegments: [{ engine: 'antigravity', nativeId: 'retired' }],
  });
  h.state.memory = [{ ...ordinary, segments: { codex: { nativeId: 'memory-current' } } }];
  for (const nativeId of ['disk-current', 'memory-current', 'parked']) {
    assert.throws(() => h.ownership.reserve({ ...h.add(), nativeId }), /another.*owner/);
  }
  assert.throws(() => h.ownership.reserve({ ...h.add('antigravity'), nativeId: 'retired' }), /another.*owner/);
  assert.throws(() => h.ownership.reserve({ ...h.add(), runtimeId: ordinary.id }), /another.*owner/);
});

test('an invalid disk index isolated by ordinary loading still blocks discussion admission', t => {
  const h = setup(t), id = randomUUID();
  h.write(path.join(h.root, 'conversations', id + '.json'), { id, origin: 'unknown', currentEngine: 'codex', segments: {} });
  const ordinary = new SharedConversations({ dir: path.join(h.root, 'conversations'), drivers: h.drivers, loadConfig: () => ({}), saveConfig() {} });
  assert.equal(ordinary.items.size, 0);
  assert.equal(ordinary.recoveryWarnings.length, 1);
  assert.ok(fs.existsSync(ordinary.recoveryWarnings[0].backupFile));
  assert.throws(() => h.ownership.reserve(h.add()), /Invalid conversation ownership index/);
  assert.equal(h.ownership.active.size, 0);
});

test('bad filenames, native IDs and parked segment metadata fail closed instead of disappearing', t => {
  const h = setup(t), record = h.ordinary('native'), file = path.join(h.root, 'conversations', record.id + '.json');
  const identity = h.add();
  for (const bad of [
    { ...record, id: randomUUID() },
    { ...record, segments: { codex: { nativeId: '../invalid' } } },
    { ...record, modelSessions: { broken: { nativeId: 'hidden' } } },
    { ...record, retiredSegments: {} },
  ]) {
    h.write(file, bad); assert.throws(() => h.ownership.reserve(identity), /ownership/);
  }
  h.write(file, '{torn'); assert.throws(() => h.ownership.reserve(identity), /Invalid JSON/);
});

test('unmanaged mirrors and explicit external activity exclude native IDs without parsing transcript content', t => {
  const h = setup(t);
  h.mirror('unmanaged'); h.state.external.histories.push({ engine: 'codex', nativeId: 'raw-only' });
  h.state.external.activities.push({ engine: 'codex', runtimeId: randomUUID(), nativeId: 'external-active' });
  for (const nativeId of ['unmanaged', 'raw-only', 'external-active']) {
    assert.throws(() => h.ownership.reserve({ ...h.add(), nativeId }), /another.*owner/);
  }
  const identity = h.add(), lease = h.ownership.reserve(identity);
  h.state.external.activities.push({ engine: 'codex', runtimeId: identity.runtimeId });
  assert.throws(() => h.ownership.assert(lease), /another.*owner/);
  h.ownership.release(lease);
});

test('mirrors of a recorded discussion history retain their one logical owner across restart', t => {
  const h = setup(t), identity = h.add();
  h.manager.store.update(h.group.id, state => { state.participants[0].session.nativeId = 'owned'; });
  h.mirror('owned'); h.state.external.histories.push({ engine: 'codex', nativeId: 'owned' });
  const rows = h.inventory.read().filter(row => row.nativeId === 'owned');
  assert.deepEqual([...new Set(rows.map(row => row.ownerId))], [`discussion/${identity.discussionId}/${identity.participantId}/1`]);
  const lease = h.ownership.reserve({ ...identity, nativeId: 'owned' }); h.ownership.release(lease);
  assert.throws(() => h.ownership.reserve({ ...h.add(), nativeId: 'owned' }), /another.*owner/);
});

test('a newly opened scoped process explains its uncommitted mirror and retains the claim after release', async t => {
  const h = setup(t), identity = h.add(), lease = h.ownership.reserve(identity);
  const session = h.opened(identity, 'new-native'); h.mirror('new-native');
  h.ownership.claimNative(lease, 'new-native'); h.ownership.assert(lease);
  await h.drivers.codex.sessions.release(session.opts); h.ownership.release(lease);
  // The durable participant still has nativeId:null, but the shared registry
  // must protect the ID until the scheduler has resolved that uncertain commit.
  assert.equal(h.manager.get(h.group.id).participants[0].session.nativeId, null);
  assert.throws(() => h.drivers.codex.sessions.assertAccess({ sessionId: 'new-native' }), /owned by a discussion/);
  assert.throws(() => h.ownership.reserve({ ...h.add(), nativeId: 'new-native' }), /another.*owner/);
});

test('opening cannot reattribute a preexisting unmanaged mirror to the new discussion', async t => {
  const h = setup(t), identity = h.add(), file = h.mirror('preexisting');
  const lease = h.ownership.reserve(identity), session = h.opened(identity, 'preexisting');
  // Even if the source disappears during open, the launch baseline survives.
  fs.unlinkSync(file);
  assert.throws(() => h.ownership.claimNative(lease, 'preexisting'), /another owner before launch/);
  await h.drivers.codex.sessions.release(session.opts); h.ownership.release(lease);
});

test('preparation rechecks retain newly observed foreign histories before opening', async t => {
  const h = setup(t), identity = h.add(), lease = h.ownership.reserve(identity);
  const file = h.mirror('appeared-during-preparation');
  h.ownership.assert(lease);
  fs.unlinkSync(file);
  const session = h.opened(identity, 'appeared-during-preparation');
  assert.throws(() => h.ownership.claimNative(lease, session.sessionId), /another owner before launch/);
  await h.drivers.codex.sessions.release(session.opts); h.ownership.release(lease);
});

test('ordinary ownership acquired during discussion opening is rechecked before native input', async t => {
  const h = setup(t), identity = h.add(), lease = h.ownership.reserve(identity);
  h.ordinary('racing-native'); const session = h.opened(identity, 'racing-native');
  assert.throws(() => h.ownership.claimNative(lease, 'racing-native'), /another.*owner/);
  await h.drivers.codex.sessions.release(session.opts); h.ownership.release(lease);
});

test('retained ordinary pool entries reserve IDs even when dead and absent from persisted indexes', t => {
  const h = setup(t), runtimeId = randomUUID();
  h.drivers.codex.sessions.set({ conversationId: runtimeId }, { opts: { conversationId: runtimeId }, sessionId: 'live-only', dead: true });
  h.drivers.antigravity.sessions.set({}, { opts: {}, sessionId: 'legacy-only', dead: true });
  assert.throws(() => h.ownership.reserve({ ...h.add(), nativeId: 'live-only' }), /another.*owner/);
  assert.throws(() => h.ownership.reserve({ ...h.add(), runtimeId }), /another.*owner/);
  assert.throws(() => h.ownership.reserve({ ...h.add('antigravity'), nativeId: 'legacy-only' }), /another.*owner/);
});

test('missing external coverage keeps forward admission disabled while ordinary guards and empty registry remain usable', async t => {
  const h = setup(t), identity = h.add();
  h.state.external = null;
  assert.throws(() => h.ownership.reserve(identity), /Complete external.*not available/);
  assert.equal(h.registry.entries.size, 0);
  h.drivers.codex.sessions.assertAccess({ conversationId: 'ordinary' });
  h.state.external = Promise.reject(new Error('late external scan rejection'));
  assert.throws(() => h.ownership.reserve(identity), /must be synchronous/);
  await new Promise(resolve => setImmediate(resolve));
  h.state.external = { complete: false, histories: [], activities: [] };
  assert.throws(() => h.ownership.reserve(identity), /Complete external/);
});

test('directory creation during the external callback invalidates the inventory instead of authorizing from stale emptiness', t => {
  const h = setup(t), identity = h.add();
  h.inventory.external = () => { h.ordinary('late'); return h.state.external; };
  assert.throws(() => h.ownership.reserve(identity), /sources changed/);
  assert.equal(h.ownership.active.size, 0);
});

test('linked sources and bounded scans never fall back to partial ownership', t => {
  const h = setup(t), identity = h.add();
  h.inventory.limits = { maxBytes: 1 };
  assert.throws(() => h.ownership.reserve(identity), /byte limit/);
  h.inventory.limits = { maxEntries: 1 }; h.ordinary('entry');
  assert.throws(() => h.ownership.reserve(identity), /entry limit/);
  h.inventory.limits = undefined;
  const target = path.join(h.root, 'linked-native'); fs.mkdirSync(target);
  fs.symlinkSync(target, h.drivers.codex.history.root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => h.ownership.reserve(identity), /Linked ownership/);
});

test('orphan launch records reserve every engine and a matching persisted delivery retains its discussion owner', t => {
  const h = setup(t), identity = h.add();
  const journal = new WindowsJobJournal({ dir: path.join(h.root, 'discussions/windows-jobs') });
  const record = { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 }; journal.reserve(record);
  assert.throws(() => h.ownership.reserve({ ...identity, runtimeId: record.runtimeId }), /another.*owner/);
  const request = h.manager.enqueue(h.group.id, { requestId: 'request', text: 'Test', participantIds: [identity.participantId] });
  const delivery = h.manager.prepare(h.group.id, request.deliveryIds[0]);
  journal.reserve({ runtimeId: identity.runtimeId, deliveryId: delivery.id, generation: identity.generation });
  const lease = h.ownership.reserve(identity); h.ownership.assert(lease); h.ownership.release(lease);
});

test('malformed or asynchronous in-memory sources cannot silently shrink the ownership view', async t => {
  const h = setup(t), identity = h.add(), c = { id: randomUUID(), origin: 'codex', currentEngine: 'codex', segments: {} };
  h.state.memory = [{ ...c, segments: new Map([['codex', { nativeId: 'hidden' }]]) }];
  assert.throws(() => h.ownership.reserve(identity), /Invalid conversation ownership/);
  h.state.memory = Promise.reject(new Error('late memory rejection'));
  assert.throws(() => h.ownership.reserve(identity), /must be synchronous/);
  await new Promise(resolve => setImmediate(resolve));
  h.state.memory = [c];
  h.inventory.claims = () => [{ engine: 'codex', nativeId: 'native' }];
  assert.throws(() => h.ownership.reserve(identity), /Invalid native ownership/);
});

test('main-process records from another VM realm remain visible without accepting Map or class dictionaries', t => {
  const h = setup(t), identity = h.add();
  h.inventory.drivers = vm.runInNewContext('({ ...drivers })', { drivers: h.drivers });
  h.state.memory = vm.runInNewContext('[{ id, origin: "codex", currentEngine: "codex", segments: { codex: { nativeId: "vm-owned" } } }]', { id: randomUUID() });
  assert.throws(() => h.ownership.reserve({ ...identity, nativeId: 'vm-owned' }), /another.*owner/);
  const lease = h.ownership.reserve(identity); h.ownership.release(lease);
  for (const segments of [new Map(), new (class Segments {})()]) {
    h.state.memory[0].segments = segments;
    assert.throws(() => h.ownership.reserve(identity), /Invalid conversation ownership/);
  }
});

test('native Windows path aliases cannot bypass historical ownership or active runtime claims', { skip: process.platform !== 'win32' }, t => {
  const h = setup(t), identity = h.add(); h.mirror('Known-Native');
  assert.throws(() => h.ownership.reserve({ ...identity, nativeId: 'KNOWN-NATIVE' }), /another.*owner/);
  const lease = h.ownership.reserve(identity);
  assert.throws(() => h.ownership.reserve({ ...identity, runtimeId: identity.runtimeId.toUpperCase() }), /reserved/);
  h.ownership.release(lease);
});
