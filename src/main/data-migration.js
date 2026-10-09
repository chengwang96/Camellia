'use strict';

// Move Camellia between installations, folders or computers without losing
// conversations, goals, scheduled tasks, settings or engine native history.
// Subscription accounts stay device-local in every transfer category.
//
// The package is a plain ZIP so it can be inspected without Camellia. Only the
// manifest and a bounded file index are held in memory; file contents are
// streamed in both directions. Selected JSON metadata is rewritten one file
// at a time under its existing size limits. Absolute paths
// recorded by the source installation are rewritten on import, which is what
// makes a source checkout and a packaged build interchangeable.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const JSZip = require('jszip');
const { openArchive, entryMetadata, readEntry } = require('./data-import-archive');
const { ImportTransaction, recoverDataImports: recoverImports } = require('./data-import-transaction');
const { snapshotExportFiles } = require('./data-export-snapshot');

const FORMAT = 'camellia-data';
const VERSION = 1;
const MANIFEST = 'camellia-migration.json';
const APP_ROOT = 'app';
const HOME_ROOT = 'home';

// Engine homes live next to the user's home directory, not in the app data
// directory, so a package carries both roots and restores each in place.
const HOME_DIRS = ['.dsh', '.claude', '.kimi-code', '.gemini'];
const HOME_FILES = ['.claude.json'];

// Caches, browser state and download-on-demand payloads. They are either
// rebuilt automatically or are a fraction of the transfer in size.
const APP_SKIP_TOP = new Set([
  'runtimes', 'logs', 'benchmark-libraries', 'migration-backups',
  'Cache', 'Code Cache', 'GPUCache', 'GPUPersistentCache', 'GPUShaderCache', 'GrShaderCache', 'ShaderCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage', 'Local Storage', 'Session Storage',
  'Network', 'Shared Dictionary', 'DIPS', 'SharedStorage', 'lockfile', 'Preferences', 'Local State',
]);
// Dependency trees and scratch directories are never worth migrating, at any
// depth: this is what keeps the DSH profile junctions out of the package.
const APP_SKIP_ANY = new Set(['node_modules', '.tmp', '.tmp-maintenance', 'tmp', '.history-index', 'plugin-caches', '.plugin-cache-operation.json',
  '.camellia-plugin-cache-maintenance.json', '.camellia-plugin-cache-maintenance-result.json']);
const HOME_SKIP_ANY = new Set(['node_modules', '.tmp', 'tmp']);
// Home directories keep most files; only clearly re-creatable caches are left
// behind, and only near the root. The depth check keeps a plugin's own `cache`
// folder (deeper in its tree) in scope.
const HOME_SKIP_SHALLOW = new Set(['cache', 'Cache', 'paste-cache', 'shell-snapshots', 'telemetry', 'image-upload-cache']);

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
// JSZip 3.x writes 32-bit sizes and offsets with no ZIP64 record, so one
// archive is capped below 4 GiB. Larger profiles are split into numbered parts
// automatically; the caps stay conservative because the compressed size is not
// known until each part is written. The entry cap covers the 16-bit directory
// count. Single entries must also stay under 4 GiB.
const MAX_PART_BYTES = 3 * 1024 ** 3;
const MAX_PART_ENTRIES = 30000;
const MAX_ENTRY_BYTES = 3 * 1024 ** 3;
// Metadata that may embed the source installation's absolute paths.
const REWRITE_JSON = /(?:^|\/)(?:desktop-config\.json|[^/]+\.json)$/;
// Path rewriting parses JSON, so keep it to small metadata files.
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;
// Cross-part paths and selected entry descriptors must also stay bounded. The
// charge includes fixed overhead and UTF-16 path copies, not archive payloads.
const MAX_IMPORT_INDEX_BYTES = 64 * 1024 * 1024;

// Every entry is one of three kinds, so an import can bring back API
// credentials, application settings, conversation history, or any combination.
// Conversation data is recognised first so an account or engine folder that
// holds native sessions keeps them with the rest of the history. API files are
// then matched explicitly; anything left is ordinary configuration, which keeps
// a new or unexpected settings file in the safe category by default.
const CONVERSATION_SEGMENTS = new Set(['conversations', 'sessions', 'projects', 'transcripts',
  'storages', 'file-history', 'handoffs', 'goals', 'tasks', 'cli-sessions']);
