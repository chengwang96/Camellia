'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { removeTree } = require('./test-fs.cjs');
const { defaultDataDirectory, configureDataDirectory, migrationStatus, requestDirectoryMigration, completeDirectoryMigration,
  saveDirectoryMigrationResult, readDirectoryMigrationResult } = require('../src/main/data-directory');

function fixture(context) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-directory-test-'));
  context.after(() => {
    const resolved = path.resolve(appData);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('camellia-directory-test-'));
    removeTree(resolved);
  });
  const dataDir = path.join(appData, 'dsh-desktop'), destination = path.join(appData, 'camellia');
  const write = (relative, content) => {
    const file = path.join(dataDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { appData, dataDir, destination, write, strategy: 'copy' };
}

function mockApp(appData, overrides = {}) {
  const paths = { appData, userData: path.join(appData, 'camellia-desktop'), sessionData: path.join(appData, 'camellia-desktop'), ...overrides };
  return { paths, getName: () => 'camellia-desktop', getPath: name => paths[name], setPath: (name, value) => { paths[name] = value; } };
}

test('new installations use camellia for both application and browser data', context => {
  const box = fixture(context), app = mockApp(box.appData);
  assert.equal(configureDataDirectory(app), true);
  assert.equal(app.paths.userData, box.destination);
  assert.equal(app.paths.sessionData, box.destination);
  assert.equal(fs.existsSync(box.dataDir), false);
});

test('existing legacy data is used until explicitly migrated', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{"language":"en"}');
  fs.mkdirSync(box.destination);
  const app = mockApp(box.appData);
  configureDataDirectory(app);
  assert.equal(app.paths.userData, box.dataDir);
  assert.equal(app.paths.sessionData, box.dataDir);
  assert.equal(migrationStatus(box).canMigrate, true);
});

test('an existing camellia profile takes precedence over a remaining legacy directory', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{}');
  fs.mkdirSync(box.destination);
  fs.writeFileSync(path.join(box.destination, 'desktop-config.json'), '{"language":"zh-CN"}');
  assert.equal(defaultDataDirectory(box.appData), box.destination);
  assert.equal(migrationStatus(box).canMigrate, false);
  assert.throws(() => requestDirectoryMigration(box), /already contains files/);
});

test('explicit application or browser directories are never changed', context => {
  const box = fixture(context);
  const custom = path.join(box.appData, 'test-profile');
  const app = mockApp(box.appData, { userData: custom, sessionData: custom });
  assert.equal(configureDataDirectory(app), false);
  assert.equal(app.paths.userData, custom);
  const browser = mockApp(box.appData, { sessionData: custom });
  configureDataDirectory(browser);
  assert.equal(browser.paths.userData, box.destination);
  assert.equal(browser.paths.sessionData, custom);
  const switchApp = mockApp(box.appData);
  switchApp.commandLine = { hasSwitch: name => name === 'user-data-dir' };
  assert.equal(configureDataDirectory(switchApp), false);
});

