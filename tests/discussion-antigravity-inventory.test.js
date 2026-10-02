'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readAntigravityNativeInventory } = require('../src/engines/discussions/antigravity-history-inventory');
const { removeTree } = require('./test-fs.cjs');

const sdkId = () => randomBytes(16).toString('hex');
function fixture(t) {
  // Keep the fixture outside macOS's /var alias without relaxing the scanner's
  // checks for linked storage and linked ancestors.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'discussion-antigravity-inventory-test-'));
  const home = path.join(root, 'adapter'), cliDataDir = path.join(root, 'cli');
  const databases = [];
  t.after(() => { for (const db of databases) { try { db.close(); } catch {} } removeTree(root); });
  const write = (file, record) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(record)); return file;
  };
  const database = (file, sql) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new DatabaseSync(file); databases.push(db); db.exec(sql); return db;
  };
  const native = (storageDir, id) => {
    const file = path.join(storageDir, id + '.db');
    const db = database(file, 'CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT); CREATE TABLE steps (content TEXT)');
    db.prepare('INSERT INTO trajectory_meta VALUES (?,?)').run(id, id);
    db.prepare('INSERT INTO steps VALUES (?)').run('private transcript text'); return { db, file };
  };
  const summaries = () => {
    const file = path.join(cliDataDir, 'conversation_summaries.db');
    const db = database(file, "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT DEFAULT '', winning_conversation_id TEXT DEFAULT '', app_data_dir TEXT DEFAULT '', title TEXT DEFAULT '', status TEXT DEFAULT '')");
    return { db, file };
  };
  const sdk = (conversationId = sdkId(), nativeId = randomUUID()) => {
    const dir = path.join(home, 'sessions', nativeId), storageDir = path.join(dir, 'native');
    const file = write(path.join(dir, 'session.json'), { conversationId });
    return { nativeId, conversationId, storageDir, file };
  };
  const cli = (conversationId = randomUUID(), nativeId = 'agy-' + randomUUID()) => {
    const file = write(path.join(home, 'cli-sessions', nativeId + '.json'), { id: nativeId, cwd: root, ...(conversationId === null ? {} : { conversationId }) });
    return { nativeId, conversationId, storageDir: path.join(cliDataDir, 'conversations'), file };
  };
  const sources = { homes: [{ home, cliDataDir }], cliDataDirs: [], sdkSaveDirs: [] };
  const read = limits => readAntigravityNativeInventory(sources, limits);
  return { root, home, cliDataDir, write, database, native, summaries, sdk, cli, sources, read };
}

test('SDK copies with the same native ID remain distinct by save directory', t => {
  const h = fixture(t), id = sdkId(), first = h.sdk(id), second = h.sdk(id);
  h.native(first.storageDir, id); h.native(second.storageDir, id);
  const result = h.read();
  assert.deepEqual(result.bridges.map(row => row.conversationId), [id, id]);
  assert.equal(new Set(result.bridges.map(row => row.storageDir)).size, 2);
  assert.equal(result.histories.length, 2); assert.equal(Object.hasOwn(result, 'complete'), false);
  assert.ok(result.bridges.every(row => row.databaseVerified === true));
  assert.ok(!JSON.stringify(result).includes('private transcript text'));
});

test('CLI aliases retain the same storage identity instead of claiming independent histories', t => {
  const h = fixture(t), id = randomUUID(), first = h.cli(id), second = h.cli(id);
  h.native(first.storageDir, id);
  const result = h.read();
  assert.equal(result.bridges.length, 2); assert.equal(result.histories.length, 1);
  assert.notEqual(first.nativeId, second.nativeId);
  assert.equal(result.bridges[0].storageDir, result.bridges[1].storageDir);
  assert.equal(result.bridges[0].conversationId, result.bridges[1].conversationId);
});

