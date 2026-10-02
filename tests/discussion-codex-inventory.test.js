'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const TOML = require('smol-toml');
const { readCodexNativeHistories, readCodexApplicationHistories } = require('../src/engines/discussions/codex-history-inventory');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { createDiscussionBoundary } = require('../src/engines/discussions/native-boundary');
const { SessionPool } = require('../src/engines/session-pool');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { removeTree } = require('./test-fs.cjs');

function fixture(t) {
  // macOS exposes os.tmpdir() through /var; ownership fixtures use the real
  // directory so only the links explicitly created by tests are rejected.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'discussion-codex-inventory-test-'));
  const home = path.join(root, 'native-home'); fs.mkdirSync(home);
  const databases = [];
  t.after(() => { for (const db of databases) { try { db.close(); } catch {} } removeTree(root); });
  const database = (dir = home) => {
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'state_5.sqlite')); databases.push(db);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT DEFAULT '', source TEXT DEFAULT 'cli', archived INTEGER DEFAULT 0, rollout_path TEXT DEFAULT '')");
    return db;
  };
  const rollout = (id, { dir = path.join(home, 'sessions/2026/10/02'), name, metadata, tail = '' } = {}) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name || `rollout-2026-10-02T12-00-00-${id}.jsonl`);
    fs.writeFileSync(file, (metadata ?? JSON.stringify({ timestamp: '2026-10-02T12:00:00Z', type: 'session_meta', payload: { id } })) + '\n' + tail);
    return file;
  };
  const ids = (homes = [home], limits) => readCodexNativeHistories(homes, limits).map(row => {
    assert.equal(row.engine, 'codex'); assert.deepEqual(Object.keys(row).sort(), ['engine', 'nativeId']); return row.nativeId;
  }).sort();
  const config = (value, file = path.join(home, 'config.toml')) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, TOML.stringify(value)); return file;
  };
  return { root, home, database, rollout, ids, config };
}

test('raw SQLite inventory includes archived, unnamed, subagent and missing-rollout threads without import filters', t => {
  const h = fixture(t), db = h.database(), ids = Array.from({ length: 5 }, randomUUID);
  const insert = db.prepare('INSERT INTO threads (id,title,source,archived,rollout_path) VALUES (?,?,?,?,?)');
  insert.run(ids[0], 'Current', 'cli', 0, 'missing-current.jsonl');
  insert.run(ids[1], 'Archived', 'cli', 1, 'missing-archive.jsonl');
  insert.run(ids[2], '', 'cli', 0, '');
  insert.run(ids[3], 'Child', '{"subagent":{"parent_thread_id":"parent"}}', 0, '');
  insert.run(ids[4], 'Missing rollout', 'desktop', 0, 'does-not-exist.jsonl');
  assert.deepEqual(h.ids(), ids.sort());
});

test('a live WAL snapshot sees committed IDs and never writes the source database or journal files', t => {
  const h = fixture(t), db = h.database(), id = randomUUID(), pending = randomUUID();
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.prepare('INSERT INTO threads(id) VALUES(?)').run(id);
  db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO threads(id) VALUES(?)').run(pending);
  const files = ['', '-wal'].map(suffix => path.join(h.home, 'state_5.sqlite' + suffix));
  const snapshot = () => files.map(file => ({ hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    stat: fs.statSync(file).mtimeMs }));
  const before = snapshot();
  assert.deepEqual(h.ids(), [id]); assert.deepEqual(snapshot(), before);
  db.exec('ROLLBACK');
});

test('a concurrent WAL commit invalidates the snapshot without returning a partial set of owners', t => {
  const h = fixture(t), db = h.database();
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.prepare('INSERT INTO threads(id) VALUES(?)').run(randomUUID());
  const open = fs.openSync, read = fs.readSync; let walFd, changed = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = open(file, ...args); if (file === path.join(h.home, 'state_5.sqlite-wal')) walFd = fd; return fd;
  });
  t.mock.method(fs, 'readSync', (...args) => {
    const result = read(...args);
    if (args[0] === walFd && !changed) { changed = true; db.prepare('INSERT INTO threads(id) VALUES(?)').run(randomUUID()); }
    return result;
  });
  assert.throws(() => h.ids(), /source changed/);
  assert.equal(changed, true); assert.equal(db.prepare('SELECT count(*) AS n FROM threads').get().n, 2);
});

