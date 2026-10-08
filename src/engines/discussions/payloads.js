'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { UUID, LIMITS } = require('./schema');
const { writeText } = require('../../shared/json-store');
const HASH = /^[0-9a-f]{64}$/;
const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
function directoryStat(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid discussion directory');
  return stat;
}
function fileStat(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit) throw new Error('Invalid or oversized discussion record file');
  return stat;
}
function readBoundedJson(file, limit) {
  const before = fileStat(file, limit);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (!sameStat(before, fs.fstatSync(fd))) throw new Error('Discussion record changed while opening');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0, count;
    do { count = fs.readSync(fd, buffer, length, buffer.length - length, null); length += count; }
    while (count && length < buffer.length);
    if (length !== before.size || !sameStat(before, fs.fstatSync(fd)) || !sameStat(before, fileStat(file, limit)))
      throw new Error('Discussion record changed while reading');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)).replace(/^\uFEFF/, '')); }
    catch { throw new Error('Cannot read discussion record: Invalid JSON or UTF-8'); }
    return { value, stat: before, buffer: buffer.subarray(0, length) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Only schema-defined text fields can be references. Arbitrary tool inputs
// remain ordinary JSON, including objects that happen to contain "$text".
function textFields(state) {
  const fields = [];
  for (const m of state.messages || []) fields.push([m, 'text', 6]);
  for (const r of state.requests || []) fields.push([r, 'fingerprint', 6]);
  for (const d of state.deliveries || []) {
    if (d.inputPlan) fields.push([d.inputPlan, 'prompt', 8]);
    if (d.partialText !== undefined) fields.push([d, 'partialText', 6]);
    if (d.settlement?.text !== undefined) fields.push([d.settlement, 'text', 8]);
    for (const t of d.tools || []) fields.push([t, 'output', 10]);
  }
  return fields;
}
function reference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !HASH.test(value.$text) || !Number.isSafeInteger(value.bytes) || value.bytes < 2 || value.bytes > LIMITS.promptBytes)
    throw new Error('Invalid discussion payload reference');
  return value;
}
function payloadReferences(state) {
  return new Set(textFields(state).filter(([o, k]) => typeof o[k] !== 'string').map(([o, k]) => reference(o[k]).$text));
}
function logicalBytes(state) {
  const copy = { ...state }; delete copy.storageVersion;
  let bytes = Buffer.byteLength(JSON.stringify(copy, null, 2) + '\n');
  for (const [object, key, indent] of textFields(copy)) if (typeof object[key] !== 'string') {
    const ref = reference(object[key]);
    bytes += ref.bytes - Buffer.byteLength(JSON.stringify(ref, null, 2).replace(/\n/g, '\n' + ' '.repeat(indent)));
  }
  return bytes;
}

