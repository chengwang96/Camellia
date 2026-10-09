'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { completeBackup, backupInventory, MARKER } = require('../src/main/backup-retention');
const { ImportTransaction, recoverDataImports } = require('../src/main/data-import-transaction');
const { StorageCleanup, PROTECTION_MS } = require('../src/main/storage-cleanup');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { readDiscussionRecord } = require('../src/engines/discussions/store');
const { removeTree } = require('./test-fs.cjs');
const DAY = 86400000;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retention-')), dataDir = path.join(root, 'app'), home = path.join(root, 'home');
  fs.mkdirSync(dataDir); fs.mkdirSync(home);
  let now = Date.now() + 1000;
  const cleaner = new StorageCleanup({ dataDir, conversations: { items: new Map() }, references: async () => [], now: () => now });
  t.after(() => { clearTimeout(cleaner.previewTimer); removeTree(root); });
  const write = (relative, data = '{}') => {
    const file = path.join(dataDir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
    const old = new Date(now - 2 * PROTECTION_MS); fs.utimesSync(file, old, old); return file;
  };
  const backup = (age, content = { 'app/desktop-config.json': '{}' }, status = 'committed') => {
    const time = now - age * DAY, name = new Date(time).toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const directory = path.join(dataDir, 'migration-backups', name);
    for (const [rel, value] of Object.entries(content)) write(path.relative(dataDir, path.join(directory, rel)), value);
    if (status) completeBackup({ directory, header: { id: randomUUID(), createdAt: time }, begins: Object.keys(content).map(rel => ({ rel })) }, status, time);
    const old = new Date(time); fs.utimesSync(directory, old, old);
    return directory;
  };
  const inventory = options => backupInventory({ dataDir, safeStat: file => cleaner.safeStat(file), now,
    entries: directory => fs.existsSync(directory) ? fs.readdirSync(directory) : [], ...options });
  const remote = () => write('remote/device-attachments/' + randomUUID().replaceAll('-', '').repeat(2) + '.txt', 'attachment');
  return { root, dataDir, home, cleaner, write, backup, inventory, remote, advance: ms => { now += ms; } };
}
const paths = result => result.candidates.map(entry => entry.path);

test('completed backup count, age and byte limits retain the newest recovery point', async t => {
  const h = setup(t), dirs = [1, 2, 3, 4, 40].map(age => h.backup(age));
  const count = await h.inventory();
  assert.equal(count.summary.count, 5); assert.equal(count.candidates.length, 2);
  assert.deepEqual(paths(count).sort(), dirs.slice(3).map(dir => path.relative(h.dataDir, dir)).sort());
  const cap = await h.inventory({ maxBytes: 1 });
  assert.equal(cap.candidates.length, 4); assert.equal(cap.backups.find(b => b.directory === dirs[0]).expired, false);
  assert.ok(cap.summary.bytes > 1); // The cap is soft while the newest point is protected.
  const old = await h.inventory({ maxDays: 0 });
  assert.equal(old.candidates.length, 4); assert.ok(old.summary.reclaimableBytes < old.summary.bytes);
});

test('pending, damaged and unknown backup trees remain protected, and legacy cleanup is manual', async t => {
  const h = setup(t), completed = h.backup(45), pending = h.backup(46), invalid = h.backup(47), legacy = h.backup(48, undefined, null);
  h.write(path.relative(h.dataDir, path.join(pending, 'transaction.jsonl')), '{"version":1}\n');
  h.write(path.relative(h.dataDir, path.join(invalid, MARKER)), '{broken');
  h.write('migration-backups/user-owned/app/desktop-config.json');
  const state = await h.inventory();
  assert.equal(state.backups.length, 5); assert.equal(state.candidates.length, 0);
  assert.deepEqual(state.legacyCandidates.map(b => b.path), [path.relative(h.dataDir, legacy)]);
  assert.equal(state.summary.protected, 4);
  await h.cleaner.sweepRetention();
  for (const dir of [completed, pending, invalid, legacy]) assert.ok(fs.existsSync(dir));
  const preview = await h.cleaner.scan();
  assert.equal(preview.backups.count, 5);
  assert.deepEqual(preview.candidates.filter(b => b.category.includes('import backups')).map(b => b.path), [path.relative(h.dataDir, legacy)]);
  await h.cleaner.clean(preview.token);
  assert.equal(fs.existsSync(legacy), false); assert.ok(fs.existsSync(pending)); assert.ok(fs.existsSync(invalid));
});

