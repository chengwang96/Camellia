'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { completeBackup } = require('./backup-retention');

const JOURNAL = 'transaction.jsonl';
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function entryPath(rel, { dataDir, home, homeEntries }) {
  const parts = typeof rel === 'string' ? rel.split('/') : [];
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))
    || !['app', 'home'].includes(parts[0]) || parts[0] === 'app' && parts[1] === 'migration-backups'
    || parts[0] === 'home' && !homeEntries.includes(parts[1])) throw new Error('Unsafe data import transaction path');
  return path.join(parts[0] === 'app' ? dataDir : home, ...parts.slice(1));
}
function checkParents(file, root, create = false) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe data import path');
  let current = root;
  for (const part of ['', ...relative.split(path.sep).slice(0, -1)]) {
    if (part) current = path.join(current, part);
    let info = stat(current);
    if (!info && create) { fs.mkdirSync(current, { recursive: true }); info = stat(current); }
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked or unexpected data import directory: ' + current);
  }
  const info = stat(file);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Unexpected data import target: ' + file);
}
function fingerprint(file) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, 'r'); let size = 0;
  try { for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null));) { hash.update(buffer.subarray(0, n)); size += n; } }
  finally { fs.closeSync(fd); }
  return { hash: hash.digest('hex'), size };
}
const matches = (file, expected) => {
  if (!stat(file)) return !expected;
  const actual = fingerprint(file);
  return actual.hash === expected?.hash && actual.size === expected?.size;
};
function flush(file) {
  const mode = fs.statSync(file).mode, readonly = process.platform === 'win32' && !(mode & 0o200);
  if (readonly) fs.chmodSync(file, mode | 0o200);
  let fd;
  try { fd = fs.openSync(file, process.platform === 'win32' ? 'r+' : 'r'); fs.fsyncSync(fd); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (readonly) fs.chmodSync(file, mode); }
}
async function copy(from, to, mode) {
  const hash = createHash('sha256'); let size = 0;
  await pipeline(fs.createReadStream(from), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } }),
    fs.createWriteStream(to, { flags: 'wx', mode }));
  flush(to);
  return { hash: hash.digest('hex'), size, mode };
}
const temporary = (target, id, index) => target + `.camellia-import-${id}-${index}.tmp`;

function readTransaction(directory, options) {
  checkParents(path.join(directory, JOURNAL), options.dataDir);
  const text = fs.readFileSync(path.join(directory, JOURNAL), 'utf8');
  const lines = text.split('\n'); lines.pop(); // A torn trailing record was never acknowledged before a file swap.
  const [header, ...records] = lines.map(line => JSON.parse(line));
  if (header?.version !== 1 || !/^[a-f0-9-]{36}$/.test(header.id || '') || !samePath(header.dataDir || '.', options.dataDir)
    || !samePath(header.home || '.', options.home)) throw new Error('The data import recovery record does not match this profile');
  const begins = [], prepared = [], keys = new Set(); let committed = false;
  for (const record of records) {
    if (committed) throw new Error('Unexpected data import record after commit');
    if (record.type === 'committed') { committed = true; continue; }
    const target = entryPath(record.rel, options), key = process.platform === 'win32' ? record.rel.toLowerCase() : record.rel;
    if (record.type === 'begin' && record.index === begins.length && !keys.has(key)) { begins.push(record); keys.add(key); }
    else if (record.type === 'prepared' && record.index === prepared.length && begins[record.index]?.rel === record.rel) {
      for (const value of [record.before, record.after].filter(Boolean)) {
        if (!/^[a-f0-9]{64}$/.test(value.hash || '') || !Number.isSafeInteger(value.size) || value.size < 0
          || !Number.isInteger(value.mode)) throw new Error('Invalid data import fingerprint');
      }
      if (!record.after) throw new Error('Missing prepared data import file');
      prepared.push(record);
    } else throw new Error('Invalid data import recovery record');
    checkParents(target, record.rel.startsWith('app/') ? options.dataDir : options.home);
  }
  if (committed && prepared.length !== begins.length) throw new Error('Incomplete committed data import record');
  return { directory, header, begins, prepared, committed, options };
}

