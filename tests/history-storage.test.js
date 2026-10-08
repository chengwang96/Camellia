'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConversationHistory, FLAGS, tokens, contextRow } = require('../src/engines/conversation-history');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');
const { RemoteReadModel } = require('../src/main/remote/read-model');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { removeTree } = require('./test-fs.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-history-storage-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  const history = new ConversationHistory(root, options);
  t.after(() => { history.close(); removeTree(root); });
  const seed = rows => fs.writeFileSync(path.join(root, 'sample.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  return { root, history, seed };
}
function logical(rows) {
  const result = [];
  for (const original of rows) {
    const { previousAttempt, ...row } = original;
    if (row.role === 'revision') {
      const at = result.findIndex(r => r.role === 'user' && r.seq === row.replacesSeq);
      result.splice(at, result.length - at, { ...row, role: 'user' });
    } else result.push(row);
  }
  return result;
}
function managerFixture(t) {
  const { root, history } = fixture(t);
  history.close();
  let config = { sharedMeta: { workspaces: [] } };
  const args = { dir: root, loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; },
    drivers: Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => ({ model: 'test', connection: 'api' }) }])) };
  const manager = new SharedConversations(args);
  t.after(() => manager.closeGoalTools());
  const conversation = manager.create('codex', null, 'History', root);
  return { root, manager, conversation, args };
}

test('cold indexing is chunked; 100 warm remote refreshes never reread or reparse saved history', t => {
  const { root, manager, conversation: c } = managerFixture(t);
  const benchmark = process.env.CAMELLIA_HISTORY_BENCHMARK === '1', count = benchmark ? 50000 : 10000;
  const rows = Array.from({ length: count }, (_, i) => ({ seq: i + 1, role: i % 2 ? 'assistant' : 'user', at: i, text: '汉😀 x '.repeat(120) }));
  fs.writeFileSync(path.join(root, c.id + '.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  c.seq = rows.length; manager.save(c);
  const reader = new RemoteReadModel(manager), device = { id: 'phone', permission: 'read', allWorkspaces: true };
  const first = reader.snapshot(device, c.id);
  assert.equal(first.messages.length, 200); assert.equal(first.nextBefore, count - 199);
  const baseline = { ...manager.historyStore.metrics };
  if (benchmark) global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed; let heapPeak = heapBefore;
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(reader.snapshot(device, c.id), first);
    if (benchmark) heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }
  if (benchmark) global.gc?.();
  assert.equal(manager.historyStore.metrics.historyBytes, baseline.historyBytes);
  assert.equal(manager.historyStore.metrics.parsedRows, baseline.parsedRows);
  assert.equal(manager.historyStore.metrics.indexBytes, baseline.indexBytes);
  assert.ok(manager.historyStore.used <= manager.historyStore.limit);
  t.diagnostic(JSON.stringify({ historyMiB: +(fs.statSync(path.join(root, c.id + '.jsonl')).size / 1048576).toFixed(3),
    updates: 100, repeatedHistoryBytes: manager.historyStore.metrics.historyBytes - baseline.historyBytes,
    repeatedParsedRows: manager.historyStore.metrics.parsedRows - baseline.parsedRows,
    indexKiB: +(fs.statSync(manager.historyStore.index(c.id)).size / 1024).toFixed(2),
    ...(benchmark ? { rows: count, chargedCacheMiB: +(manager.historyStore.used / 1048576).toFixed(3),
      warmHeapPeakIncreaseMiB: +((heapPeak - heapBefore) / 1048576).toFixed(3),
      warmRetainedHeapIncreaseMiB: +((process.memoryUsage().heapUsed - heapBefore) / 1048576).toFixed(3) } : {}) }));
});

test('append updates only the new index record and retains cached immutable messages', t => {
  const h = fixture(t);
  h.seed(Array.from({ length: 600 }, (_, i) => ({ seq: i + 1, role: 'user', text: 'message ' + i })));
  h.history.page('sample'); const bytes = h.history.metrics.historyBytes, parsed = h.history.metrics.parsedRows;
  h.history.append('sample', { seq: 601, role: 'assistant', text: 'New answer' });
  const page = h.history.page('sample');
  assert.equal(page.rows.at(-1).text, 'New answer');
  assert.ok(h.history.metrics.historyBytes - bytes < 200);
  assert.equal(h.history.metrics.parsedRows - parsed, 1);
  assert.equal(h.history.metrics.rebuilds, 1);
});

test('remote pages stop at their output budget and cache projections of oversized uncached rows', t => {
  const { root, manager, conversation: c } = managerFixture(t);
  const file = path.join(root, c.id + '.jsonl'), text = 'x'.repeat(6 * 1024 * 1024);
  const older = Array.from({ length: 20 }, (_, i) => JSON.stringify({ seq: i + 1, role: 'user', text: 'o'.repeat(300000) }) + '\n').join('');
  fs.writeFileSync(file, older + [21, 22, 23].map(seq => JSON.stringify({ seq, role: 'assistant', text }) + '\n').join(''));
  c.seq = 23; manager.historyStore.ensure(c.id);
  const reader = new RemoteReadModel(manager), device = { id: 'phone', permission: 'read', allWorkspaces: true };
  const parsed = manager.historyStore.metrics.parsedRows;
  const first = reader.snapshot(device, c.id);
  assert.equal(first.messages.length, 3); assert.equal(first.nextBefore, 21);
  assert.equal(manager.historyStore.metrics.parsedRows - parsed, 4);
  const baseline = { ...manager.historyStore.metrics };
  for (let i = 0; i < 5; i++) assert.deepEqual(reader.snapshot(device, c.id), first);
  assert.equal(manager.historyStore.metrics.parsedRows, baseline.parsedRows);
  assert.equal(manager.historyStore.metrics.historyBytes, baseline.historyBytes);
  assert.ok(manager.historyStore.used <= manager.historyStore.limit);
});

test('a restarted store reuses its persisted index without scanning history', t => {
  const h = fixture(t); h.seed(Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, role: 'user', text: 'x'.repeat(500) })));
  h.history.ensure('sample'); h.history.close();
  const restarted = new ConversationHistory(h.root); t.after(() => restarted.close());
  assert.equal(restarted.ensure('sample').maxSeq, 1000);
  assert.equal(restarted.metrics.historyBytes, 0); assert.equal(restarted.metrics.parsedRows, 0);
  assert.equal(restarted.page('sample', { limit: 100 }).rows.length, 100);
  assert.equal(restarted.metrics.parsedRows, 101);
});

