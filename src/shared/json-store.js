'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // JSON.parse error messages may contain source text, including API keys.
    throw new Error(`Cannot read configuration ${file}: ${err instanceof SyntaxError ? "Invalid JSON" : err.code || "Unable to load"}`, { cause: err });
  }
}

// Replace only after a complete write. A failed write/rename leaves the old
// configuration intact; unique temporary names also avoid writer collisions.
function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2) + '\n');
}

// Windows antivirus and search indexers briefly hold freshly written files,
// so rename can fail with a transient EPERM/EACCES/EBUSY. Retry a few times
// before reporting failure; anything else is a real error and rethrown.
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until); }
}

function writeText(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (err) {
        if (!TRANSIENT_RENAME.has(err.code) || attempt >= 5) throw err;
        sleepSync(15 * (attempt + 1));
      }
    }
  } finally {
    // Best-effort cleanup: a leftover uniquely-named temporary is harmless,
    // but a failed delete must never mask the outcome of the write itself.
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
  }
}

module.exports = { readJson, writeJson, writeText };
