'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { maintainPluginCaches } = require('../src/main/plugin-cache-maintenance');

test('offline maintenance deduplicates only identical caches and retains different snapshots and unknown data', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-cache-test-'));
  context.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-cache-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cache = id => path.join(root, 'codex/api/conversations', id, '.tmp');
  for (const id of ['first', 'second', 'third', 'custom']) {
    fs.mkdirSync(path.join(cache(id), 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(cache(id), 'plugins', 'manifest.json'), id === 'third' ? 'different' : 'same');
  }
  fs.writeFileSync(path.join(cache('custom'), 'user.txt'), 'preserve');
  const preview = maintainPluginCaches(root);
  assert.equal(preview.duplicates, 1);
  assert.equal(preview.bytes, 4);
  assert.equal(fs.lstatSync(cache('first')).isSymbolicLink(), false);
  const result = maintainPluginCaches(root, { apply: true });
  assert.equal(result.duplicates, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(fs.realpathSync(cache('first')), fs.realpathSync(cache('second')));
  assert.notEqual(fs.realpathSync(cache('first')), fs.realpathSync(cache('third')));
  assert.equal(fs.readFileSync(path.join(cache('custom'), 'user.txt'), 'utf8'), 'preserve');
  assert.equal(maintainPluginCaches(root, { apply: true }).linked, 0);
});
