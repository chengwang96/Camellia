'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const JSZip = require('jszip');
const unzipper = require('unzipper');
const { openArchive, entryMetadata, readEntry } = require('../src/main/data-import-archive');
const { createDataPackage, importDataPackage, inspectDataPackage, readManifest, MANIFEST, FORMAT } = require('../src/main/data-migration');
const { removeTree } = require('./test-fs.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-import-limits-'));
  t.after(() => removeTree(root));
  return { root, file: path.join(root, 'profile.zip'), dataDir: path.join(root, 'target'), home: path.join(root, 'home') };
}
function manifest(box, files, bytes, extra = {}) {
  return JSON.stringify({ format: FORMAT, version: 1, source: { appDataDir: path.join(box.root, 'source'), home: path.join(box.root, 'source-home') },
    counts: { files, ...(bytes === undefined ? {} : { bytes }) }, ...extra });
}
async function zipFile(file, entries, compression = 'DEFLATE') {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content, { createFolders: false });
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression });
  fs.writeFileSync(file, buffer);
  return buffer;
}
function centralRecord(buffer, name) {
  let at = buffer.readUInt32LE(buffer.length - 6);
  while (buffer.readUInt32LE(at) === 0x02014b50) {
    const length = buffer.readUInt16LE(at + 28);
    if (buffer.subarray(at + 46, at + 46 + length).toString('utf8') === name) return at;
    at += 46 + length + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  throw new Error('Missing fixture entry: ' + name);
}
function seedOldProfile(box) {
  fs.mkdirSync(box.dataDir, { recursive: true });
  fs.writeFileSync(path.join(box.dataDir, 'desktop-config.json'), '{"language":"en"}');
}
function unchanged(box) {
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'desktop-config.json'), 'utf8'), '{"language":"en"}');
  assert.equal(fs.existsSync(path.join(box.dataDir, 'migration-backups')), false);
}

test('selection skips corrupted history and legacy backups without opening their payload streams', async t => {
  const box = setup(t), config = '{"language":"zh-CN"}';
  const history = 'HISTORY_PAYLOAD_MARKER', backup = 'BACKUP_PAYLOAD_MARKER';
  const buffer = await zipFile(box.file, { [MANIFEST]: manifest(box, 3, Buffer.byteLength(config + history + backup)),
    'app/desktop-config.json': config, 'app/conversations/history.jsonl': history,
    'app/migration-backups/old/app/desktop-config.json': backup }, 'STORE');
  buffer[buffer.indexOf(history)] ^= 1; buffer[buffer.indexOf(backup)] ^= 1; fs.writeFileSync(box.file, buffer);
  const directory = await openArchive(box.file);
  const excluded = directory.files.filter(entry => entry.path.includes('history.jsonl') || entry.path.includes('migration-backups'));
  const read = fs.createReadStream, opened = [];
  t.mock.method(fs, 'createReadStream', (name, options) => {
    if (name === box.file) opened.push(options.start);
    return read(name, options);
  });
  const progress = [];
  const preview = await inspectDataPackage(box.file);
  assert.equal(preview.categories.settings.files, 1, 'old backup is not offered as active settings');
  const imported = await importDataPackage({ ...box, scope: 'settings', onProgress: event => progress.push(event) });
  assert.equal(imported.restored, 1); assert.equal(imported.available, 3);
  for (const entry of excluded) assert.equal(opened.some(start => start >= entry.offsetToLocalFileHeader
    && start < entry.offsetToLocalFileHeader + 30 + entry.path.length + entry.compressedSize), false);
  const extraction = progress.filter(event => event.phase === 'import').at(-1);
  assert.equal(extraction.bytes, Buffer.byteLength(config));
  assert.equal(extraction.totalBytes, Buffer.byteLength(config));
  assert.equal(fs.existsSync(path.join(box.dataDir, 'conversations')), false);
  await assert.rejects(importDataPackage({ ...box, scope: 'conversations' }), /checksum/);
});

test('forged manifest size stops actual inflation at its bound and closes the compressed source', async t => {
  const box = setup(t), text = manifest(box, 1, 2) + ' '.repeat(6 * 1024 * 1024);
  const buffer = await zipFile(box.file, { [MANIFEST]: text, 'app/desktop-config.json': '{}' });
  buffer.writeUInt32LE(4 * 1024 * 1024, centralRecord(buffer, MANIFEST) + 24); fs.writeFileSync(box.file, buffer);
  const directory = await openArchive(box.file), entry = directory.files.find(entry => entry.path === MANIFEST);
  const inputs = [], read = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => { const input = read(...args); inputs.push(input); return input; });
  let received = 0;
  await assert.rejects(readEntry({ file: box.file, entry: entryMetadata(entry, directory.dataEnd), maxBytes: 4 * 1024 * 1024, manifest: true,
    output: () => new Writable({ write(chunk, _encoding, done) { received += chunk.length; done(); } }) }), /manifest.*large/);
  assert.equal(received, 4 * 1024 * 1024);
  assert.ok(inputs.every(input => input.destroyed && input.closed));
  seedOldProfile(box);
  await assert.rejects(importDataPackage(box), /manifest.*large/);
  unchanged(box);
});

