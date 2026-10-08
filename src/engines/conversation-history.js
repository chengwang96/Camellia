'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');

// The JSONL remains authoritative. This disposable index contains offsets and
// cumulative statistics, never message bodies. Fixed-size records allow paging
// without loading an entire conversation's index into the heap.
const HEADER = 4096, RECORD = 80, BLOCK = RECORD * 512, READ = 128 * 1024;
const VERSION = 1;
const FLAGS = { public: 1, visible: 2, remote: 4, user: 8, summary: 16, preview: 32, sequence: 64 };
const signature = stat => stat ? [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') : 'missing';
const tokens = text => {
  const value = String(text || '');
  let dense = 0;
  for (const char of value) if (char.codePointAt(0) > 127) dense++;
  return (value.length - dense) / 3 + dense;
};
const contextRow = row => !(row.role === 'assistant' && !row.runResult && /^Context recovery failed: /u.test(String(row.text || '')))
  && !(row.runResult && (!row.text || row.text === row.runResult.result));
function stat(file) { try { return fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function checksum(buffer, offset = 0) {
  let hash = 2166136261;
  for (let i = 0; i < RECORD; i += 4) if (i !== 60) hash = Math.imul(hash ^ buffer.readUInt32LE(offset + i), 16777619);
  return hash >>> 0;
}
function readAt(fd, size, offset) {
  const buffer = Buffer.alloc(size);
  for (let used = 0; used < size;) {
    const n = fs.readSync(fd, buffer, used, size - used, offset + used);
    if (!n) throw new Error('Conversation history changed while reading');
    used += n;
  }
  return buffer;
}
function writeAt(fd, buffer, offset) {
  for (let used = 0; used < buffer.length;) {
    const n = fs.writeSync(fd, buffer, used, buffer.length - used, offset + used);
    if (!n) throw new Error('Could not write the conversation history index');
    used += n;
  }
}
function unpack(buffer, offset = 0) {
  return { offset: buffer.readDoubleLE(offset), length: buffer.readDoubleLE(offset + 8), seq: buffer.readDoubleLE(offset + 16),
    total: buffer.readDoubleLE(offset + 24), userSeq: buffer.readDoubleLE(offset + 32), userAt: buffer.readDoubleLE(offset + 40),
    maxSeq: buffer.readDoubleLE(offset + 48), flags: buffer.readUInt32LE(offset + 56), cost: buffer.readDoubleLE(offset + 64), summaryIndex: buffer.readDoubleLE(offset + 72) };
}

class ConversationHistory {
  constructor(dir, { cacheBytes = 16 * 1024 * 1024, onCacheError = () => {} } = {}) {
    this.dir = path.resolve(dir); this.indexDir = path.join(this.dir, '.history-index');
    this.limit = cacheBytes; this.used = 0; this.cache = new Map(); this.temporary = new Set(); this.tempById = new Map(); this.onCacheError = onCacheError;
    this.metrics = { historyBytes: 0, indexBytes: 0, parsedRows: 0, rebuilds: 0, appends: 0 };
  }
  file(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid conversation ID');
    return path.join(this.dir, id + '.jsonl');
  }
  index(id) { this.file(id); return path.join(this.indexDir, id + '.idx'); }
  checkIndex(file, parentOnly = false) {
    const parent = fs.lstatSync(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw Object.assign(new Error('History cache directory is unavailable'), { code: 'EACCES' });
    if (!parentOnly) {
      const entry = fs.lstatSync(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
        throw Object.assign(new Error('History cache file is unavailable'), { code: 'EACCES' });
    }
  }
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key); this.cache.set(key, entry); return entry.value;
  }
  put(key, value, bytes) {
    this.drop(key);
    if (bytes > this.limit) return value;
    this.cache.set(key, { value, bytes }); this.used += bytes;
    while (this.used > this.limit) this.drop(this.cache.keys().next().value);
    return value;
  }
  drop(key) { const entry = this.cache.get(key); if (entry) { this.used -= entry.bytes; this.cache.delete(key); } }
  forget(id) {
    for (const key of this.cache.keys()) if (key.startsWith(id + ':')) this.drop(key);
  }
  empty(id, source) {
    return { version: VERSION, id, generation: randomUUID(), source: signature(source), size: source?.size || 0, count: 0, total: 0,
      userSeq: 0, userAt: 0, maxSeq: 0, lastSeq: 0, lastSummary: -1, ordered: true, tail: null, repaired: false };
  }
  header(fd, value) {
    const { index, indexStamp, ...saved } = value;
    const text = Buffer.from(JSON.stringify({ ...saved, checksum: digest(saved) }));
    if (text.length >= HEADER) throw new Error('Conversation index header is too large');
    const buffer = Buffer.alloc(HEADER); text.copy(buffer); writeAt(fd, buffer, 0);
  }
  ensure(id) {
    const source = stat(this.file(id)), stamp = signature(source);
    const cached = this.get(id + ':meta');
    if (cached?.source === stamp && (!cached.count || signature(stat(cached.index)) === cached.indexStamp)) return cached;
    if (cached) this.forget(id);
    if (!source?.size) return this.put(id + ':meta', { ...this.empty(id, source), index: this.index(id) }, HEADER);
    const index = this.index(id);
    try {
      this.checkIndex(index);
      const fd = fs.openSync(index, 'r');
      let value, indexStamp;
      try { const buffer = readAt(fd, HEADER, 0); this.metrics.indexBytes += HEADER;
        const parsed = JSON.parse(buffer.subarray(0, buffer.indexOf(0)).toString('utf8'));
        const { checksum: expected, ...saved } = parsed; value = saved;
        if (expected !== digest(saved)) throw new Error('Invalid index header checksum');
        const info = fs.fstatSync(fd); indexStamp = signature(info);
        if (info.size !== HEADER + value.count * RECORD) throw new Error('Invalid index size');
      } finally { fs.closeSync(fd); }
      if (value.version === VERSION && value.id === id && value.source === stamp && Number.isSafeInteger(value.count) && value.count >= 0)
        return this.put(id + ':meta', { ...value, index, indexStamp }, HEADER);
    } catch (error) { if (!['ENOENT'].includes(error.code)) this.report(error); }
    return this.rebuild(id);
  }
  report(error) { try { this.onCacheError(error); } catch {} }
  // Only an unterminated invalid tail is repairable. An invalid complete line
  // remains an error, and the original torn file is retained before truncation.
  scan(id, consume, start = 0) {
    const file = this.file(id), before = stat(file);
    if (!before) return { source: null, tail: null, repaired: false };
    const fd = fs.openSync(file, 'r'), chunk = Buffer.alloc(READ);
    let position = start, lineStart = start, parts = [], length = 0, tail = null, repaired = false;
    const line = (end, complete) => {
      if (!length) { parts = []; return; }
      const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
      let row;
      try { row = JSON.parse(buffer.toString('utf8')); this.metrics.parsedRows++; }
      catch (error) {
        if (complete) throw Object.assign(new Error('Conversation history is damaged: ' + id), { historyDamage: true });
        // Check the opened file and pathname still describe the same source.
        if (signature(fs.fstatSync(fd)) !== signature(before) || signature(stat(file)) !== signature(before))
          throw new Error('Conversation history changed while reading');
        fs.copyFileSync(file, file + '.torn-' + Date.now()); fs.truncateSync(file, lineStart); repaired = true;
        return;
      }
      consume(row, lineStart, end - lineStart);
      if (!complete) tail = lineStart;
      parts = []; length = 0;
    };
    try {
      while (position < before.size) {
        const n = fs.readSync(fd, chunk, 0, Math.min(READ, before.size - position), position);
        if (!n) throw new Error('Conversation history changed while reading');
        this.metrics.historyBytes += n;
        let from = 0, end;
        while ((end = chunk.indexOf(10, from)) !== -1 && end < n) {
          if (end > from) { parts.push(Buffer.from(chunk.subarray(from, end))); length += end - from; }
          line(position + end, true); lineStart = position + end + 1; from = end + 1;
        }
        if (from < n) { parts.push(Buffer.from(chunk.subarray(from, n))); length += n - from; }
        position += n;
      }
      if (length) line(position, false);
      const after = stat(file);
      if (!repaired && signature(after) !== signature(before)) throw new Error('Conversation history changed while reading');
      return { source: after, tail, repaired };
    } finally { fs.closeSync(fd); }
  }
  add(fd, value, original, offset, length) {
    if (original == null) throw Object.assign(new Error('Conversation history is damaged: ' + value.id), { historyDamage: true });
    const row = { ...original }; delete row.previousAttempt;
    if (row.role === 'revision') {
      let found = -1;
      const read = i => {
        const buffer = readAt(fd, RECORD, HEADER + i * RECORD);
        if (checksum(buffer) !== buffer.readUInt32LE(60)) throw new Error('Invalid conversation index record');
        return unpack(buffer);
      };
      if (value.ordered && Number.isFinite(row.replacesSeq)) {
        let left = 0, right = value.count;
        while (left < right) { const mid = (left + right) >>> 1;
          if (read(mid).seq < row.replacesSeq) left = mid + 1; else right = mid; }
        if (left < value.count) { const record = read(left); if (record.flags & FLAGS.user && record.seq === row.replacesSeq) found = left; }
      } else for (let i = 0; i < value.count; i++) {
        const record = read(i);
        if (record.flags & FLAGS.user && record.seq === row.replacesSeq) { found = i; break; }
      }
      if (found < 0) throw Object.assign(new Error('Conversation revision target is missing: ' + value.id), { historyDamage: true });
      value.count = found; row.role = 'user';
      const previous = found ? read(found - 1) : null;
      Object.assign(value, { total: previous?.total || 0, userSeq: previous?.userSeq || 0, userAt: previous?.userAt || 0,
        maxSeq: previous?.maxSeq || 0, lastSeq: previous?.seq || 0, lastSummary: previous?.summaryIndex ?? -1 });
    }
    const seq = Number.isFinite(row.seq) ? row.seq : 0;
    if (!Number.isFinite(row.seq) || value.count && seq <= value.lastSeq) value.ordered = false;
    let flags = Number.isFinite(row.seq) ? FLAGS.sequence : 0;
    if (row.role === 'user') flags |= FLAGS.user;
    if (!row.internal) {
      flags |= FLAGS.public;
      if (['user', 'assistant', 'notice'].includes(row.role)) flags |= FLAGS.visible;
      if (['user', 'assistant', 'notice', 'tool'].includes(row.role)) flags |= FLAGS.remote;
      if (row.role === 'user') { value.userSeq = Math.max(value.userSeq, seq); value.userAt = Math.max(value.userAt, Number(row.at) || 0); }
      if (row.role === 'notice' && row.file) { flags |= FLAGS.summary; value.lastSummary = value.count; }
      if (row.role === 'user' && row.attachments?.length || row.role === 'assistant' && row.artifacts?.length) flags |= FLAGS.preview;
    }
    const cost = seq > 0 && !row.internal && contextRow(row) ? tokens(row.text) + 200 / 3 : 0;
    value.total += cost; value.maxSeq = Math.max(value.maxSeq, seq); value.lastSeq = seq;
    const buffer = Buffer.alloc(RECORD);
    [offset, length, seq, value.total, value.userSeq, value.userAt, value.maxSeq].forEach((n, i) => buffer.writeDoubleLE(n, i * 8));
    buffer.writeUInt32LE(flags, 56); buffer.writeDoubleLE(cost, 64);
    buffer.writeDoubleLE(value.lastSummary, 72);
    buffer.writeUInt32LE(checksum(buffer), 60);
    writeAt(fd, buffer, HEADER + value.count++ * RECORD);
  }
  rebuild(id, temporary = false) {
    this.forget(id); this.metrics.rebuilds++;
    const target = temporary ? path.join(os.tmpdir(), 'camellia-history-index-' + randomUUID()) : this.index(id);
    const pending = target + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true }); this.checkIndex(target, true); fd = fs.openSync(pending, 'wx+', 0o600);
      const value = this.empty(id, stat(this.file(id)));
      const scanned = this.scan(id, (row, offset, length) => this.add(fd, value, row, offset, length));
      value.source = signature(scanned.source); value.size = scanned.source?.size || 0;
      value.tail = scanned.tail; value.repaired = scanned.repaired;
      fs.ftruncateSync(fd, HEADER + value.count * RECORD); this.header(fd, value); fs.closeSync(fd); fd = undefined;
      fs.renameSync(pending, target);
      const old = this.tempById.get(id);
      if (old) { try { fs.unlinkSync(old); } catch {} this.temporary.delete(old); this.tempById.delete(id); }
      if (temporary) { this.temporary.add(target); this.tempById.set(id, target); }
      return this.put(id + ':meta', { ...value, index: target, indexStamp: signature(stat(target)) }, HEADER);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(pending); } catch {}
      if (!temporary && !error.historyDamage && ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(error.code)) {
        this.report(error); return this.rebuild(id, true);
      }
      throw error;
    }
  }
  append(id, row) {
    const value = this.ensure(id), file = this.file(id), before = stat(file);
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    this.metrics.appends++;
    // Index writes are disposable; their failure cannot turn an already saved
    // user message or reply into a failed conversation commit.
    try {
      if (value.tail !== null || signature(before) !== value.source) { this.rebuild(id); return; }
      if (!stat(value.index)) { this.rebuild(id); return; }
      this.checkIndex(value.index);
      const fd = fs.openSync(value.index, 'r+');
      const previousCount = value.count;
      try {
        const length = Buffer.byteLength(JSON.stringify(row));
        this.add(fd, value, row, before?.size || 0, length);
        if (row.role === 'revision') { this.forget(id); value.generation = randomUUID(); }
        const source = stat(file); value.source = signature(source); value.size = source.size;
        fs.ftruncateSync(fd, HEADER + value.count * RECORD); this.header(fd, value);
        value.indexStamp = signature(fs.fstatSync(fd));
      } finally { fs.closeSync(fd); }
      const changedBlock = Math.floor(Math.min(previousCount, value.count - 1) / 512);
      for (const key of this.cache.keys()) if (key.startsWith(id + ':index:') && Number(key.split(':').at(-1)) >= changedBlock) this.drop(key);
      this.put(id + ':meta', value, HEADER);
    } catch (error) { this.forget(id); this.report(error); }
  }
  record(value, i, rebuilt = false) {
    const block = Math.floor(i / 512), key = value.id + ':index:' + value.generation + ':' + block;
    let buffer = this.get(key);
    if (!buffer) {
      const fd = fs.openSync(value.index, 'r');
      try { buffer = readAt(fd, Math.min(BLOCK, (value.count - block * 512) * RECORD), HEADER + block * BLOCK); }
      finally { fs.closeSync(fd); }
      this.metrics.indexBytes += buffer.length; this.put(key, buffer, buffer.length);
    }
    const offset = (i % 512) * RECORD;
    if (checksum(buffer, offset) !== buffer.readUInt32LE(offset + 60)) {
      if (rebuilt) throw new Error('Invalid conversation index record');
      Object.assign(value, this.rebuild(value.id)); return this.record(value, i, true);
    }
    return unpack(buffer, offset);
  }
  row(value, record) {
    const key = value.id + ':row:' + value.generation + ':' + record.offset;
    let row = this.get(key);
    if (!row) {
      const fd = fs.openSync(this.file(value.id), 'r');
      let buffer;
      try {
        if (signature(fs.fstatSync(fd)) !== value.source) throw new Error('Conversation history changed while reading');
        buffer = readAt(fd, record.length, record.offset);
        if (signature(fs.fstatSync(fd)) !== value.source) throw new Error('Conversation history changed while reading');
      } finally { fs.closeSync(fd); }
      this.metrics.historyBytes += buffer.length; this.metrics.parsedRows++;
      row = JSON.parse(buffer.toString('utf8')); delete row.previousAttempt;
      if (row.role === 'revision') row.role = 'user';
      // Charge conservatively for decoded strings, object overhead and clones
      // retained in the cache. Oversized individual rows are read on demand.
      this.put(key, row, buffer.length * 3 + 512);
    }
    return structuredClone(row);
  }
  *iterate(id, { after = -Infinity, before = Infinity, mask = 0, reverse = false } = {}) {
    const value = this.ensure(id);
    let low = 0, high = value.count;
    if (value.ordered) {
      const boundary = (seq, inclusive) => {
        let left = 0, right = value.count;
        while (left < right) { const mid = Math.floor((left + right) / 2), n = this.record(value, mid).seq;
          if (inclusive ? n <= seq : n < seq) left = mid + 1; else right = mid; }
        return left;
      };
      if (Number.isFinite(after)) low = boundary(after, true);
      if (Number.isFinite(before)) high = boundary(before, false);
    }
    for (let i = reverse ? high - 1 : low; reverse ? i >= low : i < high; i += reverse ? -1 : 1) {
      const record = this.record(value, i);
      if ((!mask || record.flags & mask) && (record.flags & FLAGS.sequence || after === -Infinity && before === Infinity)
        && record.seq > after && record.seq < before) yield this.row(value, record);
    }
  }
  rows(id, options) { return [...this.iterate(id, options)]; }
  projection(id, key, build) {
    const info = this.ensure(id), name = id + ':projection:' + info.source + ':' + key;
    let result = this.get(name);
    if (result === undefined) {
      result = build(); this.put(name, result, Buffer.byteLength(JSON.stringify(result)) * 3 + 1024);
    }
    return structuredClone(result);
  }
  page(id, { before = Infinity, limit = 200, mask = FLAGS.visible } = {}) {
    const rows = [];
    for (const row of this.iterate(id, { before, mask, reverse: true })) {
      if (rows.length === limit) { const nextBefore = rows[rows.length - 1]?.seq ?? null; return { rows: rows.reverse(), nextBefore }; }
      rows.push(row);
    }
    return { rows: rows.reverse(), nextBefore: null };
  }
  summary(id, before = Infinity, contextOnly = false) {
    const value = this.ensure(id);
    for (let i = value.lastSummary; i >= 0;) {
      const record = this.record(value, i);
      if (record.seq < before && (record.flags & FLAGS.sequence || before === Infinity)) {
        const row = this.row(value, record);
        if (fs.existsSync(row.file) && (!contextOnly || contextRow(row))) return row;
      }
      i = i ? this.record(value, i - 1).summaryIndex : -1;
    }
    return null;
  }
  estimate(id) {
    const value = this.ensure(id), summary = this.summary(id, Infinity, true);
    if (!summary) return value.total;
    let remaining = 0;
    if (value.ordered) {
      let left = 0, right = value.count;
      while (left < right) { const mid = (left + right) >>> 1;
        if (this.record(value, mid).seq <= summary.seq) left = mid + 1; else right = mid; }
      remaining = value.total - (left ? this.record(value, left - 1).total : 0);
    } else for (let i = 0; i < value.count; i++) { const r = this.record(value, i); if (r.seq > summary.seq) remaining += r.cost; }
    const source = stat(summary.file), key = id + ':summary:' + summary.file + ':' + signature(source);
    let cost = this.get(key);
    if (cost === undefined) { const text = fs.readFileSync(summary.file, 'utf8'); cost = tokens(text); this.put(key, cost, 256); }
    return cost + remaining;
  }
  remove(id) {
    this.forget(id);
    const temporary = this.tempById.get(id);
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} this.temporary.delete(temporary); this.tempById.delete(id); }
    try { fs.unlinkSync(this.index(id)); } catch (error) { if (error.code !== 'ENOENT') this.report(error); }
  }
  close() {
    for (const file of this.temporary) { try { fs.unlinkSync(file); } catch {} }
    this.temporary.clear(); this.tempById.clear(); this.cache.clear(); this.used = 0;
  }
}

module.exports = { ConversationHistory, FLAGS, contextRow, tokens };
