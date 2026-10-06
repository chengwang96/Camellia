'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { spawnSync } = require('node:child_process');

const LEGACY_NAME = 'dsh-desktop';
const DATA_NAME = 'camellia';
const REQUEST_NAME = '.camellia-directory-migration.json';
const RESULT_NAME = '.camellia-directory-migration-result.json';
const SKIP_REWRITE = new Set(['node_modules', 'logs', 'migration-backups', 'Cache', 'Code Cache', 'GPUCache', 'Local Storage', 'Session Storage', 'Network']);

function samePath(first, second) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(first) === normalize(second);
}

function hasData(directory) {
  try { return fs.readdirSync(directory).length > 0; } catch { return false; }
}

function defaultDataDirectory(appData) {
  appData ||= process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const current = path.join(appData, DATA_NAME), legacy = path.join(appData, LEGACY_NAME);
  if (hasData(current) || !fs.existsSync(legacy)) return current;
  return legacy;
}

function usesManagedDataDirectory(app) {
  const initial = app.getPath('userData');
  if (app.commandLine?.hasSwitch?.('user-data-dir') || path.basename(initial).toLowerCase() !== app.getName().toLowerCase()) return false;
  if (!samePath(initial, path.join(app.getPath('appData'), app.getName()))) return false;
  return true;
}

function configureDataDirectory(app) {
  if (!usesManagedDataDirectory(app)) return false;
  const initial = app.getPath('userData');
  recoverDirectoryMigration(app.getPath('appData'));
  const directory = defaultDataDirectory(app.getPath('appData'));
  fs.mkdirSync(directory, { recursive: true });
  if (samePath(app.getPath('sessionData'), initial)) app.setPath('sessionData', directory);
  app.setPath('userData', directory);
  return true;
}

function migrationStatus({ appData, dataDir }) {
  if (!appData) return { legacy: false, canMigrate: false, source: dataDir, destination: null, error: null };
  const source = path.join(appData, LEGACY_NAME), destination = path.join(appData, DATA_NAME);
  const legacy = samePath(dataDir, source);
  let error = null;
  if (legacy) {
    try {
      if (fs.lstatSync(source).isSymbolicLink()) error = 'The data directory is a link; migrate it manually';
      if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || !fs.statSync(destination).isDirectory() || hasData(destination))) {
        error = 'The Camellia data directory already contains files; nothing was overwritten';
      }
    } catch (failure) { error = failure.message; }
  }
  return { legacy, canMigrate: legacy && !error, source: dataDir, destination, error };
}

function requestDirectoryMigration(options) {
  const state = migrationStatus(options);
  if (!state.canMigrate) throw new Error(state.error || 'This installation is not using the legacy data directory');
  fs.writeFileSync(path.join(options.appData, REQUEST_NAME), JSON.stringify({ source: state.source, destination: state.destination }), { flag: 'wx', mode: 0o600 });
  return state;
}

function cancelDirectoryMigration(appData) {
  fs.rmSync(path.join(appData, REQUEST_NAME), { force: true });
}

function movePath(value, source, destination) {
  const resolved = path.resolve(value);
  const relative = path.relative(source, resolved);
  return relative && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) ? value : path.join(destination, relative);
}

function progressPhase(onProgress, stage, expected, details = {}) {
  const totals = expected ? [...expected.values()] : [];
  const state = { stage, processedEntries: 0, totalEntries: expected?.size || 0,
    processedBytes: 0, totalBytes: totals.reduce((sum, entry) => sum + (entry.size || 0), 0), current: '', cancellable: stage !== 'cleanup', ...details };
  const report = () => onProgress?.({ ...state });
  report();
  return {
    start(current) { state.current = current; report(); },
    read(bytes) { state.processedBytes += bytes; report(); },
    complete() { state.processedEntries += 1; report(); },
    finish() { onProgress?.({ ...state, phaseComplete: true }); },
  };
}