// Immutable UTF-8 JSON strings preserve escaping and lone surrogates exactly.
// The manifest is committed only after all referenced payloads are durable.
class DiscussionPayloads {
  constructor(dir, { cacheBytes = 8 * 1024 * 1024 } = {}) {
    this.root = path.resolve(dir); this.cacheLimit = cacheBytes; this.cacheBytes = 0;
    this.cache = new Map(); this.known = new WeakMap();
  }
  directory(id, create = false) {
    if (!UUID.test(id)) throw new Error('Invalid discussion ID');
    directoryStat(this.root);
    const dir = path.join(this.root, id + '.payloads');
    if (create) fs.mkdirSync(dir, { recursive: true });
    directoryStat(dir); return dir;
  }
  remember(file, value, stat) {
    const old = this.cache.get(file);
    if (old) { this.cacheBytes -= old.stat.size; this.cache.delete(file); }
    if (stat.size > this.cacheLimit) return;
    this.cache.set(file, { value, stat }); this.cacheBytes += stat.size;
    while (this.cacheBytes > this.cacheLimit) {
      const [key, entry] = this.cache.entries().next().value;
      this.cache.delete(key); this.cacheBytes -= entry.stat.size;
    }
  }
  get(id, ref) {
    reference(ref);
    const file = path.join(this.directory(id), ref.$text + '.text'), stat = fileStat(file, ref.bytes);
    if (stat.size !== ref.bytes) throw new Error('Invalid discussion payload size');
    const cached = this.cache.get(file);
    if (cached && sameStat(stat, cached.stat)) {
      this.cache.delete(file); this.cache.set(file, cached); return cached.value;
    }
    const read = readBoundedJson(file, ref.bytes);
    if (typeof read.value !== 'string' || createHash('sha256').update(read.buffer).digest('hex') !== ref.$text)
      throw new Error('Invalid discussion payload checksum');
    this.remember(file, read.value, read.stat); return read.value;
  }
  decode(id, state, limit) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid discussion records');
    if (state.storageVersion === undefined) return { state, bytes: Buffer.byteLength(JSON.stringify(state, null, 2) + '\n') };
    if (state.storageVersion !== 1) throw new Error('Invalid discussion storage version');
    const bytes = logicalBytes(state);
    if (bytes > limit) throw new Error('Invalid or oversized discussion record file');
    delete state.storageVersion;
    try {
      for (const [object, key] of textFields(state)) if (typeof object[key] !== 'string') {
        const ref = reference(object[key]), value = this.get(id, ref);
        object[key] = value;
        let known = this.known.get(object);
        if (!known) this.known.set(object, known = new Map());
        known.set(key, { value, ref });
      }
    } catch (error) { throw new Error('Invalid discussion payload storage', { cause: error }); }
    return { state, bytes };
  }
  encode(state) {
    // Clone metadata without copying the large strings; no object returned to
    // a caller is changed into a storage reference.
    const encoded = { ...state, storageVersion: 1,
      messages: state.messages.map(m => ({ ...m })), requests: state.requests.map(r => ({ ...r })),
      deliveries: state.deliveries.map(d => ({ ...d, ...(d.inputPlan ? { inputPlan: { ...d.inputPlan } } : {}),
        ...(d.settlement ? { settlement: { ...d.settlement } } : {}), ...(d.tools ? { tools: d.tools.map(t => ({ ...t })) } : {}) })) };
    const source = textFields(state), fields = textFields(encoded), pending = new Map();
    for (let i = 0; i < fields.length; i++) {
      const [object, key] = fields[i], [original] = source[i], value = object[key];
      const known = this.known.get(original)?.get(key);
      if (known?.value === value) { object[key] = known.ref; continue; }
      const data = JSON.stringify(value);
      // Keep small text inline to avoid thousands of tiny allocated files.
      if (Buffer.byteLength(data) < 16 * 1024 || Buffer.byteLength(data) > LIMITS.promptBytes) continue;
      const ref = { $text: createHash('sha256').update(data).digest('hex'), bytes: Buffer.byteLength(data) };
      object[key] = ref; pending.set(ref.$text, { ref, data });
    }
    return { state: encoded, pending, bytes: logicalBytes(encoded) };
  }
  stage(id, pending) {
    const created = [];
    if (!pending.size) return created;
    const dir = this.directory(id, true);
    try {
      for (const { ref, data } of pending.values()) {
        const file = path.join(dir, ref.$text + '.text');
        if (fs.existsSync(file)) this.get(id, ref);
        else { writeText(file, data); created.push(file); }
      }
    } catch (error) {
      // A cleanup failure must not hide the failed durable write. Unreferenced
      // leftovers are reclaimed by startup maintenance of this private folder.
      for (const file of created) { try { fs.unlinkSync(file); } catch { /* retain for maintenance */ } }
      throw error;
    }
    return created;
  }
  drop(id, hashes) {
    if (!hashes.size) return;
    const dir = this.directory(id);
    for (const hash of hashes) {
      if (!HASH.test(hash)) throw new Error('Invalid discussion payload reference');
      const file = path.join(dir, hash + '.text');
      try { fileStat(file, LIMITS.promptBytes); fs.unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const cached = this.cache.get(file);
      if (cached) { this.cache.delete(file); this.cacheBytes -= cached.stat.size; }
    }
  }
  prune(id, refs) {
    let dir;
    try { dir = this.directory(id); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{64}\.text$/.test(name) || refs.has(name.slice(0, -5))) continue;
      const file = path.join(dir, name); fileStat(file, LIMITS.promptBytes); fs.unlinkSync(file);
      const cached = this.cache.get(file);
      if (cached) { this.cache.delete(file); this.cacheBytes -= cached.stat.size; }
    }
    try { fs.rmdirSync(dir); } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error; }
  }
}

module.exports = { DiscussionPayloads, payloadReferences, logicalBytes, fileStat, directoryStat, sameStat, readBoundedJson };
