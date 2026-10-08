'use strict';

// A sibling directory rename preserves opaque data, hard links and reparse
// points. Only path-bearing metadata and internal absolute links are replaced.
// Originals stay in a transaction directory until activation has committed.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const JOURNAL = '.camellia-directory-migration-transaction.json';
const REQUEST = '.camellia-directory-migration.json';
const WORK_PREFIX = '.camellia-migration-work-';
const PHASES = ['inventory', 'prepare', 'verify-prepared', 'move', 'verify-updates', 'activate'];
const SIDECARS = ['', '-wal', '-shm', '-journal'];

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(file, expected) {
  if (!exists(file)) return false;
  const actual = identity(file);
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function snapshot(file, helpers, progress) {
  if (!exists(file)) return null;
  const stat = fs.lstatSync(file), id = identity(file);
  if (stat.isSymbolicLink()) return { ...id, type: 'link', target: fs.readlinkSync(file) };
  if (stat.isFile()) return { ...id, ...helpers.fileFingerprint(file, progress) };
  throw new Error('Unsupported migration metadata: ' + file);
}

function verifySnapshot(file, expected, helpers, progress, checkIdentity = true) {
  const actual = snapshot(file, helpers, progress);
  if (!actual || actual.type !== expected?.type || (checkIdentity && (actual.dev !== expected.dev || actual.ino !== expected.ino))
    || (actual.type === 'link' ? actual.target !== expected.target : actual.hash !== expected.hash || actual.size !== expected.size)) {
    throw new Error('Migration metadata changed or failed verification: ' + file);
  }
}

function relativeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Unsafe migration transaction path');
  const file = path.resolve(root, relative), back = path.relative(root, file);
  if (!back || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) throw new Error('Unsafe migration transaction path');
  return file;
}

function safeParents(root, relative) {
  const parts = path.relative(root, relativeFile(root, relative)).split(path.sep).slice(0, -1);
  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Migration metadata parent changed: ' + directory);
  }
}

function syncFile(file) {
  // FlushFileBuffers on Windows requires a writable file handle.
  const mode = fs.statSync(file).mode, writable = process.platform === 'win32' && !(mode & 0o200);
  if (writable) fs.chmodSync(file, mode | 0o200);
  let fd;
  try { fd = fs.openSync(file, process.platform === 'win32' ? 'r+' : 'r'); fs.fsyncSync(fd); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (writable) fs.chmodSync(file, mode); }
}

function writeJournal(appData, journal, initial = false) {
  const file = path.join(appData, JOURNAL);
  if (initial) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(journal)); fs.fsyncSync(fd); }
    catch (error) { error.journalCreated = true; throw error; }
    finally { fs.closeSync(fd); }
  } else {
    const temporary = file + '.tmp';
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(journal)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
}

function validateJournal(appData, journal, helpers) {
  if (journal?.version !== 1 || !/^[0-9a-f-]{36}$/.test(journal.id || '')
    || !['preparing', 'moving', 'committed'].includes(journal.status)
    || !helpers.samePath(journal.source || '.', path.join(appData, 'dsh-desktop'))
    || !helpers.samePath(journal.destination || '.', path.join(appData, 'camellia'))
    || !helpers.samePath(journal.work || '.', path.join(appData, WORK_PREFIX + journal.id))
    || !/^\d+$/.test(journal.root?.dev || '') || !/^\d+$/.test(journal.root?.ino || '')
    || !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid <= 0 || !Array.isArray(journal.operations)) {
    throw new Error('The data migration recovery record is invalid; no data was changed');
  }
  if (exists(journal.work) && (fs.lstatSync(journal.work).isSymbolicLink() || !fs.lstatSync(journal.work).isDirectory())) {
    throw new Error('The migration transaction directory was replaced; no data was changed');
  }
  const paths = new Set();
  for (const [index, op] of journal.operations.entries()) {
    relativeFile(journal.destination, op.relative);
    relativeFile(journal.work, op.backup);
    const key = process.platform === 'win32' ? op.relative.toLowerCase() : op.relative;
    if (op.backup !== path.join('original', String(index)) || paths.has(key)) throw new Error('Invalid migration backup path');
    paths.add(key);
    if (op.prepared) {
      relativeFile(journal.work, op.prepared);
      if (!op.prepared.startsWith('updated' + path.sep) && !op.prepared.startsWith('databases' + path.sep)) {
        throw new Error('Invalid prepared migration path');
      }
    }
    for (const record of [op.before, op.after].filter(Boolean)) {
      if (!['file', 'link'].includes(record.type) || !/^\d+$/.test(record.dev || '') || !/^\d+$/.test(record.ino || '')
        || (record.type === 'file' && (!/^[a-f0-9]{64}$/.test(record.hash || '') || !Number.isSafeInteger(record.size) || record.size < 0))
        || (record.type === 'link' && typeof record.target !== 'string')) throw new Error('Invalid migration file identity');
    }
    if (!op.before && !op.after && op.guard !== true) throw new Error('Invalid empty migration operation');
  }
}