function directoryLink(source) {
  try { return fs.statSync(source).isDirectory(); }
  catch (error) {
    if (process.platform !== 'win32') return false;
    // stat follows a junction's target. A missing package must not turn a
    // directory junction into a file symlink, which needs extra privileges.
    // Read the reparse entry's own Directory attribute without following it.
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'try { [int](Get-Item -LiteralPath $env:CAMELLIA_MIGRATION_LINK -Force -ErrorAction Stop).Attributes } catch { exit 1 }'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, CAMELLIA_MIGRATION_LINK: source } });
    if (result.status !== 0 || !/^\d+$/.test(result.stdout?.trim() || '')) {
      throw new Error('Could not inspect the directory link: ' + source + ' (' + error.code + ')');
    }
    return (Number(result.stdout.trim()) & 16) !== 0;
  }
}

function copyTree(source, destination, roots, progress) {
  const stat = fs.lstatSync(source);
  progress?.start(path.relative(roots.source, source));
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(source);
    const target = path.isAbsolute(link) ? movePath(link, roots.source, roots.destination) : link;
    const directory = directoryLink(source);
    const type = directory ? (process.platform === 'win32' && path.isAbsolute(target) ? 'junction' : 'dir') : 'file';
    fs.symlinkSync(target, destination, type);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: stat.mode });
    for (const name of fs.readdirSync(source)) {
      if (source === roots.source && (name.startsWith('Singleton') || name === 'lockfile')) continue;
      copyTree(path.join(source, name), path.join(destination, name), roots, progress);
    }
    fs.utimesSync(destination, stat.atime, stat.mtime);
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, stat.mode);
    fs.utimesSync(destination, stat.atime, stat.mtime);
    progress?.read(stat.size);
  } else {
    throw new Error('The data directory contains an unsupported file: ' + source);
  }
  progress?.complete();
}

