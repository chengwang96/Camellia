'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validSessionId } = require('../engines/claude-history');

const PROTECTION_MS = 24 * 60 * 60 * 1000;
const MAX_READ_BYTES = 256 * 1024 * 1024;
const normalize = value => {
  const text = String(value).replace(/\\+/g, '/');
  return process.platform === 'win32' ? text.toLowerCase() : text;
};

class StorageCleanup {
  constructor({ dataDir, histories = [], conversations, references, liveOwners = () => [], now = Date.now }) {
    Object.assign(this, { dataDir: path.resolve(dataDir), histories, conversations, references, liveOwners, now });
    this.preview = null;
    this.running = false;
  }

  safeStat(file, root = this.dataDir) {
    const resolved = path.resolve(file), base = path.resolve(root);
    const relative = path.relative(base, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup path');
    let current = base, stat;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (stat.isSymbolicLink()) throw new Error('Linked paths are excluded from space cleanup');
    }
    return stat;
  }

  inventory(extraReferences) {
    let readBytes = 0, visited = 0, skipped = 0;
    const sources = [normalize(JSON.stringify(extraReferences))];
    const owners = new Set([...this.conversations.items.keys(), ...this.liveOwners()]);
    const candidates = [];
    const read = (file, root = this.dataDir, json = false, lines = false) => {
      const stat = this.safeStat(file, root);
      if (!stat?.isFile()) throw new Error('A reference file is missing or unreadable; cleanup was stopped');
      readBytes += stat.size;
      if (readBytes > MAX_READ_BYTES) throw new Error('Reference data is too large to verify safely; no files were deleted');
      const text = fs.readFileSync(file, 'utf8');
      if (json) sources.push(normalize(JSON.stringify(JSON.parse(text))));
      if (lines) for (const line of text.split('\n')) if (line.trim()) sources.push(normalize(JSON.stringify(JSON.parse(line))));
      sources.push(normalize(text));
      return text;
    };
    const entries = (directory, root = this.dataDir) => {
      const stat = this.safeStat(directory, root);
      if (!stat) return [];
      if (!stat.isDirectory()) throw new Error('Unexpected storage layout; cleanup was stopped');
      const names = fs.readdirSync(directory);
      visited += names.length;
      if (visited > 100000) throw new Error('Too many files to verify safely; cleanup was stopped');
      return names;
    };
    const sharedDir = path.join(this.dataDir, 'conversations');
    const names = entries(sharedDir);
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const file = path.join(sharedDir, name);
      const record = JSON.parse(read(file, this.dataDir, true));
      if (!validSessionId(record.id) || name !== record.id + '.json') throw new Error('A conversation index is damaged; cleanup was stopped');
      owners.add(record.id);
      if (record.seq > 0 && !this.safeStat(path.join(sharedDir, record.id + '.jsonl')))
        throw new Error('A reference file is missing or unreadable; cleanup was stopped');
    }
    for (const record of this.conversations.items.values()) sources.push(normalize(JSON.stringify(record)));
    for (const name of names) {
      const match = name.match(/^([a-zA-Z0-9_-]+)\.jsonl(?:\.torn-\d+)?$/);
      if (match) read(path.join(sharedDir, name), this.dataDir, false, owners.has(match[1]) && !name.includes('.torn-'));
    }
    for (const history of this.histories) {
      for (const directory of entries(history.root, history.root)) {
        const dir = path.join(history.root, directory);
        const stat = this.safeStat(dir, history.root);
        if (!stat?.isDirectory()) continue;
        for (const name of entries(dir, history.root)) {
          if (name.endsWith('.jsonl')) read(path.join(dir, name), history.root, false, true);
        }
      }
    }
    for (const relative of ['desktop-config.json', 'conversations/tasks/state.json']) {
      const file = path.join(this.dataDir, relative);
      if (this.safeStat(file)) read(file, this.dataDir, true);
    }
    const goalDir = path.join(sharedDir, 'goals');
    const goals = entries(goalDir);
    for (const name of goals) if (name.endsWith('.json')) read(path.join(goalDir, name), this.dataDir, true);
    const engineRoots = ['codex/api/conversations', 'kimi-code/conversations', 'dsh-chat/conversations'];
    const readEngine = directory => {
      for (const name of entries(directory)) {
        const file = path.join(directory, name), stat = this.safeStat(file);
        if (stat?.isDirectory()) readEngine(file);
        else read(file);
      }
    };
    for (const relative of engineRoots) {
      try { readEngine(path.join(this.dataDir, relative)); }
      catch (error) {
        if (error.message === 'Linked paths are excluded from space cleanup') return { candidates: [], skipped: 1 };
        throw error;
      }
    }
    const referenced = value => sources.some(source => source.includes(normalize(value)));
    const handoffDir = path.join(sharedDir, 'handoffs');
    const handoffs = entries(handoffDir).filter(name => /^[a-f0-9-]{36}\.md$/i.test(name));
    for (const name of handoffs) read(path.join(handoffDir, name));
    const add = (file, category, recursive = false) => {
      try {
        const files = [], directories = [];
        const walk = target => {
          const stat = this.safeStat(target);
          if (!stat) return;
          if (stat.mtimeMs > this.now() - PROTECTION_MS) throw new Error('Recent file');
          if (referenced(target) || referenced(path.relative(this.dataDir, target))) throw new Error('Referenced path');
          if (stat.isDirectory() && recursive) {
            for (const name of entries(target)) walk(path.join(target, name));
            directories.push(target);
          } else if (stat.isFile()) {
            if (stat.nlink !== 1) throw new Error('Linked file');
            files.push({ path: target, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
          } else throw new Error('Unsupported file');
        };
        walk(file);
        if (!files.length && !directories.length) return;
        candidates.push({ path: path.relative(this.dataDir, file), category, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), count: files.length, files, directories });
      } catch { skipped += 1; }
    };
    for (const name of names) {
      const match = name.match(/^([a-zA-Z0-9_-]+)\.jsonl(?:\.torn-\d+)?$/);
      if (match && !owners.has(match[1]) && !referenced(match[1])) add(path.join(sharedDir, name), 'Conversation remnants');
    }
    for (const name of goals) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (validSessionId(id) && !owners.has(id) && !referenced(id)) add(path.join(goalDir, name), 'Conversation remnants');
    }
    for (const name of handoffs) if (!referenced(name)) add(path.join(handoffDir, name), 'Handoffs and summaries');
    const attachmentDir = path.join(this.dataDir, 'clipboard-attachments');
    for (const name of entries(attachmentDir)) {
      if (/^pasted-(?:image|text)-\d+-[a-f0-9-]{36}\.(?:png|jpg|gif|webp|bmp|svg|txt)$/i.test(name) && !referenced(name)) add(path.join(attachmentDir, name), 'Unused pasted attachments');
    }
    for (const relative of engineRoots) {
      const directory = path.join(this.dataDir, relative);
      for (const id of entries(directory)) if (validSessionId(id) && !owners.has(id) && !referenced(id)) add(path.join(directory, id), 'Unused engine directories', true);
    }
    return { candidates, skipped };
  }

  async scan() {
    if (this.running) throw new Error('Space cleanup is already running');
    this.running = true;
    this.preview = null;
    try {
      const references = await this.references();
      const inventory = this.inventory(references);
      const token = randomUUID();
      this.preview = { ...inventory, token, createdAt: this.now() };
      return { token, skipped: inventory.skipped, candidates: inventory.candidates.map(({ files, directories, ...entry }) => entry) };
    } finally { this.running = false; }
  }

  async clean(token) {
    if (this.running) throw new Error('Space cleanup is already running');
    const preview = this.preview;
    this.preview = null;
    if (!preview || token !== preview.token || this.now() - preview.createdAt > 30 * 60 * 1000) throw new Error('Scan again before cleaning space');
    this.running = true;
    try {
      const references = await this.references();
      const current = this.inventory(references);
      const approved = new Map(preview.candidates.map(entry => [entry.path, entry]));
      let bytes = 0, files = 0, skipped = preview.candidates.length;
      const errors = [];
      for (const entry of current.candidates) {
        const previous = approved.get(entry.path);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(entry)) continue;
        skipped -= 1;
        try {
          for (const file of entry.files) {
            const stat = this.safeStat(file.path);
            if (!stat?.isFile() || stat.nlink !== 1 || stat.size !== file.bytes || stat.mtimeMs !== file.mtimeMs || stat.ctimeMs !== file.ctimeMs || stat.ino !== file.ino) throw new Error('File changed; scan again');
            fs.unlinkSync(file.path); bytes += file.bytes; files += 1;
          }
          for (const directory of entry.directories) {
            if (!this.safeStat(directory)?.isDirectory()) throw new Error('Directory changed; scan again');
            fs.rmdirSync(directory);
          }
        } catch (error) { errors.push({ path: entry.path, error: error.message }); }
      }
      return { bytes, files, skipped, errors };
    } finally { this.running = false; }
  }
}

module.exports = { StorageCleanup, PROTECTION_MS };
