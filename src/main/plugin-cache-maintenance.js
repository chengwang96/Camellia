'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validSessionId } = require('../engines/claude-history');

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

function snapshot(directory) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
  let bytes = 0, files = 0;
  const visit = relative => {
    const file = path.join(directory, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsupported cache entry');
    hash.update(JSON.stringify([relative.split(path.sep).join('/'), stat.isDirectory() ? 'directory' : 'file', stat.isFile() ? stat.size : 0]));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else {
      if (stat.nlink !== 1) throw new Error('Hard-linked cache entry');
      const descriptor = fs.openSync(file, 'r');
      try {
        let count;
        while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
      } finally { fs.closeSync(descriptor); }
      const after = fs.lstatSync(file);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino) throw new Error('Cache changed during maintenance');
      bytes += stat.size; files++;
    }
  };
  visit('');
  return { digest: hash.digest('hex'), bytes, files };
}

function maintainPluginCaches(dataDir, { apply = false, onProgress = () => {} } = {}) {
  const root = path.resolve(dataDir), home = checked(root, path.join(root, 'codex'));
  const conversations = checked(root, path.join(home, 'api', 'conversations'));
  const stores = new Map(), result = { linked: 0, duplicates: 0, bytes: 0, skipped: [], apply };
  if (!fs.existsSync(conversations)) return result;
  for (const id of fs.readdirSync(conversations).sort()) {
    if (!validSessionId(id)) continue;
    const local = path.join(conversations, id, '.tmp');
    try {
      if (!fs.existsSync(local) || fs.lstatSync(local).isSymbolicLink()) continue;
      checked(root, local);
      onProgress(id);
      const names = fs.readdirSync(local);
      if (!names.includes('plugins') || names.some(name => !['plugins', 'plugins.sha', 'plugins.sync.lock'].includes(name))) throw new Error('Cache contains unrecognized files; retained');
      const original = snapshot(local);
      const target = checked(root, path.join(home, 'plugin-caches', original.digest));
      const existing = stores.has(original.digest) || fs.existsSync(target);
      if (apply) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (existing) {
          if (snapshot(target).digest !== original.digest) throw new Error('Shared cache differs; retained');
          if (snapshot(checked(root, local)).digest !== original.digest) throw new Error('Local cache changed; retained');
          const staging = checked(root, local + '-maintenance');
          if (fs.existsSync(staging)) throw new Error('Previous maintenance requires inspection');
          fs.renameSync(checked(root, local), staging);
          try { fs.symlinkSync(target, local, process.platform === 'win32' ? 'junction' : 'dir'); }
          catch (error) { fs.renameSync(checked(root, staging), checked(root, local)); throw error; }
          fs.rmSync(checked(root, staging), { recursive: true });
        } else {
          fs.renameSync(checked(root, local), target);
          try { fs.symlinkSync(target, local, process.platform === 'win32' ? 'junction' : 'dir'); }
          catch (error) { fs.renameSync(checked(root, target), checked(root, local)); throw error; }
        }
      }
      stores.set(original.digest, target);
      result.linked++;
      if (existing) { result.duplicates++; result.bytes += original.bytes; }
    } catch (error) { result.skipped.push({ id, error: error.message }); }
  }
  return result;
}

module.exports = { maintainPluginCaches };
