'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedConversations } = require('../src/engines/shared-conversations');
const { SessionPool } = require('../src/engines/session-pool');
const { removeTree } = require('./test-fs.cjs');

function fixture(t, shutdown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-stop-delete-'));
  t.after(() => removeTree(dir));
  const pool = new SessionPool();
  let manager;
  let session;
  const driver = {
    settings: () => ({ model: 'fixture' }),
    saveSettings: value => value,
    sessions: pool,
    ensure(opts) {
      session = {
        gen: 1, sessionId: opts.sessionId || 'native-fixture', opts, running: false,
        sendUserMessage() {
          this.running = true;
          manager.capture('codex', { type: 'system', subtype: 'init', session_id: this.sessionId, runId: this.gen });
          return true;
        },
        interrupt() {},
        shutdown() { return shutdown(this, manager); },
      };
      pool.set(opts, session);
      return session;
    },
  };
  manager = new SharedConversations({ dir, loadConfig: () => ({}), saveConfig: () => {}, drivers: { codex: driver }, stopTimeoutMs: 5 });
  return { manager, pool, get session() { return session; } };
}

test('stop completes a native turn whose interrupt never replies', async t => {
  const h = fixture(t, async session => { session.dead = true; session.running = false; });
  const run = await h.manager.send('codex', { prompt: 'Work' });
  assert.equal(h.manager.busy(run.sessionId), true);
  assert.deepEqual(await h.manager.cancel({ sessionId: run.sessionId }), { ok: true });
  assert.equal((await run.done).subtype, 'stopped');
  assert.equal(h.manager.busy(run.sessionId), false);
  assert.equal(h.manager.get(run.sessionId).pending, null);
});

test('delete stops a running turn, blocks new sends, releases its process, and removes its history', async t => {
  let beginShutdown;
  const shutdownStarted = new Promise(resolve => { beginShutdown = resolve; });
  let finishShutdown;
  const shutdownGate = new Promise(resolve => { finishShutdown = resolve; });
  const h = fixture(t, async session => {
    beginShutdown();
    await shutdownGate;
    session.dead = true;
    session.running = false;
  });
  const run = await h.manager.send('codex', { prompt: 'Work' });
  const deleted = h.manager.deleteConversation(run.sessionId);
  await shutdownStarted;
  await assert.rejects(h.manager.send('codex', { sessionId: run.sessionId, prompt: 'Late message' }), /stopping or being deleted/);
  finishShutdown();
  assert.deepEqual(await deleted, { ok: true, removed: true });
  assert.equal((await run.done).subtype, 'stopped');
  assert.equal(h.manager.items.has(run.sessionId), false);
  assert.equal(fs.existsSync(h.manager.file(run.sessionId)), false);
  assert.equal(h.pool.get({ conversationId: run.sessionId }), null);
});

test('delete retains history if the engine cannot be confirmed stopped', async t => {
  const h = fixture(t, async () => {});
  const run = await h.manager.send('codex', { prompt: 'Work' });
  await assert.rejects(h.manager.deleteConversation(run.sessionId), /Could not confirm/);
  assert.equal(h.manager.items.has(run.sessionId), true);
  assert.equal(fs.existsSync(h.manager.file(run.sessionId)), true);
  assert.equal(h.pool.get({ conversationId: run.sessionId }), h.session);
});
