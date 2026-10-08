'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionPool } = require('../src/engines/session-pool');

test('released conversations stop their native session and discard retained references', async () => {
  const pool = new SessionPool(), options = { conversationId: 'removed' };
  let stopped = 0;
  pool.set(options, { shutdown: async () => stopped++ });
  await pool.release(options);
  assert.equal(stopped, 1);
  assert.equal(pool.get(options), null);
  await pool.release(options);
  assert.equal(stopped, 1);
});

test('release retains running or failed sessions and does not erase a concurrent replacement', async () => {
  const pool = new SessionPool(), options = { conversationId: 'session' };
  const active = { running: true };
  pool.set(options, active);
  await assert.rejects(pool.release(options), /Stop/);
  assert.equal(pool.get(options), active);
  const failed = { shutdown: async () => { throw new Error('still alive'); } };
  pool.set(options, failed);
  await assert.rejects(pool.release(options), /still alive/);
  assert.equal(pool.get(options), failed);
  const replacement = {};
  pool.set(options, { shutdown: async () => pool.set(options, replacement) });
  await pool.release(options);
  assert.equal(pool.get(options), replacement);
});

test('pool reads preserve activity while new instances and explicit use refresh it', () => {
  let now = 0; const pool = new SessionPool({ now: () => now }), options = { conversationId: 'activity' }, first = {};
  pool.set(options, first); const stamp = pool.activity.get(first);
  now = 100; pool.get(options); pool.set(options, first);
  assert.equal(pool.activity.get(first), stamp);
  pool.touch(options); assert.equal(pool.activity.get(first).at, 100);
  const next = {}; now = 200; pool.set(options, next); assert.equal(pool.activity.get(next).at, 200);
});

test('teardown checks the selected instance and a changed eligibility decision', async () => {
  const pool = new SessionPool(), options = { conversationId: 'selected' }; let calls = 0;
  const first = { shutdown: async () => { calls++; } }, next = {};
  pool.set(options, first); pool.set(options, next);
  assert.equal(await pool.release(options, { expected: first }), false);
  pool.set(options, first);
  assert.equal(await pool.release(options, { expected: first, canRelease: () => false }), false);
  assert.equal(calls, 0); assert.equal(pool.get(options), first);
});

test('concurrent release and global shutdown close a native instance once', async () => {
  const pool = new SessionPool(), options = { conversationId: 'closing' }; let finish, calls = 0;
  pool.set(options, { shutdown: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const release = pool.release(options);
  assert.ok(pool.pendingRelease(options));
  await new Promise(setImmediate);
  const joined = pool.release(options), shutdown = pool.shutdown();
  assert.equal(calls, 1); finish();
  await Promise.all([release, joined, shutdown]);
  assert.equal(calls, 1); assert.equal(pool.get(options), null);
});

test('global shutdown still stops a slot removed before an idle release begins', async () => {
  const pool = new SessionPool(), options = { conversationId: 'quit' }; let calls = 0;
  pool.set(options, { shutdown: async () => { calls++; } });
  const release = pool.release(options), shutdown = pool.shutdown();
  assert.equal(await release, false); await shutdown;
  assert.equal(calls, 1); assert.equal(pool.get(options), null);
});
