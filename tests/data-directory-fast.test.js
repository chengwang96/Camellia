'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { removeTree } = require('./test-fs.cjs');
const { requestDirectoryMigration, completeDirectoryMigration, recoverDirectoryMigration, configureDataDirectory,
  readDirectoryMigrationResult } = require('../src/main/data-directory');

const JOURNAL = '.camellia-directory-migration-transaction.json';
const REQUEST = '.camellia-directory-migration.json';
function fixture(context) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-rename-test-'));
  const dataDir = path.join(appData, 'dsh-desktop'), destination = path.join(appData, 'camellia');
  const write = (relative, content) => {
    const file = path.join(dataDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  context.after(() => {
    assert.equal(path.dirname(path.resolve(appData)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(appData).startsWith('camellia-rename-test-'));
    removeTree(appData);
  });
  return { appData, dataDir, destination, write };
}
function seed(box) {
  const original = JSON.stringify({ path: path.join(box.dataDir, 'attachments/keep.bin'), sibling: box.dataDir + '-external', text: '中文🙂' });
  box.write('metadata.json', original);
  box.write('history/second.jsonl', original + '\n');
  box.write('attachments/keep.bin', Buffer.alloc(4096, 0x73));
  requestDirectoryMigration(box);
  return original;
}
function clean(box) {
  assert.equal(fs.existsSync(path.join(box.appData, REQUEST)), false);
  assert.equal(fs.existsSync(path.join(box.appData, JOURNAL)), false);
  assert.equal(fs.readdirSync(box.appData).some(name => name.startsWith('.camellia-migration-work-')), false);
}
function crashAt(box, crash) {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'data-directory-crash-fixture.cjs'), box.appData, crash], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 23, child.stdout + child.stderr);
  return JSON.parse(fs.readFileSync(path.join(box.appData, JOURNAL), 'utf8'));
}

test('rename preserves opaque files, inode identity, hard links and unchanged metadata without copying or opening them', context => {
  const box = fixture(context);
  seed(box);
  const opaque = box.write('runtimes/node_modules/opaque.bin', Buffer.alloc(2 * 1024 * 1024, 0x91));
  const unchanged = box.write('plugins/unchanged.json', '{"cache":"retain byte for byte"}');
  box.write('plugins/non-utf8.json', Buffer.from([0xff, 0xfe, 0x31]));
  fs.linkSync(opaque, path.join(path.dirname(opaque), 'alias.bin'));
  const before = fs.statSync(opaque, { bigint: true }), rootBefore = fs.statSync(box.dataDir, { bigint: true });
  const open = fs.openSync, copy = fs.copyFileSync;
  let copies = 0;
  fs.openSync = (file, ...args) => {
    assert.ok(!['opaque.bin', 'alias.bin'].includes(path.basename(String(file))), 'Opaque content must not be read');
    return open(file, ...args);
  };
  fs.copyFileSync = (from, ...args) => {
    assert.notEqual(from, unchanged, 'Unchanged JSON must not be copied');
    copies++;
    return copy(from, ...args);
  };
  let result;
  try { result = completeDirectoryMigration(box); }
  finally { fs.openSync = open; fs.copyFileSync = copy; }
  assert.equal(result.migrated, true, JSON.stringify(result));
  assert.equal(result.method, 'rename');
  assert.equal(copies, 2, 'Only the two changed text files were copied');
  assert.equal(fs.statSync(box.destination, { bigint: true }).ino, rootBefore.ino);
  const moved = path.join(box.destination, 'runtimes/node_modules/opaque.bin');
  assert.equal(fs.statSync(moved, { bigint: true }).ino, before.ino);
  assert.equal(fs.statSync(path.join(path.dirname(moved), 'alias.bin'), { bigint: true }).ino, before.ino);
  assert.deepEqual(fs.readFileSync(path.join(box.destination, 'plugins/non-utf8.json')), Buffer.from([0xff, 0xfe, 0x31]));
  const metadata = JSON.parse(fs.readFileSync(path.join(box.destination, 'metadata.json'), 'utf8'));
  assert.equal(metadata.path, path.join(box.destination, 'attachments/keep.bin'));
  assert.equal(metadata.sibling, box.dataDir + '-external');
  assert.equal(metadata.text, '中文🙂');
  assert.equal(fs.existsSync(box.dataDir), false);
  clean(box);
});

