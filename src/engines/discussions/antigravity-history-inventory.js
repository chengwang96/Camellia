'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SDK_ID = /^[0-9a-f]{32}$/;
const CLI_ID = new RegExp('^agy-' + UUID.source.slice(1));
const validConversationId = (connection, id) => typeof id === 'string' && (connection === 'api' ? SDK_ID : UUID).test(id);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const unchanged = (a, b) => !a && !b || Boolean(a && b) && a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// Raw, explicitly scoped storage topology, not an admission decision. A bridge
// ID is NOT the native conversation ID: CLI aliases can share one database;
// SDK forks copy a database into another save_dir and retain its native ID.
// Callers must preserve BOTH storageDir and conversationId, resolve aliases,
// and establish complete external/runtime/activity coverage before admission.
class AntigravityHistoryScan {
  constructor({ maxEntries = 100000, maxBytes = 128 * 1024 * 1024, maxMetadataBytes = 1024 * 1024 } = {}) {
    if ([maxEntries, maxBytes, maxMetadataBytes].some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid Antigravity inventory limits');
    Object.assign(this, { maxEntries, maxBytes, maxMetadataBytes });
    this.entriesRead = 0; this.bytesRead = 0; this.checked = new Map();
    this.bridges = new Map(); this.histories = new Map(); this.nativeDirs = new Set(); this.cliDirs = new Set();
    this.verifiedDatabases = new Set();
    this.ancestors = new Map(); this.homes = new Map();
  }
  count(amount = 1) {
    this.entriesRead += amount;
    if (this.entriesRead > this.maxEntries) throw new Error('Antigravity inventory exceeds its entry limit');
  }
  stat(file) {
    let info;
    try { info = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink() || info?.isFile() && info.nlink !== 1n) throw new Error('Linked Antigravity ownership source');
    return info || null;
  }
  remember(file) {
    const info = this.stat(file);
    if (this.checked.has(file) && !unchanged(this.checked.get(file), info)) throw new Error('Antigravity source changed during inventory');
    this.checked.set(file, info); return info;
  }
  directory(dir) {
    const info = this.remember(dir);
    if (info && !info.isDirectory()) throw new Error('Invalid Antigravity ownership directory');
    return info;
  }
  root(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Explicit Antigravity storage paths are required');
    const dir = path.resolve(value);
    // Checking each ancestor also catches a missing leaf behind a junction.
    for (let current = dir; ; current = path.dirname(current)) {
      const info = this.stat(current);
      if (info && !info.isDirectory()) throw new Error('Invalid Antigravity storage path');
      if (!this.ancestors.has(current)) this.ancestors.set(current, info);
      if (current === path.dirname(current)) break;
    }
    this.directory(dir);
    if (fs.existsSync(dir) && key(fs.realpathSync(dir)) !== key(dir)) throw new Error('Linked Antigravity storage path');
    return dir;
  }
  entries(dir) {
    if (!this.directory(dir)) return [];
    const names = fs.readdirSync(dir); this.count(names.length); return names;
  }
  full(file, maximum = this.maxBytes) {
    const before = this.remember(file);
    if (!before) return null;
    if (!before.isFile() || before.size > BigInt(Math.min(maximum, this.maxBytes - this.bytesRead))) throw new Error('Antigravity inventory exceeds its byte limit or has an invalid file');
    const size = Number(before.size); this.bytesRead += size;
    const fd = fs.openSync(file, 'r');
    try {
      if (!unchanged(before, fs.fstatSync(fd, { bigint: true }))) throw new Error('Antigravity source changed before reading');
      const bytes = Buffer.alloc(size + 1); let total = 0;
      while (total < bytes.length) {
        const count = fs.readSync(fd, bytes, total, bytes.length - total, total);
        if (!count) break;
        total += count;
      }
      if (total !== size || !unchanged(before, fs.fstatSync(fd, { bigint: true }))) throw new Error('Antigravity source changed while reading');
      return bytes.subarray(0, total);
    } finally { fs.closeSync(fd); }
  }
  json(file) {
    const bytes = this.full(file, this.maxMetadataBytes);
    if (bytes === null) return null;
    try { const value = JSON.parse(bytes.toString('utf8')); if (object(value)) return value; }
    catch { /* Never echo stored content in parser errors. */ }
    throw new Error('Invalid Antigravity bridge metadata');
  }
  database(file, table, query) {
    const files = ['', '-wal'].map(suffix => ({ suffix, bytes: this.full(file + suffix) }));
    const shm = this.remember(file + '-shm');
    if (shm && !shm.isFile()) throw new Error('Invalid Antigravity shared memory');
    if (this.remember(file + '-journal')) throw new Error('Unverified Antigravity rollback journal');
    if (!files[0].bytes) {
      if (shm || files.some(row => row.bytes)) throw new Error('Incomplete Antigravity database');
      return [];
    }
    this.verify();
    const scratch = fs.realpathSync(os.tmpdir()), temp = fs.mkdtempSync(path.join(scratch, 'discussion-antigravity-index-'));
    if (path.dirname(temp) !== scratch) throw new Error('Invalid Antigravity scratch directory');
    try {
      for (const row of files) if (row.bytes) fs.writeFileSync(path.join(temp, 'state.sqlite' + row.suffix), row.bytes, { flag: 'wx' });
      // Live Windows SHM contains byte locks. Rebuild it beside the copy; no SQL
      // or database handle is ever opened on the original files.
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(temp, 'state.sqlite'), { readOnly: true });
      try {
        db.exec('PRAGMA trusted_schema=OFF');
        const schema = db.prepare('SELECT type, sql FROM sqlite_schema WHERE name=?').get(table);
        if (schema?.type !== 'table' || /^CREATE\s+VIRTUAL\b/i.test(schema.sql || '')) throw new Error('Unverified Antigravity database table');
        if (Object.values(db.prepare('PRAGMA quick_check(1)').get() || {})[0] !== 'ok') throw new Error('Invalid Antigravity database');
        const rows = db.prepare(query + ' LIMIT ?').all(this.maxEntries - this.entriesRead + 1); this.count(rows.length);
        return rows;
      } finally { db.close(); }
    } catch (error) {
      if (/^(?:Antigravity|Invalid Antigravity|Unverified Antigravity) /.test(error.message)) throw error;
      throw new Error('Cannot verify Antigravity database');
    } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  history(connection, storageDir, conversationId) {
    if (!validConversationId(connection, conversationId)) throw new Error('Invalid Antigravity native conversation ID');
    const identity = JSON.stringify([connection, key(storageDir), conversationId]);
    if (!this.histories.has(identity)) { this.count(); this.histories.set(identity, { connection, storageDir, conversationId }); }
    return identity;
  }
  bridge(nativeId, connection, storageDir, conversationId, home) {
    const previous = this.bridges.get(nativeId);
    if (previous && previous.home !== key(home)) throw new Error('Antigravity bridge ID occurs in multiple homes');
    if (conversationId !== null) this.history(connection, storageDir, conversationId);
    this.bridges.set(nativeId, { home: key(home), value: { nativeId, connection, storageDir, conversationId } });
  }
  nativeDirectory(dir, connection) {
    const identity = JSON.stringify([connection, key(dir)]);
    if (this.nativeDirs.has(identity)) return;
    this.nativeDirs.add(identity);
    const ids = new Set();
    for (const name of this.entries(dir)) {
      const match = /^(.*?)\.db(?:-(?:wal|shm))?$/.exec(name);
      if (!match || !(connection === 'api' ? SDK_ID : UUID).test(match[1]) || !this.remember(path.join(dir, name))?.isFile()) throw new Error('Unrecognized Antigravity native storage entry');
      ids.add(match[1]);
    }
    for (const id of ids) {
      const rows = this.database(path.join(dir, id + '.db'), 'trajectory_meta', 'SELECT trajectory_id, cascade_id FROM trajectory_meta');
      // SDK files use the trajectory ID. CLI files use the cascade ID, and
      // multiple trajectories can belong to the same persisted conversation.
      if (!rows.length || (connection === 'api' ? rows.length !== 1 || rows[0].trajectory_id !== id
        || !validConversationId('api', rows[0].cascade_id) : rows.some(row => !validConversationId('subscription', row.trajectory_id) || row.cascade_id !== id))) {
        throw new Error('Antigravity database identity mismatch');
      }
      if (connection === 'api') this.history(connection, dir, rows[0].cascade_id);
      this.verifiedDatabases.add(this.history(connection, dir, id));
    }
  }
  cliDirectory(value) {
    const dir = this.root(value);
    if (this.cliDirs.has(key(dir))) return;
    this.cliDirs.add(key(dir));
    const nativeDir = path.join(dir, 'conversations');
    this.nativeDirectory(nativeDir, 'subscription');
    for (const row of this.database(path.join(dir, 'conversation_summaries.db'), 'conversation_summaries',
      'SELECT conversation_id, parent_conversation_id, winning_conversation_id, app_data_dir FROM conversation_summaries')) {
      // CLI 1.2.3 stores its product namespace, not an absolute filesystem path.
      const nativeNamespace = row.app_data_dir === 'antigravity-cli' && path.basename(dir) === 'antigravity-cli';
      if (typeof row.app_data_dir !== 'string' || row.app_data_dir && !nativeNamespace
        && (!path.isAbsolute(row.app_data_dir) || key(path.resolve(row.app_data_dir)) !== key(dir))) throw new Error('Unverified Antigravity indexed storage redirect');
      this.history('subscription', nativeDir, row.conversation_id);
      for (const id of [row.parent_conversation_id, row.winning_conversation_id]) {
        if (typeof id !== 'string') throw new Error('Invalid Antigravity indexed identity');
        if (id) this.history('subscription', nativeDir, id);
      }
    }
    // Orphan artifacts and presence files still reserve their conversation ID.
    // Neither their existence nor their absence says that a process is idle.
    for (const [folder, suffix, directory] of [['brain', '', true], ['annotations', '.pbtxt', false], ['presence', '.lock', false]]) {
      for (const name of this.entries(path.join(dir, folder))) {
        const id = suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : suffix ? '' : name;
        const info = this.remember(path.join(dir, folder, name));
        if (!UUID.test(id) || !(directory ? info?.isDirectory() : info?.isFile())) throw new Error('Unrecognized Antigravity native reference');
        this.history('subscription', nativeDir, id);
      }
    }
  }
  home({ home: source, cliDataDir }) {
    const home = this.root(source), cliDir = this.root(cliDataDir);
    if (this.homes.has(key(home)) && this.homes.get(key(home)) !== key(cliDir)) throw new Error('Ambiguous Antigravity bridge storage scope');
    this.homes.set(key(home), key(cliDir));
    this.cliDirectory(cliDir);
    for (const nativeId of this.entries(path.join(home, 'sessions'))) {
      if (!UUID.test(nativeId)) throw new Error('Invalid Antigravity SDK bridge ID');
      const dir = path.join(home, 'sessions', nativeId), storageDir = path.join(dir, 'native');
      if (this.entries(dir).some(name => !['session.json', 'native'].includes(name))) throw new Error('Unrecognized or incomplete Antigravity SDK bridge');
      const metadata = this.json(path.join(dir, 'session.json'));
      if (metadata && (Object.keys(metadata).some(name => name !== 'conversationId') || !validConversationId('api', metadata.conversationId))) throw new Error('Invalid Antigravity SDK bridge metadata');
      this.bridge(nativeId, 'api', storageDir, metadata?.conversationId ?? null, home);
      this.nativeDirectory(storageDir, 'api');
    }
    for (const name of this.entries(path.join(home, 'cli-sessions'))) {
      const nativeId = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!CLI_ID.test(nativeId)) throw new Error('Invalid Antigravity CLI bridge ID');
      const metadata = this.json(path.join(home, 'cli-sessions', name));
      if (!metadata || metadata.id !== nativeId || typeof metadata.cwd !== 'string' || !path.isAbsolute(metadata.cwd)
        || Object.keys(metadata).some(name => !['id', 'cwd', 'conversationId'].includes(name))
        || Object.hasOwn(metadata, 'conversationId') && !validConversationId('subscription', metadata.conversationId)) throw new Error('Invalid Antigravity CLI bridge metadata');
      this.bridge(nativeId, 'subscription', path.join(cliDir, 'conversations'), metadata.conversationId ?? null, home);
    }
  }
  verify() {
    for (const [dir, before] of this.ancestors) {
      const after = this.stat(dir);
      if (!before && !after) continue;
      if (!before || !after || before.dev !== after.dev || before.ino !== after.ino) throw new Error('Antigravity storage ancestor changed during inventory');
    }
    for (const [file, before] of this.checked) if (!unchanged(before, this.stat(file))) throw new Error('Antigravity sources changed during inventory');
  }
}

function readAntigravityNativeInventory({ homes, cliDataDirs, sdkSaveDirs } = {}, limits) {
  if (![homes, cliDataDirs, sdkSaveDirs].every(Array.isArray) || homes.some(home => !object(home))) throw new Error('Explicit Antigravity native sources are required');
  const scan = new AntigravityHistoryScan(limits);
  scan.count(homes.length + cliDataDirs.length + sdkSaveDirs.length);
  for (const home of homes) scan.home(home);
  for (const dir of cliDataDirs) scan.cliDirectory(dir);
  for (const dir of sdkSaveDirs) scan.nativeDirectory(scan.root(dir), 'api');
  scan.verify();
  return { bridges: [...scan.bridges.values()].map(({ value }) => ({ ...value,
    // A saved mapping reserves the identity even without a database. Only a
    // successfully read current native database can authorize preparation.
    databaseVerified: scan.verifiedDatabases.has(JSON.stringify([value.connection, key(value.storageDir), value.conversationId])),
  })), histories: [...scan.histories.values()] };
}

module.exports = { readAntigravityNativeInventory };
