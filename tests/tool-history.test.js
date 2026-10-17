'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { retainEvent, projectRow, INLINE_CHARS } = require('../src/engines/tool-history');
const { ConversationHistory } = require('../src/engines/conversation-history');
const { appendText } = require('../src/shared/file-open');
const { removeTree } = require('./test-fs.cjs');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tool-history-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); removeTree(root); });
  return root;
}

test('large tool previews retain the complete event and preserve lifecycle, paths and both ends of output', t => {
  const root = fixture(t), output = 'START\n' + 'diff 中文😀\n'.repeat(100000) + '\nFINISH';
  const event = { type: 'gui:tool', id: 'edit', name: 'fileChange', input: { changes: [{ path: '/work/slide.xml', kind: { type: 'update' }, diff: output }] },
    output, status: 'completed', is_error: false, runId: 9 };
  const result = retainEvent(event, root);
  assert.ok(JSON.stringify(result).length < INLINE_CHARS);
  assert.equal(result.id, event.id); assert.equal(result.status, 'completed'); assert.equal(result.runId, 9);
  assert.equal(result.input.changes[0].path, '/work/slide.xml');
  assert.match(result.output, /START/); assert.match(result.output, /FINISH/);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.fullOutput.path, 'utf8')), event);
  assert.equal(event.output, output);
  assert.deepEqual(retainEvent(event, root), result);
  assert.equal(fs.readdirSync(root).length, 1);
});

test('ordinary tools remain unchanged and huge arrays cannot make an unbounded preview', t => {
  const root = fixture(t), small = { type: 'gui:tool', id: 'small', output: 'ok' };
  assert.equal(retainEvent(small, root), small);
  const event = { type: 'gui:tool', id: 'many', input: Array.from({ length: 20000 }, (_, i) => ({ number: i, nested: ['x'.repeat(50)] })), status: 'completed' };
  const result = retainEvent(event, root);
  assert.ok(JSON.stringify(result).length < INLINE_CHARS);
  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(result.fullOutput.path)).input.length, 20000);
});

test('failed complete-record persistence is reported instead of losing the original behind a successful preview', t => {
  const root = fixture(t), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).startsWith(root)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return write(file, ...args);
  });
  assert.throws(() => retainEvent({ type: 'gui:tool', output: 'x'.repeat(INLINE_CHARS + 1) }, root), /disk full/);
});

test('legacy oversized tools use persistent bounded projections without rewriting authoritative history', t => {
  const root = fixture(t), file = path.join(root, 'sample.jsonl');
  const tool = { seq: 1, role: 'tool', text: JSON.stringify({ type: 'gui:tool', id: 'legacy', output: 'a'.repeat(4 * 1024 * 1024) + 'END', status: 'completed' }) };
  fs.writeFileSync(file, JSON.stringify(tool) + '\n');
  const original = fs.readFileSync(file), store = new ConversationHistory(root);
  t.after(() => store.close());
  const row = store.rows('sample')[0];
  assert.ok(row.text.length < INLINE_CHARS); assert.match(row.text, /END/);
  const reference = JSON.parse(row.text).fullOutput;
  assert.equal(reference.path, file); assert.equal(reference.offset, 0);
  assert.deepEqual(JSON.parse(original.subarray(reference.offset, reference.offset + reference.length)), tool);
  assert.ok(store.estimate('sample') < 50000);
  store.close();
  const restarted = new ConversationHistory(root); t.after(() => restarted.close());
  for (let i = 0; i < 5; i++) { assert.deepEqual(restarted.rows('sample')[0], row); restarted.cache.clear(); restarted.used = 0; }
  assert.equal(restarted.metrics.historyBytes, 0);
  assert.deepEqual(fs.readFileSync(file), original);
  restarted.remove('sample');
  assert.equal(fs.readdirSync(restarted.indexDir).filter(name => name.endsWith('.tool')).length, 0);
  assert.deepEqual(fs.readFileSync(file), original);
});

