'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { searchFilesAsync, searchContentsAsync } = require('../src/main/file-search-process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-file-search-worker-'));
  t.after(() => removeTree(root));
  fs.writeFileSync(path.join(root, 'report.txt'), 'needle in the report\n');
  return root;
}

test('file search worker returns name and content matches without blocking the caller', async t => {
  const root = fixture(t);
  let yielded = false;
  const timer = setImmediate(() => { yielded = true; });
  const names = await searchFilesAsync({ query: 'report', roots: [root] });
  assert.equal(yielded, true);
  clearImmediate(timer);
  assert.equal(names.results[0].name, 'report.txt');
  const contents = await searchContentsAsync({ query: 'needle', roots: [root] });
  assert.equal(contents.results[0].name, 'report.txt');
  assert.match(contents.results[0].snippet, /needle/);
});

test('cancelling file search terminates its worker and leaves later searches usable', async t => {
  const root = fixture(t), controller = new AbortController();
  const pending = searchFilesAsync({ query: 'report', roots: [root] }, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  const result = await searchFilesAsync({ query: 'report', roots: [root] });
  assert.equal(result.results[0].name, 'report.txt');
});