test('rename preserves broken external junctions and retargets internal links even under node_modules', context => {
  const box = fixture(context);
  seed(box);
  fs.mkdirSync(path.join(box.dataDir, 'packages/node_modules'), { recursive: true });
  const internal = path.join(box.dataDir, 'packages/node_modules/internal');
  fs.symlinkSync(path.join(box.dataDir, 'attachments'), internal, process.platform === 'win32' ? 'junction' : 'dir');
  const external = path.join(box.dataDir, 'packages/node_modules/missing');
  fs.symlinkSync(path.join(box.appData, 'missing-runtime'), external, process.platform === 'win32' ? 'junction' : 'dir');
  const oldId = fs.lstatSync(external, { bigint: true }).ino;
  const symlink = fs.symlinkSync;
  fs.symlinkSync = (target, ...args) => {
    assert.notEqual(target, path.join(box.appData, 'missing-runtime'), 'External junctions should not be recreated');
    return symlink(target, ...args);
  };
  let result;
  try { result = completeDirectoryMigration(box); } finally { fs.symlinkSync = symlink; }
  assert.equal(result.migrated, true, JSON.stringify(result));
  assert.equal(path.resolve(fs.readlinkSync(path.join(box.destination, 'packages/node_modules/internal'))), path.join(box.destination, 'attachments'));
  assert.equal(fs.lstatSync(path.join(box.destination, 'packages/node_modules/missing'), { bigint: true }).ino, oldId);
  clean(box);
});

test('rename rewrites verified SQLite data while retaining BigInts, blobs and external paths', context => {
  const box = fixture(context);
  seed(box);
  const file = box.write('codex/state.sqlite', '');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE history (id INTEGER, location TEXT, external TEXT, bytes BLOB)');
  database.prepare('INSERT INTO history VALUES (?, ?, ?, ?)').run(9007199254740993n, path.join(box.dataDir, 'attachments/keep.bin'), box.dataDir + '-outside', Buffer.from([0, 255]));
  database.close();
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true, JSON.stringify(result));
  const saved = new DatabaseSync(path.join(box.destination, 'codex/state.sqlite'), { readOnly: true });
  try {
    const statement = saved.prepare('SELECT * FROM history'); statement.setReadBigInts(true);
    const row = statement.get();
    assert.equal(row.id, 9007199254740993n);
    assert.equal(row.location, path.join(box.destination, 'attachments/keep.bin'));
    assert.equal(row.external, box.dataDir + '-outside');
    assert.deepEqual(Buffer.from(row.bytes), Buffer.from([0, 255]));
  } finally { saved.close(); }
  clean(box);
});

test('text preflight respects chunk boundaries, root suffixes and multibyte content', context => {
  const box = fixture(context);
  seed(box);
  const root = box.dataDir.replace(/\\/g, '/'), target = box.destination.replace(/\\/g, '/');
  const padding = 'x'.repeat(256 * 1024 - root.length);
  const unchanged = padding + root + '-outside\n中文🙂';
  box.write('suffix.jsonl', unchanged);
  box.write('boundary.jsonl', padding + root + '/history\n' + root + '\n中文🙂');
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(box.destination, 'suffix.jsonl'), 'utf8'), unchanged);
  assert.equal(fs.readFileSync(path.join(box.destination, 'boundary.jsonl'), 'utf8'), padding + target + '/history\n' + target + '\n中文🙂');
  clean(box);
});

for (const stage of ['inventory', 'prepare', 'verify-prepared']) {
  test('canceling during ' + stage + ' leaves the source unchanged', context => {
    const box = fixture(context), original = seed(box);
    const result = completeDirectoryMigration({ ...box, onProgress: state => { if (state.stage === stage) throw new Error('User canceled'); } });
    assert.equal(result.migrated, false);
    assert.equal(result.error, 'User canceled');
    assert.equal(fs.readFileSync(path.join(box.dataDir, 'metadata.json'), 'utf8'), original);
    assert.equal(fs.existsSync(box.destination), false);
    clean(box);
  });
}

test('prepared-file corruption is detected before moving the source directory', context => {
  const box = fixture(context), original = seed(box);
  let corrupt = false;
  const result = completeDirectoryMigration({ ...box, onProgress: state => {
    if (state.stage === 'verify-prepared' && !corrupt) {
      corrupt = true;
      const work = fs.readdirSync(box.appData).find(name => name.startsWith('.camellia-migration-work-'));
      const file = path.join(box.appData, work, 'updated', '0');
      const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
    }
  } });
  assert.equal(result.migrated, false);
  assert.match(result.error, /verification/);
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'metadata.json'), 'utf8'), original);
  assert.equal(fs.existsSync(box.destination), false);
  clean(box);
});

