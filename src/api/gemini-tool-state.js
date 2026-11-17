'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CACHE_BYTES = 2 * 1024 * 1024, STORE_BYTES = 128 * 1024 * 1024;
const RECORD_BYTES = 16 * 1024 * 1024;
// Import old journals one bounded record at a time. A failed import leaves the
// original intact and rolls back the database transaction.
function legacyEntries(file, consume) {
  const fd = fs.openSync(file, 'r'), chunk = Buffer.alloc(64 * 1024);
  let parts = [], bytes = 0, position = 0;
  const line = () => {
    if (bytes) consume(JSON.parse(Buffer.concat(parts, bytes).toString('utf8')));
    parts = []; bytes = 0;
  };
  const add = buffer => {
    bytes += buffer.length;
    if (bytes > RECORD_BYTES) throw new Error('Gemini tool history contains an oversized record; the original journal was preserved');
    parts.push(Buffer.from(buffer));
  };
  try {
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, position)); position += n) {
      let from = 0, end;
      while ((end = chunk.indexOf(10, from)) >= 0 && end < n) {
        add(chunk.subarray(from, end)); line(); from = end + 1;
      }
      if (from < n) add(chunk.subarray(from, n));
    }
    line();
  } finally { fs.closeSync(fd); }
}

// Some harnesses retain standard tool IDs but discard provider-specific fields.
// Keep Google's opaque thought signatures with those IDs, including on resume.
class GeminiToolState {
  constructor(file, { cacheBytes = CACHE_BYTES, storeBytes = STORE_BYTES } = {}) {
    this.file = file; this.databaseFile = file + '.sqlite';
    this.signatures = new Map(); this.cacheBytes = 0; this.cacheLimit = cacheBytes; this.storeLimit = storeBytes;
  }

  open() {
    if (this.closed) throw new Error('Gemini tool history is closed');
    if (this.db) return;
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try { fs.closeSync(fs.openSync(this.databaseFile, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = fs.lstatSync(this.databaseFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Gemini tool history database is not a regular private file');
    const db = new DatabaseSync(this.databaseFile);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA cache_size=-1024; '
        + 'CREATE TABLE IF NOT EXISTS signatures (model TEXT NOT NULL, id TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(model,id)) WITHOUT ROWID');
      const save = db.prepare('INSERT INTO signatures VALUES (?,?,?) ON CONFLICT(model,id) DO UPDATE SET signature=excluded.signature');
      let legacy;
      try { legacy = fs.lstatSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (legacy) {
        if (!legacy.isFile() || legacy.isSymbolicLink() || legacy.nlink !== 1) throw new Error('Gemini tool history journal is not a regular private file');
        db.exec('BEGIN IMMEDIATE');
        try {
          legacyEntries(this.file, entry => {
            if (typeof entry.model !== 'string' || typeof entry.id !== 'string' || typeof entry.signature !== 'string')
              throw new Error('Invalid Gemini tool history record; the original journal was preserved');
            save.run(entry.model, entry.id, entry.signature);
          });
          const after = fs.lstatSync(this.file);
          if (after.dev !== legacy.dev || after.ino !== legacy.ino || after.size !== legacy.size || after.mtimeMs !== legacy.mtimeMs)
            throw new Error('Gemini tool history changed during import; the original journal was preserved');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        // The complete transaction is durable before retiring the append-only
        // source. Re-importing after a failed unlink is idempotent.
        fs.unlinkSync(this.file);
      }
      const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
      const pages = Number(db.prepare('PRAGMA page_count').get().page_count);
      // Existing histories may exceed today's budget. Keep them readable and
      // stop growth at their current footprint rather than dropping signatures.
      const maxPages = Math.max(pages, Math.floor(this.storeLimit / pageSize));
      db.exec('PRAGMA max_page_count=' + maxPages);
      this.read = db.prepare('SELECT signature FROM signatures WHERE model=? AND id=?');
      this.save = save; this.db = db;
    } catch (error) { db.close(); throw error; }
  }

  cache(key, signature) {
    const previous = this.signatures.get(key);
    if (previous !== undefined) { this.cacheBytes -= Buffer.byteLength(key + previous) * 2 + 128; this.signatures.delete(key); }
    const bytes = Buffer.byteLength(key + signature) * 2 + 128;
    if (bytes <= this.cacheLimit) {
      this.signatures.set(key, signature); this.cacheBytes += bytes;
    }
    while (this.cacheBytes > this.cacheLimit) {
      const [oldKey, value] = this.signatures.entries().next().value;
      this.signatures.delete(oldKey); this.cacheBytes -= Buffer.byteLength(oldKey + value) * 2 + 128;
    }
  }

  get(model, id) {
    const key = JSON.stringify([model, id]), cached = this.signatures.get(key);
    if (cached !== undefined) { this.cache(key, cached); return cached; }
    this.open();
    const signature = this.read.get(model, id)?.signature;
    if (signature !== undefined) this.cache(key, signature);
    return signature;
  }

  remember(model, id, signature) {
    if (Buffer.byteLength(signature) > RECORD_BYTES / 2) throw new Error('Gemini tool signature is too large to persist safely');
    if (this.get(model, id) === signature) return;
    try { this.save.run(model, id, signature); }
    catch (error) {
      if (error.errcode === 13 || /database or disk is full/i.test(error.message))
        throw Object.assign(new Error('Gemini tool history storage is full; existing signatures are preserved. Free disk space or use another provider.'), { code: 'GEMINI_TOOL_STATE_FULL' });
      throw error;
    }
    this.cache(JSON.stringify([model, id]), signature);
  }

  close() {
    this.db?.close(); this.db = null; this.read = null; this.save = null;
    this.signatures.clear(); this.cacheBytes = 0; this.closed = true;
  }

  restore(body, model) {
    for (const message of body.messages || []) for (const tool of message.tool_calls || []) {
      const signature = tool.extra_content?.google?.thought_signature || (typeof tool.id === 'string' ? this.get(model, tool.id) : undefined);
      if (signature) tool.extra_content = { ...tool.extra_content, google: { ...tool.extra_content?.google, thought_signature: signature } };
    }
    // Claude's generic thinking flag is not a Gemini Chat Completions option.
    delete body.thinking;
    if (['max', 'xhigh', 'ultra'].includes(body.reasoning_effort)) body.reasoning_effort = 'high';
    return body;
  }

  response(model) {
    const calls = new Map();
    return body => {
      if (!body || typeof body !== 'object') return;
      for (const choice of body.choices || []) {
        const message = choice.message || choice.delta;
        for (const [offset, tool] of (message?.tool_calls || []).entries()) {
          const index = (choice.index || 0) + '/' + (tool.index ?? offset);
          let id = calls.get(index);
          if (!id) { id = 'call_' + randomUUID().replaceAll('-', ''); calls.set(index, id); }
          // Supply the stable ID even if Google sends the signature in a later frame.
          if (tool.id || choice.message) tool.id = id;
          const signature = tool.extra_content?.google?.thought_signature;
          if (signature) this.remember(model, id, signature);
        }
      }
    };
  }
}

module.exports = { GeminiToolState };