test('an understated file is stopped before oversized output reaches staging and preserves the profile', async t => {
  const box = setup(t), name = 'app/conversations/large.jsonl', config = '{"language":"zh-CN"}', declared = 32 * 1024;
  const buffer = await zipFile(box.file, { [MANIFEST]: manifest(box, 2, declared + Buffer.byteLength(config)),
    'app/desktop-config.json': config, [name]: Buffer.alloc(8 * 1024 * 1024, 7) });
  buffer.writeUInt32LE(declared, centralRecord(buffer, name) + 24); fs.writeFileSync(box.file, buffer);
  seedOldProfile(box);
  const write = fs.createWriteStream, staged = [], inputs = [], read = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => { const input = read(...args); inputs.push(input); return input; });
  t.mock.method(fs, 'createWriteStream', (file, options) => {
    const output = write(file, options);
    if (String(file).endsWith('large.jsonl')) {
      staged.push(String(file));
      const originalWrite = output.write;
      let accepted = 0;
      output.write = function(chunk, ...args) {
        accepted += chunk.length; assert.ok(accepted <= declared);
        return originalWrite.call(this, chunk, ...args);
      };
    }
    return output;
  });
  await assert.rejects(importDataPackage(box), /larger than declared/);
  assert.ok(staged.length > 0); assert.ok(staged.every(file => !fs.existsSync(file)));
  assert.ok(inputs.every(input => input.destroyed && input.closed));
  unchanged(box);
});

test('uncompressed ordinary files obey the same actual output guard', async t => {
  const box = setup(t), name = 'app/conversations/history.jsonl';
  const buffer = await zipFile(box.file, { [MANIFEST]: manifest(box, 1, 1), [name]: 'not one byte' }, 'STORE');
  buffer.writeUInt32LE(1, centralRecord(buffer, name) + 24); fs.writeFileSync(box.file, buffer);
  seedOldProfile(box);
  await assert.rejects(importDataPackage(box), /larger than declared/); unchanged(box);
});

test('a later selected multipart checksum failure occurs before the first profile overwrite', async t => {
  const box = setup(t), second = path.join(box.root, 'second.zip'), config = '{"language":"zh-CN"}', history = 'SELECTED_HISTORY';
  const header = manifest(box, 2, Buffer.byteLength(config + history), { parts: [{ name: path.basename(box.file) }, { name: path.basename(second) }] });
  await zipFile(box.file, { [MANIFEST]: header, 'app/desktop-config.json': config });
  const buffer = await zipFile(second, { [MANIFEST]: header, 'app/conversations/history.jsonl': history }, 'STORE');
  buffer[buffer.indexOf(history)] ^= 1; fs.writeFileSync(second, buffer); seedOldProfile(box);
  await assert.rejects(importDataPackage(box), /checksum/); unchanged(box);
  assert.equal(fs.existsSync(path.join(box.dataDir, 'conversations')), false);
});

test('import opens each part directory only once, including manifest-bearing parts', async t => {
  const box = setup(t), second = path.join(box.root, 'second.zip');
  const header = manifest(box, 2, 4, { parts: [{ name: path.basename(box.file) }, { name: path.basename(second) }] });
  await zipFile(box.file, { [MANIFEST]: header, 'app/desktop-config.json': '{}' });
  await zipFile(second, { [MANIFEST]: header, 'app/preferences.json': '{}' });
  const open = unzipper.Open.custom; let calls = 0;
  t.mock.method(unzipper.Open, 'custom', (...args) => { calls++; return open(...args); });
  await importDataPackage(box); assert.equal(calls, 2);
});

test('oversized directory metadata is rejected before the ZIP library allocates entries', async t => {
  const box = setup(t), bytes = 64 * 1024 * 1024 + 1;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(bytes, 12);
  const fd = fs.openSync(box.file, 'w');
  try { fs.ftruncateSync(fd, bytes + end.length); fs.writeSync(fd, end, 0, end.length, bytes); }
  finally { fs.closeSync(fd); }
  t.mock.method(unzipper.Open, 'custom', () => assert.fail('directory allocation must not start'));
  await assert.rejects(readManifest(box.file), /directory.*memory limit/);
});

test('ZIP64 record counts cannot bypass the directory allocation limit', async t => {
  const box = setup(t), count = 1000000, bytes = count * 46, record = Buffer.alloc(56), locator = Buffer.alloc(20), end = Buffer.alloc(22);
  record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32); record.writeBigUInt64LE(BigInt(bytes), 40);
  locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(bytes), 8); locator.writeUInt32LE(1, 16);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(bytes, 12);
  const fd = fs.openSync(box.file, 'w');
  try { fs.ftruncateSync(fd, bytes + 98); fs.writeSync(fd, Buffer.concat([record, locator, end]), 0, 98, bytes); }
  finally { fs.closeSync(fd); }
  t.mock.method(unzipper.Open, 'custom', () => assert.fail('directory allocation must not start'));
  await assert.rejects(readManifest(box.file), /directory.*memory limit/);
});

