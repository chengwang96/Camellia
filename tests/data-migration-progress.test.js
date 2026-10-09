'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createDataPackage, importDataPackage } = require('../src/main/data-migration');
const { ImportTransaction } = require('../src/main/data-import-transaction');
const { removeTree } = require('./test-fs.cjs');

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-transfer-progress-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-transfer-progress-'));
    removeTree(root);
  });
  return { root, dataDir: path.join(root, 'app'), home: path.join(root, 'home') };
}

function write(box, relative, contents) {
  const file = path.join(box.dataDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function assertPendingProgress(events, phases) {
  assert.deepEqual([...new Set(events.map(event => event.phase))], phases);
  let previous = 0;
  for (const event of events) {
    assert.ok(Number.isInteger(event.percent), 'Every transfer update has an overall percentage');
    assert.ok(event.percent >= previous, `${event.phase} moved backward from ${previous} to ${event.percent}`);
    assert.ok(event.percent < 100, 'Streaming, validation and activation must not claim completion');
    previous = event.percent;
  }
  assert.equal(previous, 99, 'Successful work reserves completion for the operation result');
}

// Exercise real archive streams and part activation with small fixtures rather
// than allocating the production multi-gigabyte archive limit.
function smallPartExporter() {
  const file = require.resolve('../src/main/data-migration');
  const original = fs.readFileSync(file, 'utf8');
  const source = original.replace('const MAX_PART_BYTES = 3 * 1024 ** 3;', 'const MAX_PART_BYTES = 12 * 1024;');
  assert.notEqual(source, original, 'The fixture must lower the archive partition limit');
  const context = { require: createRequire(file), module: { exports: {} }, Buffer, process, setImmediate, setTimeout };
  vm.runInNewContext(source, context, { filename: file });
  return context.module.exports.createDataPackage;
}

test('multipart export reports cumulative bytes across snapshot and every archive', async t => {
  const source = profile(t);
  write(source, 'desktop-config.json', '{"language":"en"}');
  for (let index = 0; index < 3; index++) write(source, `conversations/${index}.jsonl`, 'x'.repeat(10 * 1024));
  const events = [];
  const result = await smallPartExporter()({ ...source, destination: path.join(source.root, 'profile.zip'),
    onProgress: state => events.push(state) });
  assert.equal(result.parts.length, 3);
  assertPendingProgress(events, ['snapshot', 'export']);
  const exporting = events.filter(event => event.phase === 'export');
  const total = 30 * 1024 + Buffer.byteLength('{"language":"en"}');
  assert.ok(exporting.every(event => event.totalBytes === total));
  assert.equal(exporting.at(-1).bytes, total);
  for (let index = 1; index < exporting.length; index++) assert.ok(exporting[index].bytes >= exporting[index - 1].bytes);
  assert.ok(exporting.some(event => event.bytes > 10 * 1024 && event.bytes < total), 'Progress includes later archive parts');
});

test('import progress includes staging validation and activation for more than 200 files', async t => {
  const source = profile(t), target = profile(t);
  write(source, 'desktop-config.json', JSON.stringify({ language: 'en', memoryDirectory: path.join(source.dataDir, 'memory') }));
  for (let index = 0; index < 405; index++) write(source, `conversations/${index}.jsonl`, '{"seq":1}\n');
  const file = path.join(source.root, 'profile.zip');
  await createDataPackage({ ...source, destination: file });
  const events = [];
  const result = await importDataPackage({ ...target, file, onProgress: state => events.push(state) });
  assert.equal(result.restored, 406);
  assertPendingProgress(events, ['import', 'rewrite', 'apply']);
  assert.ok(events.some(event => event.phase === 'apply' && event.files === 200));
  assert.equal(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'desktop-config.json'), 'utf8')).memoryDirectory,
    path.join(target.dataDir, 'memory'));
});

test('a transfer containing only an empty file still advances without early completion', async t => {
  const source = profile(t), target = profile(t), file = path.join(source.root, 'empty.zip');
  write(source, 'conversations/empty.jsonl', '');
  const exporting = [], importing = [];
  await createDataPackage({ ...source, destination: file, onProgress: state => exporting.push(state) });
  const result = await importDataPackage({ ...target, file, onProgress: state => importing.push(state) });
  assert.equal(result.restored, 1);
  assertPendingProgress(exporting, ['snapshot', 'export']);
  assertPendingProgress(importing, ['import', 'rewrite', 'apply']);
  assert.equal(fs.statSync(path.join(target.dataDir, 'conversations/empty.jsonl')).size, 0);
});

test('a failed import commit never reports 100% and restores the original profile', async t => {
  const source = profile(t), target = profile(t), file = path.join(source.root, 'profile.zip');
  write(source, 'desktop-config.json', '{"language":"zh-CN"}');
  write(target, 'desktop-config.json', '{"language":"en"}');
  await createDataPackage({ ...source, destination: file });
  t.mock.method(ImportTransaction.prototype, 'commit', () => { throw new Error('Commit failed'); });
  const events = [];
  await assert.rejects(importDataPackage({ ...target, file, onProgress: state => events.push(state) }), /Commit failed/);
  assertPendingProgress(events, ['import', 'rewrite', 'apply']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'desktop-config.json'), 'utf8')), { language: 'en' });
});
