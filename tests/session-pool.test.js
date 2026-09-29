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
