'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SessionPool } = require('../src/engines/session-pool');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { NativeSessionOwnership } = require('../src/engines/discussions/native-ownership');
const { installDiscussionGuards } = require('../src/engines/discussions/native-access');
const { createDiscussionLaunch, revokeDiscussionLaunch } = require('../src/engines/discussions/native-launch');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { removeTree } = require('./test-fs.cjs');

const engines = ['claude', 'codex', 'kimi', 'antigravity', 'dsh', 'pi'];
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-access-'));
  t.after(() => removeTree(root));
  const manager = new DiscussionManager({ dir: path.join(root, 'discussions') });
  const group = manager.create({ cwd: root });
  const drivers = Object.fromEntries(engines.map(engine => [engine, {
    sessions: new SessionPool(), history: new ClaudeHistory(path.join(root, engine + '-history')),
  }]));
  const access = installDiscussionGuards({ dataDir: root, drivers });
  const add = engine => {
    const member = manager.addMember(group.id, { name: engine, engine, connection: 'api', model: 'fixture' });
    const nativeId = engine + '-' + randomUUID();
    manager.store.update(group.id, state => { state.participants.find(p => p.id === member.id).session.nativeId = nativeId; });
    return { ...member, session: { ...member.session, nativeId } };
  };
  return { root, manager, group, drivers, access, add };
}

test('persisted current, retired and removed discussion histories exclude ordinary access after restart', t => {
  const h = setup(t), old = h.add('codex');
  const next = h.manager.configureMember(h.group.id, old.id, { engine: 'antigravity' });
  h.manager.store.update(h.group.id, state => { state.participants[0].session.nativeId = 'current-native'; });
  h.manager.removeMember(h.group.id, old.id);
  // New pools and a fresh reader simulate restart without any live session.
  const restarted = Object.fromEntries(engines.map(engine => [engine, { sessions: new SessionPool() }]));
  installDiscussionGuards({ dataDir: h.root, drivers: restarted });
  for (const engine of engines) {
    for (const conversationId of [h.group.id, old.session.runtimeId, next.session.runtimeId]) {
      assert.throws(() => restarted[engine].sessions.assertAccess({ conversationId }), /owned by a discussion/);
    }
  }
  for (const [engine, sessionId] of [['codex', old.session.nativeId], ['antigravity', 'current-native']]) {
    for (const opts of [{ sessionId }, { conversationId: randomUUID(), sessionId, fork: true }]) {
      assert.throws(() => restarted[engine].sessions.assertAccess(opts), /owned by a discussion/);
    }
  }
  // Native IDs remain engine-scoped; ordinary unrelated histories still work.
  restarted.kimi.sessions.assertAccess({ sessionId: old.session.nativeId });
  restarted.codex.sessions.set({ conversationId: 'ordinary' }, {});
  assert.ok(restarted.codex.sessions.get({ conversationId: 'ordinary' }));
});

test('ordinary native deletion cannot erase discussion history but still deletes an unrelated transcript', t => {
  const h = setup(t);
  for (const engine of engines) {
    const member = h.add(engine), history = h.drivers[engine].history;
    const dir = path.join(history.root, 'project'); fs.mkdirSync(dir, { recursive: true });
    const retained = path.join(dir, member.session.nativeId + '.jsonl'), ordinary = path.join(dir, 'ordinary.jsonl');
    fs.writeFileSync(retained, '{}\n'); fs.writeFileSync(ordinary, '{}\n');
    assert.throws(() => history.remove(member.session.nativeId), /owned by a discussion/);
    assert.ok(fs.existsSync(retained));
    if (engine === 'antigravity') {
      assert.throws(() => history.remove('ordinary'), /storage coverage/);
      assert.ok(fs.existsSync(ordinary), 'Unknown bridge aliases need a current native storage source');
    } else { assert.equal(history.remove('ordinary'), true); assert.equal(fs.existsSync(ordinary), false); }
  if (process.platform === 'win32') {
      assert.throws(() => history.remove(member.session.nativeId.toUpperCase()), /owned by a discussion/);
      assert.throws(() => h.drivers[engine].sessions.assertAccess({ conversationId: member.session.runtimeId.toUpperCase() }), /owned by a discussion/);
    }
  }
});

