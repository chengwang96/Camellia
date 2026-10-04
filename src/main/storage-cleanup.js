'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { validSessionId } = require('../engines/claude-history');
const { referenceMatcher } = require('./reference-matcher');
const { readDiscussionRecord } = require('../engines/discussions/store');
const { collectNativeOwners } = require('../engines/discussions/native-ownership');
const { jobRecordIdentity } = require('../engines/discussions/windows-job-journal');

const PROTECTION_MS = 24 * 60 * 60 * 1000;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_VISITED_ENTRIES = 100000;
const normalize = value => {
  const text = String(value).replace(/\\+/g, '/');
  return process.platform === 'win32' ? text.toLowerCase() : text;
};

class StorageCleanup {
  constructor({ dataDir, histories = [], conversations, references, liveOwners = () => [], isActive = () => false, now = Date.now, maxVisited = MAX_VISITED_ENTRIES, signal }) {
    Object.assign(this, { dataDir: path.resolve(dataDir), histories, conversations, references, liveOwners, isActive, now, maxVisited, signal });
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

  isLink(file) {
    try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
  }

  async inventory(extraReferences) {
    const yieldScan = async () => {
      await new Promise(resolve => setImmediate(resolve));
      this.signal?.throwIfAborted();
    };
    let visited = 0, skipped = 0;
    const active = this.isActive() || Boolean(extraReferences?.active);
    const sources = [];
    const listedDirectories = new Map();
    const owners = new Set([...this.conversations.items.keys(), ...this.liveOwners()]);
    const candidates = [];
    const read = (file, root = this.dataDir, json = false, lines = false) => {
      const stat = this.safeStat(file, root);
      if (!stat?.isFile()) throw new Error('A reference file is missing or unreadable; cleanup was stopped');
      sources.push({ file, root, json, lines });
    };
    const readJson = (file, root = this.dataDir) => {
      const stat = this.safeStat(file, root);
      if (!stat?.isFile()) throw new Error('A reference file is missing or unreadable; cleanup was stopped');
      if (stat.size > MAX_RECORD_BYTES) throw new Error('A reference JSON record is too large to verify safely; no files were deleted');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    const entries = (directory, root = this.dataDir) => {
      const stat = this.safeStat(directory, root);
      if (!stat) {
        // A new discussion or journal directory appearing during the async
        // scan invalidates the empty inventory just like a changed file does.
        listedDirectories.set(directory, { file: directory, root, stat: null });
        return [];
      }
      if (!stat.isDirectory()) throw new Error('Unexpected storage layout; cleanup was stopped');
      const names = fs.readdirSync(directory);
      listedDirectories.set(directory, { file: directory, root, stat });
      visited += names.length;
      if (visited > this.maxVisited) throw new Error('Too many files to verify safely; cleanup was stopped');
      return names;
    };
    const sharedDir = path.join(this.dataDir, 'conversations');
    const names = entries(sharedDir);
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const file = path.join(sharedDir, name);
      read(file, this.dataDir, true);
      const record = readJson(file);
      if (!validSessionId(record.id) || name !== record.id + '.json') throw new Error('A conversation index is damaged; cleanup was stopped');
      owners.add(record.id);
      if (record.seq > 0 && !this.safeStat(path.join(sharedDir, record.id + '.jsonl')))
        throw new Error('A reference file is missing or unreadable; cleanup was stopped');
    }
    for (const name of names) {
      const match = name.match(/^([a-zA-Z0-9_-]+)\.jsonl(?:\.torn-\d+)?$/);
      if (match) read(path.join(sharedDir, name), this.dataDir, false, owners.has(match[1]) && !name.includes('.torn-'));
    }
    // Discussion snapshots are retained references even for archived groups,
    // removed members and retired native generations. Never offer these files,
    // launch locks or permanent seals as cleanup candidates.
    const discussionDir = path.join(this.dataDir, 'discussions');
    for (const name of entries(discussionDir).filter(name => /\.json$/i.test(name))) {
      const id = name.slice(0, -5), file = path.join(discussionDir, name);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid discussion record name; cleanup was stopped');
      read(file, this.dataDir, true);
      const record = readDiscussionRecord(file, id);
      for (const owner of collectNativeOwners({ discussions: [record] })) {
        owners.add(owner.runtimeId);
        if (owner.nativeId) owners.add(owner.nativeId);
        if (owner.nativeStorage) owners.add(owner.nativeStorage.conversationId);
      }
    }
    const journalDir = path.join(discussionDir, 'windows-jobs');
    for (const name of entries(journalDir)) {
      const dir = path.join(journalDir, name), file = path.join(dir, 'record.json');
      entries(dir);
      const info = this.safeStat(file);
      if (!info?.isFile() || info.size < 1 || info.size > 4096) throw new Error('Job launch record is missing or invalid; cleanup was stopped');
      const identity = jobRecordIdentity(readJson(file));
      if (name !== identity.deliveryId || !this.safeStat(path.join(dir, 'launch.lock'))?.isFile()) throw new Error('Invalid job journal; cleanup was stopped');
      owners.add(identity.runtimeId);
      read(file, this.dataDir, true);
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
    const cachePath = file => /^codex\/api\/conversations\/[a-zA-Z0-9_-]+\/\.tmp$/.test(path.relative(this.dataDir, file).split(path.sep).join('/'));
    const dependencyPath = file => /^dsh-chat\/conversations\/[a-zA-Z0-9_-]+\/profiles\/node_modules(?:\/[^/]+(?:\/[^/]+)?)?$/.test(path.relative(this.dataDir, file).split(path.sep).join('/'));
    const managedLink = file => this.isLink(file) && (cachePath(file) || dependencyPath(file));
    const readEngine = async directory => {
      await yieldScan();
      for (const name of entries(directory)) {
        const file = path.join(directory, name);
        if (cachePath(file) || managedLink(file)) continue;
        const stat = this.safeStat(file);
        if (stat?.isDirectory()) await readEngine(file);
        else read(file);
      }
    };
    for (const relative of engineRoots) {
      try { await readEngine(path.join(this.dataDir, relative)); }
      catch (error) {
        if (error.message === 'Linked paths are excluded from space cleanup') return { candidates: [], skipped: 1 };
        throw error;
      }
    }
    const handoffDir = path.join(sharedDir, 'handoffs');
    const handoffs = entries(handoffDir).filter(name => /^[a-f0-9-]{36}\.md$|^conversation-[a-f0-9-]{36}\.(?:md|jsonl)$/i.test(name));
    for (const name of handoffs) if (/^[a-f0-9-]{36}\.md$/i.test(name)) read(path.join(handoffDir, name));
    const guards = new Map();
    const add = (file, category, recursive = false, identity = '') => {
      if (active && (category === 'Handoffs and summaries' || category === 'Unused pasted attachments')) {
        skipped += 1;
        return;
      }
      try {
        const files = [], directories = [], links = [];
        const references = [normalize(identity)];
        // The candidate root itself is never a link: a linked path must not be
        // followed, so it stays protected instead of becoming removable.
        if (this.isLink(file)) throw new Error('Linked paths are excluded from space cleanup');
        const walk = target => {
          if (cachePath(target) && !this.isLink(target)) throw new Error('Legacy cache requires offline maintenance');
          let stat;
          try { stat = this.safeStat(target); }
          catch (error) {
            if (!managedLink(target)) throw error;
            const link = fs.lstatSync(target);
            if (link.mtimeMs > this.now() - PROTECTION_MS) throw new Error('Recent file');
            references.push(normalize(target), normalize(path.relative(this.dataDir, target)));
            links.push({ path: target, target: fs.readlinkSync(target), mtimeMs: link.mtimeMs, ctimeMs: link.ctimeMs, ino: link.ino });
            return;
          }
          if (!stat) return;
          if (stat.mtimeMs > this.now() - PROTECTION_MS) throw new Error('Recent file');
          references.push(normalize(target), normalize(path.relative(this.dataDir, target)));
          if (stat.isDirectory() && recursive) {
            for (const name of entries(target)) walk(path.join(target, name));
            directories.push(target);
          } else if (stat.isFile()) {
            if (stat.nlink !== 1) throw new Error('Linked file');
            files.push({ path: target, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
          } else throw new Error('Unsupported file');
        };
        walk(file);
        if (!files.length && !directories.length && !links.length) return;
        const candidate = { path: path.relative(this.dataDir, file), category, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), count: files.length, files, directories, links };
        candidates.push(candidate);
        guards.set(candidate, references.filter(Boolean));
      } catch { skipped += 1; }
    };
    for (const name of names) {
      const match = name.match(/^([a-zA-Z0-9_-]+)\.jsonl(?:\.torn-\d+)?$/);
      if (match && !owners.has(match[1])) add(path.join(sharedDir, name), 'Conversation remnants', false, match[1]);
    }
    for (const name of goals) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (validSessionId(id) && !owners.has(id)) add(path.join(goalDir, name), 'Conversation remnants', false, id);
    }
    for (const name of handoffs) add(path.join(handoffDir, name), 'Handoffs and summaries', false, name);
    const attachmentDir = path.join(this.dataDir, 'clipboard-attachments');
    for (const name of entries(attachmentDir)) {
      if (/^pasted-(?:image|text)-\d+-[a-f0-9-]{36}\.(?:png|jpg|gif|webp|bmp|svg|txt)$/i.test(name)) add(path.join(attachmentDir, name), 'Unused pasted attachments', false, name);
    }
    for (const relative of engineRoots) {
      const directory = path.join(this.dataDir, relative);
      for (const id of entries(directory)) if (validSessionId(id) && !owners.has(id)) add(path.join(directory, id), 'Unused engine directories', true, id);
    }
    const pending = new Set([...guards.values()].flat());
    const matcher = referenceMatcher(pending), found = matcher.found;
    let overlap = 0;
    for (const term of pending) overlap = Math.max(overlap, term.length - 1);
    const inspect = text => {
      const source = normalize(text);
      matcher.inspect(source);
    };
    inspect(JSON.stringify(extraReferences));
    for (const record of this.conversations.items.values()) inspect(JSON.stringify(record));
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    const verifiedSources = [];
    for (const { file, root, json, lines } of sources) {
      await yieldScan();
      const stat = this.safeStat(file, root);
      if (!stat?.isFile()) throw new Error('A reference file is missing or unreadable; cleanup was stopped');
      if (json) {
        inspect(JSON.stringify(readJson(file, root)));
      }
      const descriptor = fs.openSync(file, 'r');
      try {
        const decoder = new StringDecoder('utf8');
        let tail = '', record = '', recordBytes = 0, trailingBackslash = false;
        const inspectRecord = text => {
          if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new Error('A reference JSON record is too large to verify safely; no files were deleted');
          if (text.trim()) inspect(JSON.stringify(JSON.parse(text)));
        };
        const consume = text => {
          const raw = trailingBackslash ? text.replace(/^\\+/, '') : text;
          if (text) trailingBackslash = text.endsWith('\\');
          const source = tail + normalize(raw);
          inspect(source);
          tail = overlap ? source.slice(-overlap) : '';
          if (lines) {
            let start = 0, end;
            while ((end = text.indexOf('\n', start)) !== -1) {
              inspectRecord(record + text.slice(start, end));
              record = '';
              recordBytes = 0;
              start = end + 1;
            }
            const remainder = text.slice(start);
            recordBytes += Buffer.byteLength(remainder, 'utf8');
            if (recordBytes > MAX_RECORD_BYTES) throw new Error('A reference JSON record is too large to verify safely; no files were deleted');
            record += remainder;
          }
        };
        let remaining = stat.size;
        let processed = 0;
        while (remaining > 0) {
          const bytes = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
          if (!bytes) throw new Error('Reference files changed; scan again');
          consume(decoder.write(buffer.subarray(0, bytes)));
          remaining -= bytes;
          processed += bytes;
          if (processed >= 4 * 1024 * 1024) {
            processed = 0;
            await yieldScan();
          }
        }
        consume(decoder.end());
        if (lines) inspectRecord(record);
        verifiedSources.push({ file, root, stat });
      } finally { fs.closeSync(descriptor); }
    }
    const verification = [...verifiedSources, ...listedDirectories.values()];
    this.verify(verification);
    return { candidates: candidates.filter(candidate => !guards.get(candidate).some(term => found.has(term))), skipped, active, verification };
  }

  verify(records) {
    for (const { file, root, stat } of records) {
      const current = this.safeStat(file, root);
      if (!stat && !current) continue;
      if (!stat || !current || current.isFile() !== stat.isFile() || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs || current.ino !== stat.ino)
        throw new Error('Reference files changed; scan again');
    }
  }

  async scan() {
    if (this.running) throw new Error('Space cleanup is already running');
    this.running = true;
    this.preview = null;
    clearTimeout(this.previewTimer);
    try {
      const references = await this.references();
      const { verification, ...inventory } = await this.inventory(references);
      const token = randomUUID();
      this.preview = { ...inventory, token, createdAt: this.now() };
      this.previewTimer = setTimeout(() => { this.preview = null; }, 30 * 60 * 1000);
      this.previewTimer.unref?.();
      return { token, skipped: inventory.skipped, active: inventory.active, candidates: inventory.candidates.map(({ files, directories, links, caches, ...entry }) => entry) };
    } finally { this.running = false; }
  }

  async clean(token) {
    if (this.running) throw new Error('Space cleanup is already running');
    const preview = this.preview;
    this.preview = null;
    clearTimeout(this.previewTimer);
    if (!preview || token !== preview.token || this.now() - preview.createdAt > 30 * 60 * 1000) throw new Error('Scan again before cleaning space');
    this.running = true;
    try {
      const references = await this.references();
      const current = await this.inventory(references);
      if (JSON.stringify(await this.references()) !== JSON.stringify(references)) throw new Error('Reference files changed; scan again');
      this.verify(current.verification || []);
      const approved = new Map(preview.candidates.map(entry => [entry.path, entry]));
      let bytes = 0, files = 0, skipped = preview.candidates.length;
      const errors = [];
      for (const entry of current.candidates) {
        if (entry.category === 'Unused engine directories' && (this.conversations.items.has(path.basename(entry.path)) || this.liveOwners().includes(path.basename(entry.path)))) continue;
        if (this.isActive() && ['Handoffs and summaries', 'Unused pasted attachments'].includes(entry.category)) continue;
        const previous = approved.get(entry.path);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(entry)) continue;
        skipped -= 1;
        try {
          for (const file of entry.files) {
            const stat = this.safeStat(file.path);
            if (!stat?.isFile() || stat.nlink !== 1 || stat.size !== file.bytes || stat.mtimeMs !== file.mtimeMs || stat.ctimeMs !== file.ctimeMs || stat.ino !== file.ino) throw new Error('File changed; scan again');
            fs.unlinkSync(file.path); bytes += file.bytes; files += 1;
          }
          // Unlink cached plugin mounts before their parent directory is removed.
          // Unlinking a link never touches the shared cache it points at.
          for (const link of entry.links || []) {
            this.safeStat(path.dirname(link.path));
            const stat = fs.lstatSync(link.path);
            if (!stat.isSymbolicLink() || stat.mtimeMs !== link.mtimeMs || stat.ctimeMs !== link.ctimeMs || stat.ino !== link.ino || fs.readlinkSync(link.path) !== link.target) throw new Error('Directory changed; scan again');
            fs.unlinkSync(link.path);
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