const CONVERSATION_BASENAMES = [/^session_index\.jsonl$/, /^history\.jsonl$/, /^rollout-.*\.jsonl$/,
  /^(?:state|thread_history|goals)_\d+\.sqlite(?:-(?:wal|shm|journal))?$/, /^conversation_summaries\.db$/, /^workspace\.json$/];
const CONVERSATION_PATHS = [/(^|\/)claude-profiles\/[^/]+\.settings\.json$/,
  /(^|\/)discussions\//, /(^|\/)antigravity-backup\//];
// Subscription logins and their native homes stay on the original device in
// every scope. Apply the same policy to old packages before classification so
// credentials cannot enter through settings or conversation history either.
const SUBSCRIPTION_PATHS = [/(^|\/)(?:subscription-accounts|kimi-subscription|credentials)(?:\/|$)/i,
  /^app\/codex\/subscription(?:\/|$)/i,
  /^home\/\.kimi-code\/\.credentials\.yaml$/i,
  /(^|\/)(?:\.credentials\.json|auth\.json|account-state\.json|subscription-usage\.json|google-account\.json|google-quota\.json|oauth_creds\.json|mcp-oauth-tokens(?:-v\d+)?\.json)$/i];
const isSubscriptionData = relative => SUBSCRIPTION_PATHS.some(pattern => pattern.test(relative));
// API routes, provider keys and their balance/model metadata.
const API_PATHS = [/(^|\/)(?:ollama-proxy|opencode-proxy)\.json$/, /(^|\/)\.credentials\.yaml$/,
  /(^|\/)(?:provider-insights|context-capacity)\.json$/, /(^|\/)server\.token$/];
const KINDS = ['api', 'settings', 'conversations'];
// These documents mix portable preferences with device-local account identity.
// Strip source identities on export and keep the destination's identities on
// import, including when the source is an older, unfiltered package.
const ACCOUNT_METADATA_KEYS = new Map([
  ['app/desktop-config.json', ['subscriptionAccounts', 'subscriptionActive', 'kimiSessionAccounts', 'codexSessionAccounts']],
  ['home/.claude.json', ['oauthAccount']],
]);

async function readAccountConfig(file, relative) {
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_REWRITE_BYTES) throw new Error('The package configuration is too large to validate: ' + relative);
  let value;
  try { value = JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code) throw error;
    throw new Error('The package contains invalid JSON: ' + relative);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The package contains invalid JSON: ' + relative);
  return value;
}

async function stripExportAccountMetadata(files) {
  for (const file of files) {
    const keys = ACCOUNT_METADATA_KEYS.get(file.rel.toLowerCase());
    if (!keys) continue;
    const value = await readAccountConfig(file.abs, file.rel);
    if (!keys.some(key => Object.hasOwn(value, key))) continue;
    for (const key of keys) delete value[key];
    const text = JSON.stringify(value, null, 2) + '\n';
    await fs.promises.writeFile(file.abs, text);
    file.size = Buffer.byteLength(text);
  }
}

async function preserveLocalAccountMetadata({ targets, staging, dataDir, home }) {
  const changed = [];
  for (const relative of targets) {
    const keys = ACCOUNT_METADATA_KEYS.get(relative.toLowerCase());
    if (!keys) continue;
    const file = path.join(staging, ...relative.split('/'));
    const value = await readAccountConfig(file, relative);
    let current = {};
    try { current = await readAccountConfig(targetPath(relative, dataDir, home), relative); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('The current subscription account settings could not be preserved: ' + relative);
    }
    for (const key of keys) {
      delete value[key];
      if (Object.hasOwn(current, key)) value[key] = current[key];
    }
    const text = JSON.stringify(value, null, 2) + '\n';
    if (text !== await fs.promises.readFile(file, 'utf8')) {
      await fs.promises.writeFile(file, text);
      changed.push(relative);
    }
  }
  return changed;
}

function classify(relative) {
  if (CONVERSATION_PATHS.some(pattern => pattern.test(relative))) return 'conversations';
  const segments = relative.split('/');
  if (CONVERSATION_BASENAMES.some(pattern => pattern.test(segments[segments.length - 1]))) return 'conversations';
  if (segments.some(part => CONVERSATION_SEGMENTS.has(part))) return 'conversations';
  if (API_PATHS.some(pattern => pattern.test(relative))) return 'api';
  return 'settings';
}

// Older callers passed one of these strings; keep them working. A selection is
// a non-empty subset of KINDS.
const SCOPE_ALIASES = { all: KINDS, settings: ['settings'], conversations: ['conversations'], api: ['api'] };

