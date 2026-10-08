'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { maintainPluginCaches, recoverPluginCacheOperation, OPERATION, CHUNK_BYTES } = require('../src/main/plugin-cache-maintenance');
const { completePluginCacheMaintenance, requestPluginCacheMaintenance, pluginCacheMaintenanceStatus, REQUEST } = require('../src/main/plugin-cache-startup');
const { assertPluginCachesOffline } = require('../src/main/plugin-cache-startup');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-cache-test-'));
  context.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-cache-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cache = id => path.join(root, 'codex/api/conversations', id, '.tmp');
  const seed = (id, text = 'same', sha = '') => {
    fs.mkdirSync(path.join(cache(id), 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(cache(id), 'plugins', 'manifest.json'), text);
    if (sha) fs.writeFileSync(path.join(cache(id), 'plugins.sha'), sha);
    return cache(id);
  };
  return { root, cache, seed };
}

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

test('plugin identifiers only group candidates; equal identifiers with different contents remain separate', context => {
  const h = fixture(context);
  h.seed('one', 'first', 'revision'); h.seed('two', 'other', 'revision'); h.seed('three', 'first', 'revision');
  const result = maintainPluginCaches(h.root, { apply: true });
  assert.equal(result.duplicates, 1);
  assert.equal(fs.realpathSync(h.cache('one')), fs.realpathSync(h.cache('three')));
  assert.notEqual(fs.realpathSync(h.cache('one')), fs.realpathSync(h.cache('two')));
});

test('an offline batch reads each cache once with bounded chunks and reports accurate progress', context => {
  const benchmark = process.env.CAMELLIA_PLUGIN_CACHE_BENCHMARK === '1';
  const h = fixture(context), size = benchmark ? 12 * 1024 * 1024 : CHUNK_BYTES * 2 + 17;
  for (const id of ['one', 'two', 'three']) h.seed(id, Buffer.alloc(size, 7));
  const states = [];
  const result = maintainPluginCaches(h.root, { apply: true, onProgress: state => states.push(state) });
  assert.equal(result.readBytes, size * 3);
  assert.equal(result.bytes, size * 2);
  assert.equal(result.skipped.length, 0);
  assert.ok(states.filter(state => state.stage === 'verify-cache').length >= 9);
  assert.equal(states.at(-1).processedEntries, 3);
  assert.equal(states.at(-1).totalEntries, 3);
  assert.ok(states.some(state => state.stage === 'link-cache' && !state.cancellable));
  if (benchmark) {
    const targets = new Set(['one', 'two', 'three'].map(id => fs.realpathSync(h.cache(id))));
    assert.equal(targets.size, 1);
    assert.equal(fs.statSync(path.join([...targets][0], 'plugins/manifest.json')).size, size);
    context.diagnostic(JSON.stringify({ beforeMiB: size * 3 / 1048576, afterMiB: size / 1048576,
      freedMiB: result.bytes / 1048576, readMiB: result.readBytes / 1048576, readChunkKiB: CHUNK_BYTES / 1024 }));
  }
});

test('the primary cache is reused and native conversation, account and group contexts remain byte identical', context => {
  const h = fixture(context), primary = path.join(h.root, 'codex/.tmp');
  fs.mkdirSync(path.join(primary, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'plugins/manifest.json'), 'same');
  for (const id of ['one', 'two']) {
    h.seed(id);
    for (const file of ['sessions/member.jsonl', 'state_5.sqlite', 'auth.json']) {
      const target = path.join(h.cache(id), '..', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, id + ':' + file);
    }
  }
  const result = maintainPluginCaches(h.root, { apply: true });
  assert.equal(result.duplicates, 2);
  assert.equal(result.readBytes, 12);
  for (const id of ['one', 'two']) {
    assert.equal(fs.realpathSync(h.cache(id)), fs.realpathSync(primary));
    for (const file of ['sessions/member.jsonl', 'state_5.sqlite', 'auth.json']) assert.equal(fs.readFileSync(path.join(h.cache(id), '..', file), 'utf8'), id + ':' + file);
  }
});

test('mutable shared snapshots are identified by current content rather than stale directory hashes', context => {
  const h = fixture(context);
  h.seed('old', 'first');
  maintainPluginCaches(h.root, { apply: true });
  const target = fs.realpathSync(h.cache('old'));
  fs.writeFileSync(path.join(target, 'plugins/manifest.json'), 'updated');
  h.seed('new', 'updated');
  const result = maintainPluginCaches(h.root, { apply: true });
  assert.equal(result.duplicates, 1);
  assert.equal(fs.realpathSync(h.cache('new')), target);
  assert.equal(fs.readdirSync(path.join(h.root, 'codex/plugin-caches')).length, 1);
});

test('a failed link restores the old cache without losing native history', context => {
  const h = fixture(context);
  h.seed('one');
  const symlink = fs.symlinkSync;
  fs.symlinkSync = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  let result;
  try { result = maintainPluginCaches(h.root, { apply: true }); } finally { fs.symlinkSync = symlink; }
  assert.equal(result.linked, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(fs.lstatSync(h.cache('one')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(h.cache('one'), 'plugins/manifest.json'), 'utf8'), 'same');
  assert.equal(fs.existsSync(path.join(h.root, 'codex', OPERATION)), false);
});

for (const step of ['staged', 'seeded', 'linked', 'cleaned']) test('abrupt process exit at ' + step + ' is recovered before maintenance continues', context => {
  const h = fixture(context);
  h.seed('one'); h.seed('two');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'plugin-cache-crash-fixture.cjs'), h.root, step], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 73, result.stderr);
  assert.equal(recoverPluginCacheOperation(h.root), true);
  const resumed = maintainPluginCaches(h.root, { apply: true });
  assert.equal(resumed.skipped.length, 0);
  assert.equal(fs.realpathSync(h.cache('one')), fs.realpathSync(h.cache('two')));
  assert.equal(fs.existsSync(path.join(h.root, 'codex', OPERATION)), false);
});