test('quarantined original records remain protected in both completed and legacy backups', async t => {
  const h = setup(t), name = 'app/conversations/broken.json.invalid-' + randomUUID();
  const completed = h.backup(45, { [name]: '{broken' }), legacy = h.backup(46, { [name]: '{broken' }, null); h.backup(1);
  const state = await h.inventory();
  assert.equal(state.candidates.length, 0); assert.equal(state.legacyCandidates.length, 0); assert.equal(state.summary.protected, 3);
  assert.equal((await h.cleaner.sweepRetention()).files, 0);
  assert.ok(fs.existsSync(completed)); assert.ok(fs.existsSync(legacy));
});

test('large flat backup inventories yield and abort before visiting every file', async t => {
  const h = setup(t), content = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`app/file-${i}.txt`, 'text']));
  const dir = h.backup(45, content), abort = new AbortController(); let reads = 0;
  await assert.rejects(h.inventory({ signal: abort.signal,
    safeStat(file) { if (file.endsWith('.txt')) reads++; return h.cleaner.safeStat(file); },
    entries(directory) {
      if (directory === path.join(dir, 'app')) setImmediate(() => abort.abort(new Error('cancel retention test')));
      return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    } }), /cancel retention test/);
  assert.ok(reads > 0 && reads < 500); assert.ok(fs.existsSync(path.join(dir, 'app/file-499.txt')));
});

test('backup-only maintenance expires files without loading long or damaged live history', async t => {
  const h = setup(t); h.write('conversations/torn.json', '{broken');
  const dirs = [1, 2, 3, 4].map(age => h.backup(age));
  const result = await h.cleaner.sweepRetention();
  assert.equal(result.files, 2); assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(dirs[3]), false); assert.ok(fs.existsSync(dirs[0]));
});

test('an unreadable attachment reference does not hide successful independent backup pruning', async t => {
  const h = setup(t), attachment = h.remote(); h.write('conversations/torn.json', '{broken');
  const expired = h.backup(40); h.backup(1);
  const result = await h.cleaner.sweepRetention();
  assert.equal(result.files, 2); assert.equal(result.errors.length, 1); assert.match(result.errors[0].error, /Attachments retained/);
  assert.equal(fs.existsSync(expired), false); assert.ok(fs.existsSync(attachment));
});

test('retained shared and native backups protect orphan homes, logs and attachment references', async t => {
  const h = setup(t), attachment = h.remote(), nativeAttachment = h.remote(), orphan = h.remote();
  const transcript = h.write('conversations/retained.jsonl', '{"text":"native context"}\n');
  const engine = h.write('codex/api/conversations/retained/config.txt', 'member native context');
  const pending = h.backup(50, {
    'app/conversations/retained.json': '{"id":"retained"}',
    'app/conversations/retained.jsonl': JSON.stringify({ attachments: [{ path: attachment }] }) + '\n',
    'home/.claude/projects/workspace/native.jsonl': JSON.stringify({ text: nativeAttachment }) + '\n',
  }, null);
  h.write(path.relative(h.dataDir, path.join(pending, 'transaction.jsonl')), '{"version":1}\n');
  h.advance(2 * DAY);
  assert.equal((await h.cleaner.sweepAttachments()).files, 1);
  assert.equal(fs.existsSync(orphan), false);
  const preview = await h.cleaner.scan();
  assert.equal(preview.candidates.length, 0);
  for (const file of [attachment, nativeAttachment, transcript, engine]) assert.ok(fs.existsSync(file));
});

