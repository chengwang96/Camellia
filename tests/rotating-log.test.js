'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { RotatingLog, logFiles } = require('../src/main/rotating-log');
const { StorageCleanup } = require('../src/main/storage-cleanup');
const { removeTree } = require('./test-fs.cjs');
const DAY = 86400000, tick = () => new Promise(setImmediate);
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotating-log-')), directory = path.join(root, 'logs');
  let now = Date.now();
  const errors = [], writer = new RotatingLog({ directory, now: () => now, onError: e => errors.push(e), ...options });
  t.after(async () => { await writer.close(); removeTree(root); });
  const historical = (age, data = 'diagnostic', prefix = 'dsh-desktop') => {
    const file = path.join(directory, `${prefix}.${Math.floor(now - age * DAY)}.${randomUUID()}.log`);
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, data); return file;
  };
  return { root, directory, writer, errors, historical, advance: ms => { now += ms; } };
}

test('size rotation closes the Windows file handle and retains at most five bounded segments', async t => {
  const h = setup(t, { maxBytes: 180 });
  for (let i = 0; i < 20; i++) { h.writer.write('entry ' + i + ' ' + 'x'.repeat(70)); await h.writer.running; }
  h.writer.write('final record'); await h.writer.close();
  assert.deepEqual(h.errors, []);
  const files = fs.readdirSync(h.directory);
  assert.equal(files.length, 6); // Active plus five historical segments.
  for (const file of files) assert.ok(fs.statSync(path.join(h.directory, file)).size <= 180);
  assert.match(fs.readFileSync(h.writer.file, 'utf8'), /final record/);
  const moved = h.writer.file + '.closed'; fs.renameSync(h.writer.file, moved); assert.ok(fs.existsSync(moved));
});

test('daily rotation works both during a run and on the next application start', async t => {
  const h = setup(t); h.writer.write('previous day'); await h.writer.running;
  h.advance(DAY); h.writer.write('next day'); await h.writer.close();
  assert.deepEqual(h.errors, []); assert.equal(fs.readdirSync(h.directory).length, 2);
  assert.match(fs.readFileSync(h.writer.file, 'utf8'), /next day/); assert.doesNotMatch(fs.readFileSync(h.writer.file, 'utf8'), /previous day/);
  const old = new Date(Date.now() - DAY * 2); fs.utimesSync(h.writer.file, old, old);
  const restarted = new RotatingLog({ directory: h.directory }); restarted.write('restart'); await restarted.close();
  assert.match(fs.readFileSync(restarted.file, 'utf8'), /restart/); assert.doesNotMatch(fs.readFileSync(restarted.file, 'utf8'), /next day/);
});

test('age/count pruning touches only recognized history and excludes links and active logs', async t => {
  const h = setup(t), old = h.historical(15), keep = h.historical(1), external = path.join(h.root, 'external.log');
  const linked = h.historical(20); fs.linkSync(linked, external);
  const custom = path.join(h.directory, 'user.log'); fs.writeFileSync(custom, 'user diagnostic');
  h.writer.write('active'); await h.writer.close();
  assert.equal(fs.existsSync(old), false);
  for (const file of [keep, linked, external, custom, h.writer.file]) assert.ok(fs.existsSync(file));
  assert.deepEqual(logFiles(h.directory), []);
});

test('a pre-existing oversized log is rotated without reading its full contents', async t => {
  const h = setup(t, { maxBytes: 200 }), io = Object.create(fs);
  io.readFileSync = () => assert.fail('Log rotation must not buffer an old log');
  h.writer.io = io;
  fs.mkdirSync(h.directory); fs.writeFileSync(h.writer.file, 'x'.repeat(5000));
  h.writer.write('new start'); await h.writer.close();
  assert.equal(fs.readdirSync(h.directory).length, 1); assert.ok(fs.statSync(h.writer.file).size <= 200);
  assert.match(fs.readFileSync(h.writer.file, 'utf8'), /new start/); assert.deepEqual(h.errors, []);
});

test('slow disk writes bound memory, truncate giant entries and record dropped queue entries', async t => {
  const h = setup(t, { queueBytes: 256, lineBytes: 128 }), io = Object.create(fs), chunks = [], callbacks = [];
  io.createWriteStream = () => new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); callbacks.push(done); } });
  h.writer.io = io;
  h.writer.write('x'.repeat(2 * 1024 * 1024));
  for (let i = 0; i < 1000; i++) h.writer.write('queued ' + i + ' ' + 'y'.repeat(50));
  assert.ok(h.writer.pendingBytes <= 256); assert.equal(callbacks.length, 1); assert.ok(h.writer.dropped > 900);
  let closed = false; const closing = h.writer.close().then(() => { closed = true; });
  for (let i = 0; i < 20 && !closed; i++) { callbacks.shift()?.(); await tick(); }
  await closing;
  assert.ok(chunks.every(chunk => chunk.length <= 128));
  const output = Buffer.concat(chunks).toString(); assert.match(output, /truncated/); assert.match(output, /Dropped \d+ diagnostic log entries/);
  assert.equal(h.writer.pendingBytes, 0); assert.equal(h.writer.queue.length, 0); assert.deepEqual(h.errors, []);
});

test('fatal records are synchronously durable, separately bounded, and survive normal shutdown', async t => {
  const h = setup(t), file = path.join(h.directory, 'dsh-desktop-fatal.log');
  h.writer.write('normal queue');
  for (let i = 0; i < 9; i++) assert.equal(h.writer.fatal('FATAL ' + i + ' ' + 'x'.repeat(100000)), true);
  assert.match(fs.readFileSync(file, 'utf8'), /FATAL 8/); assert.ok(fs.statSync(file).size <= 256 * 1024);
  await h.writer.close();
  assert.match(fs.readFileSync(h.writer.file, 'utf8'), /normal queue/);
  assert.ok(fs.readdirSync(h.directory).filter(name => name.startsWith('dsh-desktop-fatal.')).length <= 5);
});

test('an invalid or unwritable active log does not reject the drain or write through a hard link', async t => {
  const h = setup(t); fs.mkdirSync(h.directory);
  fs.writeFileSync(h.writer.file, 'external'); const outside = path.join(h.root, 'external.log'); fs.linkSync(h.writer.file, outside);
  h.writer.write('cannot append'); await h.writer.close();
  assert.equal(h.errors.length, 1); assert.equal(fs.readFileSync(outside, 'utf8'), 'external');
});

test('manual space preview includes old recognized logs while protecting active logs and exported ZIPs', async t => {
  const h = setup(t), expired = h.historical(15); h.writer.write('active'); await h.writer.close();
  const userZip = path.join(h.root, 'user-export.zip'); fs.writeFileSync(userZip, 'user backup');
  const fatal = path.join(h.directory, 'dsh-desktop-fatal.log'); fs.writeFileSync(fatal, 'crash reason');
  const cleaner = new StorageCleanup({ dataDir: h.root, conversations: { items: new Map() }, references: async () => [] });
  t.after(() => clearTimeout(cleaner.previewTimer));
  // Add an old file after logger shutdown so the preview, not logger pruning, removes it.
  fs.writeFileSync(expired, 'old diagnostic');
  const preview = await cleaner.scan(); assert.deepEqual(preview.candidates.map(c => c.category), ['Old diagnostic logs']);
  const result = await cleaner.clean(preview.token); assert.equal(result.files, 1);
  for (const file of [h.writer.file, fatal, userZip]) assert.ok(fs.existsSync(file)); assert.equal(fs.existsSync(expired), false);
});
