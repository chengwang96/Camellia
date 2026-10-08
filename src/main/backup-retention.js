'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJson } = require('../shared/json-store');
const { payloadReferences, readBoundedJson } = require('../engines/discussions/payloads');
const { LIMITS } = require('../engines/discussions/schema');
const MARKER = 'retention.json', JOURNAL = 'transaction.jsonl';
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
const MAX_MARKER_BYTES = 32 * 1024 * 1024;
const BACKUP_COUNT = 3, BACKUP_DAYS = 30, BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const validRelative = rel => typeof rel === 'string' && /^(app|home)\//.test(rel)
  && rel.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:\0]/.test(part));
const DAY = 86400000;

function ownedFile(file, root, create = false) {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe backup payload path');
  let directory = root;
  for (const part of ['', ...relative.split(path.sep).slice(0, -1)]) {
    if (part) directory = path.join(directory, part);
    if (create && !fs.existsSync(directory)) fs.mkdirSync(directory);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked backup payload directory');
  }
  let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Linked or invalid backup payload');
  return stat;
}
function payloadHash(file) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024), fd = fs.openSync(file, 'r');
  try { for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function preserveGroupPayloads(directory, dataDir, entries) {
  const known = new Set(entries.map(entry => entry.rel));
  for (const entry of [...entries]) {
    const group = entry.rel.match(/^app\/discussions\/([a-f0-9-]{36})\.json$/i);
    if (!group) continue;
    const saved = readBoundedJson(path.join(directory, ...entry.rel.split('/')), LIMITS.recordBytes).value;
    if (saved.storageVersion !== 1) continue;
    for (const hash of payloadReferences(saved)) {
      const rel = `app/discussions/${group[1]}.payloads/${hash}.text`, file = path.join(directory, ...rel.split('/'));
      let stat = ownedFile(file, directory, true);
      if (!stat) {
        const source = path.join(dataDir, ...rel.split('/').slice(1)), original = ownedFile(source, dataDir);
        if (!original || original.size > LIMITS.promptBytes) throw new Error('Original discussion payload is missing or oversized');
        const temp = file + '.retention.tmp';
        if (ownedFile(temp, directory)) fs.unlinkSync(temp);
        fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
        if (payloadHash(temp) !== hash) throw new Error('Original discussion payload checksum changed');
        const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, file); stat = ownedFile(file, directory);
      } else if (stat.size > LIMITS.promptBytes || payloadHash(file) !== hash) throw new Error('Retained discussion payload checksum changed');
      if (!known.has(rel)) {
        entries.push({ rel, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) }); known.add(rel);
      }
    }
  }
}

function markerEntries(saved, directory) {
  if (saved?.version !== 1 || saved.kind !== 'camellia-import-backup' || saved.directory !== path.basename(directory)
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(saved.id || '')
    || !['committed', 'rolled-back'].includes(saved.status) || !Number.isSafeInteger(saved.completedAt)
    || !Array.isArray(saved.entries) || !saved.entries.length) throw new Error('Invalid backup completion record');
  const listed = new Map();
  for (const { rel, size, mtimeMs } of saved.entries) {
    if (!validRelative(rel) || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mtimeMs) || listed.has(rel)) throw new Error('Invalid backup completion record');
    listed.set(rel, { size, mtimeMs });
  }
  return listed;
}

function completeBackup(transaction, status, now = Date.now()) {
  const { directory, header, begins } = transaction;
  const marker = path.join(directory, MARKER);
  if (fs.existsSync(marker)) {
    const info = fs.lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_MARKER_BYTES) throw new Error('Invalid backup completion record');
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    markerEntries(saved, directory);
    if (saved.id !== header.id || saved.status !== status) throw new Error('Import backup completion record changed');
    return;
  }
  const entries = [];
  for (const record of begins) {
    if (!validRelative(record.rel)) throw new Error('Invalid retained import backup path');
    const file = path.join(directory, ...record.rel.split('/'));
    let parent = directory;
    for (const part of ['', ...record.rel.split('/').slice(0, -1)]) {
      if (part) parent = path.join(parent, part);
      let info; try { info = fs.lstatSync(parent); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked import backup directory');
    }
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink()) throw new Error('Invalid retained import backup');
    // Millisecond timestamps survive profile copies that preserve Date values.
    entries.push({ rel: record.rel, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
  }
  if (!entries.length) return;
  // A replaced group manifest can refer to immutable text that was never
  // overwritten. Give the recovery point its own copies before live pruning.
  preserveGroupPayloads(directory, header.dataDir || path.dirname(path.dirname(directory)), entries);
  const value = { version: 1, kind: 'camellia-import-backup', id: header.id, directory: path.basename(directory), status,
    createdAt: header.createdAt ?? now, completedAt: now, entries };
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) > MAX_MARKER_BYTES) throw new Error('Import backup completion record is too large');
  writeJson(marker, value);
}

