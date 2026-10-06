'use strict';

// Synthetic, isolated profiles only. Reports actual JS filesystem read/copy
// bytes alongside elapsed time; it never opens the user's application data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { requestDirectoryMigration, completeDirectoryMigration } = require('../src/main/data-directory');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-migration-benchmark-'));
function seed(method) {
  const appData = path.join(root, method), dataDir = path.join(appData, 'dsh-desktop');
  const dirs = ['Cache/files', 'attachments', 'plugins', 'history'];
  for (const dir of dirs) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(dataDir, 'Cache/files', i + '.bin'), Buffer.alloc(1024, i % 256));
  for (let i = 0; i < 32; i++) fs.writeFileSync(path.join(dataDir, 'attachments', i + '.bin'), Buffer.alloc(2 * 1024 * 1024, i));
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dataDir, 'plugins', i + '.json'), '{"cache":"unchanged"}');
  fs.writeFileSync(path.join(dataDir, 'desktop-config.json'), JSON.stringify({ attachment: path.join(dataDir, 'attachments/0.bin') }));
  fs.writeFileSync(path.join(dataDir, 'history/rollout.jsonl'), JSON.stringify({ home: dataDir, response: 'keep' }) + '\n');
  return { appData, dataDir };
}
try {
  const fixtures = ['rename', 'copy'].map(seed), results = [];
  for (const [index, box] of fixtures.entries()) {
    const method = index === 0 ? 'rename' : 'copy';
    requestDirectoryMigration(box);
    const read = fs.readSync, copy = fs.copyFileSync;
    let readBytes = 0, copiedBytes = 0, copiedFiles = 0;
    fs.readSync = (...args) => { const bytes = read(...args); readBytes += bytes; return bytes; };
    fs.copyFileSync = (source, ...args) => { copiedFiles++; copiedBytes += fs.statSync(source).size; return copy(source, ...args); };
    const started = performance.now();
    let result;
    try { result = completeDirectoryMigration({ ...box, strategy: method }); }
    finally { fs.readSync = read; fs.copyFileSync = copy; }
    assert.equal(result.migrated, true, JSON.stringify(result));
    results.push({ method: result.method, elapsedMs: Math.round(performance.now() - started), readBytes, copiedBytes, copiedFiles });
  }
  console.log(JSON.stringify({ files: 2134, opaqueBytes: 2000 * 1024 + 32 * 2 * 1024 * 1024, results,
    speedup: Number((results[1].elapsedMs / Math.max(1, results[0].elapsedMs)).toFixed(1)) }, null, 2));
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('camellia-migration-benchmark-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
