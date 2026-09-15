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

function writeText(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

module.exports = { readJson, writeJson, writeText };