test('live discussion opening protects an uncommitted native ID and requires the exact scoped capability', async t => {
  const h = setup(t), member = h.add('codex');
  const settings = { model: 'fixture', connection: 'api', permissionMode: 'plan', thinkingBudget: '', proxyUrl: '', contextWindow: 12000 };
  const opts = { conversationId: member.session.runtimeId, sessionId: member.session.nativeId, cwd: h.root, settings };
  opts.discussionLaunch = createDiscussionLaunch({ engine: 'codex', identity: member.session, cwd: h.root,
    nativeId: opts.sessionId, settings, launch: { buildSpec() {}, spawn() {} } });
  const session = { opts, sessionId: 'uncommitted-native', shutdown: async () => {} };
  const pool = h.drivers.codex.sessions;
  pool.set(opts, session);
  assert.throws(() => pool.assertAccess({ sessionId: session.sessionId }), /owned by a discussion/);
  assert.throws(() => h.drivers.pi.sessions.assertAccess({ conversationId: opts.conversationId }), /owned by a discussion/);
  assert.throws(() => pool.assertAccess({ ...opts, discussionLaunch: {} }), /Invalid.*discussion launch/);
  assert.throws(() => h.drivers.kimi.sessions.assertAccess(opts), /Invalid.*discussion launch/);
  assert.throws(() => pool.set({ conversationId: opts.conversationId }, {}), /owned by a discussion/);
  assert.throws(() => pool.set({ conversationId: opts.conversationId }, null), /replaced by their owner/);
  await pool.release(opts); revokeDiscussionLaunch(opts.discussionLaunch);
  assert.throws(() => pool.assertAccess(opts), /expired discussion launch/);
  assert.throws(() => pool.assertAccess({ sessionId: member.session.nativeId }), /owned by a discussion/);
});

test('damaged or unrecognized persisted ownership fails before admission and never prevents stopping an ordinary process', async t => {
  const h = setup(t), pool = h.drivers.codex.sessions;
  let stopped = 0;
  pool.set({ conversationId: 'ordinary' }, { shutdown: async () => stopped++ });
  const file = h.manager.store.file(h.group.id), original = fs.readFileSync(file);
  fs.writeFileSync(file, '{torn');
  assert.throws(() => pool.assertAccess({}), /Invalid JSON/);
  assert.throws(() => h.drivers.codex.history.remove('ordinary'), /Invalid JSON/);
  await pool.release({ conversationId: 'ordinary' }); assert.equal(stopped, 1);
  fs.writeFileSync(file, original);
  const unknown = path.join(h.manager.store.dir, 'unknown.json'); fs.writeFileSync(unknown, '{}');
  assert.throws(() => pool.assertAccess({}), /record name/);
  fs.unlinkSync(unknown);
  h.add('codex');
  const state = h.manager.get(h.group.id); state.participants[0].engine = 'damaged'; fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => pool.assertAccess({}), /Invalid discussion records: member connection/);
});

test('a missing discussion store permits ordinary startup without creating any storage', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-access-empty-'));
  t.after(() => removeTree(root));
  const sessions = new SessionPool(); installDiscussionGuards({ dataDir: root, drivers: { codex: { sessions } } });
  sessions.assertAccess({}); assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => sessions.setAccessGuard(() => {}), /already set/);
});

test('the shared ownership registry retains reverse protection after release even without a durable native ID', t => {
  const h = setup(t), identity = { engine: 'codex', discussionId: randomUUID(), participantId: randomUUID(), runtimeId: randomUUID(), generation: 1 };
  const ownership = new NativeSessionOwnership({ readOwners: () => [] });
  const lease = ownership.reserve(identity); ownership.claimNative(lease, 'pending-native'); ownership.release(lease);
  const sessions = new SessionPool(); installDiscussionGuards({ dataDir: h.root, ownership, drivers: { codex: { sessions } } });
  assert.throws(() => sessions.assertAccess({ sessionId: 'pending-native' }), /owned by a discussion/);
  assert.throws(() => sessions.assertAccess({ conversationId: identity.runtimeId }), /owned by a discussion/);
});

test('an asynchronous access guard cannot silently authorize a pool entry', async () => {
  const pool = new SessionPool(); pool.setAccessGuard(async () => { throw new Error('late rejection'); });
  assert.throws(() => pool.set({}, {}), /must be synchronous/);
  assert.equal(pool.sessions.size, 0);
  await new Promise(resolve => setImmediate(resolve));
});

test('launch journals independently reserve runtime paths and partial journal entries cannot be ignored', t => {
  const h = setup(t), journal = new WindowsJobJournal({ dir: path.join(h.root, 'discussions/windows-jobs') });
  const identity = { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 };
  const record = journal.reserve(identity);
  for (const engine of engines) assert.throws(() => h.drivers[engine].sessions.assertAccess({ conversationId: identity.runtimeId }), /owned by a discussion/);
  h.drivers.codex.sessions.assertAccess({ conversationId: 'ordinary' });
  fs.unlinkSync(record.lockFile);
  assert.throws(() => h.drivers.codex.sessions.assertAccess({ conversationId: 'ordinary' }), /ENOENT/);
});

test('a record with an uppercase JSON extension cannot disappear from the admission inventory', t => {
  const h = setup(t), member = h.add('codex'), file = h.manager.store.file(h.group.id);
  fs.renameSync(file, file.slice(0, -5) + '.JSON');
  assert.throws(() => h.drivers.codex.sessions.assertAccess({ sessionId: member.session.nativeId }), /owned by a discussion/);
});
