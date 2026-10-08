'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AttachmentMaintenance } = require('../src/main/attachment-maintenance');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageCleanup, PROTECTION_MS } = require('../src/main/storage-cleanup');
const { createRemoteService } = require('../src/main/remote/service');
const { removeTree } = require('./test-fs.cjs');
const tick = () => new Promise(setImmediate);

function setup(t, sweep = async () => ({ files: 0, bytes: 0 })) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000, calls = 0;
  const logs = [], cleanup = { async sweepAttachments() { calls++; return sweep(); } };
  const maintenance = new AttachmentMaintenance({ cleanup, log: value => logs.push(value), delayMs: 30, now: () => now });
  t.after(() => maintenance.close());
  return { maintenance, logs, calls: () => calls, cleanup,
    async advance(ms) { now += ms; t.mock.timers.tick(ms); await tick(); } };
}

test('startup and repeated changes coalesce into one pass, with no periodic history rescan', async t => {
  const h = setup(t);
  h.maintenance.markDirty(); h.maintenance.markDirty();
  await h.advance(29); assert.equal(h.calls(), 0);
  await h.advance(1); assert.equal(h.calls(), 1);
  await h.advance(86400000); assert.equal(h.calls(), 1);
  h.maintenance.markDirty(); await h.advance(30); assert.equal(h.calls(), 2);
});

test('active work defers the pass and one later idle pass ends the retry timer', async t => {
  let active = true;
  const h = setup(t, async () => active ? { deferred: true } : { files: 0, bytes: 0 });
  await h.advance(30); assert.equal(h.calls(), 1);
  active = false; await h.advance(30); assert.equal(h.calls(), 2);
  await h.advance(300); assert.equal(h.calls(), 2);
});

test('young files receive one age wake, and a new change brings the wake forward', async t => {
  const h = setup(t, async () => h.calls() < 3 ? { nextSweepAt: 1100 } : { files: 1, bytes: 10 });
  await h.advance(30); assert.equal(h.calls(), 1);
  await h.advance(20); h.maintenance.markDirty();
  await h.advance(30); assert.equal(h.calls(), 2);
  await h.advance(19); assert.equal(h.calls(), 2);
  await h.advance(1); assert.equal(h.calls(), 3);
  await h.advance(100); assert.equal(h.calls(), 3);
  assert.match(h.logs[0], /1 unused.*10 bytes/);
});

test('a backup expiry beyond the timer range waits without creating a millisecond retry loop', async t => {
  const h = setup(t, async () => ({ files: 0, bytes: 0, nextSweepAt: 1000 + 30 * 86400000 }));
  await h.advance(30); assert.equal(h.calls(), 1);
  await h.advance(1000); assert.equal(h.calls(), 1);
  await h.advance(0x7fffffff - 1000); assert.equal(h.calls(), 2);
});

test('changes during a running pass schedule one follow-up without overlapping scans', async t => {
  let finish;
  const h = setup(t, () => new Promise(resolve => { finish = resolve; }));
  await h.advance(30); assert.equal(h.calls(), 1);
  h.maintenance.markDirty(); await h.advance(30); assert.equal(h.calls(), 1);
  finish({ files: 0, bytes: 0 }); await tick();
  await h.advance(30); assert.equal(h.calls(), 2);
  finish({ files: 0, bytes: 0 }); await tick();
  await h.advance(300); assert.equal(h.calls(), 2);
});

test('a stable unreadable reference is logged once and waits for new activity', async t => {
  const h = setup(t, async () => { throw new Error('Invalid saved reference'); });
  await h.advance(30); await h.advance(300);
  assert.equal(h.calls(), 1); assert.equal(h.logs.length, 1);
  h.maintenance.markDirty(); await h.advance(30); assert.equal(h.calls(), 2);
});

test('close cancels a pending age wake and waits for an existing pass', async t => {
  let finish;
  const h = setup(t, () => new Promise(resolve => { finish = resolve; }));
  await h.advance(30);
  let closed = false;
  const closing = h.maintenance.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  finish({ nextSweepAt: 2000 }); await closing;
  h.maintenance.markDirty(); await h.advance(2000);
  assert.equal(h.calls(), 1); assert.equal(h.maintenance.timer, null);
});

test('close aborts a scanner at its next yield so shutdown does not wait for a full history scan', async t => {
  const h = setup(t, async () => {
    await tick(); h.cleanup.signal.throwIfAborted(); return { files: 0, bytes: 0 };
  });
  const pass = h.maintenance.run();
  await h.maintenance.close(); await pass;
  assert.equal(h.cleanup.signal.aborted, true); assert.equal(h.logs.length, 0);
});

test('service cleanup starts with remote networking disabled and preserves the manual preview', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-service-'));
  const directory = path.join(dataDir, 'remote/device-attachments'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'a'.repeat(64) + '.txt'); fs.writeFileSync(file, 'orphan');
  const old = new Date(Date.now() - 2 * PROTECTION_MS); fs.utimesSync(file, old, old);
  const manager = { items: new Map() }, logs = [];
  const service = createRemoteService({ dataDir, manager, networkFactory: () => { assert.fail('Cleanup must not start networking'); } });
  const cleaner = new StorageCleanup({ dataDir, conversations: manager, references: async () => [] });
  t.after(async () => { await service.close(); clearTimeout(cleaner.previewTimer); removeTree(dataDir); });
  const preview = await cleaner.scan();
  service.maintainAttachments(cleaner, value => logs.push(value));
  t.mock.timers.tick(30000);
  for (let i = 0; i < 100 && !logs.length; i++) await tick();
  assert.equal(fs.existsSync(file), false); assert.equal(logs.length, 1);
  assert.equal(cleaner.preview.token, preview.token);
  const added = path.join(directory, 'b'.repeat(64) + '.txt'); fs.writeFileSync(added, 'new orphan'); fs.utimesSync(added, old, old);
  service.attachmentsChanged(); service.attachmentsChanged(); t.mock.timers.tick(30000);
  for (let i = 0; i < 100 && logs.length < 2; i++) await tick();
  assert.equal(fs.existsSync(added), false); assert.equal(logs.length, 2);
  assert.equal(cleaner.preview.token, preview.token);
});