function normalizeKinds(scope) {
  const list = Array.isArray(scope) ? scope : SCOPE_ALIASES[scope] ?? null;
  if (!list) throw new Error('Choose what to import: API configuration, settings, conversations, or everything');
  const selected = [...new Set(list)];
  if (!selected.length || selected.some(kind => !KINDS.includes(kind))) throw new Error('Choose what to import: API configuration, settings, conversations, or everything');
  return KINDS.filter(kind => selected.includes(kind));
}

// Lenient form for the IPC layer: returns null for a missing or empty selection
// so the caller can ask the user instead of failing the request.
function resolveKinds(scope) {
  if (scope === undefined || scope === null) return null;
  try { return normalizeKinds(scope); }
  catch { return null; }
}

function yieldLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

function hasSegment(relative, set) {
  return relative.split('/').some(part => set.has(part));
}

function hasShallowSegment(relative, set, depth) {
  return relative.split('/').some((part, index) => index < depth && set.has(part));
}

function skipRuntimeFile(relative) {
  const name = relative.split('/').pop();
  // Codex holds a Windows byte-range lock on this empty maintenance sentinel.
  // SQLite's shared-memory index also contains locks, but no database content:
  // it is rebuilt from the database and WAL, which must both remain in scope.
  return name === '.sqlite-maintenance.lock' || /(?:^|\/)thread-writer-locks(?:\/|$)/.test(relative)
    || /\.(?:sqlite3?|db)-shm$/i.test(name);
}

function skipApp(relative) {
  if (relative.startsWith('.torn-') || relative.includes('/.torn-')) return true;
  if (skipRuntimeFile(relative)) return true;
  if (hasSegment(relative, APP_SKIP_ANY)) return true;
  const top = relative.includes('/') ? relative.slice(0, relative.indexOf('/')) : relative;
  if (APP_SKIP_TOP.has(top)) return true;
  if (/^(?:DIPS|SharedStorage)-(?:wal|shm|journal)$/.test(top)) return true;
  if (top.startsWith('Singleton')) return true;
  if (top.startsWith('declarative_performance_observer.db')) return true;
  if (top.startsWith('camellia-data-') && top.endsWith('.zip')) return true;
  return false;
}

function skipHome(relative) {
  if (relative.startsWith('.torn-') || relative.includes('/.torn-')) return true;
  if (skipRuntimeFile(relative)) return true;
  if (hasSegment(relative, HOME_SKIP_ANY)) return true;
  return hasShallowSegment(relative, HOME_SKIP_SHALLOW, 3);
}

async function collect(root, rootKind, skip, files, state, prefix = '') {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { state.skipped += 1; return; }
  for (const entry of entries) {
    await yieldLoop();
    const absolute = path.join(root, entry.name);
    // The walk descends into subdirectories, so the package path is accumulated
    // rather than recomputed against the current (deeper) directory.
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    let stat;
    try { stat = await fs.promises.lstat(absolute); }
    catch { state.skipped += 1; continue; }
    // Junctions (DSH dependency links) and any other reparse point must not be
    // followed: they can leave the tree or point back into it.
    if (stat.isSymbolicLink() || entry.isSymbolicLink()) { state.skipped += 1; continue; }
    if (isSubscriptionData(rootKind + '/' + relative) || skip(relative)) { state.skipped += 1; continue; }
    if (stat.isDirectory()) { await collect(absolute, rootKind, skip, files, state, relative); continue; }
    if (!stat.isFile()) { state.skipped += 1; continue; }
    if (state.files % 1000 === 0) await yieldLoop();
    const rel = rootKind + '/' + relative;
    files.push({ abs: absolute, rel, size: stat.size, category: classify(rel) });
    state.files += 1;
    state.bytes += stat.size;
  }
}