test('expired backup references release attachments only after the backup is actually removed', async t => {
  const h = setup(t), file = h.remote();
  const expired = h.backup(40, { 'app/conversations/historical.jsonl': JSON.stringify({ path: file }) + '\n' });
  h.backup(1);
  const preview = await h.cleaner.scan();
  assert.deepEqual(preview.candidates.map(c => c.category), ['Old import backups']);
  const manual = await h.cleaner.clean(preview.token);
  assert.equal(manual.files, 2); assert.ok(fs.existsSync(file)); assert.equal(fs.existsSync(expired), false);
  assert.equal((await h.cleaner.sweepRetention()).files, 1); assert.equal(fs.existsSync(file), false);
});

test('idle pruning can reclaim an expired backup and its unreferenced attachment in the same pass', async t => {
  const h = setup(t), file = h.remote(), retained = h.remote();
  h.backup(40, { 'app/desktop-config.json': JSON.stringify({ oldDraft: file }) });
  h.backup(1, { 'app/desktop-config.json': JSON.stringify({ draft: retained }) });
  const result = await h.cleaner.sweepRetention();
  assert.equal(result.files, 3); assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(file), false); assert.ok(fs.existsSync(retained));
});

test('a changed backup tree cannot be deleted by an old manual preview', async t => {
  const h = setup(t), expired = h.backup(40); h.backup(1);
  const preview = await h.cleaner.scan();
  const added = h.write(path.relative(h.dataDir, path.join(expired, 'app/user-added.txt')), 'preserve external edit');
  const result = await h.cleaner.clean(preview.token);
  assert.equal(result.files, 0); assert.equal(result.skipped, 1); assert.ok(fs.existsSync(added));
});