// Recovery only replaces a file whose bytes still match this transaction. A
// later external edit is preserved and reported for manual recovery.
function rollback(transaction) {
  const { directory, header, prepared, begins, options } = transaction;
  for (const record of [...prepared].reverse()) {
    const target = entryPath(record.rel, options), temp = temporary(target, header.id, record.index);
    const backup = path.join(directory, ...record.rel.split('/'));
    if (matches(target, record.before)) continue;
    if (stat(target) && !matches(target, record.after)) throw new Error('An imported file changed; automatic recovery stopped: ' + target);
    if (record.before) {
      checkParents(backup, directory);
      if (!matches(backup, record.before)) throw new Error('The original import backup is missing or damaged: ' + backup);
      fs.rmSync(temp, { force: true });
      fs.copyFileSync(backup, temp); fs.chmodSync(temp, record.before.mode); flush(temp);
      fs.renameSync(temp, target);
    } else fs.rmSync(target, { force: true });
  }
  for (const record of begins) {
    const target = entryPath(record.rel, options);
    fs.rmSync(temporary(target, header.id, record.index), { force: true });
  }
  completeBackup(transaction, 'rolled-back');
  fs.unlinkSync(path.join(directory, JOURNAL));
}

function recoverDataImports(options) {
  const root = path.join(options.dataDir, 'migration-backups');
  if (!stat(root)) return [];
  checkParents(path.join(root, 'probe'), options.dataDir);
  const recovered = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name), file = path.join(directory, JOURNAL);
    if (!stat(file)) continue;
    const transaction = readTransaction(directory, options);
    if (!transaction.committed) rollback(transaction);
    else { try { completeBackup(transaction, 'committed'); fs.unlinkSync(file); } catch (error) { options.log?.('Committed import journal cleanup pending: ' + error.message); } }
    recovered.push({ backupDir: directory, rolledBack: !transaction.committed });
  }
  return recovered;
}

class ImportTransaction {
  constructor(options) {
    this.options = options; this.directory = options.backupDir; this.id = randomUUID(); this.records = []; this.committed = false;
    this.createdAt = Date.now();
    checkParents(path.join(this.directory, JOURNAL), options.dataDir, true);
    fs.writeFileSync(path.join(this.directory, JOURNAL), JSON.stringify({ version: 1, id: this.id, createdAt: this.createdAt, dataDir: path.resolve(options.dataDir), home: path.resolve(options.home) }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  }
  append(record) { fs.appendFileSync(path.join(this.directory, JOURNAL), JSON.stringify(record) + '\n', { flush: true }); }
  async replace(rel, source) {
    const target = entryPath(rel, this.options), root = rel.startsWith('app/') ? this.options.dataDir : this.options.home;
    checkParents(target, root, true);
    const info = stat(target), index = this.records.length, temp = temporary(target, this.id, index);
    this.append({ type: 'begin', index, rel });
    let before = null;
    if (info) {
      const backup = path.join(this.directory, ...rel.split('/')); checkParents(backup, this.directory, true);
      before = await copy(target, backup, info.mode);
    }
    const after = await copy(source, temp, info?.mode || 0o600);
    const current = stat(target);
    if (Boolean(info) !== Boolean(current) || info && (current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs))
      throw new Error('A profile file changed during import: ' + target);
    const record = { type: 'prepared', index, rel, before, after };
    this.append(record); this.records.push(record);
    await fs.promises.rename(temp, target);
    return { overwritten: Boolean(before), bytes: after.size };
  }
  commit() {
    this.append({ type: 'committed' }); this.committed = true;
    try {
      completeBackup({ directory: this.directory, header: { id: this.id, createdAt: this.createdAt }, begins: this.records }, 'committed');
      fs.unlinkSync(path.join(this.directory, JOURNAL));
      if (!this.records.some(record => record.before)) { fs.rmdirSync(this.directory); try { fs.rmdirSync(path.dirname(this.directory)); } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; } }
    } catch (error) { return 'Import completed; backup journal cleanup is pending: ' + error.message; }
    return null;
  }
  abort(error) {
    try { rollback(readTransaction(this.directory, this.options)); }
    catch (failure) {
      return Object.assign(new AggregateError([error, failure], `Import failed: ${error.message}; automatic rollback failed: ${failure.message}. Backups retained at ${this.directory}`),
        { backupDir: this.directory, recoveryRequired: true, rolledBack: false });
    }
    error.message += '. The original profile was restored.';
    return Object.assign(error, { backupDir: this.directory, rolledBack: true });
  }
}

module.exports = { ImportTransaction, recoverDataImports };