test('offline migration preserves the full profile and rewrites metadata, native history and database paths', context => {
  const box = fixture(context);
  const attachment = path.join(box.dataDir, 'clipboard-attachments', 'image.png');
  const external = box.dataDir + '-external-workspace';
  const config = JSON.stringify({ attachment, external });
  box.write('desktop-config.json', config);
  box.write('conversations/session.jsonl', JSON.stringify({ attachment, text: 'existing response' }) + '\n');
  box.write('codex/api/config.toml', 'sqlite_home = ' + JSON.stringify(path.join(box.dataDir, 'codex/api')) + '\n');
  box.write('runtimes/codex/node_modules/runtime.js', 'retained runtime');
  box.write('Local Storage/leveldb/state', 'retained browser draft');
  box.write('Network/Cookies', 'retained cookies');
  box.write('clipboard-attachments/image.png', Buffer.from([1, 2, 3, 4]));
  box.write('SingletonLock', 'do not copy an active lock');
  const databaseFile = box.write('codex/api/state_5.sqlite', '');
  const database = new DatabaseSync(databaseFile);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)');
  database.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread-1', path.join(box.dataDir, 'codex/api/sessions/rollout.jsonl'), external);
  database.close();

  requestDirectoryMigration(box);
  assert.equal(fs.existsSync(box.destination), false);
  box.write('conversations/final.json', '{"savedDuringShutdown":true}');
  const preserved = new Map(['runtimes/codex/node_modules/runtime.js', 'Local Storage/leveldb/state', 'Network/Cookies', 'clipboard-attachments/image.png']
    .map(relative => [relative, fs.readFileSync(path.join(box.dataDir, relative))]));
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true, result.error);
  assert.equal(defaultDataDirectory(box.appData), box.destination);
  assert.equal(fs.existsSync(box.dataDir), false);
  const moved = JSON.parse(fs.readFileSync(path.join(box.destination, 'desktop-config.json'), 'utf8'));
  assert.equal(moved.attachment, path.join(box.destination, 'clipboard-attachments', 'image.png'));
  assert.equal(moved.external, external);
  const history = JSON.parse(fs.readFileSync(path.join(box.destination, 'conversations/session.jsonl'), 'utf8'));
  assert.equal(history.attachment, moved.attachment);
  assert.equal(history.text, 'existing response');
  assert.equal(fs.existsSync(path.join(box.destination, 'conversations/final.json')), true);
  for (const [relative, content] of preserved) {
    assert.deepEqual(fs.readFileSync(path.join(box.destination, relative)), content);
  }
  assert.equal(fs.existsSync(path.join(box.destination, 'SingletonLock')), false);
  const movedDatabase = new DatabaseSync(path.join(box.destination, 'codex/api/state_5.sqlite'), { readOnly: true });
  try {
    const thread = movedDatabase.prepare('SELECT * FROM threads').get();
    assert.equal(thread.rollout_path, path.join(box.destination, 'codex/api/sessions/rollout.jsonl'));
    assert.equal(thread.cwd, external);
  } finally { movedDatabase.close(); }
  assert.equal(completeDirectoryMigration(box), null);
});

test('directory migration retains external junctions and retargets internal ones without following them', context => {
  const box = fixture(context);
  box.write('codex/.tmp/cache', 'cache');
  fs.mkdirSync(path.join(box.dataDir, 'codex/api'), { recursive: true });
  const external = path.join(box.appData, 'external-runtime');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'runtime.js'), 'external');
  fs.symlinkSync(path.join(box.dataDir, 'codex/.tmp'), path.join(box.dataDir, 'codex/api/.tmp'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(external, path.join(box.dataDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true, result.error);
  assert.equal(fs.existsSync(box.dataDir), false);
  assert.equal(fs.realpathSync(path.join(box.destination, 'codex/api/.tmp')), fs.realpathSync(path.join(box.destination, 'codex/.tmp')));
  assert.equal(fs.realpathSync(path.join(box.destination, 'node_modules')), fs.realpathSync(external));
  assert.equal(fs.readFileSync(path.join(external, 'runtime.js'), 'utf8'), 'external');
});

test('path rewriting handles multibyte text and references spanning read boundaries', context => {
  const box = fixture(context);
  const text = '中文'.repeat(120000) + JSON.stringify(path.join(box.dataDir, 'conversations/session')) + 'tail';
  const unicode = '\u{1F600}'.repeat(150000);
  box.write('conversations/large.jsonl', text);
  box.write('conversations/unicode.jsonl', unicode);
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true, result.error);
  const expected = text.replace(JSON.stringify(box.dataDir).slice(1, -1), JSON.stringify(box.destination).slice(1, -1));
  assert.equal(fs.readFileSync(path.join(box.destination, 'conversations/large.jsonl'), 'utf8'), expected);
  assert.equal(fs.readFileSync(path.join(box.destination, 'conversations/unicode.jsonl'), 'utf8'), unicode);
});

test('path rewriting leaves external siblings with the same directory-name prefix alone', context => {
  const box = fixture(context);
  const external = box.dataDir + '-external/config.json';
  const config = JSON.stringify({ internal: box.dataDir, external, nested: path.join(box.dataDir, 'conversations') });
  box.write('desktop-config.json', config);
  box.write('engine/settings.yaml', 'root: ' + box.dataDir.replace(/\\/g, '/') + '\nother: ' + external.replace(/\\/g, '/') + '\n');
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true, result.error);
  const moved = JSON.parse(fs.readFileSync(path.join(box.destination, 'desktop-config.json'), 'utf8'));
  assert.equal(moved.internal, box.destination);
  assert.equal(moved.nested, path.join(box.destination, 'conversations'));
  assert.equal(moved.external, external);
  const yaml = fs.readFileSync(path.join(box.destination, 'engine/settings.yaml'), 'utf8');
  assert.ok(yaml.includes('root: ' + box.destination.replace(/\\/g, '/')));
  assert.ok(yaml.includes('other: ' + external.replace(/\\/g, '/')));
});

