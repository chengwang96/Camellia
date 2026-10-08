'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DAY = 86400000;
const LOG_BYTES = 10 * 1024 * 1024, LOG_HISTORY = 5, LOG_DAYS = 14;
const MAX_LINE = 64 * 1024, MAX_QUEUE = 1024 * 1024, FATAL_BYTES = 256 * 1024;
const historyName = /^(dsh-desktop(?:-fatal)?)\.(\d{13})\.([a-f0-9-]{36})\.log$/;

function logFiles(directory, { now = Date.now(), maxHistory = LOG_HISTORY, maxDays = LOG_DAYS, maxBytes = LOG_BYTES, io = fs } = {}) {
  let names;
  try { names = io.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const groups = new Map();
  for (const name of names) {
    const match = name.match(historyName); if (!match) continue;
    const file = path.join(directory, name);
    let stat; try { stat = io.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink()) continue;
    const entries = groups.get(match[1]) || []; entries.push({ file, stat, time: Number(match[2]) }); groups.set(match[1], entries);
  }
  return [...groups.values()].flatMap(entries => entries.sort((a, b) => b.time - a.time || b.file.localeCompare(a.file))
    .filter((entry, index) => index >= maxHistory || entry.time < now - maxDays * DAY || entry.stat.size > (path.basename(entry.file).startsWith('dsh-desktop-fatal.') ? FATAL_BYTES : maxBytes)));
}

function line(message, now, limit = MAX_LINE) {
  const source = `[${new Date(now).toISOString()}] ${message}\n`;
  const text = Buffer.from(source.slice(0, limit));
  if (source.length <= limit && text.length <= limit) return text;
  const suffix = Buffer.from('... [log entry truncated]\n');
  if (limit <= suffix.length) return suffix.subarray(0, limit);
  return Buffer.concat([text.subarray(0, Math.max(0, limit - suffix.length)), suffix]);
}

// One outstanding stream write and a bounded pending queue. Rename only after
// the stream has closed, including on Windows. Crash output uses a separate,
// synchronously bounded file so process exit cannot discard its last record.
class RotatingLog {
  constructor({ directory, io = fs, now = Date.now, maxBytes = LOG_BYTES, maxHistory = LOG_HISTORY,
    maxDays = LOG_DAYS, queueBytes = MAX_QUEUE, lineBytes = MAX_LINE, onError = () => {} }) {
    Object.assign(this, { directory, io, now, maxBytes, maxHistory, maxDays, queueBytes, lineBytes, onError });
    this.file = path.join(directory, 'dsh-desktop.log');
    this.queue = []; this.pendingBytes = 0; this.dropped = 0; this.closed = false; this.running = null;
  }
  write(message) {
    if (this.closed) return;
    const data = line(message, this.now(), Math.min(this.lineBytes, this.maxBytes));
    if (this.pendingBytes + data.length > this.queueBytes) { this.dropped++; return; }
    this.queue.push(data); this.pendingBytes += data.length;
    this.start();
  }
  start() {
    this.running ||= this.pump().finally(() => {
      this.running = null;
      if (this.queue.length || this.dropped) this.start();
    });
  }
  safeFile(file) {
    const directory = this.io.lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Linked log directory');
    try {
      const stat = this.io.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Linked or invalid log file');
      return stat;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  prune() {
    this.safeFile(this.file);
    for (const entry of logFiles(this.directory, { now: this.now(), maxHistory: this.maxHistory, maxDays: this.maxDays, maxBytes: this.maxBytes, io: this.io })) {
      const stat = this.safeFile(entry.file);
      if (stat?.ino === entry.stat.ino && stat.size === entry.stat.size && stat.mtimeMs === entry.stat.mtimeMs && stat.ctimeMs === entry.stat.ctimeMs)
        this.io.unlinkSync(entry.file);
    }
  }
  archive(file, time) { this.io.renameSync(file, path.join(this.directory, path.basename(file, '.log') + '.' + Math.floor(time) + '.' + randomUUID() + '.log')); }
  async endStream() {
    const stream = this.stream; this.stream = null;
    if (!stream || stream.closed) return;
    await new Promise(resolve => { stream.once('close', resolve); stream.end(); });
  }
  async pump() {
    try {
      this.io.mkdirSync(this.directory, { recursive: true });
      this.prune();
      while (this.queue.length || this.dropped) {
        let data;
        if (this.dropped) { data = line(`Dropped ${this.dropped} diagnostic log entries while the write queue was full`, this.now(), Math.min(this.lineBytes, this.maxBytes)); this.dropped = 0; }
        else { data = this.queue.shift(); this.pendingBytes -= data.length; }
        if (!this.stream) {
          const stat = this.safeFile(this.file);
          this.size = stat?.size || 0; this.day = new Date(stat?.mtimeMs || this.now()).toISOString().slice(0, 10);
        }
        const today = new Date(this.now()).toISOString().slice(0, 10);
        if (this.size && (this.size + data.length > this.maxBytes || today !== this.day)) {
          await this.endStream();
          const stat = this.safeFile(this.file); if (stat) this.archive(this.file, stat.mtimeMs);
          this.size = 0; this.day = today; this.prune();
        }
        if (!this.stream) {
          this.stream = this.io.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
          this.stream.on('error', error => { this.streamError = error; });
        }
        if (this.streamError) throw this.streamError;
        await new Promise((resolve, reject) => this.stream.write(data, error => error ? reject(error) : resolve()));
        this.size += data.length;
      }
    } catch (error) {
      this.queue = []; this.pendingBytes = 0; this.dropped = 0; this.onError(error);
      await this.endStream(); this.streamError = null;
    }
  }
  fatal(message) {
    try {
      this.io.mkdirSync(this.directory, { recursive: true });
      const file = path.join(this.directory, 'dsh-desktop-fatal.log'), data = line(message, this.now(), Math.min(this.lineBytes, FATAL_BYTES));
      const stat = this.safeFile(file), limit = FATAL_BYTES;
      if (stat && (stat.size + data.length > limit || new Date(stat.mtimeMs).toISOString().slice(0, 10) !== new Date(this.now()).toISOString().slice(0, 10))) this.archive(file, stat.mtimeMs);
      this.io.appendFileSync(file, data, { mode: 0o600 }); this.prune();
      return true;
    } catch (error) { this.onError(error); return false; }
  }
  async close() { this.closed = true; while (this.running) await this.running; await this.endStream(); }
}

module.exports = { RotatingLog, logFiles, LOG_BYTES, LOG_HISTORY, LOG_DAYS };
