'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validSessionId } = require('./claude-history');
const { jsonLines } = require('../shared/json-lines');

function nativePath(value) {
  if (process.platform !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return '\\\\' + value.slice(8);
  return /^\\\\\?\\[a-z]:\\/i.test(value) ? value.slice(4) : value;
}

// Copy a fixed, complete JSONL prefix. A source may keep appending while an
// active conversation forks at an earlier native boundary.
function snapshotTranscript(source, destination) {
  const input = fs.openSync(source, 'r');
  let output;
  try {
    const size = fs.fstatSync(input).size;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    output = fs.openSync(destination, 'wx');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0, complete = 0;
    while (position < size) {
      const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!count) throw new Error('The source transcript changed while creating a fork');
      let written = 0;
      while (written < count) {
        const size = fs.writeSync(output, buffer, written, count - written);
        if (!size) throw new Error('Could not complete the native transcript snapshot');
        written += size;
      }
      const newline = buffer.subarray(0, count).lastIndexOf(10);
      if (newline >= 0) complete = position + newline + 1;
      position += count;
    }
    fs.ftruncateSync(output, complete);
    if (!complete) throw new Error('The source transcript has no complete native history');
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}

function findRollout(home, sessionId) {
  if (!validSessionId(sessionId)) return null;
  const visit = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('-' + sessionId + '.jsonl')) return path.join(directory, entry.name);
      if (entry.isDirectory()) { const found = visit(path.join(directory, entry.name)); if (found) return found; }
    }
    return null;
  };
  return visit(path.join(home, 'sessions')) || visit(path.join(home, 'archived_sessions'));
}

async function copyCodexState(sourceHome, targetHome) {
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return;
  // Modern Codex forks read both rollout metadata and the paginated history
  // database. Copy committed SQLite state with its WAL, never raw live files.
  // Auth, native goals, queued prompts, logs and config are deliberately not
  // part of the history snapshot.
  const { DatabaseSync, backup } = require('node:sqlite');
  if (typeof backup !== 'function') throw new Error('This Node runtime cannot snapshot native Codex history');
  fs.mkdirSync(targetHome, { recursive: true });
  for (const name of fs.readdirSync(sourceHome).filter(name => /^(?:state|thread_history)_\d+\.sqlite$/.test(name))) {
    const destination = path.join(targetHome, name);
    if (fs.existsSync(destination)) throw new Error('The destination native Codex history is already in use');
    const database = new DatabaseSync(path.join(sourceHome, name), { readOnly: true });
    try { await backup(database, destination); }
    finally { database.close(); }
  }
}

function copyCodexRollouts(sourceHome, home) {
  const copy = (directory, target) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(path.join(directory, entry.name), path.join(target, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.jsonl'))
        snapshotTranscript(path.join(directory, entry.name), path.join(target, entry.name));
    }
  };
  for (const directory of ['sessions', 'archived_sessions']) copy(path.join(sourceHome, directory), path.join(home, directory));
  const { DatabaseSync } = require('node:sqlite');
  for (const name of fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))) {
    const database = new DatabaseSync(path.join(home, name));
    try {
      const columns = database.prepare('PRAGMA table_info(threads)').all().map(column => column.name);
      if (!columns.includes('id') || !columns.includes('rollout_path')) continue;
      const update = database.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?');
      // Paginated forks retain ancestor references. Relocate the complete
      // copied lineage, so a fork of a fork does not depend on its old home.
      for (const row of database.prepare('SELECT id, rollout_path FROM threads').all()) {
        if (typeof row.rollout_path !== 'string' || !path.isAbsolute(row.rollout_path)) continue;
        const relative = path.relative(nativePath(sourceHome), nativePath(row.rollout_path));
        if (relative && !path.isAbsolute(relative) && !relative.startsWith('..'))
          update.run(path.join(home, relative), row.id);
      }
    } finally { database.close(); }
  }
}

async function copyGrokFork(updatesFile, sourceHome, targetHome) {
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return;
  if (!updatesFile) throw new Error('The native Grok fork was not persisted');
  const source = path.dirname(updatesFile);
  const relative = path.relative(path.join(sourceHome, 'sessions'), source);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')) throw new Error('Invalid native Grok fork location');
  const destination = path.join(targetHome, 'sessions', relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

async function copyKimiFork(sourceHome, targetHome, sessionId) {
  if (!targetHome || path.resolve(sourceHome) === path.resolve(targetHome)) return;
  if (!validSessionId(sessionId)) throw new Error('Invalid native Kimi fork identity');
  let entry;
  for await (const line of jsonLines(fs.createReadStream(path.join(sourceHome, 'session_index.jsonl')))) {
    if (line.trim()) { const row = JSON.parse(line); if (row.sessionId === sessionId) entry = row; }
  }
  if (!entry?.sessionDir) throw new Error('The native Kimi fork was not indexed');
  const relative = path.relative(path.join(sourceHome, 'sessions'), entry.sessionDir);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')) throw new Error('Invalid native Kimi fork location');
  const destination = path.join(targetHome, 'sessions', relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await fs.promises.cp(entry.sessionDir, destination, { recursive: true, errorOnExist: true, force: false });
  fs.appendFileSync(path.join(targetHome, 'session_index.jsonl'), JSON.stringify({ ...entry, sessionDir: destination.replace(/\\/g, '/') }) + '\n');
}

async function copyDshFork(sourceHome, targetHome, sessionId) {
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return;
  if (!/^session-[0-9a-f-]{36}$/.test(sessionId)) throw new Error('Invalid native DSH fork identity');
  const root = path.join(sourceHome, 'sessions');
  for (const group of fs.readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const source = path.join(root, group.name, sessionId);
    if (!fs.existsSync(source)) continue;
    const target = path.join(targetHome, 'sessions', group.name, sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false,
      filter: file => path.basename(file) !== 'session.lock' });
    // Native content-addressed attachments are referenced by the preserved
    // events. Copy blobs, never source config, credentials or queued work.
    const blobs = path.join(sourceHome, 'attachments');
    if (fs.existsSync(blobs)) await fs.promises.cp(blobs, path.join(targetHome, 'attachments'), { recursive: true });
    return;
  }
  throw new Error('The native DSH fork was not persisted');
}

module.exports = { snapshotTranscript, findRollout, copyCodexState, copyCodexRollouts, copyGrokFork, copyKimiFork, copyDshFork };
