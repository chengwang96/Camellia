'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');
const { runReviewJob } = require('../src/engines/review-worker');

test('review worker captures, copies and rechecks a real workspace without blocking the caller', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-review-worker-'));
  t.after(() => removeTree(root));
  execFileSync('git', ['init'], { cwd: root, windowsHide: true });
  fs.writeFileSync(path.join(root, 'change.txt'), 'reviewed content');
  const summary = await runReviewJob('summary', { cwd: root });
  assert.equal(summary.count, 1);
  const target = await runReviewJob('capture', { cwd: root, options: { includeUntracked: true } });
  assert.equal(target.untracked[0].text, 'reviewed content');
  const snapshot = await runReviewJob('snapshot', { cwd: target.cwd, destination: path.join(root, 'snapshot') });
  assert.equal(snapshot.files, 1);
  assert.equal(fs.readFileSync(path.join(snapshot.directory, 'change.txt'), 'utf8'), 'reviewed content');
  assert.equal(fs.readFileSync(path.join(root, 'change.txt'), 'utf8'), 'reviewed content');
});

test('review worker accepts cancellation and remains usable for later work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-review-cancel-'));
  t.after(() => removeTree(root));
  execFileSync('git', ['init'], { cwd: root, windowsHide: true });
  fs.writeFileSync(path.join(root, 'change.txt'), 'later work');
  const controller = new AbortController();
  const pending = runReviewJob('capture', { cwd: root, options: {} }, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  const summary = await runReviewJob('summary', { cwd: root });
  assert.equal(summary.count, 1);
});

test('cancelling review preparation removes partial snapshots and releases its reservation', async t => {
  const { ReviewController } = require('../src/engines/review-control');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-review-prepare-cancel-'));
  t.after(() => removeTree(root));
  execFileSync('git', ['init'], { cwd: root, windowsHide: true });
  fs.writeFileSync(path.join(root, 'change.txt'), 'content');
  const target = await runReviewJob('capture', { cwd: root, options: {} });
  const parent = { id: 'parent', currentEngine: 'codex', cwd: root };
  const manager = { items: new Map([['parent', parent]]), get: () => parent, busy: () => false,
    validateEngine() {}, settings: () => ({ connection: 'api', model: 'fixture' }) };
  const controller = new ReviewController({ manager, dir: path.join(root, 'reviews'), skills: {} });
  const started = controller.start('parent', { reviewerEngine: 'codex', allowSameEngine: true }, { target });
  let id;
  for (let attempt = 0; attempt < 100 && !controller.pendingSnapshots.size; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  id = controller.pendingSnapshots.keys().next().value;
  assert.ok(id);
  await controller.cancel(id);
  await assert.rejects(started, error => error.name === 'AbortError');
  assert.equal(controller.pendingSnapshots.size, 0);
  assert.deepEqual(fs.readdirSync(controller.snapshotRoot), []);
});
