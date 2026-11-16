'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');
const { SessionPool } = require('../src/engines/session-pool');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-retention-'));
  let manager, generation = 0;
  const pools = Object.fromEntries(ENGINES.map(engine => [engine, new SessionPool()]));
  const drivers = Object.fromEntries(ENGINES.map(engine => [engine, {
    sessions: pools[engine], settings: () => ({ model: 'fixture' }), saveSettings: value => value,
    ensure(opts) {
      let session = pools[engine].get(opts);
      if (session) return session;
      session = { gen: ++generation, sessionId: engine + '-' + generation,
        opts, settings: { cwd: opts.cwd }, running: false, dead: false, children: new Map(),
        sendUserMessage() {
          session.running = true;
          manager.capture(engine, { type: 'system', subtype: 'init',
            session_id: session.sessionId, runId: session.gen });
          return true;
        },
        shutdown() { session.dead = true; }, interrupt() { session.running = false; },
        controlChild(id, payload) { session.lastControl = { id, ...payload }; },
      };
      pools[engine].set(opts, session);
      return session;
    },
  }]));
  manager = new SharedConversations({ dir: root, skillsDir: path.join(root, 'skills'),
    loadConfig: () => ({}), saveConfig() {}, drivers });
  t.after(() => {
    manager.pauseGoals();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('session-retention-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function launch() {
    const conversation = manager.create('codex', null, 'Retention fixture');
    const run = await manager.send('codex', { sessionId: conversation.id, prompt: 'Fixture only' });
    const session = pools.codex.get({ conversationId: conversation.id });
    session.children.set('child', {});
    const capture = task => manager.capture('codex', { type: 'gui:subagent',
      conversationId: conversation.id, runId: session.gen, task: { id: 'child', ...task } });
    assert.equal(capture({ status: 'completed', result: 'Saved result', turnId: 'turn-1', canReply: true }), true);
    session.running = false;
    manager.capture('codex', { type: 'result', subtype: 'success',
      session_id: session.sessionId, runId: session.gen, result: 'Done' });
    await run.done;
    return { id: conversation.id, session, capture };
  }
  return { manager, pool: pools.codex, launch };
}

test('permanent deletion clears all child-session routing entries and native pools', async t => {
  const h = fixture(t);
  for (let i = 0; i < 8; i++) {
    const { id } = await h.launch();
    await h.manager.deleteConversation(id);
    assert.equal(h.manager.items.size, 0);
    assert.equal(h.pool.sessions.size, 0);
    assert.equal(h.manager.subagentSessions.size, 0);
  }
});

test('parent completion preserves live child controls; a released producer loses them', async t => {
  const h = fixture(t), { id, session, capture } = await h.launch();
  assert.equal(capture({ status: 'running', canReply: true, canStop: true }), true);
  assert.equal(h.manager.subagentView(id)[0].connected, true);
  await h.manager.subagentCommand(id, { engine: 'codex', taskId: 'child', operation: 'reply',
    expectedTurnId: 'turn-1', prompt: 'Follow up' });
  assert.equal(session.lastControl.operation, 'reply');
  session.children.get('child').status = 'completed';
  await h.pool.release({ conversationId: id });
  assert.equal(h.manager.subagentView(id)[0].connected, false);
  assert.equal(h.manager.subagentSessions.size, 0);
  assert.equal(capture({ status: 'running' }), false);
  await assert.rejects(h.manager.subagentCommand(id, { engine: 'codex', taskId: 'child', operation: 'reply' }), /no longer connected/);
});

test('a failed native shutdown retains its live child controls for retry', async t => {
  const h = fixture(t), { id, session } = await h.launch();
  session.shutdown = () => { throw new Error('Not stopped'); };
  await assert.rejects(h.pool.release({ conversationId: id }), /Not stopped/);
  assert.equal(h.manager.subagentView(id)[0].connected, true);
  assert.equal(h.manager.subagentSession(id, 'codex'), session);
});

test('idle teardown permits session GC while preserving saved subagent history', { skip: !global.gc }, async t => {
  const h = fixture(t);
  const released = await (async () => {
    const { id, session } = await h.launch();
    const weak = new WeakRef(session);
    await h.pool.release({ conversationId: id });
    return { id, weak };
  })();
  for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
  assert.equal(released.weak.deref(), undefined, 'the shared manager must not pin a released native session');
  assert.equal(h.manager.get(released.id).subagents[0].result, 'Saved result');
  assert.equal(h.manager.subagentView(released.id)[0].connected, false);
});