test('rollout-only and archived native IDs remain reserved, and a matching SQLite row is deduplicated', t => {
  const h = fixture(t), first = randomUUID(), archived = randomUUID(), db = h.database();
  db.prepare('INSERT INTO threads(id) VALUES(?)').run(first);
  h.rollout(first); h.rollout(archived, { dir: path.join(h.home, 'archived_sessions') });
  assert.deepEqual(h.ids(), [first, archived].sort());
});

test('the bounded metadata prefix never parses the transcript body or returns stored conversation text', t => {
  const h = fixture(t), id = randomUUID();
  h.rollout(id, { tail: 'private conversation text ' + 'x'.repeat(1024 * 1024) });
  assert.deepEqual(h.ids([h.home], { maxBytes: 8192 }), [id]);
});

test('unknown database layouts, missing main databases and corrupt indexes cannot be treated as empty', t => {
  const h = fixture(t), unknown = path.join(h.home, 'state_6.sqlite'); fs.writeFileSync(unknown, '');
  assert.throws(() => h.ids(), /Unverified.*layout/); fs.unlinkSync(unknown);
  const wal = path.join(h.home, 'state_5.sqlite-wal'); fs.writeFileSync(wal, 'partial');
  assert.throws(() => h.ids(), /Incomplete.*database/); fs.unlinkSync(wal);
  fs.writeFileSync(path.join(h.home, 'state_5.sqlite'), 'private malformed contents');
  assert.throws(() => h.ids(), error => /Cannot verify/.test(error.message) && !error.message.includes('private'));
});

test('a view or invalid thread identity cannot impersonate the native thread table', t => {
  const h = fixture(t), db = h.database();
  db.prepare('INSERT INTO threads(id) VALUES(?)').run('../not-a-thread');
  assert.throws(() => h.ids(), /Invalid.*thread ID/);
  db.exec("DROP TABLE threads; CREATE VIEW threads AS SELECT 'hidden' AS id");
  assert.throws(() => h.ids(), /Unverified.*thread table/);
});

test('partial, oversized, mismatched and unrecognized rollout entries fail closed', t => {
  const h = fixture(t), id = randomUUID(), file = h.rollout(id), original = fs.readFileSync(file);
  for (const contents of ['', '{partial', '{private malformed contents}\n', JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n']) {
    fs.writeFileSync(file, contents);
    assert.throws(() => h.ids(), /rollout/);
  }
  fs.writeFileSync(file, original);
  assert.throws(() => h.ids([h.home], { maxHeaderBytes: 16 }), /header limit/);
  fs.renameSync(file, path.join(path.dirname(file), 'unknown.jsonl'));
  assert.throws(() => h.ids(), /Unrecognized.*entry/);
});

test('entry, byte and depth limits refuse a partial native inventory', t => {
  const h = fixture(t), db = h.database(); db.prepare('INSERT INTO threads(id) VALUES(?)').run(randomUUID());
  assert.throws(() => h.ids([h.home], { maxEntries: 1 }), /entry limit/);
  assert.throws(() => h.ids([h.home], { maxBytes: 128 }), /byte limit/);
  h.rollout(randomUUID());
  assert.throws(() => h.ids([h.home], { maxDepth: 1 }), /depth limit/);
  assert.throws(() => h.ids([h.home], { maxHeaderBytes: 0 }), /limits/);
});

test('absent homes are read-only emptiness and repeated paths do not duplicate ownership', t => {
  const h = fixture(t), absent = path.join(h.root, 'not-created');
  assert.deepEqual(h.ids([absent]), []); assert.equal(fs.existsSync(absent), false);
  const id = randomUUID(); h.rollout(id);
  assert.deepEqual(h.ids([h.home, h.home]), [id]);
  assert.throws(() => h.ids([]), /Explicit.*homes/);
  assert.throws(() => h.ids(['relative']), /Explicit.*homes/);
});

test('copies of one thread across native homes are ambiguous even when each index is valid', t => {
  const h = fixture(t), id = randomUUID(), other = path.join(h.root, 'second-home');
  for (const home of [h.home, other]) h.database(home).prepare('INSERT INTO threads(id) VALUES(?)').run(id);
  assert.throws(() => h.ids([h.home, other]), /more than one native home/);
});

test('linked native directories and hard-linked rollout files cannot extend source coverage', t => {
  const h = fixture(t), target = path.join(h.root, 'outside'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(h.home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => h.ids(), /Linked.*source/);
  fs.unlinkSync(path.join(h.home, 'sessions'));
  const file = h.rollout(randomUUID()); fs.linkSync(file, path.join(target, 'copy.jsonl'));
  assert.throws(() => h.ids(), /Linked.*source/);
});

test('a thread created in a previously absent source directory during scanning invalidates the result', t => {
  const h = fixture(t), id = randomUUID(); h.rollout(id);
  const original = fs.readSync; let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = original(...args);
    if (!changed) { changed = true; h.rollout(randomUUID(), { dir: path.join(h.home, 'archived_sessions') }); }
    return result;
  });
  assert.throws(() => h.ids(), /sources changed/);
});

