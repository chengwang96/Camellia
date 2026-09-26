'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');

function dataDirectory(env = process.env, home = os.homedir()) {
  const base = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  if (!path.isAbsolute(base)) throw new Error('XDG_DATA_HOME must be an absolute path');
  return path.join(base, 'camellia-server');
}

function validatePrivate(stat, directory = false) {
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw new Error('Expected a private regular file or directory, not a link');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
    throw new Error('Camellia storage must be owned by the current user with mode 0700 (directory) or 0600 (file)');
  }
}

function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('Storage directory must be absolute');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Only the storage directory itself must be a real directory. Ancestors may
  // legitimately be symlinks — macOS resolves /tmp and /var under /private — so
  // comparing realpath with the requested path would reject valid storage.
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error('Storage directory cannot be a symbolic link');
  validatePrivate(stat, true);
  return directory;
}

function readPrivate(file, limit = 4096) {
  const before = fs.lstatSync(file);
  validatePrivate(before);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    validatePrivate(stat);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > limit) throw new Error('Invalid private file');
    return fs.readFileSync(descriptor, 'utf8');
  } finally { fs.closeSync(descriptor); }
}

function networkKey(directory, { keyFile } = {}) {
  privateDirectory(directory);
  const file = keyFile || path.join(directory, 'network.key');
  if (!path.isAbsolute(file)) throw new Error('Network key file must be absolute');
  if (!keyFile) {
    try { fs.writeFileSync(file, randomBytes(32).toString('base64') + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = readPrivate(file, 128).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error('Invalid network key file; expected a base64-encoded 32-byte key');
  return key;
}

function acquireLock(directory) {
  privateDirectory(directory);
  const file = path.join(directory, 'server.lock');
  const token = randomBytes(32).toString('hex');
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Camellia server data is locked. Stop the other server; after a crash, verify it has exited before manually removing server.lock.');
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    const stored = JSON.parse(readPrivate(file));
    if (stored.token !== token) throw new Error('Server lock ownership changed');
    fs.unlinkSync(file);
    released = true;
  };
}

module.exports = { dataDirectory, privateDirectory, readPrivate, networkKey, acquireLock };