test('corrupt tool preview caches are rebuilt from the original, never treated as authoritative', t => {
  const root = fixture(t), file = path.join(root, 'sample.jsonl');
  const raw = JSON.stringify({ seq: 1, role: 'tool', text: JSON.stringify({ type: 'gui:tool', output: 'ORIGINAL'.repeat(50000) }) }) + '\n';
  fs.writeFileSync(file, raw);
  const store = new ConversationHistory(root); t.after(() => store.close());
  const expected = store.rows('sample')[0]; store.close();
  const preview = fs.readdirSync(store.indexDir).find(name => name.endsWith('.tool'));
  fs.writeFileSync(path.join(store.indexDir, preview), JSON.stringify({ row: { seq: 1, role: 'tool', text: 'CORRUPTED' }, checksum: 'wrong' }));
  assert.deepEqual(store.rows('sample')[0], expected);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('tool projection never shortens user requests or assistant prose', () => {
  for (const role of ['user', 'assistant', 'revision']) {
    const row = { role, text: 'x'.repeat(INLINE_CHARS * 2) };
    assert.equal(projectRow(row, { path: 'history.jsonl' }), row);
  }
  const plain = { role: 'tool', text: 'Historical plain text '.repeat(INLINE_CHARS) };
  assert.equal(projectRow(plain, { path: 'history.jsonl' }), plain);
});

test('shared replay descriptors close on early return and reject a source changed mid-iteration', t => {
  const root = fixture(t), file = path.join(root, 'sample.jsonl');
  fs.writeFileSync(file, [1, 2].map(seq => JSON.stringify({ seq, role: 'user', text: 'message' }) + '\n').join(''));
  const store = new ConversationHistory(root); t.after(() => store.close()); store.ensure('sample');
  const open = fs.openSync, close = fs.closeSync, descriptors = new Set();
  t.mock.method(fs, 'openSync', (target, ...args) => { const fd = open(target, ...args); if (target === file) descriptors.add(fd); return fd; });
  t.mock.method(fs, 'closeSync', fd => { descriptors.delete(fd); return close(fd); });
  const rows = store.iterate('sample'); assert.equal(rows.next().value.seq, 1);
  assert.equal(descriptors.size, 1); rows.return(); assert.equal(descriptors.size, 0);
  store.close(); const changed = store.iterate('sample'); changed.next();
  fs.appendFileSync(file, JSON.stringify({ seq: 3, role: 'user', text: 'new' }) + '\n');
  assert.throws(() => changed.return(), /changed while reading/);
  assert.equal(descriptors.size, 0);
});

test('a transient open lock retries before writing and appends exactly one complete record', t => {
  const root = fixture(t), file = path.join(root, 'sample.jsonl'), append = fs.appendFileSync;
  let attempts = 0;
  t.mock.method(fs, 'appendFileSync', (target, ...args) => {
    if (target === file && attempts++ < 2) throw Object.assign(new Error('locked'), { code: 'EBUSY', syscall: 'open' });
    return append(target, ...args);
  });
  appendText(file, '{"seq":1}\n');
  assert.equal(attempts, 3);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"seq":1}\n');
});

test('partial writes and permanent storage failures are never replayed', t => {
  const root = fixture(t), file = path.join(root, 'sample.jsonl'), append = fs.appendFileSync;
  let attempts = 0;
  t.mock.method(fs, 'appendFileSync', (target, data, ...args) => {
    attempts++; append(target, data, ...args);
    throw Object.assign(new Error('partial write'), { code: 'EBUSY', syscall: 'write' });
  });
  assert.throws(() => appendText(file, 'once\n'), /partial write/);
  assert.equal(attempts, 1); assert.equal(fs.readFileSync(file, 'utf8'), 'once\n');
});

test('a persistent open lock stops after bounded retries without changing the file', t => {
  const root = fixture(t), file = path.join(root, 'sample.jsonl'), append = fs.appendFileSync;
  fs.writeFileSync(file, 'original\n'); let attempts = 0;
  const denied = t.mock.method(fs, 'appendFileSync', (target, ...args) => {
    if (target === file) { attempts++; throw Object.assign(new Error('locked'), { code: 'EBUSY', syscall: 'open' }); }
    return append(target, ...args);
  });
  assert.throws(() => appendText(file, 'extra\n'), /locked/); denied.mock.restore();
  assert.equal(attempts, 6); assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
});

test('real Windows sharing violations recover after the external owner releases its handle', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture(t), file = path.join(root, 'locked.jsonl'); fs.writeFileSync(file, 'original\n');
  const release = path.join(root, 'release'), released = path.join(root, 'released');
  const script = '$stream = [IO.File]::Open($env:CAMELLIA_LOCK_TEST_FILE, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); try { [Console]::WriteLine("ready"); while (-not [IO.File]::Exists($env:CAMELLIA_LOCK_TEST_RELEASE)) { [Threading.Thread]::Sleep(5) } } finally { $stream.Dispose() }; [IO.File]::WriteAllText($env:CAMELLIA_LOCK_TEST_RELEASED, "released")';
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, env: { ...process.env, CAMELLIA_LOCK_TEST_FILE: file,
      CAMELLIA_LOCK_TEST_RELEASE: release, CAMELLIA_LOCK_TEST_RELEASED: released }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (proc.exitCode === null) proc.kill(); });
  const exited = once(proc, 'exit');
  await new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.stdout.on('data', data => { if (data.toString().includes('ready')) resolve(); });
    proc.stderr.on('data', data => reject(new Error(data.toString())));
    proc.once('exit', () => reject(new Error('Lock owner exited before opening the file')));
  });
  const append = fs.appendFileSync, sleeper = new Int32Array(new SharedArrayBuffer(4)); let attempts = 0;
  t.mock.method(fs, 'appendFileSync', (...args) => {
    attempts++;
    try { return append(...args); }
    catch (error) {
      if (attempts !== 1) throw error;
      assert.equal(error.code, 'EBUSY'); assert.equal(error.syscall, 'open');
      // Observe the actual lock, then acknowledge release outside retryOpen.
      // Runner scheduling must not consume the production 150 ms retry budget.
      fs.writeFileSync(release, 'release');
      const deadline = performance.now() + 10000;
      while (!fs.existsSync(released) && performance.now() < deadline) Atomics.wait(sleeper, 0, 0, 10);
      assert.ok(fs.existsSync(released), 'External owner did not acknowledge releasing its handle');
      throw error;
    }
  });
  appendText(file, 'saved once\n');
  assert.equal(attempts, 2);
  assert.equal((await exited)[0], 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\nsaved once\n');
});