test('streaming transcript appends preserve identity, but changed metadata cannot authorize a thread', t => {
  const h = fixture(t), id = randomUUID(), file = h.rollout(id), original = fs.readSync;
  let changed = false;
  const mocked = t.mock.method(fs, 'readSync', (...args) => {
    const result = original(...args);
    if (!changed) { changed = true; fs.appendFileSync(file, '{streamed response}\n'); }
    return result;
  });
  assert.deepEqual(h.ids(), [id]); mocked.mock.restore(); changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = original(...args);
    if (!changed) {
      changed = true; fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n');
    }
    return result;
  });
  assert.throws(() => h.ids(), /identity changed/);
});

test('raw-only native IDs reach discussion admission without a mirror or ordinary conversation record', t => {
  const h = fixture(t), id = randomUUID(); h.database().prepare('INSERT INTO threads(id) VALUES(?)').run(id);
  const manager = new DiscussionManager({ dir: path.join(h.root, 'discussions') }), group = manager.create({ cwd: h.root });
  const member = manager.addMember(group.id, { name: 'Member', engine: 'codex', connection: 'api', model: 'fixture' });
  const { ownership, registry } = createDiscussionBoundary({ dataDir: h.root, conversations: () => [],
    drivers: { codex: { sessions: new SessionPool(), history: new ClaudeHistory(path.join(h.root, 'mirror')) } },
    // Complete only for this synthetic fixture. Production home resolution,
    // external activity coverage and policy verification are not configured.
    external: () => ({ complete: true, histories: readCodexNativeHistories([h.home]), activities: [] }) });
  assert.equal(registry.entries.size, 0);
  assert.throws(() => ownership.reserve({ engine: 'codex', discussionId: group.id, participantId: member.id,
    runtimeId: member.session.runtimeId, generation: 1, nativeId: id }), /another.*owner/);
  assert.equal(ownership.active.size, 0);
});

test('application sources cover legacy, API, ordinary runtime, default, configured and orphan account homes', t => {
  const h = fixture(t), dataDir = path.join(h.root, 'app'), external = path.join(h.root, 'external'), policy = path.join(h.root, 'policy');
  const homes = [path.join(dataDir, 'codex'), path.join(dataDir, 'codex/api'),
    path.join(dataDir, 'codex/api/conversations', 'internal-summary-' + randomUUID()),
    path.join(dataDir, 'codex/subscription'), path.join(dataDir, 'subscription-accounts/codex/account-1'),
    path.join(dataDir, 'subscription-accounts/codex/orphan-account'), external, policy];
  const expected = homes.map(home => {
    const id = randomUUID(); h.database(home).prepare('INSERT INTO threads(id) VALUES(?)').run(id); return id;
  });
  const rows = readCodexApplicationHistories({ dataDir, accounts: [{ id: 'default' }, { id: 'account-1' }],
    externalHomes: [external], discussionHomes: [policy] });
  assert.deepEqual(rows.map(row => row.nativeId).sort(), expected.sort());
});

