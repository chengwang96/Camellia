'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const TOML = require('smol-toml');
const { validSessionId } = require('../claude-history');
const { DEFAULT_ACCOUNT_ID, MAX_ACCOUNTS, accountHome } = require('../subscription-accounts');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
const sameFile = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => !a && !b || sameFile(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0')
  && path.isAbsolute(value) && (process.platform !== 'win32' || path.parse(value).root !== path.sep);

// Read the known Codex state_5 / rollout layout without the import UI's title,
// archive, subagent, file-existence or pagination filters. Callers must resolve
// ALL applicable native homes and non-home config/SQLite overrides first.
// This reader does not discover accounts, inspect credentials, prove that an
// external process is idle, or assert complete external ownership coverage.
class CodexHistoryScan {
  constructor({ maxEntries = 100000, maxBytes = 128 * 1024 * 1024, maxHeaderBytes = 1024 * 1024, maxConfigBytes = 1024 * 1024, maxDepth = 8 } = {}) {
    if ([maxEntries, maxBytes, maxHeaderBytes, maxConfigBytes, maxDepth].some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid Codex inventory limits');
    Object.assign(this, { maxEntries, maxBytes, maxHeaderBytes, maxConfigBytes, maxDepth });
    this.entriesRead = 0; this.bytesRead = 0; this.checked = new Map(); this.headers = new Map(); this.owners = new Map();
    this.ancestors = new Map();
  }
  count(amount = 1) {
    this.entriesRead += amount;
    if (this.entriesRead > this.maxEntries) throw new Error('Codex native inventory exceeds its entry limit');
  }
  bytes(amount) {
    this.bytesRead += amount;
    if (this.bytesRead > this.maxBytes) throw new Error('Codex native inventory exceeds its byte limit');
  }
  stat(file) {
    let stat;
    try { stat = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink() || stat?.isFile() && stat.nlink !== 1n) throw new Error('Linked Codex ownership source');
    return stat || null;
  }
  remember(file) {
    const info = this.stat(file);
    if (this.checked.has(file) && !unchanged(this.checked.get(file), info)) throw new Error('Codex ownership sources changed during inventory');
    this.checked.set(file, info); return info;
  }
  root(dir) {
    // Also reject a missing leaf behind a linked ancestor. Ancestor identity,
    // rather than directory mtime, survives unrelated files in shared parents.
    for (let current = dir; ; current = path.dirname(current)) {
      const info = this.stat(current);
      if (info && !info.isDirectory()) throw new Error('Invalid Codex storage path');
      if (!this.ancestors.has(current)) this.ancestors.set(current, info);
      if (current === path.dirname(current)) break;
    }
    if (fs.existsSync(dir) && key(fs.realpathSync(dir)) !== key(dir)) throw new Error('Linked Codex storage path');
  }
  entries(dir) {
    const stat = this.remember(dir);
    if (!stat) return [];
    if (!stat.isDirectory()) throw new Error('Invalid Codex ownership directory');
    const names = fs.readdirSync(dir); this.count(names.length); return names;
  }
  full(file, maximum = this.maxBytes) {
    const before = this.remember(file);
    if (!before) return null;
    if (!before.isFile() || before.size > BigInt(Math.min(maximum, this.maxBytes - this.bytesRead))) throw new Error('Codex native inventory exceeds its byte limit or has an invalid file');
    const size = Number(before.size); this.bytes(size);
    const fd = fs.openSync(file, 'r');
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!unchanged(before, opened)) throw new Error('Codex ownership source changed before reading');
      // A bounded descriptor read cannot grow with a concurrently growing WAL.
      const buffer = Buffer.alloc(size + 1); let total = 0;
      while (total < buffer.length) {
        const count = fs.readSync(fd, buffer, total, buffer.length - total, total);
        if (!count) break;
        total += count;
      }
      if (total !== size || !unchanged(before, fs.fstatSync(fd, { bigint: true }))) throw new Error('Codex ownership source changed while reading');
      return buffer.subarray(0, total);
    } finally { fs.closeSync(fd); }
  }
  config(file, required, addRoot) {
    this.root(path.dirname(file));
    const bytes = this.full(file, this.maxConfigBytes);
    if (bytes === null) {
      if (required) throw new Error('Missing declared Codex config source');
      return;
    }
    let value;
    try { value = TOML.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Cannot verify Codex storage configuration'); }
    const tables = [value];
    if (value.profiles !== undefined) {
      if (!object(value.profiles)) throw new Error('Invalid Codex storage configuration');
      const profiles = Object.values(value.profiles); this.count(profiles.length);
      if (profiles.some(profile => !object(profile))) throw new Error('Invalid Codex storage configuration');
      tables.push(...profiles);
    }
    for (const table of tables) if (table.sqlite_home !== undefined) {
      // Do not guess config-layer cwd or expand a user's ~ with the app's home.
      // These forms need separately verified resolution before being supported.
      if (!absolute(table.sqlite_home)) throw new Error('Unresolved Codex SQLite directory in configuration');
      addRoot(table.sqlite_home);
    }
  }
  header(file) {
    const before = this.stat(file);
    if (!before?.isFile()) throw new Error('Invalid Codex rollout file');
    const fd = fs.openSync(file, 'r');
    try {
      if (!sameFile(before, fs.fstatSync(fd, { bigint: true }))) throw new Error('Codex rollout changed before reading');
      const chunks = []; let total = 0;
      while (total <= this.maxHeaderBytes) {
        const buffer = Buffer.alloc(Math.min(4096, this.maxHeaderBytes + 1 - total));
        const count = fs.readSync(fd, buffer, 0, buffer.length, total); this.bytes(count);
        if (!count) throw new Error('Incomplete Codex rollout metadata');
        const newline = buffer.subarray(0, count).indexOf(10);
        if (newline >= 0) {
          if (total + newline > this.maxHeaderBytes) break;
          chunks.push(buffer.subarray(0, newline));
          return { bytes: Buffer.concat(chunks), stat: before };
        }
        chunks.push(buffer.subarray(0, count)); total += count;
      }
      throw new Error('Codex rollout metadata exceeds its header limit');
    } finally { fs.closeSync(fd); }
  }
  add(nativeId, home) {
    if (!UUID.test(nativeId)) throw new Error('Invalid Codex native thread ID');
    const id = nativeId.toLowerCase(), previous = this.owners.get(id);
    if (previous && previous !== key(home)) throw new Error('Codex thread occurs in more than one native home');
    this.owners.set(id, key(home));
  }
  rollouts(dir, home, depth = 0) {
    if (depth > this.maxDepth) throw new Error('Codex rollout inventory exceeds its depth limit');
    for (const name of this.entries(dir)) {
      const file = path.join(dir, name), info = this.stat(file);
      if (info?.isDirectory()) { this.rollouts(file, home, depth + 1); continue; }
      const match = ROLLOUT.exec(name);
      if (!match || !info?.isFile()) throw new Error('Unrecognized Codex rollout entry');
      const header = this.header(file); let record;
      try { record = JSON.parse(header.bytes.toString('utf8').replace(/^\uFEFF/, '')); }
      catch { throw new Error('Invalid Codex rollout metadata'); }
      if (record?.type !== 'session_meta' || !UUID.test(record.payload?.id)
        || record.payload.id.toLowerCase() !== match[1].toLowerCase()) throw new Error('Codex rollout identity mismatch');
      this.headers.set(file, { stat: header.stat, hash: digest(header.bytes) });
      this.add(record.payload.id, home);
    }
  }
  database(dir, names, home) {
    if (names.some(name => /^state_.*\.sqlite(?:-(?:wal|shm|journal))?$/i.test(name)
      && !/^state_5\.sqlite(?:-(?:wal|shm))?$/.test(name))) throw new Error('Unverified Codex native database layout');
    const file = path.join(dir, 'state_5.sqlite');
    const files = ['', '-wal'].map(suffix => ({ suffix, bytes: this.full(file + suffix) }));
    const shm = this.remember(file + '-shm');
    if (shm && !shm.isFile()) throw new Error('Invalid Codex shared-memory file');
    if (!files[0].bytes) {
      if (shm || files.some(row => row.bytes)) throw new Error('Incomplete Codex native database');
      return;
    }
    // SQLite only opens an isolated copy with its WAL. It rebuilds the transient
    // SHM there: the live SHM contains Windows byte locks and must not be read or
    // copied as database content. Source changes still invalidate the snapshot.
    this.verify();
    const scratchRoot = fs.realpathSync(os.tmpdir());
    const temp = fs.mkdtempSync(path.join(scratchRoot, 'discussion-codex-index-'));
    if (path.dirname(temp) !== scratchRoot) throw new Error('Invalid Codex inventory scratch directory');
    try {
      for (const row of files) if (row.bytes) fs.writeFileSync(path.join(temp, 'state.sqlite' + row.suffix), row.bytes, { flag: 'wx' });
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(temp, 'state.sqlite'), { readOnly: true });
      try {
        db.exec('PRAGMA trusted_schema=OFF');
        const table = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name='threads'").get();
        if (table?.type !== 'table' || /^CREATE\s+VIRTUAL\b/i.test(table.sql || '')) throw new Error('Unverified Codex thread table');
        if (Object.values(db.prepare('PRAGMA quick_check(1)').get() || {})[0] !== 'ok') throw new Error('Invalid Codex native database');
        const rows = db.prepare('SELECT id FROM threads LIMIT ?').all(this.maxEntries - this.entriesRead + 1);
        this.count(rows.length);
        for (const row of rows) this.add(row.id, home);
      } finally { db.close(); }
    } catch (error) {
      // Database/parser errors must not echo stored conversation content.
      if (error.message.startsWith('Codex ') || error.message.startsWith('Invalid Codex ') || error.message.startsWith('Unverified Codex ')) throw error;
      throw new Error('Cannot verify Codex native database');
    } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  verify() {
    for (const [dir, before] of this.ancestors) {
      const after = this.stat(dir);
      if (!before && !after) continue;
      if (!sameFile(before, after)) throw new Error('Codex storage ancestor changed during inventory');
    }
    for (const [file, before] of this.checked) {
      if (!unchanged(before, this.stat(file))) throw new Error('Codex ownership sources changed during inventory');
    }
    for (const [file, before] of this.headers) {
      const after = this.stat(file);
      if (!sameFile(before.stat, after)) throw new Error('Codex rollout was replaced during inventory');
      // Streaming appends do not change ownership. If the file changed, verify
      // only its bounded metadata prefix, never read the transcript body.
      if (!unchanged(before.stat, after) && digest(this.header(file).bytes) !== before.hash) throw new Error('Codex rollout identity changed during inventory');
    }
  }
  homes(homes) {
    if (!Array.isArray(homes) || !homes.length) throw new Error('Explicit Codex native homes are required');
    this.count(homes.length);
    const sources = new Map();
    for (const value of homes) {
      const source = typeof value === 'string' ? { home: value } : value;
      if (!object(source) || Object.keys(source).some(name => !['home', 'sqliteHomes', 'configFiles'].includes(name))
        || !absolute(source.home) || [source.sqliteHomes, source.configFiles].some(paths => paths !== undefined
          && (!Array.isArray(paths) || paths.some(file => !absolute(file))))) throw new Error('Explicit Codex native homes and resolved storage sources are required');
      const home = path.resolve(source.home);
      let row = sources.get(key(home));
      if (!row) {
        row = { home, roots: new Map([[key(home), home]]), configs: new Map() };
        sources.set(key(home), row);
      }
      this.count((source.sqliteHomes?.length || 0) + (source.configFiles?.length || 0));
      for (const value of source.sqliteHomes || []) { const dir = path.resolve(value); row.roots.set(key(dir), dir); }
      for (const value of source.configFiles || []) { const file = path.resolve(value); row.configs.set(key(file), { file, required: true }); }
    }
    for (const { home, roots, configs } of sources.values()) {
      this.root(home);
      const names = this.entries(home);
      for (const name of ['config.toml', ...names.filter(name => name.toLowerCase().endsWith('.config.toml'))]) {
        const file = path.join(home, name);
        if (!configs.has(key(file))) configs.set(key(file), { file, required: name !== 'config.toml' });
      }
      for (const { file, required } of configs.values()) this.config(file, required, value => {
        const dir = path.resolve(value); roots.set(key(dir), dir);
      });
      for (const dir of roots.values()) {
        this.root(dir);
        this.database(dir, key(dir) === key(home) ? names : this.entries(dir), home);
      }
      this.rollouts(path.join(home, 'sessions'), home);
      this.rollouts(path.join(home, 'archived_sessions'), home);
    }
    this.verify();
    return [...this.owners.keys()].map(nativeId => ({ engine: 'codex', nativeId }));
  }
}

// Each home can instead be { home, sqliteHomes, configFiles }. The extra paths
// cover resolved environment/CLI overrides and project/managed config layers;
// the reader never reads ambient process.env or guesses a native process cwd.
// Home config, inline profiles and *.config.toml files retain every declared
// absolute SQLite root, including inactive roots and the default home. Missing
// explicit config files, relative redirects and unrecognized layouts fail closed.
// No source declares itself complete: remaining config layers, old redirects
// and external activity still need a reviewed provider before production use.
function readCodexNativeHistories(homes, limits) {
  return new CodexHistoryScan(limits).homes(homes);
}

// Covers the paths used by codex.js, plus explicit external/policy homes.
// Pass raw stored account entries, never normalizeAccounts()'s filtered list.
// Directory enumeration also retains orphan accounts and API conversation
// homes that no longer have an application index.
function readCodexApplicationHistories({ dataDir, accounts = [], externalHomes, discussionHomes = [] }, limits) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !Array.isArray(accounts)
    || accounts.length > MAX_ACCOUNTS || accounts.some(row => !row || typeof row.id !== 'string' || !ACCOUNT_ID.test(row.id))
    || new Set(accounts.map(row => row.id)).size !== accounts.length
    || !Array.isArray(externalHomes) || !Array.isArray(discussionHomes)) throw new Error('Explicit Codex application sources are required');
  const scan = new CodexHistoryScan(limits), home = path.join(dataDir, 'codex');
  const api = path.join(home, 'api'), subscription = path.join(home, 'subscription');
  const homes = [home, api, subscription, ...externalHomes, ...discussionHomes,
    ...accounts.map(row => accountHome({ userData: dataDir, engine: 'codex', id: row.id, root: subscription }))];
  for (const [dir, valid] of [[path.join(api, 'conversations'), validSessionId],
    [path.join(dataDir, 'subscription-accounts', 'codex'), id => ACCOUNT_ID.test(id) && id !== DEFAULT_ACCOUNT_ID]]) {
    for (const name of scan.entries(dir)) {
      const entry = path.join(dir, name);
      if (!valid(name) || !scan.stat(entry)?.isDirectory()) throw new Error('Invalid Codex native home entry');
      homes.push(entry);
    }
  }
  return scan.homes(homes);
}

module.exports = { readCodexNativeHistories, readCodexApplicationHistories };