test('duplicate-cache cleanup after an abrupt link is recovered without following native links', context => {
  const h = fixture(context);
  h.seed('one'); maintainPluginCaches(h.root, { apply: true }); h.seed('two');
  const child = spawnSync(process.execPath, [path.join(__dirname, 'plugin-cache-crash-fixture.cjs'), h.root, 'linked'], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 73, child.stderr);
  recoverPluginCacheOperation(h.root);
  assert.equal(fs.existsSync(h.cache('two') + '-maintenance'), false);
  assert.equal(fs.realpathSync(h.cache('one')), fs.realpathSync(h.cache('two')));
});

test('unknown scratch entries and nested links are reported without being deleted', context => {
  const h = fixture(context);
  h.seed('git'); fs.mkdirSync(path.join(h.cache('git'), 'git-worktree'));
  h.seed('linked'); fs.symlinkSync(h.cache('git'), path.join(h.cache('linked'), 'plugins/link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = maintainPluginCaches(h.root, { apply: true });
  assert.equal(result.linked, 0);
  assert.equal(result.skipped.length, 2);
  assert.ok(fs.existsSync(path.join(h.cache('git'), 'git-worktree')));
});

test('canceling a chunked scan consumes the request and a later launch does not repeat it', context => {
  const h = fixture(context);
  h.seed('one', Buffer.alloc(CHUNK_BYTES * 3)); requestPluginCacheMaintenance(h.root);
  const result = completePluginCacheMaintenance({ dataDir: h.root, assertOffline() {}, onProgress(state) {
    if (state.processedBytes > 0) throw Object.assign(new Error('canceled'), { code: 'CAMELLIA_CACHE_CANCELLED' });
  } });
  assert.equal(result.canceled, true);
  assert.equal(pluginCacheMaintenanceStatus(h.root).pending, false);
  assert.equal(fs.lstatSync(h.cache('one')).isSymbolicLink(), false);
  assert.equal(completePluginCacheMaintenance({ dataDir: h.root, assertOffline() { throw new Error('must not run'); } }), null);
});

test('completed maintenance records real savings and future startups perform no history or cache scan', context => {
  const h = fixture(context);
  h.seed('one'); h.seed('two'); requestPluginCacheMaintenance(h.root);
  const result = completePluginCacheMaintenance({ dataDir: h.root, assertOffline() {} });
  assert.equal(result.bytes, 4);
  assert.equal(result.duplicates, 1);
  assert.equal(pluginCacheMaintenanceStatus(h.root).result.bytes, 4);
  assert.equal(completePluginCacheMaintenance({ dataDir: h.root, assertOffline() { throw new Error('must not scan'); } }), null);
});

test('native processes block requested maintenance before any cache is changed', context => {
  const h = fixture(context);
  h.seed('one'); requestPluginCacheMaintenance(h.root);
  const result = completePluginCacheMaintenance({ dataDir: h.root, assertOffline() { throw new Error('native process still running'); } });
  assert.equal(result.error, 'native process still running');
  assert.equal(result.recoveryRequired, false);
  assert.equal(fs.lstatSync(h.cache('one')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(h.root, REQUEST)), false);
});

test('canceling after completed duplicates preserves both the links and the reported freed bytes', context => {
  const h = fixture(context);
  for (const id of ['one', 'three', 'two']) h.seed(id);
  requestPluginCacheMaintenance(h.root);
  const result = completePluginCacheMaintenance({ dataDir: h.root, assertOffline() {}, onProgress(state) {
    if (state.cancellable && state.processedEntries === 2) throw Object.assign(new Error('canceled'), { code: 'CAMELLIA_CACHE_CANCELLED' });
  } });
  assert.equal(result.canceled, true);
  assert.equal(result.duplicates, 1); assert.equal(result.bytes, 4);
  assert.equal(fs.realpathSync(h.cache('one')), fs.realpathSync(h.cache('three')));
  assert.equal(fs.lstatSync(h.cache('two')).isSymbolicLink(), false);
});

test('the primary-cache target is recovered after an abrupt duplicate link', context => {
  const h = fixture(context), primary = path.join(h.root, 'codex/.tmp');
  fs.mkdirSync(path.join(primary, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'plugins/manifest.json'), 'same'); h.seed('one');
  const child = spawnSync(process.execPath, [path.join(__dirname, 'plugin-cache-crash-fixture.cjs'), h.root, 'linked'], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 73, child.stderr);
  recoverPluginCacheOperation(h.root);
  assert.equal(fs.realpathSync(h.cache('one')), fs.realpathSync(primary));
  assert.equal(fs.existsSync(h.cache('one') + '-maintenance'), false);
});

test('a running headless host protects the profile even before it creates Codex processes', context => {
  const h = fixture(context);
  fs.writeFileSync(path.join(h.root, 'server.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => assertPluginCachesOffline(h.root), /Stop the Camellia server/);
});