async function collectAll({ dataDir, home }) {
  const files = [];
  const state = { files: 0, bytes: 0, skipped: 0 };
  await collect(dataDir, APP_ROOT, skipApp, files, state);
  for (const name of HOME_DIRS) {
    const root = path.join(home, name);
    if (fs.existsSync(root)) await collect(root, HOME_ROOT + '/' + name, skipHome, files, state);
  }
  for (const name of HOME_FILES) {
    const absolute = path.join(home, name);
    let stat;
    try { stat = await fs.promises.lstat(absolute); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const rel = HOME_ROOT + '/' + name;
    files.push({ abs: absolute, rel, size: stat.size, category: classify(rel) });
    state.files += 1;
    state.bytes += stat.size;
  }
  return { files, count: state.files, bytes: state.bytes, skipped: state.skipped };
}

// JSZip binds an input stream for every entry before it writes them, and
// fs.createReadStream opens its descriptor on construction. A profile can hold
// tens of thousands of files, which would exhaust the process handle limit long
// before the archive is written, so the descriptor is opened only when the
// archive actually reads that entry. Entries are consumed one at a time, so the
// number of open descriptors stays small regardless of the file count.
const TRANSIENT_READ = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// A running engine can hold its sqlite, WAL or log files on Windows, where a
// read then fails with EBUSY. Retry briefly, then report the file as skipped so
// one locked history file cannot abort the whole export. Re-export after
// closing that engine to capture it.
async function readable(file, probe) {
  for (let attempt = 0; ; attempt++) {
    let handle;
    try {
      handle = await fs.promises.open(file, 'r');
      // Opening succeeds for byte-range locks on Windows; the read detects
      // them, including locks on an empty file beyond its current EOF.
      await handle.read(probe, 0, probe.length, 0);
      return true;
    }
    catch (error) {
      if (!TRANSIENT_READ.has(error.code) || attempt >= 4) return false;
      await delay(120 * (attempt + 1));
    } finally { try { await handle?.close(); } catch { /* ignore */ } }
  }
}

function fileStream(file, onBytes, expectedBytes, relative) {
  let bytes = 0;
  const fail = error => { error.profileFile = relative; outer.destroy(error); };
  const outer = new Readable({
    read() {
      // A later read means the consumer drained the buffer, so resume a source
      // that was paused for backpressure. Without this the entry stalls forever.
      if (this.inner) { this.inner.resume(); return; }
      let inner;
      try { inner = fs.createReadStream(file); }
      catch (error) { fail(error); return; }
      this.inner = inner;
      inner.on('data', chunk => { bytes += chunk.length; onBytes(chunk.length); if (!outer.push(chunk)) inner.pause(); });
      inner.on('end', () => {
        if (bytes !== expectedBytes) outer.destroy(new Error('A profile file changed while packaging; export again: ' + relative));
        else outer.push(null);
      });
      inner.on('error', fail);
    },
    destroy(error, callback) { try { this.inner?.destroy(); } catch { /* ignore */ } callback(error); },
  });
  return outer;
}

// Write to a sibling temporary file and rename on success, so an interrupted
// export never leaves a half-written package under the name the user chose.
async function writeZip({ files, destination, manifest, onProgress }) {
  const zip = new JSZip();
  const inputs = [];
  let processed = 0;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const bump = bytes => {
    processed += bytes;
    if (onProgress) onProgress({ phase: 'export', bytes: processed, totalBytes: total });
  };
  // Small, fixed entry first so the manifest is readable without scanning.
  zip.file(MANIFEST, JSON.stringify(manifest, null, 2));
  for (const file of files) {
    // A fixed timestamp keeps repeat exports of unchanged data byte-identical.
    const input = fileStream(file.abs, bump, file.size, file.rel); inputs.push(input);
    zip.file(file.rel, input, { date: new Date(0) });
  }
  const temporary = destination + '.' + randomUUID().slice(0, 8) + '.part';
  const output = fs.createWriteStream(temporary);
  try {
    await pipeline(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } }), output);
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    try { await fs.promises.rm(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  } finally {
    for (const input of inputs) input.destroy();
  }
}