test('verification or activation failure after the rename restores the original metadata and directory', context => {
  for (const failure of ['verification', 'activation']) {
    const box = fixture(context), original = seed(box), calls = [];
    let injected = false;
    const result = completeDirectoryMigration({ ...box,
      suspend: () => calls.push('suspend'), resume: () => calls.push('resume'),
      activate: () => { calls.push('activate'); if (failure === 'activation') throw new Error('Lock acquisition failed'); },
      onProgress: state => {
        if (failure === 'verification' && state.stage === 'verify-updates' && !injected) {
          injected = true;
          fs.writeFileSync(path.join(box.destination, 'metadata.json'), 'corrupt');
        }
      } });
    assert.equal(result.migrated, false, JSON.stringify(result));
    assert.equal(result.recoveryRequired, undefined, JSON.stringify(result));
    assert.equal(calls.at(-1), 'resume');
    assert.equal(fs.readFileSync(path.join(box.dataDir, 'metadata.json'), 'utf8'), original);
    assert.equal(fs.existsSync(box.destination), false);
    clean(box);
  }
});

test('cross-device rename failure resumes the original lock and uses the verified copy fallback', context => {
  const box = fixture(context); seed(box);
  const rename = fs.renameSync, calls = [];
  fs.renameSync = (from, to) => {
    if (from === box.dataDir && to === box.destination) { const error = new Error('Injected cross-device rename'); error.code = 'EXDEV'; throw error; }
    return rename(from, to);
  };
  let result;
  try { result = completeDirectoryMigration({ ...box, suspend: () => calls.push('suspend'), resume: () => calls.push('resume'), activate: () => calls.push('activate') }); }
  finally { fs.renameSync = rename; }
  assert.equal(result.migrated, true, JSON.stringify(result));
  assert.equal(result.method, 'copy');
  assert.match(result.fallbackReason, /EXDEV/);
  assert.deepEqual(calls, ['suspend', 'suspend', 'resume', 'activate']);
  assert.equal(fs.existsSync(box.dataDir), false);
  clean(box);
});

test('a concurrently occupied destination is never overwritten', context => {
  const box = fixture(context), original = seed(box);
  const result = completeDirectoryMigration({ ...box, onProgress: state => {
    if (state.stage === 'verify-prepared' && !fs.existsSync(box.destination)) {
      fs.mkdirSync(box.destination);
      fs.writeFileSync(path.join(box.destination, 'independent.txt'), 'keep');
    }
  } });
  assert.equal(result.migrated, false);
  assert.equal(fs.readFileSync(path.join(box.destination, 'independent.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'metadata.json'), 'utf8'), original);
  clean(box);
});

for (const crash of ['prepare', 'root', 'swap', 'moved', 'activation', 'committed']) {
  test('startup recovers an abrupt process exit during ' + crash, context => {
    const box = fixture(context), original = seed(box);
    const journal = crashAt(box, crash);
    assert.equal(journal.status, crash === 'prepare' ? 'preparing' : crash === 'committed' ? 'committed' : 'moving');
    const paths = { appData: box.appData, userData: path.join(box.appData, 'camellia-desktop'), sessionData: path.join(box.appData, 'camellia-desktop') };
    configureDataDirectory({ getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; }, getName: () => 'camellia-desktop' });
    const committed = crash === 'committed';
    assert.equal(paths.userData, committed ? box.destination : box.dataDir);
    const recovered = fs.readFileSync(path.join(paths.userData, 'metadata.json'), 'utf8');
    const expected = JSON.parse(original);
    if (committed) expected.path = path.join(box.destination, 'attachments/keep.bin');
    assert.equal(recovered, JSON.stringify(expected));
    assert.equal(fs.existsSync(committed ? box.dataDir : box.destination), false);
    const result = readDirectoryMigrationResult(box.appData);
    assert.equal(result.recovered, true);
    assert.equal(result.migrated, committed);
    clean(box);
  });
}

test('a live migration owner blocks a second startup before it creates a profile', context => {
  const box = fixture(context); seed(box);
  const journal = crashAt(box, 'root'), deadPid = journal.ownerPid;
  journal.ownerPid = process.pid;
  fs.writeFileSync(path.join(box.appData, JOURNAL), JSON.stringify(journal));
  const paths = { appData: box.appData, userData: path.join(box.appData, 'camellia-desktop'), sessionData: path.join(box.appData, 'camellia-desktop') };
  assert.throws(() => configureDataDirectory({ getPath: key => paths[key], getName: () => 'camellia-desktop', setPath: () => assert.fail('No profile should be configured') }), { code: 'CAMELLIA_MIGRATION_BUSY' });
  assert.equal(fs.existsSync(box.dataDir), false);
  journal.ownerPid = deadPid;
  fs.writeFileSync(path.join(box.appData, JOURNAL), JSON.stringify(journal));
  recoverDirectoryMigration(box.appData);
  clean(box);
});

test('recovery refuses an unsafe journal path and retains all backups', context => {
  const box = fixture(context); seed(box);
  const journal = crashAt(box, 'moved'), original = JSON.stringify(journal);
  journal.operations[0].backup = path.join('original', '..', '..', 'dsh-desktop');
  fs.writeFileSync(path.join(box.appData, JOURNAL), JSON.stringify(journal));
  assert.throws(() => recoverDirectoryMigration(box.appData), /Unsafe|Invalid/);
  assert.equal(fs.existsSync(journal.work), true);
  assert.equal(fs.existsSync(box.destination), true);
  fs.writeFileSync(path.join(box.appData, JOURNAL), original);
  recoverDirectoryMigration(box.appData);
  clean(box);
});

test('rollback after a crash restores SQLite WAL sidecars and original internal junctions byte for byte', context => {
  for (const crash of ['moved', 'activation']) {
    const box = fixture(context), original = seed(box);
    const external = path.join(box.appData, 'snapshot.sqlite');
    const database = new DatabaseSync(external);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads (path TEXT, response TEXT)');
    database.prepare('INSERT INTO threads VALUES (?, ?)').run(path.join(box.dataDir, 'attachments/keep.bin'), 'keep WAL-only row');
    fs.mkdirSync(path.join(box.dataDir, 'codex'));
    const before = new Map();
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const bytes = fs.readFileSync(external + suffix);
        const relative = 'codex/state.sqlite' + suffix;
        box.write(relative, bytes); before.set(relative, bytes);
      }
    } finally { database.close(); }
    fs.mkdirSync(path.join(box.dataDir, 'packages/node_modules'), { recursive: true });
    const link = path.join(box.dataDir, 'packages/node_modules/internal');
    fs.symlinkSync(path.join(box.dataDir, 'attachments'), link, process.platform === 'win32' ? 'junction' : 'dir');
    const linkBefore = fs.lstatSync(link, { bigint: true }).ino;
    crashAt(box, crash);
    recoverDirectoryMigration(box.appData);
    for (const [relative, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(box.dataDir, relative)), bytes, relative);
    assert.equal(fs.lstatSync(link, { bigint: true }).ino, linkBefore);
    assert.equal(path.resolve(fs.readlinkSync(link)), path.join(box.dataDir, 'attachments'));
    assert.equal(fs.readFileSync(path.join(box.dataDir, 'metadata.json'), 'utf8'), original);
    const saved = new DatabaseSync(path.join(box.dataDir, 'codex/state.sqlite'));
    try { assert.equal(saved.prepare('SELECT response FROM threads').get().response, 'keep WAL-only row'); }
    finally { saved.close(); }
    clean(box);
  }
});