test('path references ending on a read boundary do not rewrite similar external directories', context => {
  const box = fixture(context);
  const escaped = JSON.stringify(box.dataDir).slice(1, -1);
  const overlap = Math.max(box.dataDir.length, escaped.length) + 1;
  const prefix = 'x'.repeat(256 * 1024 - overlap - escaped.length);
  const external = prefix + escaped + '-external';
  box.write('conversations/boundary.jsonl', external + '\n' + escaped + '/session');
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true, result.error);
  const moved = fs.readFileSync(path.join(box.destination, 'conversations/boundary.jsonl'), 'utf8');
  assert.equal(moved, external + '\n' + JSON.stringify(box.destination).slice(1, -1) + '/session');
});

test('a destination created after the request is never overwritten', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{}');
  requestDirectoryMigration(box);
  fs.mkdirSync(box.destination);
  fs.writeFileSync(path.join(box.destination, 'mine'), 'keep');
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.match(result.error, /already contains files/);
  assert.equal(fs.readFileSync(path.join(box.destination, 'mine'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(box.dataDir, 'desktop-config.json')), true);
});

test('migration failure rolls back to the legacy profile without a partial camellia directory', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{}');
  box.write('codex/api/state_5.sqlite', 'SQLite format 3\0corrupted database');
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.equal(defaultDataDirectory(box.appData), box.dataDir);
  assert.equal(fs.existsSync(box.destination), false);
  assert.equal(fs.readdirSync(box.appData).some(name => name.startsWith('camellia.migrating-')), false);
  assert.equal(fs.existsSync(path.join(box.dataDir, 'desktop-config.json')), true);
});

test('copy verification detects same-size corruption and leaves the entire old profile intact', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{"language":"en"}');
  const attachment = box.write('clipboard-attachments/keep.txt', 'original');
  const copy = fs.copyFileSync;
  context.mock.method(fs, 'copyFileSync', (source, destination, ...args) => {
    copy(source, destination, ...args);
    if (source === attachment) fs.writeFileSync(destination, 'modified');
  });
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.match(result.error, /verification failed/);
  assert.equal(fs.readFileSync(attachment, 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'desktop-config.json'), 'utf8'), '{"language":"en"}');
  assert.equal(fs.existsSync(box.destination), false);
  assert.equal(defaultDataDirectory(box.appData), box.dataDir);
});

test('rewritten text is verified before the old profile is deleted', context => {
  const box = fixture(context);
  const config = JSON.stringify({ root: box.dataDir });
  const source = box.write('desktop-config.json', config);
  const rename = fs.renameSync;
  context.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (path.basename(to) === 'desktop-config.json' && from.includes('.migrating-')) fs.writeFileSync(to, '{"corrupted":true}');
  });
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.match(result.error, /verification failed/);
  assert.equal(fs.readFileSync(source, 'utf8'), config);
  assert.equal(fs.existsSync(box.destination), false);
});

test('the final directory is verified again after publication and rolled back on corruption', context => {
  const box = fixture(context);
  const config = '{"language":"en"}';
  const source = box.write('desktop-config.json', config);
  const rename = fs.renameSync;
  context.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === box.destination) fs.writeFileSync(path.join(to, 'desktop-config.json'), '{"language":"xx"}');
  });
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.match(result.error, /verification failed/);
  assert.equal(fs.readFileSync(source, 'utf8'), config);
  assert.equal(fs.existsSync(box.destination), false);
  assert.equal(defaultDataDirectory(box.appData), box.dataDir);
});

test('source files added during migration prevent cleanup and keep the legacy profile active', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{}');
  const rename = fs.renameSync;
  context.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === box.destination) box.write('conversations/late.json', '{"keep":true}');
  });
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.match(result.error, /verification failed/);
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'conversations/late.json'), 'utf8'), '{"keep":true}');
  assert.equal(fs.existsSync(box.destination), false);
});