async function createDataPackage({ dataDir, home, appVersion, destination, scope = 'all', onProgress }) {
  if (!path.isAbsolute(destination)) throw new Error('Choose a destination file for the package');
  const kinds = normalizeKinds(scope);
  const collected = await collectAll({ dataDir, home });
  const files = collected.files.filter(file => kinds.includes(file.category));
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const skipped = collected.skipped;
  if (!files.length) throw new Error('There is nothing to export yet');
  const oversized = files.find(file => file.size >= MAX_ENTRY_BYTES);
  if (oversized) throw new Error(`A single file is too large to package: ${oversized.rel}`);
  // Keep only entries that can be opened now, so a file held by a running
  // engine is reported instead of aborting the export.
  const usable = [], locked = [];
  const probe = Buffer.alloc(64 * 1024);
  for (const file of files) (await readable(file.abs, probe) ? usable : locked).push(file);
  if (!usable.length) throw new Error('No profile files could be read; close running engines and try again');
  const lockedFiles = locked.slice(0, 20).map(file => file.rel);
  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'camellia-export-'));
  try {
    const snapshots = await snapshotExportFiles({ files: usable, directory: staging, onProgress });
    await stripExportAccountMetadata(snapshots);
    const oversizedSnapshot = snapshots.find(file => file.size >= MAX_ENTRY_BYTES);
    if (oversizedSnapshot) throw new Error(`A single file is too large to package: ${oversizedSnapshot.rel}`);
    const parts = partitionFiles(snapshots, MAX_PART_BYTES, MAX_PART_ENTRIES);
    const names = partNames(destination, parts.length);
    // Per-kind totals let the import dialog tell the user what a scope holds
    // before they commit to overwriting anything.
    const categories = snapshots.reduce((totals, file) => {
      totals[file.category] = totals[file.category] || { files: 0, bytes: 0 };
      totals[file.category].files += 1;
      totals[file.category].bytes += file.size;
      return totals;
    }, {});
    const manifest = {
      format: FORMAT, version: VERSION,
      createdAt: new Date().toISOString(), appVersion: appVersion || null,
      source: { platform: process.platform, home, appDataDir: dataDir },
      roots: { app: APP_ROOT, home: HOME_ROOT },
      counts: { files: snapshots.length, bytes: snapshots.reduce((sum, file) => sum + file.size, 0), skipped, locked: locked.length },
      lockedFiles,
      categories,
      // Part names are stored as base names so the manifest survives being copied
      // anywhere; import resolves them next to whichever part was selected.
      parts: parts.map((entries, index) => ({ name: path.basename(names[index]), files: entries.length })),
    };
    let written = 0;
    for (let index = 0; index < parts.length; index++) {
      await writeZip({ files: parts[index], destination: names[index], manifest, onProgress });
      written += (await fs.promises.stat(names[index])).size;
    }
    return { files: snapshots.length, bytes: written, sourceBytes: bytes, skipped, categories, scope: kinds, locked: locked.length,
      lockedFiles, parts: names, split: names.length > 1 };
  } catch (error) {
    if (TRANSIENT_READ.has(error.code) && error.profileFile) {
      throw new Error('A profile file was locked while packaging; close running engines and export again: ' + error.profileFile);
    }
    throw error;
  } finally { await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// Group files into archives that stay inside the single-archive limits. Order
// is preserved so a package reads naturally in a file manager.
function partitionFiles(files, maxBytes, maxEntries) {
  const parts = [];
  let current = [], currentBytes = 0;
  for (const file of files) {
    if (current.length && (currentBytes + file.size > maxBytes || current.length >= maxEntries)) {
      parts.push(current); current = []; currentBytes = 0;
    }
    current.push(file); currentBytes += file.size;
  }
  if (current.length) parts.push(current);
  return parts.length ? parts : [[]];
}

function partNames(destination, count) {
  if (count <= 1) return [destination];
  const directory = path.dirname(destination);
  const extension = path.extname(destination) || '.zip';
  const base = path.basename(destination, extension);
  const width = String(count).length;
  return Array.from({ length: count }, (_, index) =>
    path.join(directory, `${base}-${String(index + 1).padStart(width, '0')}${extension}`));
}

function normalizeEntryPath(name) {
  const cleaned = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;
  const parts = cleaned.split('/');
  if (/^[a-zA-Z]:/.test(cleaned)) return null;
  if (parts.includes('..')) return null;
  return parts.filter(Boolean).join('/');
}

async function readManifest(file, directory = null) {
  directory ||= await openArchive(file);
  const entry = directory.files.find(candidate => candidate.path === MANIFEST && candidate.type === 'File');
  if (!entry) throw new Error('This file is not a Camellia data package');
  if (entry.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error('The package manifest is unexpectedly large');
  const chunks = [];
  const bytes = await readEntry({ file, entry: entryMetadata(entry, directory.dataEnd), maxBytes: MAX_MANIFEST_BYTES, manifest: true,
    output: () => new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }) });
  const buffer = Buffer.concat(chunks, bytes);
  let manifest;
  try { manifest = JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('The package manifest is not valid JSON'); }
  if (manifest?.format !== FORMAT || manifest.version !== VERSION) {
    throw new Error('This package was written by a different Camellia version');
  }
  if (!manifest.source || typeof manifest.source.appDataDir !== 'string') {
    throw new Error('The package manifest is incomplete');
  }
  return { directory, manifest };
}