test('unmapped native files and all summary IDs include unnamed, archived, child, missing and related histories', t => {
  const h = fixture(t), ids = Array.from({ length: 6 }, randomUUID), { db } = h.summaries();
  db.prepare('INSERT INTO conversation_summaries(conversation_id,title,status) VALUES (?,?,?)').run(ids[0], '', 'archived');
  db.prepare('INSERT INTO conversation_summaries(conversation_id,parent_conversation_id,winning_conversation_id,app_data_dir) VALUES (?,?,?,?)')
    .run(ids[1], ids[2], ids[3], h.cliDataDir);
  h.native(path.join(h.cliDataDir, 'conversations'), ids[4]);
  const external = path.join(h.root, 'external-save'), rawSdk = sdkId(); h.native(external, rawSdk);
  h.sources.sdkSaveDirs.push(external);
  h.sources.cliDataDirs.push(path.join(h.root, 'external-cli'));
  h.native(path.join(h.root, 'external-cli/conversations'), ids[5]);
  const result = h.read(); assert.deepEqual(result.bridges, []);
  assert.deepEqual(result.histories.map(row => row.conversationId).sort(), [...ids, rawSdk].sort());
});

test('CLI orphan brain, annotations and presence references reserve identities without reading their content', t => {
  const h = fixture(t), ids = Array.from({ length: 3 }, randomUUID);
  fs.mkdirSync(path.join(h.cliDataDir, 'brain', ids[0]), { recursive: true });
  h.write(path.join(h.cliDataDir, 'annotations', ids[1] + '.pbtxt'), 'not parsed');
  h.write(path.join(h.cliDataDir, 'presence', ids[2] + '.lock'), 'not a stopped proof');
  assert.deepEqual(h.read().histories.map(row => row.conversationId).sort(), ids.sort());
});

test('pending bridges and mapped IDs with missing native files stay visible', t => {
  const h = fixture(t), first = h.cli(null), second = h.cli(), third = randomUUID();
  fs.mkdirSync(path.join(h.home, 'sessions', third), { recursive: true });
  const result = h.read();
  assert.equal(result.bridges.length, 3); assert.equal(result.histories.length, 1);
  assert.equal(result.bridges.find(row => row.nativeId === first.nativeId).conversationId, null);
  assert.equal(result.bridges.find(row => row.nativeId === third).conversationId, null);
  assert.equal(result.histories[0].conversationId, second.conversationId);
  assert.ok(result.bridges.every(row => row.databaseVerified === false));
});

test('index and parent references do not substitute for the bridge native database', t => {
  const h = fixture(t), row = h.cli(), { db } = h.summaries(), sdk = h.sdk(), childId = sdkId();
  db.prepare('INSERT INTO conversation_summaries(conversation_id) VALUES (?)').run(row.conversationId);
  const child = h.native(sdk.storageDir, childId); child.db.prepare('UPDATE trajectory_meta SET cascade_id=?').run(sdk.conversationId);
  const result = h.read();
  assert.ok(result.histories.some(history => history.conversationId === row.conversationId));
  assert.ok(result.histories.some(history => history.conversationId === sdk.conversationId));
  assert.ok(result.bridges.every(bridge => bridge.databaseVerified === false));
  h.native(row.storageDir, row.conversationId);
  assert.equal(h.read().bridges.find(bridge => bridge.nativeId === row.nativeId).databaseVerified, true);
});

test('explicit sources are required; missing sources are not created and duplicate paths are deduplicated', t => {
  const h = fixture(t);
  assert.deepEqual(h.read(), { bridges: [], histories: [] }); assert.equal(fs.existsSync(h.home), false);
  assert.equal(fs.existsSync(h.cliDataDir), false);
  assert.throws(() => readAntigravityNativeInventory(), /Explicit/);
  assert.throws(() => readAntigravityNativeInventory({ homes: [], sdkSaveDirs: [] }), /Explicit/);
  h.sources.homes.push({ home: 'relative', cliDataDir: h.cliDataDir }); assert.throws(() => h.read(), /Explicit/); h.sources.homes.pop();
  const row = h.cli(); h.native(row.storageDir, row.conversationId);
  h.sources.homes.push({ ...h.sources.homes[0] }); h.sources.cliDataDirs.push(h.cliDataDir);
  const result = h.read(); assert.equal(result.bridges.length, 1); assert.equal(result.histories.length, 1);
});

test('the same bridge ID in two homes is ambiguous even when its native storage matches', t => {
  const h = fixture(t), row = h.cli(), other = path.join(h.root, 'other-home');
  h.write(path.join(other, 'cli-sessions', row.nativeId + '.json'), JSON.parse(fs.readFileSync(row.file)));
  h.sources.homes.push({ home: other, cliDataDir: h.cliDataDir });
  assert.throws(() => h.read(), /multiple homes/);
});