test('database verification detects unexpected changes from triggers without touching the old database', context => {
  const box = fixture(context);
  const file = box.write('codex/api/state_5.sqlite', '');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT)');
  database.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread', path.join(box.dataDir, 'rollout.jsonl'), 'keep');
  database.exec("CREATE TRIGGER corrupt_migration AFTER UPDATE ON threads BEGIN UPDATE threads SET title = 'lost' WHERE id = NEW.id; END");
  database.close();
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.match(result.error, /database could not be verified/);
  const original = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(original.prepare('SELECT title FROM threads').get().title, 'keep'); } finally { original.close(); }
  assert.equal(fs.existsSync(box.destination), false);
});

test('the database is reopened and verified after commit before the old data is deleted', context => {
  const box = fixture(context);
  const file = box.write('codex/api/state_5.sqlite', '');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT)');
  database.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread', path.join(box.dataDir, 'rollout.jsonl'), 'keep');
  database.close();
  const execute = DatabaseSync.prototype.exec;
  context.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    const result = execute.call(this, sql);
    if (sql === 'COMMIT; PRAGMA wal_checkpoint(TRUNCATE)') execute.call(this, "UPDATE threads SET title = 'lost'");
    return result;
  });
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.match(result.error, /database could not be verified/);
  const original = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(original.prepare('SELECT title FROM threads').get().title, 'keep'); } finally { original.close(); }
  assert.equal(fs.existsSync(box.destination), false);
});

test('cleanup failure uses the verified new directory and reports that the old folder remains', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{}');
  box.write('clipboard-attachments/keep.txt', 'keep');
  const remove = fs.rmSync;
  context.mock.method(fs, 'rmSync', (target, options) => {
    if (target === box.dataDir) {
      fs.unlinkSync(path.join(target, 'desktop-config.json'));
      throw new Error('EPERM: file is locked');
    }
    return remove(target, options);
  });
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true);
  assert.match(result.error, /could not be completely removed/);
  assert.match(result.cleanupError, /EPERM/);
  assert.equal(defaultDataDirectory(box.appData), box.destination);
  assert.equal(fs.readFileSync(path.join(box.destination, 'desktop-config.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(box.destination, 'clipboard-attachments/keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'clipboard-attachments/keep.txt'), 'utf8'), 'keep');
  assert.equal(completeDirectoryMigration(box), null);
});

test('the new profile is activated before cleanup, while the complete old profile still exists', context => {
  const box = fixture(context);
  const config = JSON.stringify({ attachment: path.join(box.dataDir, 'clipboard-attachments/keep.txt') });
  box.write('desktop-config.json', config);
  box.write('clipboard-attachments/keep.txt', 'keep');
  let activated = false;
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration({ ...box, activate: state => {
    assert.equal(state.destination, box.destination);
    assert.equal(fs.readFileSync(path.join(box.dataDir, 'desktop-config.json'), 'utf8'), config);
    assert.equal(JSON.parse(fs.readFileSync(path.join(box.destination, 'desktop-config.json'), 'utf8')).attachment,
      path.join(box.destination, 'clipboard-attachments/keep.txt'));
    activated = true;
  } });
  assert.equal(result.migrated, true, result.error);
  assert.equal(activated, true);
  assert.equal(fs.existsSync(box.dataDir), false);
});

test('activation failure keeps both verified data and the complete old profile instead of starting cleanup', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{}');
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration({ ...box, activate: () => { throw new Error('Could not lock the new data directory'); } });
  assert.equal(result.migrated, true);
  assert.match(result.cleanupError, /Could not lock/);
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'desktop-config.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(box.destination, 'desktop-config.json'), 'utf8'), '{}');
});

test('migration reports every phase and advances while hashing a large file', context => {
  const box = fixture(context);
  const size = 700 * 1024;
  box.write('clipboard-attachments/large.bin', Buffer.alloc(size, 7));
  box.write('desktop-config.json', JSON.stringify({ attachment: path.join(box.dataDir, 'clipboard-attachments/large.bin') }));
  requestDirectoryMigration(box);
  const events = [];
  const result = completeDirectoryMigration({ ...box, onProgress: state => events.push(state) });
  assert.equal(result.migrated, true, result.error);
  assert.deepEqual([...new Set(events.map(event => event.stage))],
    ['scan', 'copy', 'verify-copy', 'rewrite', 'verify-rewrite', 'verify-final', 'verify-source', 'cleanup']);
  const scanning = events.filter(event => event.stage === 'scan');
  assert.ok(scanning.some(event => event.processedBytes > 0 && event.processedBytes < size), 'Scanning reports progress inside a large file');
  for (const phase of ['copy', 'verify-copy', 'verify-rewrite', 'verify-final', 'verify-source']) {
    const complete = events.findLast(event => event.stage === phase);
    assert.equal(complete.phaseComplete, true);
    assert.equal(complete.processedEntries, complete.totalEntries, phase);
    assert.equal(complete.processedBytes, complete.totalBytes, phase);
  }
  assert.equal(events.findLast(event => event.stage === 'cleanup').cancellable, false);
});