test('revisions, repeated edits, internal rows and discarded attempts match the original effective history', t => {
  const h = fixture(t);
  const source = [{ seq: 1, role: 'user', text: 'first' }, { seq: 2, role: 'assistant', text: 'first answer', previousAttempt: { secret: 'discarded' } },
    { seq: 3, role: 'user', text: 'original' }, { seq: 4, role: 'assistant', text: 'old answer' }, { seq: 5, role: 'tool', internal: true, text: 'old tool' }];
  h.seed(source); const generation = h.history.ensure('sample').generation;
  const edit = { seq: 6, role: 'revision', replacesSeq: 3, text: 'edited' };
  h.history.append('sample', edit); source.push(edit);
  assert.notEqual(h.history.ensure('sample').generation, generation);
  assert.deepEqual(h.history.rows('sample'), logical(source));
  h.history.append('sample', { seq: 7, role: 'assistant', text: 'second attempt' }); source.push({ seq: 7, role: 'assistant', text: 'second attempt' });
  const again = { seq: 8, role: 'revision', replacesSeq: 6, text: 'edited again' }; h.history.append('sample', again); source.push(again);
  assert.deepEqual(h.history.rows('sample'), logical(source));
  assert.equal(h.history.ensure('sample').maxSeq, 8);
  const wanted = logical(source).filter(r => !r.internal && contextRow(r)).reduce((sum, r) => sum + tokens(r.text) + 200 / 3, 0);
  assert.ok(Math.abs(h.history.estimate('sample') - wanted) < 1e-8);
});

test('compaction estimates retain the original rules and detect changed or removed summary files', t => {
  const h = fixture(t), summary = path.join(h.root, 'summary.md');
  fs.writeFileSync(summary, 'Summary 中文😀');
  const source = [{ seq: 1, role: 'user', text: 'OLD'.repeat(1000) }, { seq: 2, role: 'notice', text: 'compacted', file: summary },
    { seq: 3, role: 'assistant', text: 'Context recovery failed: original retained' },
    { seq: 4, role: 'assistant', text: 'Error', runResult: { result: 'Error' } },
    { seq: 5, role: 'tool', internal: true, text: 'internal' }, { seq: 6, role: 'user', text: 'new 中文😀' }];
  h.seed(source);
  assert.ok(Math.abs(h.history.estimate('sample') - (tokens('Summary 中文😀') + tokens('new 中文😀') + 200 / 3)) < 1e-8);
  fs.writeFileSync(summary, 'Changed longer summary');
  assert.ok(Math.abs(h.history.estimate('sample') - (tokens('Changed longer summary') + tokens('new 中文😀') + 200 / 3)) < 1e-8);
  fs.unlinkSync(summary);
  const wanted = source.filter(r => !r.internal && contextRow(r)).reduce((sum, r) => sum + tokens(r.text) + 200 / 3, 0);
  assert.ok(Math.abs(h.history.estimate('sample') - wanted) < 1e-8);
});