test('a database trigger cannot silently alter non-path data during preparation', context => {
  const box = fixture(context); seed(box);
  const file = box.write('codex/state.sqlite', '');
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE history (path TEXT, response TEXT); CREATE TRIGGER mutate AFTER UPDATE ON history BEGIN UPDATE history SET response='lost'; END;");
  database.prepare('INSERT INTO history VALUES (?, ?)').run(path.join(box.dataDir, 'attachments/keep.bin'), 'retain response');
  database.close();
  const before = fs.readFileSync(file);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.match(result.error, /database could not be verified/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(box.destination), false);
  clean(box);
});

test('failed recovery retains the journal and can resume after the filesystem obstruction clears', context => {
  const box = fixture(context), original = seed(box);
  crashAt(box, 'activation');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (from === box.destination && to === box.dataDir) { const error = new Error('Injected temporary sharing violation'); error.code = 'EPERM'; throw error; }
    return rename(from, to);
  };
  try { assert.throws(() => recoverDirectoryMigration(box.appData), /sharing violation/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(path.join(box.appData, JOURNAL)), true);
  assert.equal(fs.readFileSync(path.join(box.destination, 'metadata.json'), 'utf8'), original);
  recoverDirectoryMigration(box.appData);
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'metadata.json'), 'utf8'), original);
  clean(box);
});

test('an explicit custom profile does not recover or modify the managed application profile', context => {
  const box = fixture(context); seed(box);
  crashAt(box, 'activation');
  const custom = path.join(box.appData, 'custom-profile');
  const paths = { appData: box.appData, userData: custom, sessionData: custom };
  assert.equal(configureDataDirectory({ getPath: key => paths[key], getName: () => 'camellia-desktop', setPath: () => assert.fail('Custom profile changed') }), false);
  assert.equal(fs.existsSync(box.dataDir), false);
  assert.equal(fs.existsSync(path.join(box.appData, JOURNAL)), true);
  recoverDirectoryMigration(box.appData);
  clean(box);
});