test('a same-size external backup edit invalidates automatic ownership', async t => {
  const h = setup(t), expired = h.backup(40, { 'app/config.txt': 'old' }); h.backup(1);
  const file = path.join(expired, 'app/config.txt'); fs.writeFileSync(file, 'new');
  const changed = new Date(Date.now()); fs.utimesSync(file, changed, changed);
  assert.equal((await h.cleaner.sweepRetention()).files, 0); assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('failed backup deletion keeps its attachment references protected until a successful retry', async t => {
  const h = setup(t), attachment = h.remote();
  const expired = h.backup(40, { 'app/config.json': JSON.stringify({ path: attachment }) }); h.backup(1);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (...args) => {
    if (args[0] === path.join(expired, 'app/config.json')) throw Object.assign(new Error('backup locked'), { code: 'EACCES' });
    return unlink(...args);
  });
  const failed = await h.cleaner.sweepRetention(); assert.equal(failed.errors.length, 1); assert.ok(fs.existsSync(attachment));
  t.mock.restoreAll(); assert.equal((await h.cleaner.sweepRetention()).files, 3); assert.equal(fs.existsSync(attachment), false);
});

test('partial backup deletion retries only the remaining manifest-owned files', async t => {
  const h = setup(t), expired = h.backup(40, { 'app/a.txt': 'a', 'app/b.txt': 'b' }); h.backup(1);
  fs.unlinkSync(path.join(expired, 'app/a.txt'));
  assert.equal((await h.cleaner.sweepRetention()).files, 2); assert.equal(fs.existsSync(expired), false);
});

test('linked backup trees and hardlinked files are retained without touching external data', async t => {
  const h = setup(t), dir = h.backup(40); h.backup(1);
  const external = path.join(h.root, 'external.json'); fs.linkSync(path.join(dir, 'app/desktop-config.json'), external);
  const snapshot = await h.inventory(); assert.equal(snapshot.candidates.length, 0); assert.equal(snapshot.referenceErrors.length, 1);
  assert.equal((await h.cleaner.sweepRetention()).files, 0); assert.ok(fs.existsSync(external));
  h.remote(); await assert.rejects(h.cleaner.sweepAttachments(), /backup could not be verified/);
});

for (const payloadLocation of ['backup', 'live']) test(`backed-up group payloads in ${payloadLocation} storage protect each member's context and attachments`, async t => {
  const h = setup(t), manager = new DiscussionManager({ dir: path.join(h.dataDir, 'discussions') });
  const group = manager.create({ cwd: h.root }), member = manager.addMember(group.id, { name: 'Member', engine: 'codex', connection: 'api', model: 'fixture' });
  const file = h.remote(), orphan = h.remote();
  const req = manager.enqueue(group.id, { requestId: 'backed-up', text: 'x'.repeat(17000) + file, participantIds: [member.id] });
  const delivery = manager.prepare(group.id, req.deliveryIds[0]);
  manager.saveInput(group.id, delivery.id, delivery.generation, { prompt: 'y'.repeat(17000) + file, inputThroughSeq: delivery.inputThroughSeq });
  const native = h.write(`codex/api/conversations/${delivery.runtimeId}/native.txt`, 'member context');
  const content = { [`app/discussions/${group.id}.json`]: fs.readFileSync(manager.store.file(group.id), 'utf8') };
  const payloadDir = path.join(h.dataDir, 'discussions', group.id + '.payloads');
  if (payloadLocation === 'backup') for (const name of fs.readdirSync(payloadDir)) content[`app/discussions/${group.id}.payloads/${name}`] = fs.readFileSync(path.join(payloadDir, name));
  h.backup(1, content, payloadLocation === 'live' ? null : 'committed'); fs.unlinkSync(manager.store.file(group.id));
  if (payloadLocation === 'backup') for (const name of fs.readdirSync(payloadDir)) fs.unlinkSync(path.join(payloadDir, name));
  h.advance(2 * DAY);
  assert.equal((await h.cleaner.sweepAttachments()).files, 1); assert.equal(fs.existsSync(orphan), false);
  assert.ok(fs.existsSync(file)); assert.ok(fs.existsSync(native));
  const preview = await h.cleaner.scan(); assert.equal(preview.candidates.filter(entry => !entry.category.includes('import backups')).length, 0);
});

test('new group backups copy unchanged immutable text before live payload pruning', async t => {
  const h = setup(t), manager = new DiscussionManager({ dir: path.join(h.dataDir, 'discussions') });
  const group = manager.create({ cwd: h.root }), member = manager.addMember(group.id, { name: 'Member', engine: 'codex', connection: 'api', model: 'fixture' });
  const text = 'retained message '.repeat(1500);
  manager.enqueue(group.id, { requestId: 'old', text, participantIds: [member.id] });
  const dir = h.backup(1, { 'app/empty.txt': '' }, null); fs.unlinkSync(path.join(dir, 'app/empty.txt'));
  const options = { dataDir: h.dataDir, home: h.home, homeEntries: [], backupDir: dir };
  const transaction = new ImportTransaction(options), source = h.write('replacement.json', '{}');
  await transaction.replace(`app/discussions/${group.id}.json`, source);
  assert.equal(transaction.commit(), null);
  manager.store.payloads.prune(group.id, new Set());
  const saved = path.join(dir, 'app/discussions', group.id + '.json');
  assert.equal(readDiscussionRecord(saved, group.id).messages[0].text, text);
  const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
  assert.ok(marker.entries.some(entry => entry.rel.endsWith('.text')));
});

test('interrupted backup payload copying retains the journal and can finish before live maintenance starts', async t => {
  const h = setup(t), manager = new DiscussionManager({ dir: path.join(h.dataDir, 'discussions') });
  const group = manager.create({ cwd: h.root }), member = manager.addMember(group.id, { name: 'Member', engine: 'codex', connection: 'api', model: 'fixture' });
  const text = 'crash-safe text '.repeat(1600); manager.enqueue(group.id, { requestId: 'old', text, participantIds: [member.id] });
  const dir = h.backup(1, { 'app/empty.txt': '' }, null); fs.unlinkSync(path.join(dir, 'app/empty.txt'));
  const options = { dataDir: h.dataDir, home: h.home, homeEntries: [], backupDir: dir };
  const transaction = new ImportTransaction(options); await transaction.replace(`app/discussions/${group.id}.json`, h.write('replacement.json', '{}'));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (String(from).endsWith('.text.retention.tmp')) throw Object.assign(new Error('interrupted payload copy'), { code: 'EIO' });
    return rename(from, to, ...args);
  });
  assert.match(transaction.commit(), /cleanup is pending/); assert.ok(fs.existsSync(path.join(dir, 'transaction.jsonl')));
  t.mock.restoreAll(); recoverDataImports(options);
  assert.equal(readDiscussionRecord(path.join(dir, 'app/discussions', group.id + '.json'), group.id).messages[0].text, text);
  assert.equal(fs.existsSync(path.join(dir, 'transaction.jsonl')), false);
  assert.ok(!fs.readdirSync(path.join(dir, 'app/discussions', group.id + '.payloads')).some(name => name.endsWith('.tmp')));
});

