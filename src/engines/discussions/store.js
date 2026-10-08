'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJson } = require('../../shared/json-store');
const { UUID, LIMITS, validateDiscussion: validate, admissionBytes, capacityError, replyDigest } = require('./schema');
const { DiscussionPayloads, payloadReferences, fileStat, directoryStat, sameStat: unchanged, readBoundedJson } = require('./payloads');
const { DiscussionDrafts, applyDrafts } = require('./drafts');
const recordInfo = new WeakMap();
let lastMessageClock = 0;
function messageStamp(previous = 0) {
  lastMessageClock = Math.max(Date.now(), lastMessageClock + 1, previous + 1);
  return lastMessageClock;
}

function byteLimit(value = LIMITS.recordBytes) {
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.recordBytes) throw new Error('Invalid discussion byte limit');
  return value;
}
// Bound the allocation AND reads on the open descriptor. lstat alone followed
// by readFileSync would permit growth or replacement between those operations.
function readDiscussionRecord(file, id, { maxRecordBytes = LIMITS.recordBytes, payloads = new DiscussionPayloads(path.dirname(file)), drafts } = {}) {
  const limit = byteLimit(maxRecordBytes), raw = readBoundedJson(file, limit + 64);
  const separated = raw.value?.storageVersion === 1;
  const refs = separated ? payloadReferences(raw.value) : new Set();
  const decoded = payloads.decode(id, raw.value, limit);
  if (decoded.bytes > limit)
    throw new Error('Invalid or oversized discussion record file');
  const state = validate(decoded.state, id);
  const revisionLength = String(state.revision).length;
  const partials = state.deliveries.map(d => [d, d.partialText === undefined ? 0 : Buffer.byteLength(JSON.stringify(d.partialText))]);
  if (drafts) drafts.merge(state); else applyDrafts(path.dirname(file), state);
  let bytes = decoded.bytes + String(state.revision).length - revisionLength;
  for (const [d, previous] of partials) if (d.partialText !== undefined) {
    bytes += Buffer.byteLength(JSON.stringify(d.partialText)) - previous;
    if (!previous) bytes += Buffer.byteLength(',\n      "partialText": ');
  }
  if (bytes > limit) throw new Error('Invalid or oversized discussion record file');
  recordInfo.set(state, { bytes, refs, separated });
  return state;
}

function compactCompleted(state) {
  const messages = new Map(state.messages.map(m => [m.id, m]));
  let changed = false;
  for (const d of state.deliveries) if (d.status === 'completed' && !d.settlement?.resultId) {
    delete d.partialText;
    d.settlement = { status: 'completed', resultId: d.resultId, sha256: replyDigest(messages.get(d.resultId).text) };
    changed = true;
  }
  return changed;
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
function readInventory(dir, { allowMissing = true, maxRecordBytes = LIMITS.recordBytes, payloads = new DiscussionPayloads(dir), drafts } = {}) {
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
    const file = path.join(dir, name), stat = fileStat(file, maxRecordBytes + 64);
    const state = readDiscussionRecord(file, id, { maxRecordBytes, payloads, drafts }), logicalSize = recordInfo.get(state).bytes;
    bytes += logicalSize;
    if (bytes > LIMITS.inventoryBytes) throw new Error('Discussion inventory exceeds byte limit');
    records.push(state); observed.push({ file, stat, id, bytes: logicalSize });
  }
  // Directory timestamps can lag behind new entries on Windows. Compare a
  // second bounded enumeration with the snapshot taken before reading files.
  const afterNames = directoryNames(dir), expectedNames = new Set(names);
  if (afterNames.length !== names.length || afterNames.some(name => !expectedNames.has(name))
    || !unchanged(before, directoryStat(dir)) || observed.some(({ file, stat }) => !unchanged(stat, fileStat(file, maxRecordBytes + 64)))) {
    throw new Error('Discussion inventory changed while reading');
  }
  return { records, observed, entries: names.length };
}
function readDiscussionRecords(dir, options) { return readInventory(dir, options).records; }