test('invalid and partial bridge records never become an empty inventory', t => {
  const h = fixture(t), row = h.cli(), record = JSON.parse(fs.readFileSync(row.file));
  for (const value of [[], null, {}, { ...record, id: 'agy-' + randomUUID() }, { ...record, conversationId: '../x' },
    { ...record, conversationId: null }, { ...record, conversationId: [record.conversationId] }, { ...record, cwd: 'relative' }, { ...record, unverifiedSetting: true }]) {
    h.write(row.file, value); assert.throws(() => h.read(), /metadata/);
  }
  fs.writeFileSync(row.file, '{"private input'); assert.throws(() => h.read(), error => /metadata/.test(error.message) && !error.message.includes('private input'));
  h.write(row.file, record); const sdk = h.sdk(); h.write(sdk.file, { conversationId: randomUUID() }); assert.throws(() => h.read(), /metadata/);
  h.write(sdk.file, { conversationId: sdk.conversationId }); h.write(path.join(path.dirname(sdk.file), 'session.tmp'), {});
  assert.throws(() => h.read(), /incomplete/);
});

test('unknown bridge directories, native entries and artifact entries fail closed', t => {
  const h = fixture(t), sdk = h.sdk(), unexpected = path.join(sdk.storageDir, 'future-format.bin');
  h.write(unexpected, {}); assert.throws(() => h.read(), /Unrecognized/); fs.unlinkSync(unexpected);
  fs.mkdirSync(path.join(h.home, 'sessions', 'not-an-id')); assert.throws(() => h.read(), /bridge ID/);
  fs.rmdirSync(path.join(h.home, 'sessions', 'not-an-id'));
  h.write(path.join(h.cliDataDir, 'annotations', 'unknown.pbtxt'), {}); assert.throws(() => h.read(), /native reference/);
});

test('corrupt, orphan-WAL, mismatched and unsupported native databases fail closed', t => {
  const h = fixture(t), row = h.cli(), file = path.join(row.storageDir, row.conversationId + '.db');
  h.write(file, 'corrupt'); assert.throws(() => h.read(), /database/); fs.unlinkSync(file);
  fs.writeFileSync(file + '-wal', 'partial'); assert.throws(() => h.read(), /Incomplete/); fs.unlinkSync(file + '-wal');
  const { db } = h.native(row.storageDir, row.conversationId);
  db.prepare('UPDATE trajectory_meta SET cascade_id=?').run(randomUUID()); assert.throws(() => h.read(), /identity mismatch/);
  db.exec('DROP TABLE trajectory_meta; CREATE VIEW trajectory_meta AS SELECT 1 AS trajectory_id'); assert.throws(() => h.read(), /Unverified/);
});

test('indexed redirects and invalid linked conversation IDs are not silently accepted', t => {
  const h = fixture(t), { db } = h.summaries(), id = randomUUID();
  db.prepare('INSERT INTO conversation_summaries(conversation_id,app_data_dir) VALUES (?,?)').run(id, path.join(h.root, 'elsewhere'));
  assert.throws(() => h.read(), /redirect/);
  db.exec("UPDATE conversation_summaries SET app_data_dir='', parent_conversation_id='bad'"); assert.throws(() => h.read(), /conversation ID/);
});

test('CLI cascade IDs and SDK trajectory IDs use their respective database identities', t => {
  const h = fixture(t), row = h.cli(), { db } = h.native(row.storageDir, row.conversationId);
  db.prepare('UPDATE trajectory_meta SET trajectory_id=?').run(randomUUID());
  db.prepare('INSERT INTO trajectory_meta VALUES (?,?)').run(randomUUID(), row.conversationId);
  assert.equal(h.read().histories.length, 1);
  db.prepare('UPDATE trajectory_meta SET cascade_id=?').run(randomUUID()); assert.throws(() => h.read(), /identity mismatch/);
});