test('external replacement, truncation and corrupt derived headers rebuild without stale rows', t => {
  const h = fixture(t); h.seed([{ seq: 1, role: 'user', text: 'old' }]); h.history.rows('sample');
  const file = path.join(h.root, 'sample.jsonl'), next = file + '.new';
  fs.writeFileSync(next, JSON.stringify({ seq: 2, role: 'user', text: 'replacement' }) + '\n'); fs.renameSync(next, file);
  assert.equal(h.history.rows('sample')[0].text, 'replacement');
  fs.writeFileSync(file, ''); assert.deepEqual(h.history.rows('sample'), []);
  h.seed([{ seq: 3, role: 'user', text: 'final' }]); h.history.ensure('sample'); h.history.close();
  fs.writeFileSync(h.history.index('sample'), 'damaged derived data');
  assert.equal(h.history.rows('sample')[0].text, 'final');
});

test('damaged index records and edited header statistics rebuild from the unchanged JSONL', t => {
  const h = fixture(t); h.seed(Array.from({ length: 300 }, (_, i) => ({ seq: i + 1, role: 'user', text: 'message ' + i })));
  const expected = h.history.rows('sample'), original = fs.readFileSync(path.join(h.root, 'sample.jsonl'));
  const file = h.history.index('sample'), buffer = fs.readFileSync(file);
  buffer[4096 + 299 * 80 + 16] ^= 1; fs.writeFileSync(file, buffer);
  assert.deepEqual(h.history.page('sample', { limit: 5 }).rows, expected.slice(-5));
  const header = fs.readFileSync(file).subarray(0, 4096), parsed = JSON.parse(header.subarray(0, header.indexOf(0)).toString());
  parsed.total = 1; parsed.maxSeq = 999999;
  const changed = Buffer.alloc(4096); Buffer.from(JSON.stringify(parsed)).copy(changed);
  const fd = fs.openSync(file, 'r+'); try { fs.writeSync(fd, changed, 0, changed.length, 0); } finally { fs.closeSync(fd); }
  assert.equal(h.history.ensure('sample').maxSeq, 300);
  assert.deepEqual(fs.readFileSync(path.join(h.root, 'sample.jsonl')), original);
});

test('an unwritable derived cache falls back to an owned temporary index and retains readable history', t => {
  const h = fixture(t); h.seed([{ seq: 1, role: 'user', text: 'readable original' }]);
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (target, ...args) => {
    if (target === h.history.indexDir) throw Object.assign(new Error('Read-only cache'), { code: 'EACCES' });
    return mkdir(target, ...args);
  });
  assert.equal(h.history.rows('sample')[0].text, 'readable original');
  assert.equal(h.history.temporary.size, 1);
  const file = [...h.history.temporary][0]; assert.equal(path.dirname(file), os.tmpdir());
  h.history.close(); assert.equal(fs.existsSync(file), false);
});

test('UTF-8 byte offsets, CRLF, empty lines and valid unterminated rows retain exact message text', t => {
  const h = fixture(t), texts = ['中文😀\n\r"\\\ud800', 'second message'];
  fs.writeFileSync(path.join(h.root, 'sample.jsonl'), JSON.stringify({ seq: 1, role: 'user', text: texts[0] }) + '\r\n\n'
    + JSON.stringify({ seq: 2, role: 'assistant', text: texts[1] }));
  assert.deepEqual(h.history.rows('sample').map(r => r.text), texts);
  assert.equal(h.history.ensure('sample').tail !== null, true);
});

test('torn tails retain the original file; complete invalid lines still reject the conversation', t => {
  const h = fixture(t), file = path.join(h.root, 'sample.jsonl');
  const text = JSON.stringify({ seq: 1, role: 'user', text: 'valid' }) + '\n{"role":'; fs.writeFileSync(file, text);
  assert.equal(h.history.rows('sample')[0].text, 'valid'); assert.equal(h.history.ensure('sample').repaired, true);
  const backup = fs.readdirSync(h.root).find(n => n.startsWith('sample.jsonl.torn-'));
  assert.equal(fs.readFileSync(path.join(h.root, backup), 'utf8'), text);
  fs.writeFileSync(file, '{broken}\n');
  assert.throws(() => h.history.rows('sample'), /history is damaged/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken}\n');
});

