'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const validSessionId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id)
  && !['__proto__', 'constructor', 'prototype'].includes(id);

class ClaudeHistory {
  constructor(root, fileSystem = fs) {
    this.root = root;
    this.fs = fileSystem;
    this.heads = new Map();
    this.pendingScan = null;
  }

  directories() {
    try { return this.fs.readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(this.root, d.name)); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  }

  list() {
    if (!this.pendingScan) this.pendingScan = this.scan().finally(() => { this.pendingScan = null; });
    return this.pendingScan;
  }

  async scan() {
    const entries = [];
    const present = new Set();
    let directories;
    try { directories = await this.fs.promises.readdir(this.root, { withFileTypes: true }); }
    catch (err) { if (err.code === 'ENOENT') directories = []; else throw err; }
    for (const dir of directories.filter(d => d.isDirectory())) {
      let files;
      try { files = await this.fs.promises.readdir(path.join(this.root, dir.name)); }
      catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      await Promise.all(files.filter(name => name.endsWith('.jsonl') && validSessionId(name.slice(0, -6))).map(async name => {
        const file = path.join(this.root, dir.name, name);
        try {
          const stat = await this.fs.promises.stat(file);
          if (!stat.isFile()) return;
          entries.push({ id: name.slice(0, -6), file, mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs });
          present.add(file);
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }));
    }
    for (const file of this.heads.keys()) if (!present.has(file)) this.heads.delete(file);
    return entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  }

  find(id) {
    if (!validSessionId(id)) return null;
    let newest = null;
    let mtime = -1;
    for (const dir of this.directories()) {
      const file = path.join(dir, id + '.jsonl');
      try {
        const stat = this.fs.statSync(file);
        if (stat.isFile() && stat.mtimeMs > mtime) { newest = file; mtime = stat.mtimeMs; }
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    return newest;
  }

  remove(id) {
    const file = this.find(id);
    if (!file) return false;
    this.fs.unlinkSync(file);
    this.heads.delete(file);
    return true;
  }

  head(file, stat = this.fs.statSync(file)) {
    const key = `${stat.mtimeMs}/${stat.ctimeMs}/${stat.size}`;
    const cached = this.heads.get(file);
    if (cached?.key === key) return cached.value;
    const fd = this.fs.openSync(file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      const length = this.fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, length);
    } finally { this.fs.closeSync(fd); }
    return this.cacheHead(file, key, text);
  }

  async readHead(file, stat) {
    const key = `${stat.mtimeMs}/${stat.ctimeMs}/${stat.size}`;
    const cached = this.heads.get(file);
    if (cached?.key === key) return cached.value;
    const handle = await this.fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return this.cacheHead(file, key, buffer.toString('utf8', 0, bytesRead));
    } finally { await handle.close(); }
  }

  cacheHead(file, key, text) {
    const value = { summary: '', title: '', cwd: '' };
    for (const line of text.split(/\r?\n/)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      if (!value.cwd && typeof row.cwd === 'string') value.cwd = row.cwd;
      if (!value.summary && row.type === 'summary' && typeof row.summary === 'string') value.summary = row.summary;
      if (!value.title && row.type === 'user' && !row.isMeta && row.message?.role === 'user') {
        value.title = messageText(row.message.content).trim();
      }
      if (value.title && value.cwd) break;
    }
    this.heads.set(file, { key, value });
    return value;
  }

  async transcript(id, limit = 200) {
    const file = this.find(id);
    if (!file) throw new Error("Transcript not found. Refresh the session list.");
    const input = this.fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const full = limit === Infinity;
    const messages = full ? [] : new Array(limit);
    let total = 0;
    let cwd = '';
    try {
      for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row !== 'object') continue;
        if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
        const role = row.type;
        if (!['user', 'assistant'].includes(role) || row.isMeta || !row.message) continue;
        if (role === 'user' && row.message.role !== 'user') continue;
        const text = messageText(row.message.content).trim();
        const output = role === 'assistant' && Array.isArray(row.outputBlocks) ? { outputBlocks: row.outputBlocks } : {};
        if ((!text && !output.outputBlocks?.length) || (role === 'user' && /^\s*<system-reminder>/.test(text))) continue;
        if (full) { messages.push({ role, text, ...output }); total++; }
        else messages[total++ % limit] = { role, text: text.slice(0, role === 'user' ? 8000 : 20000), ...output };
      }
    } finally {
      lines.close();
      input.destroy();
    }
    if (full) return { messages, cwd, truncated: false };
    const count = Math.min(total, limit);
    const start = total > limit ? total % limit : 0;
    return { messages: Array.from({ length: count }, (_, i) => messages[(start + i) % limit]), cwd, truncated: total > limit };
  }
}

function messageText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
}

module.exports = { ClaudeHistory, validSessionId };
