'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validSessionId } = require('../engines/claude-history');
const { readJson, writeJson } = require('../shared/json-store');

const OPERATION = '.plugin-cache-operation.json';
const CACHE_NAMES = new Set(['plugins', 'plugins.sha', 'plugins.sync.lock']);
const DIGEST = /^[a-f0-9]{64}$/;
const CHUNK_BYTES = 256 * 1024;

function checked(root, target) {
  const base = path.resolve(root), resolved = path.resolve(target), relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe cache maintenance path');
  let current = base;
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked maintenance path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}

function cacheLayout(directory, empty = false) {
  const names = fs.readdirSync(directory);
  if ((!empty && !names.includes('plugins')) || names.some(name => !CACHE_NAMES.has(name))) throw new Error('Cache contains unrecognized files; retained');
}

// Content identity excludes timestamps. A separate metadata fingerprint allows
// reuse of a verified tree without reading its bytes again during an offline batch.
function snapshot(directory, { content = true, onRead = () => {} } = {}) {
  const hash = createHash('sha256'), metadata = createHash('sha256');
  const buffer = content ? Buffer.alloc(CHUNK_BYTES) : null;
  let bytes = 0, files = 0;
  const visit = relative => {
    const file = path.join(directory, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsupported cache entry');
    if (stat.isFile() && stat.nlink !== 1) throw new Error('Hard-linked cache entry');
    hash.update(JSON.stringify([relative.split(path.sep).join('/'), stat.isDirectory() ? 'directory' : 'file', stat.isFile() ? stat.size : 0]));
    // Renaming a directory changes its ctime, but not the files it contains.
    metadata.update(JSON.stringify([relative, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.isFile() ? stat.ctimeMs : 0, stat.nlink]));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else {
      if (content) {
        const descriptor = fs.openSync(file, 'r');
        try {
          const opened = fs.fstatSync(descriptor);
          if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Cache changed during maintenance');
          let count;
          while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, count)); onRead(count, file); }
        } finally { fs.closeSync(descriptor); }
      }
      const after = fs.lstatSync(file);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino || after.dev !== stat.dev) throw new Error('Cache changed during maintenance');
      bytes += stat.size; files++;
    }
    if (stat.isDirectory() && fs.lstatSync(file).mtimeMs !== stat.mtimeMs) throw new Error('Cache changed during maintenance');
  };
  visit('');
  return { digest: hash.digest('hex'), metadata: metadata.digest('hex'), bytes, files };
}

function verify(directory, original) {
  if (snapshot(directory, { content: false }).metadata !== original.metadata) throw new Error('Cache changed during maintenance');
}

function operationPaths(root, operation) {
  if (operation?.version !== 1 || !validSessionId(operation.id) || !DIGEST.test(operation.digest)
      || typeof operation.primary !== 'boolean' || (!operation.primary && !DIGEST.test(operation.targetName))
      || (operation.primary && operation.kind !== 'duplicate')
      || !['seed', 'duplicate'].includes(operation.kind) || !['prepared', 'staged', 'linked'].includes(operation.stage)) throw new Error('Invalid cache maintenance operation; retained');
  const home = checked(root, path.join(root, 'codex'));
  const local = path.join(home, 'api/conversations', operation.id, '.tmp');
  const target = operation.primary ? path.join(home, '.tmp') : path.join(home, 'plugin-caches', operation.targetName);
  return { home, local, staging: local + '-maintenance', target, journal: checked(root, path.join(home, OPERATION)) };
}