function removeMigrationWorkDirectory(appData, directory) {
  const root = path.resolve(directory), relative = path.relative(path.resolve(appData), root);
  if (path.dirname(relative) !== '.' || !/^\.camellia-migration-work-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(relative)) {
    throw new Error('Unsafe migration cleanup directory; no data was removed');
  }
  if (!exists(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The migration cleanup directory was replaced; no data was removed');
  const unlinkLinks = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name), info = fs.lstatSync(file);
      // After the profile rename, original internal junctions point at the
      // absent old directory. Electron's recursive rm can silently leave the
      // whole backup tree behind; unlink reparse entries without following them.
      if (info.isSymbolicLink()) fs.unlinkSync(file);
      else if (info.isDirectory()) unlinkLinks(file);
    }
  };
  unlinkLinks(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (exists(root)) throw new Error('Migration backup directory still exists after cleanup: ' + root);
}

function cleanupTransaction(appData, journal, helpers) {
  validateJournal(appData, journal, helpers);
  // The resolved directory must be this transaction's sibling, never a
  // profile or a path from an unchecked journal.
  removeMigrationWorkDirectory(appData, journal.work);
  fs.rmSync(path.join(appData, JOURNAL + '.tmp'), { force: true });
  fs.unlinkSync(path.join(appData, JOURNAL));
}

function rollbackTransaction(appData, journal, helpers) {
  validateJournal(appData, journal, helpers);
  if (journal.status === 'preparing') {
    if (!sameIdentity(journal.source, journal.root)) throw new Error('The original data directory changed; recovery stopped');
    return;
  }
  let root;
  if (sameIdentity(journal.source, journal.root)) root = journal.source;
  else if (sameIdentity(journal.destination, journal.root)) root = journal.destination;
  else throw new Error('Cannot locate the original data directory; recovery stopped');
  if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) throw new Error('The data directory was replaced; recovery stopped');
  for (const op of [...journal.operations].reverse()) {
    safeParents(root, op.relative);
    const target = relativeFile(root, op.relative), backup = relativeFile(journal.work, op.backup);
    if (op.guard) {
      if (exists(target)) throw new Error('A database sidecar appeared during recovery: ' + target);
      continue;
    }
    if (exists(journal.work)) safeParents(journal.work, op.backup);
    if (exists(backup)) {
      verifySnapshot(backup, op.before, helpers);
      if (exists(target)) {
        if (!op.after || !sameIdentity(target, op.after)) throw new Error('A replaced file changed during recovery: ' + target);
        fs.unlinkSync(target);
      }
      fs.renameSync(backup, target);
    } else if (!op.before) {
      if (exists(target)) {
        if (!sameIdentity(target, op.after)) throw new Error('A new file changed during recovery: ' + target);
        fs.unlinkSync(target);
      }
    } else verifySnapshot(target, op.before, helpers);
  }
  if (root === journal.destination) {
    if (exists(journal.source)) throw new Error('The old directory was recreated; recovery did not overwrite it');
    fs.renameSync(journal.destination, journal.source);
  }
}