test('completion record failure leaves a committed journal for recovery without rolling back the import', async t => {
  const h = setup(t), dir = h.backup(1, { 'app/unused.txt': 'legacy' }, null);
  fs.unlinkSync(path.join(dir, 'app/unused.txt'));
  const source = h.write('source.txt', 'new'), target = h.write('desktop-config.json', 'old');
  const options = { dataDir: h.dataDir, home: h.home, homeEntries: [], backupDir: dir };
  const transaction = new ImportTransaction(options); await transaction.replace('app/desktop-config.json', source);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (to === path.join(dir, MARKER)) throw Object.assign(new Error('completion disk full'), { code: 'ENOSPC' });
    return rename(from, to, ...args);
  });
  assert.match(transaction.commit(), /cleanup is pending/); assert.ok(fs.existsSync(path.join(dir, 'transaction.jsonl')));
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  t.mock.restoreAll(); recoverDataImports(options);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')).status, 'committed');
  assert.equal(fs.existsSync(path.join(dir, 'transaction.jsonl')), false); assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});

test('a crash after the completion marker leaves a protected journal until the recovery pass finishes', async t => {
  // Keep completion records on the fixture's clock even when CI writes are slow.
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const h = setup(t), dir = h.backup(1, { 'app/empty.txt': '' }, null); fs.unlinkSync(path.join(dir, 'app/empty.txt'));
  const source = h.write('source.txt', 'new'); h.write('desktop-config.json', 'old');
  const options = { dataDir: h.dataDir, home: h.home, homeEntries: [], backupDir: dir };
  const transaction = new ImportTransaction(options); await transaction.replace('app/desktop-config.json', source);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (...args) => {
    if (args[0] === path.join(dir, 'transaction.jsonl')) throw Object.assign(new Error('journal locked'), { code: 'EBUSY' });
    return unlink(...args);
  });
  assert.match(transaction.commit(), /cleanup is pending/); h.advance(1000);
  const pending = (await h.inventory()).backups[0]; assert.equal(pending.pending, true); assert.equal(pending.completed, false);
  t.mock.restoreAll(); recoverDataImports(options);
  assert.equal((await h.inventory()).backups[0].completed, true);
});

test('successful rollback writes its durable completion marker before dropping recovery evidence', async t => {
  const h = setup(t), dir = h.backup(1, { 'app/empty.txt': '' }, null); fs.unlinkSync(path.join(dir, 'app/empty.txt'));
  const source = h.write('source.txt', 'new'), target = h.write('desktop-config.json', 'old');
  const options = { dataDir: h.dataDir, home: h.home, homeEntries: [], backupDir: dir };
  const transaction = new ImportTransaction(options); await transaction.replace('app/desktop-config.json', source);
  assert.equal(transaction.abort(new Error('later import failure')).rolledBack, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')).status, 'rolled-back');
  assert.equal(fs.existsSync(path.join(dir, 'transaction.jsonl')), false); assert.equal(fs.readFileSync(target, 'utf8'), 'old');
});