function fileFingerprint(file, progress) {
  const reader = fs.openSync(file, 'r'), buffer = Buffer.alloc(256 * 1024), hash = createHash('sha256');
  let size = 0;
  try {
    let bytes;
    while ((bytes = fs.readSync(reader, buffer)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      size += bytes;
      progress?.read(bytes);
    }
  } finally { fs.closeSync(reader); }
  return { type: 'file', size, hash: hash.digest('hex') };
}

function treeManifest(directory, skipLocks = false, progress) {
  const manifest = new Map();
  const visit = (file, relative) => {
    progress?.start(relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      manifest.set(relative, { type: 'link', target: path.isAbsolute(target) ? path.resolve(target) : target });
    } else if (stat.isDirectory()) {
      manifest.set(relative, { type: 'directory' });
      for (const name of fs.readdirSync(file)) {
        if (skipLocks && !relative && (name.startsWith('Singleton') || name === 'lockfile')) continue;
        visit(path.join(file, name), path.join(relative, name));
      }
    } else if (stat.isFile()) manifest.set(relative, fileFingerprint(file, progress));
    else throw new Error('The data directory contains an unsupported file: ' + file);
    progress?.complete();
  };
  visit(directory, '');
  progress?.finish();
  return manifest;
}

function verifyTree(directory, expected, skipLocks = false, progress) {
  const actual = treeManifest(directory, skipLocks, progress);
  if (actual.size !== expected.size) throw new Error('Data verification failed; the old folder was kept intact');
  for (const [relative, entry] of expected) {
    const copied = actual.get(relative);
    const matches = entry.type === 'link' && copied?.type === 'link' && path.isAbsolute(entry.target)
      ? samePath(entry.target, copied.target) : JSON.stringify(entry) === JSON.stringify(copied);
    if (!matches) throw new Error('Data verification failed; the old folder was kept intact');
  }
}

function pathMappings(source, destination) {
  const variants = value => [value, value.replace(/\\/g, '/'), value.replace(/\\/g, '\\\\')];
  const from = variants(source), to = variants(destination);
  return from.map((value, index) => [value, to[index]]).filter(([value], index, list) => list.findIndex(([other]) => other === value) === index)
    .sort(([first], [second]) => second.length - first.length)
    .map(([value, target]) => ({ from: value, to: target,
      pattern: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\\\/"\\\'\\s<>,)}\\]])', process.platform === 'win32' ? 'gi' : 'g') }));
}

function rewritePaths(text, mappings) {
  let result = text;
  for (const { pattern, to } of mappings) result = result.replace(pattern, () => to);
  return result;
}

function rewriteText(file, mappings) {
  const stat = fs.statSync(file), temporary = file + '.migrating-' + randomUUID();
  const reader = fs.openSync(file, 'r'), writer = fs.openSync(temporary, 'wx', stat.mode);
  const decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(256 * 1024);
  const overlap = Math.max(...mappings.map(({ from }) => from.length)) + 1;
  const hash = createHash('sha256');
  let pending = '', changed = false, size = 0;
  const write = text => {
    const rewritten = rewritePaths(text, mappings);
    changed ||= rewritten !== text;
    hash.update(rewritten, 'utf8');
    size += Buffer.byteLength(rewritten, 'utf8');
    fs.writeFileSync(writer, rewritten);
  };
  try {
    let bytes;
    while ((bytes = fs.readSync(reader, buffer)) > 0) {
      pending += decoder.write(buffer.subarray(0, bytes));
      let boundary = Math.max(0, pending.length - overlap);
      for (const { from } of mappings) {
        const start = (process.platform === 'win32' ? pending.toLowerCase() : pending).indexOf(
          process.platform === 'win32' ? from.toLowerCase() : from, Math.max(0, boundary - from.length));
        if (start >= 0 && start < boundary && start + from.length >= boundary) boundary = start;
      }
      if (boundary > 0 && /[\uD800-\uDBFF]/.test(pending[boundary - 1]) && /[\uDC00-\uDFFF]/.test(pending[boundary])) boundary -= 1;
      write(pending.slice(0, boundary));
      pending = pending.slice(boundary);
    }
    write(pending + decoder.end());
  } finally { fs.closeSync(reader); fs.closeSync(writer); }
  if (changed) {
    fs.renameSync(temporary, file);
    fs.utimesSync(file, stat.atime, stat.mtime);
    return { type: 'file', size, hash: hash.digest('hex') };
  } else fs.unlinkSync(temporary);
  return null;
}

function databaseFingerprint(database, mappings = []) {
  const quote = value => '"' + value.replace(/"/g, '""') + '"';
  const hash = createHash('sha256');
  const schema = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all();
  hash.update(JSON.stringify(schema));
  for (const table of schema.filter(row => row.type === 'table')) {
    const columns = database.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
    const textColumns = new Set(columns.filter(column => /TEXT|CHAR|CLOB/i.test(column.type)).map(column => column.name));
    const statement = database.prepare(`SELECT * FROM ${quote(table.name)}`);
    statement.setReadBigInts(true);
    const rows = [];
    for (const row of statement.iterate()) {
      const values = Object.entries(row).map(([name, value]) => {
        if (typeof value === 'string' && textColumns.has(name) && !table.name.startsWith('sqlite_')) value = rewritePaths(value, mappings);
        if (typeof value === 'bigint') return [name, 'integer', value.toString()];
        if (value instanceof Uint8Array) return [name, 'blob', Buffer.from(value).toString('base64')];
        return [name, typeof value, value];
      });
      rows.push(createHash('sha256').update(JSON.stringify(values)).digest('hex'));
    }
    hash.update(JSON.stringify([table.name, columns, rows.length]));
    for (const row of rows.sort()) hash.update(row);
  }
  return hash.digest('hex');
}

function rewriteDatabase(file, mappings) {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(file);
  const quote = value => '"' + value.replace(/"/g, '""') + '"';
  let expected;
  try {
    database.exec('PRAGMA trusted_schema=OFF');
    if (Object.values(database.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('The native database could not be verified');
    expected = databaseFingerprint(database, mappings);
    database.function('camellia_migrate_path', value => typeof value === 'string' ? rewritePaths(value, mappings) : value);
    database.exec('BEGIN');
    for (const table of database.prepare('PRAGMA table_list').all().filter(row => row.type === 'table' && !row.name.startsWith('sqlite_'))) {
      for (const column of database.prepare(`PRAGMA table_info(${quote(table.name)})`).all().filter(row => /TEXT|CHAR|CLOB/i.test(row.type))) {
        const tableName = quote(table.name), columnName = quote(column.name);
        database.prepare(`UPDATE ${tableName} SET ${columnName} = camellia_migrate_path(${columnName}) WHERE typeof(${columnName}) = 'text' AND ${columnName} != camellia_migrate_path(${columnName})`).run();
      }
    }
    if (databaseFingerprint(database) !== expected || Object.values(database.prepare('PRAGMA integrity_check').get())[0] !== 'ok') {
      throw new Error('The native database could not be verified');
    }
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
  const saved = new DatabaseSync(file, { readOnly: true });
  try {
    saved.exec('PRAGMA trusted_schema=OFF');
    if (Object.values(saved.prepare('PRAGMA integrity_check').get())[0] !== 'ok' || databaseFingerprint(saved) !== expected) {
      throw new Error('The native database could not be verified');
    }
  } finally { saved.close(); }
}

function rewriteTree(directory, mappings, manifest, root = directory, progress) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (!fs.existsSync(file)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!SKIP_REWRITE.has(entry.name)) rewriteTree(file, mappings, manifest, root, progress);
    } else if (entry.isFile() && /\.(?:json|jsonl|toml|ya?ml)$/i.test(entry.name)) {
      progress?.start(path.relative(root, file));
      const rewritten = rewriteText(file, mappings);
      if (rewritten) manifest.set(path.relative(root, file), rewritten);
      progress?.read(fs.statSync(file).size);
      progress?.complete();
    }
    else if (entry.isFile() && /\.(?:sqlite|db)$/i.test(entry.name)) {
      progress?.start(path.relative(root, file));
      const descriptor = fs.openSync(file, 'r'), header = Buffer.alloc(16);
      try { fs.readSync(descriptor, header); } finally { fs.closeSync(descriptor); }
      if (header.toString() === 'SQLite format 3\0') {
        rewriteDatabase(file, mappings);
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          const relative = path.relative(root, file + suffix);
          if (fs.existsSync(file + suffix)) manifest.set(relative, fileFingerprint(file + suffix));
          else manifest.delete(relative);
        }
      }
      progress?.read(fs.statSync(file).size);
      progress?.complete();
    }
  }
}

function completeCopyMigration({ appData, dataDir, activate, onProgress }) {
  const request = path.join(appData, REQUEST_NAME);
  if (!fs.existsSync(request)) return null;
  const staging = path.join(appData, DATA_NAME + '.migrating-' + randomUUID());
  let published = false, state;
  try {
    const pending = JSON.parse(fs.readFileSync(request, 'utf8'));
    state = migrationStatus({ appData, dataDir });
    if (!state.canMigrate || !samePath(pending.source, state.source) || !samePath(pending.destination, state.destination)) {
      throw new Error(state.error || 'The data directory changed; migration was stopped');
    }
    const sourceStat = fs.lstatSync(state.source);
    const original = treeManifest(state.source, true, progressPhase(onProgress, 'scan'));
    const expected = new Map([...original].map(([relative, entry]) => [relative, entry.type === 'link' && path.isAbsolute(entry.target)
      ? { ...entry, target: movePath(entry.target, state.source, state.destination) } : entry]));
    const copyProgress = progressPhase(onProgress, 'copy', expected);
    copyTree(state.source, staging, state, copyProgress);
    copyProgress.finish();
    verifyTree(staging, expected, false, progressPhase(onProgress, 'verify-copy', expected));
    const rewritable = new Map([...expected].filter(([relative, entry]) => entry.type === 'file'
      && /\.(?:json|jsonl|toml|ya?ml|sqlite|db)$/i.test(relative)
      && !relative.split(path.sep).slice(0, -1).some(name => SKIP_REWRITE.has(name))));
    const rewriteProgress = progressPhase(onProgress, 'rewrite', rewritable);
    rewriteTree(staging, pathMappings(state.source, state.destination), expected, staging, rewriteProgress);
    rewriteProgress.finish();
    verifyTree(staging, expected, false, progressPhase(onProgress, 'verify-rewrite', expected));
    const checked = migrationStatus({ appData, dataDir });
    if (!checked.canMigrate) throw new Error(checked.error);
    if (fs.existsSync(state.destination)) fs.rmdirSync(state.destination);
    fs.renameSync(staging, state.destination);
    published = true;
    verifyTree(state.destination, expected, false, progressPhase(onProgress, 'verify-final', expected));
    verifyTree(state.source, original, true, progressPhase(onProgress, 'verify-source', original));
    const currentStat = fs.lstatSync(state.source);
    if (!samePath(state.source, path.join(appData, LEGACY_NAME)) || currentStat.isSymbolicLink() || !currentStat.isDirectory()
      || currentStat.dev !== sourceStat.dev || currentStat.ino !== sourceStat.ino) {
      throw new Error('The data directory changed; migration was stopped');
    }
    try {
      progressPhase(onProgress, 'cleanup');
      if (activate) activate(state);
      fs.rmSync(state.source, { recursive: true, maxRetries: 5, retryDelay: 250 });
    } catch (error) {
      try { cancelDirectoryMigration(appData); } catch {}
      return { ...state, migrated: true, error: 'Data was moved and verified, but the old folder could not be completely removed', cleanupError: error.message };
    }
    try { cancelDirectoryMigration(appData); } catch {}
    return { ...state, migrated: true };
  } catch (error) {
    let rollbackError = null;
    if (published) {
      try { fs.renameSync(state.destination, staging); } catch (failure) { rollbackError = failure.message; }
    }
    if (path.dirname(path.resolve(staging)) === path.resolve(appData) && path.basename(staging).startsWith(DATA_NAME + '.migrating-')) {
      try { fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
      catch (failure) { rollbackError ||= failure.message; }
    }
    try { cancelDirectoryMigration(appData); } catch {}
    return { migrated: false, source: dataDir, destination: path.join(appData, DATA_NAME), error: error.message,
      ...(rollbackError ? { rollbackError, leftoverDirectory: fs.existsSync(staging) ? staging : state?.destination } : {}) };
  }
}

function completeDirectoryMigration(options) {
  if (!fs.existsSync(path.join(options.appData, REQUEST_NAME))) return null;
  if (options.strategy !== 'copy') {
    const result = require('./data-directory-fast').completeRenameMigration(options, migrationHelpers);
    if (!result.fallback) return result;
    return { ...completeCopyMigration(options), method: 'copy', fallbackReason: result.fallbackReason };
  }
  return { ...completeCopyMigration(options), method: 'copy' };
}

function recoverDirectoryMigration(appData) {
  const result = require('./data-directory-fast').recoverDirectoryMigration(appData, migrationHelpers);
  if (result) saveDirectoryMigrationResult(appData, { ...result, source: path.join(appData, LEGACY_NAME), destination: path.join(appData, DATA_NAME),
    ...(!result.migrated ? { error: 'An interrupted data directory migration was rolled back; the original profile was restored' } : {}) });
  return result;
}

function saveDirectoryMigrationResult(appData, result) {
  const file = path.join(appData, RESULT_NAME), temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ ...result, finishedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readDirectoryMigrationResult(appData) {
  try {
    const result = JSON.parse(fs.readFileSync(path.join(appData, RESULT_NAME), 'utf8'));
    return typeof result.migrated === 'boolean' ? result : null;
  } catch { return null; }
}

const migrationHelpers = { samePath, movePath, migrationStatus, cancelDirectoryMigration, pathMappings, rewritePaths,
  rewriteText, rewriteDatabase, databaseFingerprint, fileFingerprint, directoryLink, progressPhase, SKIP_REWRITE };

module.exports = { defaultDataDirectory, usesManagedDataDirectory, configureDataDirectory, migrationStatus, requestDirectoryMigration, cancelDirectoryMigration,
  completeDirectoryMigration, recoverDirectoryMigration, saveDirectoryMigrationResult, readDirectoryMigrationResult };
