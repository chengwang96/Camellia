'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDesktopRestart } = require('../src/main/remote/desktop-restart');
const { removeTree } = require('./test-fs.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-restart-'));
  t.after(() => removeTree(root));
  const file = path.join(root, 'receipts.json'), scheduled = [];
  let calls = 0;
  const service = createDesktopRestart({ file, restart: () => { calls++; }, schedule: (fn, delay) => { assert.equal(delay, 1000); scheduled.push(fn); }, ...options });
  const request = { requestId: randomUUID(), instanceId: randomUUID(), confirmed: true };
  return { service, file, request, scheduled, get calls() { return calls; } };
}

test('desktop restart requires explicit confirmation, an exact payload and the current desktop instance', async t => {
  const h = fixture(t);
  for (const payload of [null, [], {}, { ...h.request, confirmed: false }, { ...h.request, requestId: 'bad' }, { ...h.request, command: 'exit' }])
    await assert.rejects(h.service.submit('phone', payload, h.request.instanceId), { status: 400 });
  await assert.rejects(h.service.submit('phone', h.request, randomUUID()), { status: 409 });
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.scheduled.length, 0);
});

test('desktop restart saves settings and its receipt before acknowledgment and executes only after the reply', async t => {
  let prepared = 0, release;
  const h = fixture(t, { prepare: () => { prepared++; return new Promise(resolve => { release = resolve; }); } });
  const first = h.service.submit('phone', h.request, h.request.instanceId);
  const duplicate = h.service.submit('phone', h.request, h.request.instanceId);
  await new Promise(setImmediate);
  assert.equal(prepared, 1); assert.equal(fs.existsSync(h.file), false);
  await assert.rejects(h.service.submit('other-phone', { ...h.request, requestId: randomUUID() }, h.request.instanceId), { status: 409 });
  release();
  assert.deepEqual(await first, await duplicate);
  assert.equal(JSON.parse(fs.readFileSync(h.file))[0].requestId, h.request.requestId);
  assert.equal(h.scheduled.length, 0); assert.equal(h.calls, 0);
  h.service.afterReply('other-phone', h.request.requestId);
  assert.equal(h.scheduled.length, 0);
  h.service.afterReply('phone', h.request.requestId);
  h.service.afterReply('phone', h.request.requestId);
  assert.equal(h.scheduled.length, 1);
  h.scheduled[0](); await new Promise(setImmediate);
  assert.equal(h.calls, 1);

  const restored = createDesktopRestart({ file: h.file, restart: () => assert.fail('Do not restart twice'), schedule: () => assert.fail('Do not schedule a replay') });
  assert.equal((await restored.submit('phone', h.request, randomUUID())).state, 'complete');
  restored.afterReply('phone', h.request.requestId);
  await assert.rejects(restored.submit('phone', { ...h.request, instanceId: randomUUID() }, randomUUID()), { status: 409 });
});

test('failed settings saves, revoked permissions and receipt failures never schedule a restart', async t => {
  const h = fixture(t, { prepare: async () => { throw new Error('Settings did not save'); } });
  await assert.rejects(h.service.submit('phone', h.request, h.request.instanceId), /did not save/);
  assert.equal(fs.existsSync(h.file), false); assert.equal(h.scheduled.length, 0);
  const revoked = fixture(t);
  await assert.rejects(revoked.service.submit('phone', revoked.request, revoked.request.instanceId, () => { throw new Error('Revoked'); }), /Revoked/);
  assert.equal(fs.existsSync(revoked.file), false); assert.equal(revoked.scheduled.length, 0);
  const unwritable = fixture(t);
  fs.mkdirSync(unwritable.file);
  await assert.rejects(unwritable.service.submit('phone', unwritable.request, unwritable.request.instanceId));
  unwritable.service.afterReply('phone', unwritable.request.requestId);
  assert.equal(unwritable.scheduled.length, 0);
});

test('a relaunch failure is recorded and its request is never automatically repeated', async t => {
  const h = fixture(t, { restart: () => { throw new Error('Cannot relaunch'); } });
  await h.service.submit('phone', h.request, h.request.instanceId);
  h.service.afterReply('phone', h.request.requestId); h.scheduled[0]();
  await new Promise(setImmediate);
  assert.equal((await h.service.submit('phone', h.request, h.request.instanceId)).state, 'failed');
  h.service.afterReply('phone', h.request.requestId);
  assert.equal(h.scheduled.length, 1);
});