// Resolve every part named by the manifest and refuse to start unless all of
// them are present, so a partial import can never silently restore half a set.
function packageParts(manifest, selected) {
  const listed = Array.isArray(manifest.parts) ? manifest.parts : [];
  const names = listed.length ? listed.map(part => path.basename(String(part.name))) : [path.basename(selected)];
  const directory = path.dirname(path.resolve(selected));
  const files = names.map(name => path.join(directory, name));
  const missing = files.filter(file => !fs.existsSync(file));
  if (missing.length) throw new Error(`The package is incomplete; missing ${missing.map(file => path.basename(file)).join(', ')}`);
  return files;
}

async function inspectPackage(file, kinds = null) {
  let { manifest, directory: initialDirectory } = await readManifest(file);
  const files = packageParts(manifest, file);
  const categories = {}, entries = new Set();
  const plans = [];
  let bytes = 0, indexBytes = 0, selectedFiles = 0, selectedBytes = 0;
  for (const part of files) {
    const initial = process.platform === 'win32'
      ? path.resolve(part).toLowerCase() === path.resolve(file).toLowerCase() : path.resolve(part) === path.resolve(file);
    const directory = initial ? initialDirectory : await openArchive(part);
    if (!initial && directory.files.some(entry => entry.path === MANIFEST)) {
      const { manifest: partManifest } = await readManifest(part, directory);
      if (JSON.stringify(partManifest) !== JSON.stringify(manifest)) throw new Error('The package parts do not belong to the same export');
    }
    const selected = [];
    let partFiles = 0, partBytes = 0;
    for (const entry of directory.files) {
      if (entry.type !== 'File' || entry.path === MANIFEST) continue;
      const rel = normalizeEntryPath(entry.path);
      if (!rel) throw new Error('The package contains an unsafe path');
      const [root, ...rest] = rel.split('/');
      if (root !== APP_ROOT && root !== HOME_ROOT) continue;
      if (!rest.length || entries.has(rel)) throw new Error('The package contains an unsafe path');
      if (root === HOME_ROOT && !HOME_DIRS.includes(rest[0]) && !HOME_FILES.includes(rest[0])) throw new Error('The package contains an unsafe path');
      if (entry.uncompressedSize >= MAX_ENTRY_BYTES) throw new Error('A single file is too large to import: ' + rel);
      partFiles += 1; partBytes += entry.uncompressedSize;
      if (partFiles > MAX_PART_ENTRIES || partBytes > MAX_PART_BYTES) throw new Error('The package part exceeds the import file or byte limit');
      indexBytes += 128 + 4 * rel.length;
      if (indexBytes > MAX_IMPORT_INDEX_BYTES) throw new Error('The package file index exceeds the import memory limit');
      entries.add(rel);
      bytes += entry.uncompressedSize;
      // Count excluded legacy entries for manifest consistency, but do not
      // offer, decompress or restore account data and recovery backups.
      if (isSubscriptionData(rel) || /^app\/migration-backups(?:\/|$)/i.test(rel)) continue;
      const kind = classify(rel);
      categories[kind] ||= { files: 0, bytes: 0 };
      categories[kind].files += 1;
      categories[kind].bytes += entry.uncompressedSize;
      if (kinds?.includes(kind)) {
        indexBytes += 256 + 4 * entry.path.length;
        if (indexBytes > MAX_IMPORT_INDEX_BYTES) throw new Error('The package file index exceeds the import memory limit');
        selected.push({ rel, entry: entryMetadata(entry, directory.dataEnd) });
        selectedFiles += 1; selectedBytes += entry.uncompressedSize;
      }
    }
    if (selected.length) plans.push({ file: part, entries: selected });
    if (initial) initialDirectory = null;
  }
  if (!entries.size) throw new Error('The package has no Camellia data to import');
  if (Number.isFinite(manifest.counts?.files) && manifest.counts.files !== entries.size) {
    throw new Error(`The package is incomplete (${entries.size} of ${manifest.counts.files} files)`);
  }
  if (Number.isFinite(manifest.counts?.bytes) && manifest.counts.bytes !== bytes) throw new Error('The package byte count does not match its manifest');
  return { manifest, files, categories, plans, available: entries.size,
    expected: { files: selectedFiles, totalBytes: selectedBytes } };
}

async function inspectDataPackage(file) {
  const { manifest, files, categories } = await inspectPackage(file);
  return { manifest, files, categories };
}