for (const phase of ['scan', 'copy', 'verify-source']) {
  test('canceling during ' + phase + ' preserves the original profile and removes the migration request', context => {
    const box = fixture(context);
    const original = JSON.stringify({ attachment: path.join(box.dataDir, 'clipboard-attachments/keep.txt') });
    box.write('desktop-config.json', original);
    box.write('clipboard-attachments/keep.txt', 'keep');
    requestDirectoryMigration(box);
    let activated = false;
    const result = completeDirectoryMigration({ ...box, activate: () => { activated = true; }, onProgress: state => {
      if (state.stage === phase) throw new Error('Canceled by the user');
    } });
    assert.equal(result.migrated, false);
    assert.match(result.error, /Canceled by the user/);
    assert.equal(activated, false);
    assert.equal(fs.readFileSync(path.join(box.dataDir, 'desktop-config.json'), 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(box.dataDir, 'clipboard-attachments/keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(box.destination), false);
    assert.equal(completeDirectoryMigration(box), null);
    assert.equal(fs.readdirSync(box.appData).some(name => name.startsWith('camellia.migrating-')), false);
  });
}

test('a dangling Windows dependency junction stays a directory junction during migration', { skip: process.platform !== 'win32' }, context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{}');
  const target = path.join(box.appData, 'runtime-no-longer-installed', '@aws-crypto', 'sha256-browser');
  const relative = path.join('dsh-chat', 'profiles', 'node_modules', '@aws-crypto', 'sha256-browser');
  const original = path.join(box.dataDir, relative);
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.symlinkSync(target, original, 'junction');
  assert.equal(fs.existsSync(original), false, 'The target really is missing');
  assert.equal(fs.lstatSync(original).isSymbolicLink(), true);
  requestDirectoryMigration(box);
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, true, result.error);
  const copied = path.join(box.destination, relative);
  assert.equal(fs.lstatSync(copied).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(copied), target);
  assert.equal(fs.existsSync(copied), false, 'Missing dependencies are preserved rather than installed or followed');
});

test('failed rollback cleanup reports the retained temporary directory and preserves the original', context => {
  const box = fixture(context);
  box.write('desktop-config.json', '{"keep":"original"}');
  requestDirectoryMigration(box);
  context.mock.method(fs, 'copyFileSync', () => { throw new Error('copy failed'); });
  const remove = fs.rmSync;
  context.mock.method(fs, 'rmSync', (target, options) => {
    if (path.basename(target).startsWith('camellia.migrating-')) throw new Error('cleanup locked');
    return remove(target, options);
  });
  const result = completeDirectoryMigration(box);
  assert.equal(result.migrated, false);
  assert.equal(result.error, 'copy failed');
  assert.equal(result.rollbackError, 'cleanup locked');
  assert.equal(path.dirname(result.leftoverDirectory), box.appData);
  assert.equal(fs.existsSync(result.leftoverDirectory), true);
  assert.equal(fs.readFileSync(path.join(box.dataDir, 'desktop-config.json'), 'utf8'), '{"keep":"original"}');
});

test('migration failure remains available after restart and a successful retry replaces it', context => {
  const box = fixture(context);
  assert.equal(readDirectoryMigrationResult(box.appData), null);
  saveDirectoryMigrationResult(box.appData, { migrated: false, error: 'junction copy failed', source: box.dataDir, destination: box.destination });
  assert.equal(readDirectoryMigrationResult(box.appData).error, 'junction copy failed');
  assert.ok(readDirectoryMigrationResult(box.appData).finishedAt);
  saveDirectoryMigrationResult(box.appData, { migrated: true, source: box.dataDir, destination: box.destination });
  assert.equal(readDirectoryMigrationResult(box.appData).migrated, true);
  assert.equal(readDirectoryMigrationResult(box.appData).error, undefined);
});
