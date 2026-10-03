'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJson } = require('../../shared/json-store');
const { UUID, LIMITS, validateDiscussion: validate, admissionBytes, capacityError } = require('./schema');
let lastMessageClock = 0;
function messageStamp(previous = 0) {
  lastMessageClock = Math.max(Date.now(), lastMessageClock + 1, previous + 1);
  return lastMessageClock;
}

function byteLimit(value = LIMITS.recordBytes) {
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.recordBytes) throw new Error('Invalid discussion byte limit');
  return value;
}
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
function fileStat(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit) throw new Error('Invalid or oversized discussion record file');
  return stat;
}
// Bound the allocation AND reads on the open descriptor. lstat alone followed
// by readFileSync would permit growth or replacement between those operations.
function readDiscussionRecord(file, id, { maxRecordBytes = LIMITS.recordBytes } = {}) {
  const limit = byteLimit(maxRecordBytes), before = fileStat(file, limit);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (!unchanged(before, fs.fstatSync(fd))) throw new Error('Discussion record changed while opening');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0, count;
    do {
      count = fs.readSync(fd, buffer, length, buffer.length - length, null); length += count;
    } while (count && length < buffer.length);
    if (length !== before.size || !unchanged(before, fs.fstatSync(fd)) || !unchanged(before, fileStat(file, limit))) {
      throw new Error('Discussion record changed while reading');
    }
    let state;
    try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)).replace(/^\uFEFF/, '')); }
    catch { throw new Error('Cannot read discussion record: Invalid JSON or UTF-8'); }
    return validate(state, id);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function directoryStat(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid discussion directory');
  return stat;
}
function directoryNames(dir) {
  const directory = fs.opendirSync(dir), names = [];
  try {
    let entry;
    while ((entry = directory.readSync())) {
      names.push(entry.name);
      if (names.length > LIMITS.directoryEntries) throw new Error('Too many discussion directory entries');
    }
  } finally { directory.closeSync(); }
  return names;
}

// Missing storage is empty; damaged/unknown records are never silently omitted
// from ownership checks. Bound directory enumeration as well as decoded bytes.
function readInventory(dir, { allowMissing = true, maxRecordBytes = LIMITS.recordBytes } = {}) {
  byteLimit(maxRecordBytes);
  let before;
  try { before = directoryStat(dir); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return { records: [], observed: [], entries: 0 }; throw error; }
  const names = directoryNames(dir), records = [], observed = [], ids = new Set();
  let bytes = 0;
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    const id = name.slice(0, -5);
    if (!UUID.test(id) || ids.has(id.toLowerCase())) throw new Error('Invalid or duplicate discussion record name');
    ids.add(id.toLowerCase());
    if (ids.size > LIMITS.records) throw new Error('Too many discussion records');
    const file = path.join(dir, name), stat = fileStat(file, maxRecordBytes);
    bytes += stat.size;
    if (bytes > LIMITS.inventoryBytes) throw new Error('Discussion inventory exceeds byte limit');
    records.push(readDiscussionRecord(file, id, { maxRecordBytes })); observed.push({ file, stat, id });
  }
  // Directory timestamps can lag behind new entries on Windows. Compare a
  // second bounded enumeration with the snapshot taken before reading files.
  const afterNames = directoryNames(dir), expectedNames = new Set(names);
  if (afterNames.length !== names.length || afterNames.some(name => !expectedNames.has(name))
    || !unchanged(before, directoryStat(dir)) || observed.some(({ file, stat }) => !unchanged(stat, fileStat(file, maxRecordBytes)))) {
    throw new Error('Discussion inventory changed while reading');
  }
  return { records, observed, entries: names.length };
}
function readDiscussionRecords(dir, options) { return readInventory(dir, options).records; }