async function extractPackage({ plans, staging, onProgress, expected }) {
  let extracted = 0, bytes = 0;
  const targets = [];
  for (const { file, entries } of plans) {
    for (const { rel, entry } of entries) {
      await yieldLoop();
      const target = path.join(staging, ...rel.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await readEntry({ file, entry, maxBytes: MAX_ENTRY_BYTES,
        output: () => fs.createWriteStream(target, { mode: 0o600 }),
        onChunk(length) {
          if (bytes + length > expected.totalBytes) throw new Error('The package exceeds the selected import byte count');
          bytes += length;
          if (onProgress) onProgress({ phase: 'import', bytes, totalBytes: expected.totalBytes, files: extracted });
        } });
      extracted += 1;
      targets.push(rel);
    }
  }
  if (!targets.length) throw new Error('The package has no Camellia data to import');
  if (Number.isFinite(expected.files) && expected.files !== extracted) {
    throw new Error(`The package is incomplete (${extracted} of ${expected.files} files)`);
  }
  if (bytes !== expected.totalBytes) throw new Error('The package byte count does not match the selected import');
  // Release entry descriptors before JSON/path rewriting allocates its own
  // bounded working set. The transaction needs only the selected paths.
  plans.length = 0;
  return targets;
}

function rewriteValue(value, mappings) {
  if (typeof value === 'string') {
    let result = value;
    for (const [from, to] of mappings) if (from && to && from !== to) result = result.split(from).join(to);
    return result;
  }
  if (Array.isArray(value)) return value.map(item => rewriteValue(item, mappings));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = rewriteValue(item, mappings);
    return output;
  }
  return value;
}

// Session metadata stores absolute workspace and data paths, so a package from
// another folder or computer would otherwise open with stale locations.
async function rewriteFile(file, mappings, relative) {
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_REWRITE_BYTES) {
    if (relative === 'app/desktop-config.json') throw new Error('The package configuration is too large to validate: ' + relative);
    return false;
  }
  const raw = await fs.promises.readFile(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error('The package contains invalid JSON: ' + relative); }
  if (relative === 'app/desktop-config.json' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))
    throw new Error('The package contains an invalid application configuration: ' + relative);
  const text = JSON.stringify(rewriteValue(parsed, mappings), null, 2);
  if (text === raw.trimEnd()) return false;
  await fs.promises.writeFile(file, text + '\n');
  return true;
}

function targetPath(rel, dataDir, home) {
  const [kind, ...rest] = rel.split('/');
  return kind === APP_ROOT ? path.join(dataDir, ...rest) : path.join(home, ...rest);
}

// Rewrite only the files an import actually wrote, and only the ones that can
// carry absolute paths, so settings and API files are corrected without walking
// the untouched conversation catalog.
async function rewriteImportedTree({ dataDir, home, targets, mappings }) {
  const rewritten = [];
  for (const rel of [...targets]) {
    await yieldLoop();
    const discussion = rel.match(/^app\/discussions\/([0-9a-f-]{36})\.json$/i);
    if (discussion) {
      // Decode before rewriting paths: payload filenames are checksums of the
      // exact text. Re-encode in staging and include any new hashes in the same
      // import transaction as the manifest; never rewrite blobs in place.
      const { readDiscussionRecord, validateDiscussion } = require('../engines/discussions/store');
      const { DiscussionPayloads, payloadReferences } = require('../engines/discussions/payloads');
      const { replyDigest } = require('../engines/discussions/schema');
      const { bindingFingerprint } = require('../engines/discussions/capabilities');
      const file = targetPath(rel, dataDir, home), id = discussion[1];
      const state = rewriteValue(readDiscussionRecord(file, id), mappings);
      const messages = new Map(state.messages.map(m => [m.id, m])), deliveries = new Map(state.deliveries.map(d => [d.id, d]));
      for (const r of state.requests) {
        const m = messages.get(r.messageId);
        r.fingerprint = JSON.stringify({ text: m.text, participantIds: r.deliveryIds.map(id => deliveries.get(id))
          .filter(d => d.retryOf === undefined).map(d => d.participantId), mode: r.mode,
        ...(m.attachments?.length ? { attachments: m.attachments } : {}) });
      }
      for (const d of state.deliveries) {
        if (d.profile && d.bindingFingerprint) d.bindingFingerprint = bindingFingerprint(d.profile);
        if (d.settlement?.resultId) d.settlement.sha256 = replyDigest(messages.get(d.resultId).text);
      }
      validateDiscussion(state, id);
      const payloads = new DiscussionPayloads(path.dirname(file)), encoded = payloads.encode(state);
      payloads.stage(id, encoded.pending);
      const refs = payloadReferences(encoded.state), prefix = 'app/discussions/' + id + '.payloads/';
      for (let i = targets.length - 1; i >= 0; i--) if (targets[i].startsWith(prefix)
        && /^[0-9a-f]{64}\.text$/.test(targets[i].slice(prefix.length))
        && !refs.has(path.basename(targets[i], '.text'))) targets.splice(i, 1);
      for (const hash of refs) if (!targets.includes(prefix + hash + '.text')) targets.push(prefix + hash + '.text');
      payloads.prune(id, refs);
      await fs.promises.writeFile(file, JSON.stringify(encoded.state, null, 2) + '\n');
      rewritten.push(rel); continue;
    }
    if (!REWRITE_JSON.test(rel)) continue;
    if (await rewriteFile(targetPath(rel, dataDir, home), mappings, rel)) rewritten.push(rel);
  }
  return rewritten;
}

