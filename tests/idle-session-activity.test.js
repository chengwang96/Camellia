'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { SessionPool } = require('../src/engines/session-pool');
const { IdleSessionReaper } = require('../src/engines/idle-session-reaper');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-idle-activity-'));
  let now = 0, gen = 0, manager;
  const sent = [], ensured = [], closed = [];
  const pools = Object.fromEntries(ENGINES.map(engine => [engine, new SessionPool({ now: () => now })]));
  const drivers = Object.fromEntries(ENGINES.map(engine => [engine, {
    sessions: pools[engine], settings: () => ({ model: 'fixture', connection: 'api', permissionMode: 'ask' }),
    saveSettings: value => value, nativeCompaction: true,
    ensure(opts) {
      ensured.push({ engine, opts });
      const current = pools[engine].get(opts);
      if (current && !current.dead) return current;
      const session = { gen: ++gen, opts, settings: opts.settings, sessionId: opts.sessionId || engine + '-native-' + gen, running: false,
        sendUserMessage(prompt) {
          session.running = true; sent.push({ engine, session, prompt });
          manager.capture(engine, { type: 'system', subtype: 'init', conversationId: opts.conversationId,
            session_id: session.sessionId, runId: session.gen });
          return true;
        },
        interrupt() { finish(engine, 'stopped'); },
        shutdown: async () => { session.dead = true; session.running = false; closed.push(session); },
        compact: async () => ({ ok: true }),
      };
      pools[engine].set(opts, session); return session;
    },
  }]));
  manager = new SharedConversations({ dir: root, loadConfig: () => ({}), saveConfig() {}, drivers });
  const reaper = new IdleSessionReaper(Object.values(pools), { timeoutMs: 100, now: () => now,
    isBlocked: id => manager.busy(id), log: message => { throw new Error(message); } });
  function finish(engine, subtype = 'success') {
    const { session } = sent.findLast(entry => entry.engine === engine);
    session.running = false;
    manager.capture(engine, { type: 'result', subtype, result: 'Stored answer', conversationId: session.opts.conversationId,
      session_id: session.sessionId, runId: session.gen });
  }
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
  t.after(async () => { reaper.stop(); manager.pauseGoals(); await Promise.all(Object.values(pools).map(pool => pool.shutdown())); manager.historyStore.close(); removeTree(root); });
  return { root, manager, reaper, pools, drivers, sent, ensured, closed, finish, flush, advance: delta => { now += delta; } };
}

for (const engine of ENGINES) {
  test(engine + ' task completion refreshes retention and reaping preserves its stored context', async t => {
    const h = fixture(t), run = await h.manager.send(engine, { prompt: 'Remember my context' });
    await h.reaper.sweep(); h.advance(500);
    assert.deepEqual(await h.reaper.sweep(), []);
    h.finish(engine); await run.done;
    const c = h.manager.get(run.sessionId), nativeId = c.segments[engine].nativeId;
    const files = [h.manager.file(c.id), path.join(h.root, c.id + '.jsonl')];
    const before = files.map(file => fs.readFileSync(file));
    h.advance(99); assert.deepEqual(await h.reaper.sweep(), []);
    h.advance(1); assert.deepEqual(await h.reaper.sweep(), [c.id]);
    for (const [index, file] of files.entries()) assert.deepEqual(fs.readFileSync(file), before[index]);
    assert.equal(c.segments[engine].nativeId, nativeId);
    const next = await h.manager.send(engine, { sessionId: c.id, prompt: 'Continue with the same context' });
    assert.equal(h.ensured.at(-1).opts.sessionId, nativeId);
    h.finish(engine); await next.done;
  });
}

test('repeated short shared turns between sweeps retain the same native process', async t => {
  const h = fixture(t), first = await h.manager.send('claude', { prompt: 'One' });
  h.finish('claude'); await first.done; await h.reaper.sweep();
  const session = h.sent.at(-1).session;
  for (let i = 0; i < 3; i++) {
    h.advance(80);
    const run = await h.manager.send('claude', { sessionId: first.sessionId, prompt: 'Another short turn' });
    h.finish('claude'); await run.done;
    assert.equal(h.sent.at(-1).session, session);
  }
  assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(100); assert.deepEqual(await h.reaper.sweep(), [first.sessionId]);
});

async function closingFixture(t) {
  const h = fixture(t), run = await h.manager.send('codex', { prompt: 'Original task' });
  h.finish('codex'); await run.done;
  const old = h.sent.at(-1).session;
  let complete;
  old.shutdown = () => new Promise(resolve => { complete = () => { old.dead = true; resolve(); }; });
  h.advance(100); const sweep = h.reaper.sweep(); await h.flush();
  return { ...h, run, old, sweep, complete: () => complete() };
}

test('a new shared turn waits for idle teardown and resumes the stored native ID', async t => {
  const h = await closingFixture(t), sending = h.manager.send('codex', { sessionId: h.run.sessionId, prompt: 'New message' });
  await h.flush(); assert.equal(h.sent.length, 1); assert.equal(h.manager.busy(h.run.sessionId), true);
  h.complete(); await h.sweep;
  const run = await sending;
  assert.equal(h.sent.length, 2); assert.notEqual(h.sent.at(-1).session, h.old);
  assert.equal(h.ensured.at(-1).opts.sessionId, h.old.sessionId);
  h.finish('codex'); await run.done;
  assert.deepEqual(await h.reaper.sweep(), []);
});