// Main-process, synchronous single-writer store. The ordered public transcript,
// deliveries and cursors live in one atomic snapshot. Orphan temporary files
// are never replayed. A lower test/embedding bound cannot exceed the hard cap.
class DiscussionStore {
  constructor({ dir, write = writeJson, maxRecordBytes = LIMITS.recordBytes }) {
    this.dir = path.resolve(dir); this.write = write; this.maxRecordBytes = byteLimit(maxRecordBytes);
    fs.mkdirSync(this.dir, { recursive: true }); directoryStat(this.dir);
  }
  file(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid discussion ID');
    return path.join(this.dir, id + '.json');
  }
  read(id) {
    directoryStat(this.dir);
    try { return readDiscussionRecord(this.file(id), id, { maxRecordBytes: this.maxRecordBytes }); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Discussion not found'); throw error; }
  }
  list() { return readDiscussionRecords(this.dir, { allowMissing: false, maxRecordBytes: this.maxRecordBytes }); }
  remove(id) {
    // Validate the exact record before unlinking; never traverse member paths.
    this.read(id);
    fs.unlinkSync(this.file(id));
  }
  checked(state, id, admission) {
    validate(state, id);
    // Match writeJson's exact UTF-8 representation, including pretty-printing
    // and the final newline; do not measure compact JSON or JS string length.
    const bytes = Buffer.byteLength(JSON.stringify(state, null, 2) + '\n', 'utf8');
    if (bytes > this.maxRecordBytes) throw capacityError('Discussion record exceeds byte limit');
    if (admission) {
      const reserved = bytes + admissionBytes(state);
      if (reserved > this.maxRecordBytes) throw capacityError('Discussion has insufficient reserved capacity');
      const inventory = readInventory(this.dir, { allowMissing: false, maxRecordBytes: this.maxRecordBytes });
      const existing = inventory.records.some(record => record.id === id);
      if (inventory.records.length + Number(!existing) > LIMITS.records
        || inventory.entries + Number(!existing) > LIMITS.directoryEntries) throw capacityError('Discussion inventory exceeds record limit');
      let total = reserved;
      for (let index = 0; index < inventory.records.length; index++) {
        const other = inventory.records[index];
        if (other.id !== id) total += inventory.observed[index].stat.size + admissionBytes(other);
      }
      if (total > LIMITS.inventoryBytes) throw capacityError('Discussion inventory has insufficient reserved capacity');
    }
  }
  create(state) {
    const file = this.file(state.id); directoryStat(this.dir);
    if (fs.existsSync(file)) throw new Error('Discussion already exists');
    state.lastMessageAt = messageStamp();
    this.checked(state, state.id, true);
    const result = structuredClone(state);
    this.write(file, state); return result;
  }
  update(id, change, { admission = false } = {}) {
    const state = this.read(id), original = JSON.stringify(state), count = state.messages.length;
    const transcript = JSON.stringify(state.messages), revision = state.revision;
    const identity = JSON.stringify([state.version, state.id, state.threadId, state.cwd]);
    const requests = state.requests.map(r => JSON.stringify([r.id, r.fingerprint, r.messageId, r.mode]));
    const result = change(state);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {}); throw new Error('Discussion updates must be synchronous');
    }
    if (state.messages.length > count) state.lastMessageAt = messageStamp(state.lastMessageAt);
    validate(state, id);
    if (JSON.stringify(state) === original) return structuredClone(result);
    if (state.revision !== revision || JSON.stringify([state.version, state.id, state.threadId, state.cwd]) !== identity
      || JSON.stringify(state.messages.slice(0, count)) !== transcript
      || state.requests.length < requests.length
      || requests.some((value, index) => value !== JSON.stringify([state.requests[index].id, state.requests[index].fingerprint, state.requests[index].messageId, state.requests[index].mode]))) {
      throw new Error('Discussion identity and public history are immutable');
    }
    state.revision++;
    this.checked(state, id, admission);
    // A non-cloneable callback result must fail before committing the snapshot.
    const copy = structuredClone(result);
    this.write(this.file(id), state); return copy;
  }
}

module.exports = { DiscussionStore, readDiscussionRecord, readDiscussionRecords, validateDiscussion: validate };