// Main-process, synchronous single-writer store. The ordered public transcript,
// deliveries and cursors live in one atomic manifest, pointing to immutable
// large text. Draft checkpoints cannot commit public replies or coverage.
class DiscussionStore {
  constructor({ dir, write = writeJson, maxRecordBytes = LIMITS.recordBytes, onError = () => {}, ...draftOptions }) {
    this.dir = path.resolve(dir); this.write = write; this.maxRecordBytes = byteLimit(maxRecordBytes);
    this.onError = onError; this.payloads = new DiscussionPayloads(this.dir);
    this.drafts = new DiscussionDrafts(this, draftOptions);
    fs.mkdirSync(this.dir, { recursive: true }); directoryStat(this.dir);
  }
  file(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid discussion ID');
    return path.join(this.dir, id + '.json');
  }
  read(id) {
    directoryStat(this.dir);
    try { return readDiscussionRecord(this.file(id), id, { maxRecordBytes: this.maxRecordBytes, payloads: this.payloads, drafts: this.drafts }); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Discussion not found'); throw error; }
  }
  list() { return readDiscussionRecords(this.dir, { allowMissing: false, maxRecordBytes: this.maxRecordBytes, payloads: this.payloads, drafts: this.drafts }); }
  report(error) { try { this.onError(error); } catch { /* diagnostics cannot undo a commit */ } }
  partial(id, deliveryId, generation, text) { return this.drafts.partial(id, deliveryId, generation, text); }
  close() { this.drafts.close(); }
  maintain() {
    for (const state of this.list()) {
      const info = recordInfo.get(state);
      let refs = info.refs;
      try {
        if (compactCompleted(state) || !info.separated) {
          state.revision++;
          const encoded = this.payloads.encode(state);
          this.checked(state, state.id, false, encoded);
          this.commit(state, encoded, refs); refs = payloadReferences(encoded.state);
        }
      } catch (error) { this.report(error); continue; }
      try { this.payloads.prune(state.id, refs); this.drafts.committed(state); }
      catch (error) { this.report(error); }
    }
  }
  remove(id) {
    // Validate the exact record before unlinking; never traverse member paths.
    const state = this.read(id);
    fs.unlinkSync(this.file(id));
    try {
      this.payloads.prune(id, new Set());
      for (const d of state.deliveries) this.drafts.discard(id, d.id);
    } catch (error) { this.report(error); }
  }
  checked(state, id, admission, encoded = this.payloads.encode(state)) {
    validate(state, id);
    // Bound the decoded UTF-8 representation, including JSON escaping and
    // indentation, even when the on-disk manifest uses small references.
    const bytes = encoded.bytes;
    if (bytes > this.maxRecordBytes) throw capacityError('Discussion record exceeds byte limit');
    if (admission) {
      const reserved = bytes + admissionBytes(state);
      if (reserved > this.maxRecordBytes) throw capacityError('Discussion has insufficient reserved capacity');
      const inventory = readInventory(this.dir, { allowMissing: false, maxRecordBytes: this.maxRecordBytes, payloads: this.payloads, drafts: this.drafts });
      const existing = inventory.records.some(record => record.id === id);
      if (inventory.records.length + Number(!existing) > LIMITS.records
        || inventory.entries + Number(!existing) > LIMITS.directoryEntries) throw capacityError('Discussion inventory exceeds record limit');
      let total = reserved;
      for (let index = 0; index < inventory.records.length; index++) {
        const other = inventory.records[index];
        if (other.id !== id) total += inventory.observed[index].bytes + admissionBytes(other);
      }
      if (total > LIMITS.inventoryBytes) throw capacityError('Discussion inventory has insufficient reserved capacity');
    }
  }
  create(state) {
    const file = this.file(state.id); directoryStat(this.dir);
    if (fs.existsSync(file)) throw new Error('Discussion already exists');
    state.lastMessageAt = messageStamp();
    validate(state, state.id);
    const encoded = this.payloads.encode(state);
    this.checked(state, state.id, true, encoded);
    const result = structuredClone(state);
    this.commit(state, encoded); return result;
  }
  commit(state, encoded, previousRefs = new Set()) {
    const created = this.payloads.stage(state.id, encoded.pending), refs = payloadReferences(encoded.state);
    try { this.write(this.file(state.id), encoded.state); }
    catch (error) {
      // A custom writer may report failure after replacing the manifest. Never
      // remove a payload now referenced by that durable result.
      try {
        let retained = new Set();
        try {
          const current = readBoundedJson(this.file(state.id), this.maxRecordBytes + 64).value;
          if (current.storageVersion === 1) retained = payloadReferences(current);
        } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
        this.payloads.drop(state.id, new Set(created.map(f => path.basename(f, '.text')).filter(hash => !retained.has(hash))));
      } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') this.report(cleanupError); }
      throw error;
    }
    try {
      this.payloads.drop(state.id, new Set([...previousRefs].filter(hash => !refs.has(hash))));
      this.drafts.committed(state);
    } catch (error) { this.report(error); }
  }
  update(id, change, { admission = false } = {}) {
    const state = this.read(id), before = this.payloads.encode(state), original = JSON.stringify(before.state), count = state.messages.length;
    const transcript = JSON.stringify(before.state.messages), revision = state.revision;
    const identity = JSON.stringify([state.version, state.id, state.threadId, state.cwd]);
    const requests = before.state.requests.map(r => JSON.stringify([r.id, r.fingerprint, r.messageId, r.mode]));
    const result = change(state);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {}); throw new Error('Discussion updates must be synchronous');
    }
    if (state.messages.length > count) state.lastMessageAt = messageStamp(state.lastMessageAt);
    validate(state, id);
    const encoded = this.payloads.encode(state);
    if (JSON.stringify(encoded.state) === original) return structuredClone(result);
    if (state.revision !== revision || JSON.stringify([state.version, state.id, state.threadId, state.cwd]) !== identity
      || JSON.stringify(encoded.state.messages.slice(0, count)) !== transcript
      || state.requests.length < requests.length
      || requests.some((value, index) => value !== JSON.stringify([encoded.state.requests[index].id, encoded.state.requests[index].fingerprint, encoded.state.requests[index].messageId, encoded.state.requests[index].mode]))) {
      throw new Error('Discussion identity and public history are immutable');
    }
    if (compactCompleted(state)) {
      const compact = this.payloads.encode(state);
      encoded.state = compact.state; encoded.pending = compact.pending; encoded.bytes = compact.bytes;
    }
    state.revision++;
    encoded.state.revision = state.revision;
    encoded.bytes += String(state.revision).length - String(revision).length;
    this.checked(state, id, admission, encoded);
    // A non-cloneable callback result must fail before committing the snapshot.
    const copy = structuredClone(result);
    this.commit(state, encoded, recordInfo.get(state).refs); return copy;
  }
}

module.exports = { DiscussionStore, readDiscussionRecord, readDiscussionRecords, validateDiscussion: validate };