test('stopping a turn waiting for teardown prevents later native dispatch', async t => {
  const h = await closingFixture(t), sending = h.manager.send('codex', { sessionId: h.run.sessionId, prompt: 'Do not send after stop' });
  await h.flush(); const stopped = await h.manager.cancel({ sessionId: h.run.sessionId });
  assert.equal(stopped.ok, true);
  h.complete(); await h.sweep; const run = await sending;
  assert.equal((await run.done).subtype, 'stopped'); assert.equal(h.sent.length, 1);
  assert.equal(h.manager.busy(h.run.sessionId), false);
});

test('a teardown failure retains the native instance and does not dispatch a waiting message', async t => {
  const h = fixture(t), first = await h.manager.send('codex', { prompt: 'Original task' });
  h.finish('codex'); await first.done;
  const old = h.sent.at(-1).session; let fail; const logs = [];
  old.shutdown = () => new Promise((_resolve, reject) => { fail = reject; });
  h.reaper.log = message => logs.push(message);
  h.advance(100); const sweep = h.reaper.sweep(); await h.flush();
  const sending = h.manager.send('codex', { sessionId: first.sessionId, prompt: 'Wait for shutdown' });
  const rejected = assert.rejects(sending, /shutdown failed/);
  await h.flush(); fail(new Error('shutdown failed')); await sweep; await rejected;
  assert.equal(h.sent.length, 1); assert.equal(h.pools.codex.get({ conversationId: first.sessionId }), old);
  assert.equal(h.manager.busy(first.sessionId), false); assert.match(logs[0], /shutdown failed/);
  old.shutdown = async () => { old.dead = true; };
});

test('editing while teardown is pending can be stopped before native boundary probing', async t => {
  const h = await closingFixture(t), c = h.manager.get(h.run.sessionId);
  h.drivers.codex.nativeEditing = true; c.segments.codex.isolated = true;
  const sending = h.manager.send('codex', { sessionId: c.id, editSeq: h.run.userSeq, prompt: 'Revised task' });
  const rejected = assert.rejects(sending, /Edit canceled/);
  await h.flush(); assert.equal(h.ensured.length, 1);
  const stopping = h.manager.cancel({ sessionId: c.id });
  h.complete(); await h.sweep; await rejected; await stopping;
  assert.equal(h.ensured.length, 1); assert.equal(h.sent.length, 1);
});

test('native compaction waits for teardown and completion earns a new idle window', async t => {
  const h = await closingFixture(t), compacting = h.manager.compact(h.run.sessionId);
  await h.flush(); assert.equal(h.ensured.length, 1);
  h.complete(); await h.sweep;
  const result = await compacting; assert.equal(result.ok, true);
  assert.equal(h.ensured.length, 2);
  h.advance(99); assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(1); assert.deepEqual(await h.reaper.sweep(), [h.run.sessionId]);
});

test('stopping compaction during teardown prevents native compaction from opening', async t => {
  const h = await closingFixture(t), compacting = h.manager.compact(h.run.sessionId);
  const rejected = assert.rejects(compacting, /canceled/);
  await h.flush(); const stopping = h.manager.cancel({ sessionId: h.run.sessionId });
  h.complete(); await h.sweep; await rejected; await stopping;
  assert.equal(h.ensured.length, 1);
});

test('long native compaction is protected and starts retention when it completes', async t => {
  const h = fixture(t), run = await h.manager.send('codex', { prompt: 'Stored native context' });
  h.finish('codex'); await run.done; await h.reaper.sweep();
  h.sent.at(-1).session.compact = async () => {
    h.advance(500); assert.deepEqual(await h.reaper.sweep(), []);
    return { ok: true };
  };
  assert.equal((await h.manager.compact(run.sessionId)).ok, true);
  h.advance(99); assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(1); assert.deepEqual(await h.reaper.sweep(), [run.sessionId]);
});

test('desktop driver wiring refreshes the actual Claude pool and preserves native history on release', async t => {
  const { createHarness } = require('./claude-harness.cjs');
  const h = createHarness(); t.after(h.cleanup); h.configureApi();
  let now = 0; const pool = h.api.claudeSessions; pool.now = () => now;
  const manager = h.api.sharedConversations;
  const reaper = new IdleSessionReaper([pool], { now: () => now, timeoutMs: 100, isBlocked: id => manager.busy(id) });
  t.after(() => reaper.stop());
  const run = await manager.send('claude', { prompt: 'Keep my real native context' });
  await reaper.sweep(); now = 500;
  assert.deepEqual(await reaper.sweep(), []);
  const nativeId = h.finishTurn(), proc = h.processes.at(-1); await run.done;
  const nativeFile = h.api.sharedConversations.drivers.claude.history.find(nativeId);
  const before = fs.readFileSync(nativeFile);
  now = 599; assert.deepEqual(await reaper.sweep(), []);
  now = 600; assert.deepEqual(await reaper.sweep(), [run.sessionId]);
  assert.equal(proc.killed, true); assert.deepEqual(fs.readFileSync(nativeFile), before);
});