test('a valid small ZIP64 package remains importable within the directory limits', async t => {
  const box = setup(t);
  const buffer = await zipFile(box.file, { [MANIFEST]: manifest(box, 1, 2), 'app/desktop-config.json': '{}' });
  const at = buffer.length - 22, end = Buffer.from(buffer.subarray(at));
  const record = Buffer.alloc(56), locator = Buffer.alloc(20), count = end.readUInt16LE(10);
  record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(BigInt(count), 24); record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40); record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
  locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(at), 8); locator.writeUInt32LE(1, 16);
  end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10);
  fs.writeFileSync(box.file, Buffer.concat([buffer.subarray(0, at), record, locator, end]));
  const imported = await importDataPackage(box);
  assert.equal(imported.restored, 1);
});

for (const compression of ['STORE', 'DEFLATE']) test('Unicode names, empty files, descriptors and ZIP comments round-trip: ' + compression, async t => {
  const box = setup(t), zip = new JSZip();
  zip.file(MANIFEST, manifest(box, 2, 2));
  zip.file('app/desktop-config.json', '{}');
  zip.file('app/conversations/中文/empty.jsonl', '');
  zip.comment = 'zip comment '.repeat(100) + 'PK\u0005\u0006';
  fs.writeFileSync(box.file, await zip.generateAsync({ type: 'nodebuffer', streamFiles: true, compression }));
  const imported = await importDataPackage(box);
  assert.equal(imported.restored, 2);
  assert.equal(fs.statSync(path.join(box.dataDir, 'conversations', '中文', 'empty.jsonl')).size, 0);
});

test('a malformed central record closes directory streams and leaves the existing profile intact', async t => {
  const box = setup(t);
  const buffer = await zipFile(box.file, { [MANIFEST]: manifest(box, 1, 2), 'app/desktop-config.json': '{}' });
  buffer.writeUInt32LE(0, centralRecord(buffer, 'app/desktop-config.json')); fs.writeFileSync(box.file, buffer);
  seedOldProfile(box);
  const inputs = [], read = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => { const input = read(...args); inputs.push(input); return input; });
  await assert.rejects(importDataPackage(box), /invalid ZIP directory/); unchanged(box);
  assert.ok(inputs.length > 0 && inputs.every(input => input.destroyed && input.closed));
});

test('the selected cross-part file index has a total memory budget before any extraction', async t => {
  const box = setup(t), second = path.join(box.root, 'second.zip');
  const header = manifest(box, 600, 0, { parts: [{ name: path.basename(box.file) }, { name: path.basename(second) }] });
  for (const [part, file] of [box.file, second].entries()) {
    const entries = { [MANIFEST]: header };
    for (let i = part * 300; i < (part + 1) * 300; i++) entries['app/' + 'p'.repeat(16380) + String(i)] = '';
    await zipFile(file, entries, 'STORE');
  }
  seedOldProfile(box);
  t.mock.method(fs, 'createWriteStream', () => assert.fail('file index must be validated before extraction'));
  await assert.rejects(importDataPackage(box), /file index.*memory limit/); unchanged(box);
});

test('oversized discussion rewriting fails in staging under the existing logical record bound', async t => {
  const box = setup(t), source = { dataDir: path.join(box.root, 'source'), home: path.join(box.root, 'source-home') };
  const discussion = path.join(source.dataDir, 'discussions', '00000000-0000-4000-8000-000000000001.json');
  fs.mkdirSync(path.dirname(discussion), { recursive: true });
  const fd = fs.openSync(discussion, 'w'), padding = Buffer.alloc(1024 * 1024, 32);
  try { fs.writeSync(fd, '{}'); for (let i = 0; i < 33; i++) fs.writeSync(fd, padding); }
  finally { fs.closeSync(fd); }
  fs.writeFileSync(path.join(source.dataDir, 'desktop-config.json'), '{"language":"zh-CN"}');
  await createDataPackage({ ...source, destination: box.file }); seedOldProfile(box);
  await assert.rejects(importDataPackage(box), /oversized discussion record/); unchanged(box);
  assert.equal(fs.existsSync(path.join(box.dataDir, 'discussions')), false);
});

test('large selected data streams under a bounded RSS increase and unselected data consumes no staging space', t => {
  const child = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'data-import-memory-fixture.cjs')],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(child.status, 0, child.stderr);
  const metrics = JSON.parse(child.stdout);
  assert.equal(metrics.restoredBytes, metrics.historyBytes);
  assert.equal(metrics.settings.restored, 1); assert.equal(metrics.all.restored, 2);
  assert.ok(metrics.settings.stagingPeakBytes < 1024);
  assert.ok(metrics.all.stagingPeakBytes >= metrics.historyBytes);
  assert.ok(metrics.all.stagingPeakBytes < metrics.historyBytes + 1024);
  for (const scope of ['settings', 'all']) assert.ok(metrics[scope].rssGrowth < 128 * 1024 * 1024, JSON.stringify(metrics));
  t.diagnostic(JSON.stringify(metrics));
});