async function applyPackage({ staging, targets, transaction, onProgress }) {
  const summary = { restored: 0, overwritten: 0, bytes: 0 };
  for (const rel of targets) {
    await yieldLoop();
    const source = path.join(staging, ...rel.split('/'));
    const result = await transaction.replace(rel, source);
    summary.overwritten += Number(result.overwritten);
    summary.bytes += result.bytes;
    summary.restored += 1;
    if (onProgress && summary.restored % 200 === 0) onProgress({ phase: 'apply', files: summary.restored, totalFiles: targets.length });
  }
  return summary;
}

async function importDataPackage({ file, dataDir, home, scope = 'all', onProgress }) {
  if (!file || !fs.existsSync(file)) throw new Error('Choose a Camellia data package to import');
  const kinds = normalizeKinds(scope);
  recoverDataImports({ dataDir, home });
  const { manifest, categories, plans, expected, available } = await inspectPackage(file, kinds);
  if (scope !== 'all' && kinds.some(kind => !categories[kind]?.files)) {
    throw new Error('The package has no data for the selected categories');
  }
  const staging = path.join(os.tmpdir(), 'camellia-migration-' + randomUUID());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, 'migration-backups', stamp + '-' + randomUUID().slice(0, 8));
  let transaction;
  try {
    // Every part's metadata is checked first. Only selected active files are
    // decompressed, and all of those pass size/CRC checks before any overwrite.
    const selected = await extractPackage({ plans, staging, onProgress, expected });
    if (!selected.length) {
      throw new Error('The package has no data for the selected categories');
    }
    const mappings = [
      [manifest.source.appDataDir, dataDir],
      [manifest.source.home, home],
    ].filter(([from, to]) => from && to && from !== to);
    // Correct paths in staging before any profile file is replaced.
    const rewritten = await rewriteImportedTree({ dataDir: path.join(staging, APP_ROOT), home: path.join(staging, HOME_ROOT), targets: selected, mappings });
    for (const relative of await preserveLocalAccountMetadata({ targets: selected, staging, dataDir, home })) {
      if (!rewritten.includes(relative)) rewritten.push(relative);
    }
    transaction = new ImportTransaction({ dataDir, home, backupDir, homeEntries: [...HOME_DIRS, ...HOME_FILES] });
    const summary = await applyPackage({ staging, targets: selected, transaction, onProgress });
    const warning = transaction.commit();
    return {
      restored: summary.restored, overwritten: summary.overwritten, bytes: summary.bytes,
      backupDir: summary.overwritten ? backupDir : null, rewritten,
      scope: kinds, selected: kinds.length, available,
      source: { appVersion: manifest.appVersion || null, createdAt: manifest.createdAt || null, platform: manifest.source.platform || null },
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    throw transaction && !transaction.committed ? transaction.abort(error) : error;
  } finally {
    try { await fs.promises.rm(staging, { recursive: true, force: true }); } catch { /* staging is disposable */ }
  }
}

function recoverDataImports(options) { return recoverImports({ ...options, homeEntries: [...HOME_DIRS, ...HOME_FILES] }); }
module.exports = { createDataPackage, importDataPackage, inspectDataPackage, readManifest, collectAll, resolveKinds, recoverDataImports, FORMAT, VERSION, MANIFEST, KINDS };