test('application inventory requires explicit external roots and never uses a silently filtered account list', t => {
  const h = fixture(t), options = { dataDir: path.join(h.root, 'app'), externalHomes: [] };
  assert.throws(() => readCodexApplicationHistories({ dataDir: options.dataDir }), /Explicit/);
  for (const accounts of [{}, [{ id: '../escape' }], [{}], [{ id: 'default' }, { id: 'default' }],
    Array.from({ length: 13 }, (_, i) => ({ id: 'account-' + i }))]) {
    assert.throws(() => readCodexApplicationHistories({ ...options, accounts }), /Explicit/);
  }
  assert.deepEqual(readCodexApplicationHistories(options), []);
  assert.equal(fs.existsSync(options.dataDir), false);
});

test('unknown entries and linked roots cannot disappear while resolving native account or runtime homes', t => {
  const h = fixture(t), dataDir = path.join(h.root, 'app'), dir = path.join(dataDir, 'subscription-accounts/codex');
  fs.mkdirSync(dir, { recursive: true }); const entry = path.join(dir, 'unknown-record'); fs.writeFileSync(entry, 'partial');
  assert.throws(() => readCodexApplicationHistories({ dataDir, externalHomes: [] }), /Invalid.*home entry/);
  fs.unlinkSync(entry);
  fs.symlinkSync(h.home, entry, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readCodexApplicationHistories({ dataDir, externalHomes: [] }), /Linked.*source/);
});

test('a runtime home appearing after application home resolution cannot escape the final verification', t => {
  const h = fixture(t), dataDir = path.join(h.root, 'app');
  const home = path.join(dataDir, 'codex/api'); h.database(home).prepare('INSERT INTO threads(id) VALUES(?)').run(randomUUID());
  const original = fs.readSync; let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = original(...args);
    if (!changed) { changed = true; fs.mkdirSync(path.join(home, 'conversations', randomUUID()), { recursive: true }); }
    return result;
  });
  assert.throws(() => readCodexApplicationHistories({ dataDir, externalHomes: [] }), /sources changed/);
});

test('SQLite redirects retain the default database, every configured profile and native rollout ownership', t => {
  const h = fixture(t), configured = path.join(h.root, 'configured'), inactive = path.join(h.root, 'inactive'),
    fileProfile = path.join(h.root, 'file-profile');
  const expected = [h.home, configured, inactive, fileProfile].map(dir => {
    const id = randomUUID(); h.database(dir).prepare('INSERT INTO threads(id) VALUES(?)').run(id); return id;
  });
  h.config({ sqlite_home: configured, profiles: { old: { sqlite_home: inactive } } });
  h.config({ sqlite_home: fileProfile }, path.join(h.home, 'another.config.toml'));
  const rolloutId = randomUUID(); h.rollout(rolloutId); expected.push(rolloutId);
  assert.deepEqual(h.ids(), expected.sort());
});

test('explicit config layers and resolved environment or CLI roots merge across repeated native homes', t => {
  const h = fixture(t), environment = path.join(h.root, 'environment'), project = path.join(h.root, 'project-state'),
    old = path.join(h.root, 'old-state');
  const expected = [environment, project, old].map(dir => {
    const id = randomUUID(); h.database(dir).prepare('INSERT INTO threads(id) VALUES(?)').run(id); return id;
  });
  const file = h.config({ sqlite_home: project }, path.join(h.root, 'project/.codex/config.toml'));
  assert.deepEqual(h.ids([h.home, { home: h.home, sqliteHomes: [environment], configFiles: [file] },
    { home: h.home, sqliteHomes: [old, environment], configFiles: [file] }]), expected.sort());
});

test('an absent redirected directory remains absent, but a missing declared config file is not an empty source', t => {
  const h = fixture(t), absent = path.join(h.root, 'not-created');
  h.config({ sqlite_home: absent });
  assert.deepEqual(h.ids(), []); assert.equal(fs.existsSync(absent), false);
  assert.throws(() => h.ids([{ home: h.home, configFiles: [path.join(absent, 'config.toml')] }]), /Missing declared/);
});