function recoverDirectoryMigration(appData, helpers) {
  const file = path.join(appData, JOURNAL);
  if (!exists(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('The migration recovery record is a link; no data was changed');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateJournal(appData, journal, helpers);
  try {
    process.kill(journal.ownerPid, 0);
    const error = new Error('Camellia is already migrating its data directory');
    error.code = 'CAMELLIA_MIGRATION_BUSY';
    throw error;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  if (journal.status === 'committed') {
    if (!sameIdentity(journal.destination, journal.root)) throw new Error('The migrated directory changed; recovery stopped');
  } else rollbackTransaction(appData, journal, helpers);
  try {
    helpers.cancelDirectoryMigration(appData);
    cleanupTransaction(appData, journal, helpers);
  }
  catch (error) {
    if (journal.status !== 'committed') throw error;
    return { recovered: true, migrated: true, method: 'rename',
      error: 'Data moved and verified; temporary backups could not be removed', cleanupError: error.message, leftoverDirectory: journal.work };
  }
  return { recovered: true, migrated: journal.status === 'committed', method: 'rename' };
}

function inventory(source, helpers, progress) {
  const candidates = [];
  const visit = (directory, skipText = false) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === source && (entry.name.startsWith('Singleton') || entry.name === 'lockfile')) continue;
      const file = path.join(directory, entry.name), relative = path.relative(source, file);
      progress.start(relative);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (path.isAbsolute(target) && helpers.movePath(target, source, path.join(path.dirname(source), 'camellia')) !== target) {
          candidates.push({ relative, kind: 'link' });
        }
      } else if (entry.isDirectory()) visit(file, skipText || helpers.SKIP_REWRITE.has(entry.name));
      else if (entry.isFile()) {
        if (!skipText && /\.(?:json|jsonl|toml|ya?ml|sqlite|db)$/i.test(entry.name)) candidates.push({ relative, kind: 'metadata' });
      } else throw new Error('Unsupported entry in the data directory: ' + file);
      progress.complete();
    }
  };
  visit(source);
  progress.finish();
  return candidates;
}

function textNeedsRewrite(file, mappings, progress) {
  const fd = fs.openSync(file, 'r'), decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(256 * 1024);
  const overlap = Math.max(...mappings.map(item => item.from.length)) + 1;
  let pending = '';
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer)) > 0) {
      progress.read(bytes);
      pending += decoder.write(buffer.subarray(0, bytes));
      const boundary = Math.max(0, pending.length - overlap);
      for (const { pattern } of mappings) {
        pattern.lastIndex = 0;
        const match = pattern.exec(pending);
        // A chunk boundary is not the end of the file: wait for the path's
        // delimiter before treating a root-only occurrence as a match.
        if (match && match.index < boundary && match.index + match[0].length < pending.length) return true;
      }
      pending = pending.slice(boundary);
    }
    pending += decoder.end();
    return helpersRewrite(pending, mappings) !== pending;
  } finally { fs.closeSync(fd); }
}

function helpersRewrite(text, mappings) {
  for (const { pattern, to } of mappings) text = text.replace(pattern, () => to);
  return text;
}

function copyMetadata(source, target, before, helpers, progress) {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const stat = fs.statSync(source);
  fs.chmodSync(target, stat.mode);
  fs.utimesSync(target, stat.atime, stat.mtime);
  verifySnapshot(target, before, helpers, progress, false);
}

function sqliteFile(file) {
  const fd = fs.openSync(file, 'r'), header = Buffer.alloc(16);
  try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
  return header.toString() === 'SQLite format 3\0';
}