function linkedTo(file, target) {
  try {
    const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return fs.lstatSync(file).isSymbolicLink() && normalize(path.resolve(path.dirname(file), fs.readlinkSync(file))) === normalize(target);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function removeStaging(root, staging) {
  checked(root, staging);
  if (!fs.existsSync(staging)) return;
  cacheLayout(staging, true);
  snapshot(staging, { content: false }); // Never follow links, including after a crash.
  fs.rmSync(staging, { recursive: true });
}

function recoverPluginCacheOperation(dataDir) {
  const root = path.resolve(dataDir), journal = checked(root, path.join(root, 'codex', OPERATION));
  const operation = readJson(journal, null);
  if (!operation) return false;
  const { local, staging, target } = operationPaths(root, operation);
  checked(root, path.dirname(local)); checked(root, target); checked(root, staging);
  if (linkedTo(local, target)) {
    if (!fs.existsSync(target)) throw new Error('Shared cache is missing; maintenance recovery is required');
    if (operation.stage !== 'linked') {
      if (snapshot(target).digest !== operation.digest || (fs.existsSync(staging) && snapshot(staging).digest !== operation.digest)) throw new Error('Cache changed before maintenance committed; retained');
      writeJson(journal, { ...operation, stage: 'linked' });
    }
    removeStaging(root, staging);
  } else if (fs.existsSync(staging)) {
    if (fs.existsSync(local)) throw new Error('Conversation cache was recreated; maintenance recovery requires inspection');
    fs.renameSync(checked(root, staging), checked(root, local));
  } else if (operation.kind === 'seed' && !fs.existsSync(local) && fs.existsSync(target)) {
    if (snapshot(target).digest !== operation.digest) throw new Error('Shared cache changed; maintenance recovery requires inspection');
    fs.renameSync(checked(root, target), checked(root, local));
  } else if (!fs.existsSync(local) || fs.lstatSync(local).isSymbolicLink()) {
    throw new Error('Cannot recover the original conversation cache');
  }
  fs.unlinkSync(journal);
  return true;
}

function maintainPluginCaches(dataDir, { apply = false, onProgress = () => {}, onStep = () => {} } = {}) {
  const root = path.resolve(dataDir), home = checked(root, path.join(root, 'codex'));
  const conversations = checked(root, path.join(home, 'api', 'conversations'));
  const stores = new Map(), result = { linked: 0, duplicates: 0, bytes: 0, skipped: [], apply, readBytes: 0 };
  if (apply) recoverPluginCacheOperation(root);
  if (!fs.existsSync(conversations)) return result;
  const hints = new Map();
  for (const id of fs.readdirSync(conversations).filter(validSessionId)) {
    let hint = '';
    try {
      const local = checked(root, path.join(conversations, id, '.tmp'));
      const file = path.join(local, 'plugins.sha'), stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256) hint = fs.readFileSync(file, 'utf8');
    } catch { /* A hint never substitutes for the actual content check. */ }
    hints.set(id, hint);
  }
  const ids = [...hints.keys()].sort((first, second) => hints.get(first).localeCompare(hints.get(second)) || first.localeCompare(second));
  let processedEntries = 0;
  const report = (stage, current = '', cancellable = true) => {
    try { onProgress({ stage, current, cancellable, processedEntries, totalEntries: ids.length, processedBytes: result.readBytes,
      phases: ['scan', 'verify-cache', 'link-cache'] }); }
    catch (error) { if (error.code === 'CAMELLIA_CACHE_CANCELLED') error.result = { ...result }; throw error; }
  };
  const read = directory => snapshot(directory, { onRead: count => { result.readBytes += count; report('verify-cache', directory); } });
  const remember = target => {
    checked(root, target); cacheLayout(target);
    const value = read(target);
    stores.set(value.digest, { target, value });
  };
  report('scan');
  // Native updates can change a stored snapshot. Its name is not a checksum
  // of its current contents; read each shared tree once per offline batch.
  const primary = path.join(home, '.tmp'), snapshotRoot = checked(root, path.join(home, 'plugin-caches'));
  if (fs.existsSync(primary)) {
    try { remember(primary); } catch (error) { if (error.code === 'CAMELLIA_CACHE_CANCELLED') throw error; result.skipped.push({ id: 'shared', error: error.message }); }
  }
  if (fs.existsSync(snapshotRoot)) for (const name of fs.readdirSync(snapshotRoot).sort()) {
    if (!DIGEST.test(name)) continue;
    try { remember(path.join(snapshotRoot, name)); }
    catch (error) { if (error.code === 'CAMELLIA_CACHE_CANCELLED') throw error; result.skipped.push({ id: name, error: error.message }); }
  }
  for (const id of ids) {
    const local = path.join(conversations, id, '.tmp');
    try {
      if (!fs.existsSync(local) || fs.lstatSync(local).isSymbolicLink()) continue;
      checked(root, local); cacheLayout(local);
      report('verify-cache', local);
      const original = read(local), existing = stores.get(original.digest);
      const target = existing?.target || checked(root, path.join(snapshotRoot, original.digest));
      if (apply) {
        verify(local, original);
        if (existing) verify(target, existing.value);
        else if (fs.existsSync(target)) throw new Error('Shared cache differs; retained');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const operation = { version: 1, id, digest: original.digest, targetName: path.basename(target),
          kind: existing ? 'duplicate' : 'seed', stage: 'prepared', primary: target === primary };
        const journal = checked(root, path.join(home, OPERATION)), staging = checked(root, local + '-maintenance');
        if (fs.existsSync(staging)) throw new Error('Previous maintenance requires inspection');
        writeJson(journal, operation);
        report('link-cache', local, false);
        fs.renameSync(checked(root, local), staging); onStep('staged');
        writeJson(journal, { ...operation, stage: 'staged' });
        if (!existing) { fs.renameSync(staging, target); onStep('seeded'); }
        fs.symlinkSync(target, local, process.platform === 'win32' ? 'junction' : 'dir'); onStep('linked');
        if (!linkedTo(local, target)) throw new Error('Shared cache link verification failed');
        writeJson(journal, { ...operation, stage: 'linked' });
        if (existing) { verify(staging, original); removeStaging(root, staging); }
        onStep('cleaned');
        fs.unlinkSync(journal);
        if (!existing) stores.set(original.digest, { target, value: original });
      } else if (!existing) stores.set(original.digest, { target, value: original });
      result.linked++;
      if (existing) { result.duplicates++; result.bytes += original.bytes; }
    } catch (error) {
      if (error.code === 'CAMELLIA_CACHE_CANCELLED') throw error;
      result.skipped.push({ id, error: error.message });
      if (apply && fs.existsSync(path.join(home, OPERATION))) {
        try { recoverPluginCacheOperation(root); }
        catch (recovery) { throw new Error(error.message + '; recovery required: ' + recovery.message, { cause: recovery }); }
      }
    } finally { processedEntries++; }
    report('verify-cache', local);
  }
  report('done', '', false);
  return result;
}

module.exports = { maintainPluginCaches, recoverPluginCacheOperation, snapshot, OPERATION, CHUNK_BYTES };