test('cache eviction remains bounded across long conversations and cannot change authoritative history', t => {
  const h = fixture(t, { cacheBytes: 32 * 1024 });
  for (let i = 0; i < 20; i++) {
    const id = 'conversation-' + i;
    fs.writeFileSync(path.join(h.root, id + '.jsonl'), JSON.stringify({ seq: 1, role: 'user', text: 'x'.repeat(16000) }) + '\n');
    const rows = h.history.rows(id); rows[0].text = 'mutated caller copy';
    assert.ok(h.history.used <= h.history.limit);
    assert.equal(h.history.rows(id)[0].text.length, 16000);
  }
});

test('a lost derived append write never reports an already committed message as failed', t => {
  const h = fixture(t); h.seed([{ seq: 1, role: 'user', text: 'first' }]); h.history.ensure('sample');
  const write = fs.writeSync; let failed = false;
  const denied = t.mock.method(fs, 'writeSync', (...args) => { if (!failed) { failed = true; throw Object.assign(new Error('cache disk full'), { code: 'ENOSPC' }); } return write(...args); });
  assert.doesNotThrow(() => h.history.append('sample', { seq: 2, role: 'assistant', text: 'committed answer' }));
  denied.mock.restore();
  assert.equal(h.history.rows('sample').at(-1).text, 'committed answer');
});

test('desktop pages preserve continuation and reject a cursor from the history before an edit', t => {
  const { manager, conversation: c } = managerFixture(t);
  for (let i = 0; i < 250; i++) manager.append(c, { role: i % 2 ? 'assistant' : 'user', text: 'Message ' + i });
  const page = manager.load('codex', c.id, {});
  assert.equal(page.messages.length, 100); assert.equal(page.historyPage.nextBefore, 151); assert.equal(page.truncated, false);
  const earlier = manager.load('codex', c.id, { before: page.historyPage.nextBefore, version: page.historyPage.version });
  assert.deepEqual(earlier.messages.map(r => r.seq), Array.from({ length: 100 }, (_, i) => i + 51));
  manager.append(c, { role: 'revision', replacesSeq: 249, text: 'Revised' });
  assert.equal(manager.load('codex', c.id, { before: 151, version: page.historyPage.version }).ok, false);
  assert.equal(manager.messages(c).at(-1).text, 'Revised');
});

test('model continuation reads only messages beyond its own native cursor', t => {
  const { root, manager, conversation: c } = managerFixture(t);
  fs.writeFileSync(path.join(root, c.id + '.jsonl'), Array.from({ length: 1000 }, (_, i) => JSON.stringify({ seq: i + 1, role: 'user', text: 'Message ' + i }) + '\n').join(''));
  c.seq = 1000; c.segments.codex = { nativeId: 'native-context', cursor: 990, isolated: true };
  manager.historyStore.ensure(c.id); const parsed = manager.historyStore.metrics.parsedRows;
  const context = manager.context(c, 'codex');
  assert.match(context, /Message 990/); assert.doesNotMatch(context, /Message 989\b/);
  assert.equal(manager.historyStore.metrics.parsedRows - parsed, 10);
  assert.equal(c.segments.codex.nativeId, 'native-context'); assert.equal(c.segments.codex.cursor, 990);
});

test('attachment previews invalidate when an external replacement keeps the same conversation metadata', t => {
  const { root, manager, conversation: c } = managerFixture(t), reader = new RemoteReadModel(manager);
  manager.append(c, { role: 'user', text: 'attachment', attachments: [{ path: '/old.txt' }] });
  assert.equal(reader.filePreview(c).name, 'old.txt');
  fs.writeFileSync(path.join(root, c.id + '.jsonl'), JSON.stringify({ seq: c.seq, role: 'user', text: 'attachment', attachments: [{ path: '/new.txt' }] }) + '\n');
  assert.equal(reader.filePreview(c).name, 'new.txt');
});

test('a conversation event refreshes its subscribers and navigation, while global changes refresh everyone', async t => {
  const gateway = new RemoteGateway({ access: { clearPairing() {} }, reader: {} }); t.after(() => gateway.stop());
  const updates = [], stream = id => ({ id, device: { id: 'phone' }, kind: 'conversations', response: { write() { updates.push(id); return true; }, end() {}, destroy() {} } });
  gateway.streams.add(stream('A')); gateway.streams.add(stream('B')); gateway.streams.add(stream(null));
  gateway.streamSnapshot = s => ({ listVersion: String(gateway.sequence), id: s.id });
  gateway.publish({ session_id: 'A' }); await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(updates, ['A', null]); updates.length = 0;
  gateway.publish(); await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(updates, ['A', 'B', null]);
});