async function backupInventory({ dataDir, safeStat, entries, now = Date.now(), signal,
  maxCount = BACKUP_COUNT, maxDays = BACKUP_DAYS, maxBytes = BACKUP_BYTES }) {
  const root = path.join(dataDir, 'migration-backups'), backups = [], verification = [], referenceErrors = [];
  let skipped = 0, nextSweepAt = null;
  for (const name of entries(root)) {
    const directory = path.join(root, name), files = [], directories = [];
    let walked = 0;
    const walk = async file => {
      const stat = safeStat(file);
      if (!stat) throw new Error('Import backup changed');
      if (++walked % 32 === 0) { await new Promise(setImmediate); signal?.throwIfAborted(); }
      if (stat.isDirectory()) {
        await new Promise(setImmediate); signal?.throwIfAborted();
        for (const child of entries(file)) await walk(path.join(file, child));
        directories.push(file);
      } else if (stat.isFile() && stat.nlink === 1) {
        files.push({ path: file, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
        verification.push({ file, stat });
      } else throw new Error('Linked or invalid import backup');
    };
    let complete = true;
    try { await walk(directory); }
    catch (error) {
      if (signal?.aborted) throw error;
      complete = false; skipped++; referenceErrors.push(directory);
    }
    const pending = files.some(file => file.path === path.join(directory, JOURNAL));
    const quarantined = files.some(file => path.basename(file.path).includes('.invalid-'));
    let saved = null, valid = false;
    try {
      const markerFile = path.join(directory, MARKER), markerEntry = files.find(file => file.path === markerFile);
      if (markerEntry) {
        if (markerEntry.bytes > MAX_MARKER_BYTES) throw new Error('Oversized backup completion record');
        saved = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        const listed = markerEntries(saved, directory);
        // A previously interrupted deletion may have removed some owned files.
        // Extra or changed files invalidate ownership; missing files do not.
        valid = complete && BACKUP_NAME.test(name) && saved.completedAt <= now && files.every(file => {
          if (file === markerEntry || file.path === path.join(directory, JOURNAL)) return true;
          const owned = listed.get(path.relative(directory, file.path).split(path.sep).join('/'));
          return owned?.size === file.bytes && owned.mtimeMs === Math.floor(file.mtimeMs);
        });
        if (!valid) throw new Error('Invalid backup completion record');
      }
    } catch (error) { if (signal?.aborted) throw error; skipped++; }
    const legacy = complete && BACKUP_NAME.test(name) && !files.some(file => file.path === path.join(directory, MARKER)) && !pending && !quarantined
      && files.length > 0 && files.every(file => validRelative(path.relative(directory, file.path).split(path.sep).join('/')));
    const bytes = files.reduce((total, file) => total + file.bytes, 0);
    backups.push({ directory, files, directories, bytes, completed: valid && !pending && !quarantined, legacy, pending, quarantined,
      time: valid ? saved.completedAt : complete ? safeStat(directory)?.mtimeMs || now : now });
  }
  const completed = backups.filter(backup => backup.completed).sort((a, b) => b.time - a.time || b.directory.localeCompare(a.directory));
  let keptBytes = 0;
  for (let index = 0; index < completed.length; index++) {
    const backup = completed[index];
    backup.expired = index > 0 && (index >= maxCount || backup.time < now - maxDays * DAY || keptBytes + backup.bytes > maxBytes);
    if (!backup.expired) keptBytes += backup.bytes;
    if (index > 0 && !backup.expired) nextSweepAt = Math.min(nextSweepAt ?? Infinity, backup.time + maxDays * DAY + 1);
  }
  const candidate = (backup, category) => ({ path: path.relative(dataDir, backup.directory), category, bytes: backup.bytes,
    count: backup.files.length, files: [...backup.files].sort((a, b) => Number(path.basename(a.path) === MARKER) - Number(path.basename(b.path) === MARKER)),
    directories: backup.directories, links: [] });
  const legacyExpired = backup => backup.legacy && backup.time < now - DAY;
  return { backups, verification, skipped, referenceErrors, nextSweepAt,
    candidates: backups.filter(backup => backup.expired).map(backup => candidate(backup, 'Old import backups')),
    legacyCandidates: backups.filter(legacyExpired).map(backup => candidate(backup, 'Legacy import backups')),
    summary: { count: backups.length, bytes: backups.reduce((sum, backup) => sum + backup.bytes, 0),
      protected: backups.filter(backup => !backup.expired && !legacyExpired(backup)).length,
      reclaimableBytes: backups.filter(backup => backup.expired || legacyExpired(backup)).reduce((sum, backup) => sum + backup.bytes, 0) } };
}

module.exports = { completeBackup, backupInventory, MARKER, BACKUP_COUNT, BACKUP_DAYS, BACKUP_BYTES };
