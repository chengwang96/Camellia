'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../../shared/json-store');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function jobIdentity(value) {
  if (!value || !UUID.test(value.runtimeId) || !UUID.test(value.deliveryId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error('Invalid job supervisor identity');
  return Object.freeze({ runtimeId: value.runtimeId.toLowerCase(), deliveryId: value.deliveryId.toLowerCase(), generation: value.generation });
}

function jobRecordIdentity(record) {
  if (!record || record.version !== 1 || Object.keys(record).sort().join(',') !== 'deliveryId,generation,runtimeId,version') {
    throw new Error('Job launch record is missing or invalid');
  }
  const scope = jobIdentity(record);
  if (Object.entries(scope).some(([key, value]) => record[key] !== value)) throw new Error('Job launch record identity is invalid');
  return scope;
}

// Read-only admission inventory. These identities reserve runtime paths even
// when a crash left no usable discussion snapshot. They are never stop proofs.
function readJobJournalRecords(dir) {
  let names;
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid job journal directory');
    names = fs.readdirSync(dir);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.map(name => {
    const entry = path.join(dir, name), file = path.join(entry, 'record.json');
    if (!fs.lstatSync(entry).isDirectory()) throw new Error('Invalid job journal entry');
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error('Invalid job launch record');
    const identity = jobRecordIdentity(readJson(file, null));
    if (name !== identity.deliveryId || !fs.lstatSync(path.join(entry, 'launch.lock')).isFile()) throw new Error('Invalid job journal identity or lock');
    return identity;
  });
}

// App-owned, append-once launch records. A record or sealed file is NOT a stop
// proof. Recovery must also inspect the OS job while holding the launch lock.
// Do not expose this store or its paths to IPC, or delete it as native cache.
class WindowsJobJournal {
  constructor({ dir }) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Absolute job journal directory required');
    fs.mkdirSync(dir, { recursive: true });
    Object.defineProperty(this, 'dir', { value: fs.realpathSync(dir), enumerable: true });
  }
  paths(identity) {
    const scope = jobIdentity(identity), dir = path.join(this.dir, scope.deliveryId);
    return { scope, dir, recordFile: path.join(dir, 'record.json'), lockFile: path.join(dir, 'launch.lock'), sealFile: path.join(dir, 'sealed') };
  }
  reserve(identity) {
    const value = this.paths(identity);
    // Never replace a previous reservation, including a partial failed write.
    // mkdir is also exclusive across a second app process opening this store.
    fs.mkdirSync(value.dir);
    fs.writeFileSync(value.lockFile, '', { flag: 'wx', mode: 0o600, flush: true });
    fs.writeFileSync(value.recordFile, JSON.stringify({ version: 1, ...value.scope }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    return this.read(identity);
  }
  read(identity) {
    const value = this.paths(identity);
    let info;
    try { info = fs.lstatSync(value.recordFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!info?.isFile() || info.size < 1 || info.size > 4096) throw new Error('Job launch record is missing or invalid');
    const record = readJson(value.recordFile, null);
    const scope = jobRecordIdentity(record);
    if (Object.entries(value.scope).some(([key, field]) => scope[key] !== field)
      || fs.realpathSync(value.dir) !== value.dir || !fs.lstatSync(value.lockFile).isFile()) throw new Error('Job launch record is missing or does not match the delivery');
    // Kernel identity comes from the expected delivery, not a stored arbitrary
    // PID/job name or a persisted stopped flag. Global covers Windows sessions.
    const jobName = `Global\\CamelliaDiscussion-${value.scope.runtimeId}-${value.scope.deliveryId}-${value.scope.generation}`;
    return Object.freeze({ ...value.scope, jobName, lockFile: value.lockFile, sealFile: value.sealFile });
  }
}

module.exports = { WindowsJobJournal, jobIdentity, jobRecordIdentity, readJobJournalRecords };