function prepareUpdates(journal, candidates, helpers, progress) {
  const mappings = helpers.pathMappings(journal.source, journal.destination);
  const add = (relative, before, prepared) => {
    const after = prepared ? snapshot(prepared, helpers, progress) : null;
    if (after?.type === 'file') syncFile(prepared);
    journal.operations.push({ relative, before, after,
      ...(!before && !after ? { guard: true } : {}),
      backup: path.join('original', String(journal.operations.length)),
      prepared: prepared ? path.relative(journal.work, prepared) : null });
  };
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index], source = relativeFile(journal.source, item.relative);
    safeParents(journal.source, item.relative);
    progress.start(item.relative);
    if (item.kind === 'link') {
      const before = snapshot(source, helpers);
      const prepared = path.join(journal.work, 'updated', String(index));
      const target = helpers.movePath(before.target, journal.source, journal.destination);
      const directory = helpers.directoryLink(source);
      fs.symlinkSync(target, prepared, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
      add(item.relative, before, prepared);
    } else if (/\.(?:sqlite|db)$/i.test(source)) {
      if (!fs.lstatSync(source).isFile()) throw new Error('Migration metadata was replaced: ' + source);
      if (sqliteFile(source)) {
        const directory = path.join(journal.work, 'databases', String(index));
        fs.mkdirSync(directory, { recursive: true });
        const prepared = path.join(directory, path.basename(source));
        const before = new Map();
        for (const suffix of SIDECARS) {
          const record = snapshot(source + suffix, helpers, progress);
          if (record && record.type !== 'file') throw new Error('A database sidecar is a link: ' + source + suffix);
          before.set(suffix, record);
          if (record) copyMetadata(source + suffix, prepared + suffix, record, helpers, progress);
        }
        const { DatabaseSync } = require('node:sqlite');
        const database = new DatabaseSync(prepared, { readOnly: true });
        let changed;
        try {
          database.exec('PRAGMA trusted_schema=OFF');
          if (Object.values(database.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('The native database could not be verified');
          changed = helpers.databaseFingerprint(database) !== helpers.databaseFingerprint(database, mappings);
        } finally { database.close(); }
        if (changed) {
          helpers.rewriteDatabase(prepared, mappings);
          for (const suffix of SIDECARS) {
            add(item.relative + suffix, before.get(suffix), exists(prepared + suffix) ? prepared + suffix : null);
          }
        }
      }
    } else {
      if (!fs.lstatSync(source).isFile()) throw new Error('Migration metadata was replaced: ' + source);
      if (textNeedsRewrite(source, mappings, progress)) {
        const before = snapshot(source, helpers, progress);
        const prepared = path.join(journal.work, 'updated', String(index));
        copyMetadata(source, prepared, before, helpers, progress);
        const expected = helpers.rewriteText(prepared, mappings);
        if (expected) {
          verifySnapshot(prepared, expected, helpers, progress, false);
          add(item.relative, before, prepared);
        }
      }
    }
    progress.complete();
  }
  progress.finish();
}

function completeRenameMigration(options, helpers) {
  const { appData, dataDir, activate, suspend, resume, lockDestination, onProgress } = options;
  // Startup normally handles this before selecting a profile. Direct callers
  // must also refuse to interfere with an unfinished transaction.
  recoverDirectoryMigration(appData, helpers);
  let state, journal, ownsJournal = false, suspended = false, committed = false;
  const phase = (stage, count = 0) => helpers.progressPhase(onProgress, stage,
    count ? new Map(Array.from({ length: count }, (_, i) => [i, {}])) : null,
    { method: 'rename', phases: PHASES, cancellable: ['inventory', 'prepare', 'verify-prepared'].includes(stage) });
  try {
    const pending = JSON.parse(fs.readFileSync(path.join(appData, REQUEST), 'utf8'));
    state = helpers.migrationStatus({ appData, dataDir });
    if (!state.canMigrate || !helpers.samePath(pending.source, state.source) || !helpers.samePath(pending.destination, state.destination)) {
      throw new Error(state.error || 'The data directory changed; migration was stopped');
    }
    if (identity(state.source).dev !== identity(appData).dev) return { fallback: true, fallbackReason: 'The data directory is on another filesystem' };
    const id = randomUUID();
    journal = { version: 1, id, ownerPid: process.pid, status: 'preparing', source: state.source, destination: state.destination,
      root: identity(state.source), work: path.join(appData, WORK_PREFIX + id), operations: [] };
    writeJournal(appData, journal, true);
    ownsJournal = true;
    fs.mkdirSync(journal.work);
    fs.mkdirSync(path.join(journal.work, 'updated'));
    fs.mkdirSync(path.join(journal.work, 'original'));
    const candidates = inventory(state.source, helpers, phase('inventory'));
    prepareUpdates(journal, candidates, helpers, phase('prepare', candidates.length));
    const preparedVerification = phase('verify-prepared', journal.operations.length);
    for (const op of journal.operations) {
      preparedVerification.start(op.relative);
      safeParents(state.source, op.relative);
      if (op.before) verifySnapshot(relativeFile(state.source, op.relative), op.before, helpers, preparedVerification);
      else if (exists(relativeFile(state.source, op.relative))) throw new Error('A database sidecar appeared during migration');
      if (op.after) verifySnapshot(relativeFile(journal.work, op.prepared), op.after, helpers, preparedVerification);
      preparedVerification.complete();
    }
    preparedVerification.finish();
    const checked = helpers.migrationStatus({ appData, dataDir });
    if (!checked.canMigrate || !sameIdentity(state.source, journal.root)) throw new Error(checked.error || 'The original data directory changed');
    const moveProgress = phase('move', journal.operations.length + 1);
    // Persist the complete swap plan before releasing the lock or moving data.
    journal.status = 'moving';
    writeJournal(appData, journal);
    suspended = true;
    suspend?.(state);
    if (exists(state.destination)) fs.rmdirSync(state.destination);
    fs.renameSync(state.source, state.destination);
    // Reacquire Electron's profile lock immediately; its browser has not
    // initialized yet and no engine may open the pending metadata updates.
    lockDestination?.(state);
    moveProgress.complete();
    for (const op of journal.operations) {
      safeParents(state.destination, op.relative);
      const target = relativeFile(state.destination, op.relative);
      moveProgress.start(op.relative);
      if (op.before) {
        const backup = relativeFile(journal.work, op.backup);
        fs.renameSync(target, backup);
        verifySnapshot(backup, op.before, helpers, moveProgress);
      }
      if (op.after) fs.renameSync(relativeFile(journal.work, op.prepared), target);
      moveProgress.complete();
    }
    moveProgress.finish();
    const verification = phase('verify-updates', journal.operations.length);
    for (const op of journal.operations) {
      verification.start(op.relative);
      const target = relativeFile(state.destination, op.relative);
      if (op.after) verifySnapshot(target, op.after, helpers, verification);
      else if (exists(target)) throw new Error('A removed database sidecar reappeared during migration');
      verification.complete();
    }
    if (!sameIdentity(state.destination, journal.root)) throw new Error('The moved directory failed identity verification');
    verification.finish();
    const activation = phase('activate');
    activate?.(state);
    if (exists(state.source)) throw new Error('The old directory was recreated during migration; activation stopped');
    journal.status = 'committed';
    writeJournal(appData, journal);
    committed = true;
    helpers.cancelDirectoryMigration(appData);
    cleanupTransaction(appData, journal, helpers);
    activation.finish();
    return { ...state, migrated: true, method: 'rename', checkedMetadata: candidates.length,
      changedEntries: journal.operations.filter(op => !op.guard).length };
  } catch (error) {
    if (committed) return { ...state, migrated: true, method: 'rename', error: 'Data moved and verified; temporary backups could not be removed',
      cleanupError: error.message, leftoverDirectory: journal.work };
    let rollbackError;
    const canFallback = journal?.status === 'moving' && sameIdentity(journal.source, journal.root)
      && ['EXDEV', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code);
    try {
      if (journal && (ownsJournal || error.journalCreated)) {
        if (suspended) suspend?.(state);
        rollbackTransaction(appData, journal, helpers);
        if (suspended) resume?.(state);
        cleanupTransaction(appData, journal, helpers);
      } else if (journal) rollbackError = 'Another migration owns the transaction record';
    } catch (failure) { rollbackError = failure.message; }
    if (canFallback && !rollbackError) return { fallback: true, fallbackReason: error.code + ': ' + error.message };
    if (!rollbackError) { try { helpers.cancelDirectoryMigration(appData); } catch {} }
    return { migrated: false, source: dataDir, destination: path.join(appData, 'camellia'), method: 'rename', error: error.message,
      ...(rollbackError ? { rollbackError, leftoverDirectory: journal?.work, recoveryRequired: true } : {}) };
  }
}

module.exports = { completeRenameMigration, recoverDirectoryMigration, removeMigrationWorkDirectory };
