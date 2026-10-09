'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function isSqlite(file) {
  if (!/\.(?:sqlite3?|db)$/i.test(file)) return false;
  const handle = await fs.promises.open(file, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 16 && header.toString('ascii') === 'SQLite format 3\0';
  } finally { await handle.close(); }
}

// Archive immutable local copies rather than profiles that an idle engine or
// account refresh can still change. SQLite's backup API includes committed WAL
// transactions in a standalone database, avoiding a mismatched DB/WAL pair.
async function snapshotExportFiles({ files, directory, onProgress }) {
  const snapshots = new Map(), folded = new Set();
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let bytes = 0, index = 0;
  async function save(file, sqlite) {
    const destination = path.join(directory, String(index++));
    try {
      if (sqlite) {
        const { DatabaseSync, backup } = require('node:sqlite');
        const database = new DatabaseSync(file.abs, { readOnly: true, timeout: 5000 });
        try { await backup(database, destination); }
        finally { database.close(); }
        folded.add(file.abs + '-wal'); folded.add(file.abs + '-journal');
      } else await fs.promises.copyFile(file.abs, destination);
      const stat = await fs.promises.stat(destination);
      snapshots.set(file.abs, { ...file, abs: destination, size: stat.size });
      bytes += file.size;
      onProgress?.({ phase: 'snapshot', bytes, totalBytes });
    } catch (error) { error.profileFile = file.rel; throw error; }
  }
  // Discover real databases first, regardless of directory enumeration order,
  // so their merged WAL/journal files cannot be copied as separate entries.
  for (const file of files) {
    try { if (await isSqlite(file.abs)) await save(file, true); }
    catch (error) { error.profileFile = file.rel; throw error; }
  }
  for (const file of files) {
    if (snapshots.has(file.abs)) continue;
    if (folded.has(file.abs)) { bytes += file.size; continue; }
    await save(file, false);
  }
  return files.flatMap(file => snapshots.has(file.abs) ? [snapshots.get(file.abs)] : []);
}

module.exports = { snapshotExportFiles };
