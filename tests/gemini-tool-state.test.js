'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { GeminiToolState } = require('../src/api/gemini-tool-state');
const { removeTree } = require('./test-fs.cjs');

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-gemini-state-')), states = [];
  const file = path.join(root, 'tools.jsonl');
  const create = () => { const state = new GeminiToolState(file, options); states.push(state); return state; };
  t.after(() => { for (const state of states) state.close(); removeTree(root); });
  return { root, file, create, state: create() };
}

test('Gemini signatures use a bounded hot cache and restore evicted entries after restart', t => {
  const h = fixture(t, { cacheBytes: 16384 });
  assert.equal(fs.existsSync(h.state.databaseFile), false, 'unused Gemini storage stays unopened');
  for (let i = 0; i < 3000; i++) h.state.remember('model', 'call-' + i, 'signature-' + i + 'x'.repeat(1024));
  assert.ok(h.state.cacheBytes <= 16384);
  assert.ok(h.state.signatures.size < 10);
  assert.equal(h.state.get('model', 'call-0'), 'signature-0' + 'x'.repeat(1024));
  const reopened = h.create();
  assert.equal(reopened.signatures.size, 0);
  const body = { messages: [{ tool_calls: [{ id: 'call-2999' }, { id: 'call-0' }] }] };
  reopened.restore(body, 'model');
  assert.equal(body.messages[0].tool_calls[1].extra_content.google.thought_signature, 'signature-0' + 'x'.repeat(1024));
  assert.equal(reopened.get('unrelated-model', 'call-0'), undefined);
});

test('legacy signature journals migrate with latest-record semantics without reading the whole file', t => {
  const h = fixture(t);
  fs.writeFileSync(h.file, [
    { model: 'm', id: 'old', signature: 'first' },
    { model: 'm', id: 'other', signature: '中文🙂' },
    { model: 'm', id: 'old', signature: 'latest' },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    assert.notEqual(file, h.file, 'legacy migration must stream records');
    return read(file, ...args);
  });
  assert.equal(h.state.get('m', 'old'), 'latest');
  assert.equal(h.state.get('m', 'other'), '中文🙂');
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.create().get('m', 'old'), 'latest');
});

test('failed legacy imports preserve the source and roll back partial signatures', t => {
  const h = fixture(t);
  const original = JSON.stringify({ model: 'm', id: 'first', signature: 'saved' }) + '\nINVALID\n';
  fs.writeFileSync(h.file, original);
  assert.throws(() => h.state.get('m', 'first'));
  assert.equal(fs.readFileSync(h.file, 'utf8'), original);
  fs.writeFileSync(h.file, JSON.stringify({ model: 'm', id: 'second', signature: 'repaired' }) + '\n');
  assert.equal(h.state.get('m', 'first'), undefined);
  assert.equal(h.state.get('m', 'second'), 'repaired');
});

test('the disk budget rejects new signatures without dropping persisted history or growing the database indefinitely', t => {
  const h = fixture(t, { storeBytes: 128 * 1024, cacheBytes: 4096 });
  let saved = 0, full;
  for (; saved < 500; saved++) {
    try { h.state.remember('m', 'call-' + saved, 'sig-' + saved + 'x'.repeat(4096)); }
    catch (error) { full = error; break; }
  }
  assert.equal(full?.code, 'GEMINI_TOOL_STATE_FULL');
  assert.ok(saved > 0 && saved < 500);
  assert.ok(fs.statSync(h.state.databaseFile).size <= 128 * 1024);
  assert.equal(h.state.get('m', 'call-0'), 'sig-0' + 'x'.repeat(4096));
  const reopened = h.create();
  assert.equal(reopened.get('m', 'call-0'), 'sig-0' + 'x'.repeat(4096));
  assert.throws(() => reopened.remember('m', 'overflow', 'x'.repeat(8192)), { code: 'GEMINI_TOOL_STATE_FULL' });
});

test('repeated signature updates replace the durable record instead of appending another journal entry', t => {
  const h = fixture(t, { storeBytes: 128 * 1024 });
  for (let i = 0; i < 1000; i++) h.state.remember('m', 'call', String(i) + 'x'.repeat(4096));
  assert.equal(h.state.get('m', 'call'), '999' + 'x'.repeat(4096));
  assert.ok(fs.statSync(h.state.databaseFile).size < 64 * 1024);
  assert.equal(fs.existsSync(h.file), false);
});

test('a journal larger than 32 MiB migrates in a small heap and old signatures remain available on demand', t => {
  const h = fixture(t), fd = fs.openSync(h.file, 'w'), signature = '中🙂'.repeat(2400);
  try {
    for (let i = 0; i < 2100; i++) fs.writeSync(fd, JSON.stringify({ model: 'm', id: 'call-' + i, signature }) + '\n');
  } finally { fs.closeSync(fd); }
  assert.ok(fs.statSync(h.file).size > 32 * 1024 * 1024);
  const child = spawnSync(process.execPath, ['--max-old-space-size=48', '-e', `
    const assert = require('node:assert/strict');
    const { GeminiToolState } = require(${JSON.stringify(require.resolve('../src/api/gemini-tool-state'))});
    const state = new GeminiToolState(process.argv[1], { cacheBytes: 32768 });
    assert.equal(state.get('m','call-0'), '中🙂'.repeat(2400));
    assert.equal(state.get('m','call-2099'), '中🙂'.repeat(2400));
    assert.ok(state.cacheBytes <= 32768); state.close();
  `, h.file], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(h.file), false);
});

test('legacy histories exceeding the new budget remain readable without permitting further disk growth', t => {
  const h = fixture(t, { storeBytes: 64 * 1024 });
  fs.writeFileSync(h.file, Array.from({ length: 30 }, (_, i) => JSON.stringify({ model: 'm', id: 'old-' + i,
    signature: 'legacy-' + i + 'x'.repeat(8192) })).join('\n'));
  assert.equal(h.state.get('m', 'old-0'), 'legacy-0' + 'x'.repeat(8192));
  const bytes = fs.statSync(h.state.databaseFile).size;
  assert.ok(bytes > 64 * 1024);
  assert.throws(() => h.state.remember('m', 'new', 'x'.repeat(32768)), { code: 'GEMINI_TOOL_STATE_FULL' });
  assert.equal(fs.statSync(h.state.databaseFile).size, bytes);
  assert.equal(h.create().get('m', 'old-29'), 'legacy-29' + 'x'.repeat(8192));
});