test('CLI namespace metadata is accepted only in the verified product directory', t => {
  const h = fixture(t), { db, file } = h.summaries(), id = randomUUID();
  db.prepare('INSERT INTO conversation_summaries(conversation_id,app_data_dir) VALUES (?,?)').run(id, 'antigravity-cli');
  assert.throws(() => h.read(), /redirect/); db.close();
  const cliDataDir = path.join(h.root, 'antigravity-cli'); fs.mkdirSync(cliDataDir);
  fs.copyFileSync(file, path.join(cliDataDir, 'conversation_summaries.db'));
  h.sources.homes[0].cliDataDir = cliDataDir;
  assert.deepEqual(h.read().histories.map(row => row.conversationId), [id]);
});

test('one bridge home cannot be assigned two CLI storage scopes', t => {
  const h = fixture(t); h.cli(); h.sources.homes.push({ home: h.home, cliDataDir: path.join(h.root, 'different') });
  assert.throws(() => h.read(), /Ambiguous/);
});

test('WAL snapshots read committed metadata without touching source databases or WALs', t => {
  const h = fixture(t), { db, file } = h.summaries(), id = randomUUID();
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.prepare('INSERT INTO conversation_summaries(conversation_id) VALUES (?)').run(id);
  db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO conversation_summaries(conversation_id) VALUES (?)').run(randomUUID());
  const snapshot = () => ['', '-wal'].map(suffix => ({ hash: createHash('sha256').update(fs.readFileSync(file + suffix)).digest('hex'), mtime: fs.statSync(file + suffix).mtimeMs }));
  const before = snapshot();
  assert.deepEqual(h.read().histories.map(row => row.conversationId), [id]); assert.deepEqual(snapshot(), before);
  db.exec('ROLLBACK');
});

test('a WAL commit during snapshot copying invalidates the whole result', t => {
  const h = fixture(t), { db, file } = h.summaries(); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.prepare('INSERT INTO conversation_summaries(conversation_id) VALUES (?)').run(randomUUID());
  const open = fs.openSync, read = fs.readSync; let target, changed = false;
  t.mock.method(fs, 'openSync', (fileName, ...args) => { const fd = open(fileName, ...args); if (fileName === file + '-wal') target = fd; return fd; });
  t.mock.method(fs, 'readSync', (...args) => {
    const result = read(...args);
    if (args[0] === target && !changed) { changed = true; db.prepare('INSERT INTO conversation_summaries(conversation_id) VALUES (?)').run(randomUUID()); }
    return result;
  });
  assert.throws(() => h.read(), /changed/); assert.equal(changed, true);
});

test('bridge replacement or a new directory during scanning invalidates ownership', t => {
  const h = fixture(t), row = h.cli(), read = fs.readSync; let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = read(...args);
    if (!changed) { changed = true; fs.mkdirSync(path.join(h.home, 'sessions', randomUUID()), { recursive: true }); }
    return result;
  });
  assert.throws(() => h.read(), /changed/); assert.equal(changed, true);
  t.mock.restoreAll();
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === row.file) {
      const old = file + '.old'; fs.renameSync(file, old); fs.copyFileSync(old, file); fs.unlinkSync(old);
    }
    return open(file, ...args);
  });
  assert.throws(() => h.read(), /changed/);
});

test('metadata, aggregate byte and entry limits reject instead of truncating the inventory', t => {
  const h = fixture(t); h.cli();
  assert.throws(() => h.read({ maxMetadataBytes: 1 }), /byte limit/);
  assert.throws(() => h.read({ maxBytes: 1 }), /byte limit/);
  assert.throws(() => h.read({ maxEntries: 1 }), /entry limit/);
  for (const name of ['maxMetadataBytes', 'maxBytes', 'maxEntries']) assert.throws(() => h.read({ [name]: 0 }), /limits/);
});

test('junctions, linked ancestors and hard links cannot masquerade as isolated storage', t => {
  const h = fixture(t), row = h.sdk(), external = path.join(h.root, 'external'); fs.mkdirSync(external);
  fs.symlinkSync(external, row.storageDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => h.read(), /Linked/); fs.unlinkSync(row.storageDir);
  const linked = path.join(h.root, 'alias'); fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  h.sources.sdkSaveDirs.push(path.join(linked, 'missing')); assert.throws(() => h.read(), /Linked/); h.sources.sdkSaveDirs.pop();
  const native = h.native(row.storageDir, row.conversationId); fs.linkSync(native.file, path.join(h.root, 'hardlink.db'));
  assert.throws(() => h.read(), /Linked/);
});