test('relative redirects, invalid source descriptors and malformed configuration cannot drop hidden native histories', t => {
  const h = fixture(t), file = path.join(h.home, 'config.toml');
  for (const value of ['relative', '~/state', 'C:state', '', 17, [], {}, 'private\0path', ...(process.platform === 'win32' ? ['\\state'] : [])]) {
    h.config({ sqlite_home: value });
    assert.throws(() => h.ids(), /Unresolved Codex/);
  }
  for (const value of ['api_token = "private-token"\nsqlite_home = ', 'profiles = 7', 'profiles = { broken = 7 }']) {
    fs.writeFileSync(file, value);
    assert.throws(() => h.ids(), error => /storage configuration/.test(error.message) && !/private-token/.test(error.message));
  }
  fs.writeFileSync(file, Buffer.from([0xff]));
  assert.throws(() => h.ids(), /storage configuration/);
  fs.unlinkSync(file);
  for (const value of [null, {}, { home: h.home, typo: [] }, { home: h.home, sqliteHomes: 'dir' },
    { home: h.home, sqliteHomes: ['relative'] }, { home: h.home, configFiles: [null] }]) {
    assert.throws(() => h.ids([value]), /Explicit Codex/);
  }
});

test('redirected sources have the same schema, entry and configuration byte bounds', t => {
  const h = fixture(t), dir = path.join(h.root, 'state'); fs.mkdirSync(dir);
  h.config({ sqlite_home: dir });
  const unsupported = path.join(dir, 'state_6.sqlite'); fs.writeFileSync(unsupported, '');
  assert.throws(() => h.ids(), /Unverified.*layout/); fs.unlinkSync(unsupported);
  assert.throws(() => h.ids([h.home], { maxConfigBytes: 4 }), /byte limit/);
  assert.throws(() => h.ids([{ home: h.home, sqliteHomes: Array(10).fill(dir) }], { maxEntries: 5 }), /entry limit/);
  assert.throws(() => h.ids([h.home], { maxConfigBytes: 0 }), /limits/);
});

test('one SQLite directory shared by two native homes cannot reassign the same native identity', t => {
  const h = fixture(t), id = randomUUID(), dir = path.join(h.root, 'shared'), other = path.join(h.root, 'other');
  h.database(dir).prepare('INSERT INTO threads(id) VALUES(?)').run(id);
  h.config({ sqlite_home: dir }); h.config({ sqlite_home: dir }, path.join(other, 'config.toml'));
  assert.throws(() => h.ids([h.home, other]), /more than one native home/);
});

test('linked config files and missing SQLite directories behind linked ancestors fail closed', t => {
  const h = fixture(t), file = h.config({}), target = path.join(h.root, 'target'); fs.mkdirSync(target);
  fs.linkSync(file, path.join(target, 'copy.toml'));
  assert.throws(() => h.ids(), /Linked.*source/); fs.unlinkSync(path.join(target, 'copy.toml'));
  const alias = path.join(h.root, 'alias'); fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  h.config({ sqlite_home: path.join(alias, 'missing') });
  assert.throws(() => h.ids(), /Linked.*source/);
  assert.throws(() => h.ids([path.join(alias, 'missing-home')]), /Linked.*source/);
});

test('rereading a shared config cannot replace earlier change-detection evidence', t => {
  const h = fixture(t), other = path.join(h.root, 'other'); fs.mkdirSync(other);
  const file = h.config({}, path.join(h.root, 'project/config.toml')), original = fs.readdirSync;
  let changed = false;
  t.mock.method(fs, 'readdirSync', (dir, ...args) => {
    const result = original(dir, ...args);
    if (dir === other && !changed) { changed = true; h.config({ sqlite_home: path.join(h.root, 'new-state') }, file); }
    return result;
  });
  assert.throws(() => h.ids([{ home: h.home, configFiles: [file] }, { home: other, configFiles: [file] }]), /sources changed/);
  assert.equal(changed, true);
});

test('application inventory includes configured redirects and explicitly declared extra layers', t => {
  const h = fixture(t), dataDir = path.join(h.root, 'app'), home = path.join(dataDir, 'codex/subscription'),
    redirected = path.join(h.root, 'redirected'), extra = path.join(h.root, 'extra');
  const expected = [redirected, extra].map(dir => {
    const id = randomUUID(); h.database(dir).prepare('INSERT INTO threads(id) VALUES(?)').run(id); return id;
  });
  h.config({ sqlite_home: redirected }, path.join(home, 'config.toml'));
  const rows = readCodexApplicationHistories({ dataDir, externalHomes: [{ home, sqliteHomes: [extra] }] });
  assert.deepEqual(rows.map(row => row.nativeId).sort(), expected.sort());
});
