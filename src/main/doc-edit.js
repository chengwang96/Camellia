'use strict';

// Legacy `.doc` editing is delegated to Microsoft Word through a small COM
// bridge, because a Word 97-2003 file is an OLE2 compound document whose text
// is addressed by a piece table plus character-formatting runs. Changing text
// length without Word recalculating those structures corrupts the document, so
// this module copies the file, lets Word edit the copy, and only then swaps it
// into place. When Word is unavailable the preview stays readable but read-only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const WORD_TIMEOUT_MS = 120_000;
const BRIDGE = path.join(__dirname, 'word-com-edit.py');

function revision(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function execFile(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
}

async function fileExists(file) {
  try { await fs.promises.access(file); return true; } catch { return false; }
}

async function removeTree(directory) {
  if (!directory) return;
  try { await fs.promises.rm(directory, { recursive: true, force: true }); } catch {}
}

function pythonCandidates() {
  const list = [];
  if (process.env.CAMELLIA_PYTHON) list.push(process.env.CAMELLIA_PYTHON);
  if (process.platform === 'win32') {
    // The py launcher also finds per-user and Store installs that are not on
    // PATH, so it is tried before fixed version directories.
    list.push(path.join(process.env.LOCALAPPDATA || '', 'Programs/Python/Python313/python.exe'));
    list.push(path.join(process.env.LOCALAPPDATA || '', 'Programs/Python/Python312/python.exe'));
    list.push('py');
  }
  list.push('python3', 'python');
  return list.filter(Boolean);
}

let bridgePython;
// Probes share one asynchronous result for the lifetime of the main process.
function findBridgePython() {
  bridgePython ??= (async () => {
    for (const python of pythonCandidates()) {
      try {
        await execFile(python, ['-c', 'import win32com.client'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
        return python;
      } catch {}
    }
    return null;
  })();
  return bridgePython;
}

async function wordBridgeAvailable({ signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || !await fileExists(BRIDGE)) return false;
  const available = Boolean(await findBridgePython());
  signal?.throwIfAborted();
  return available;
}

async function readDocSnapshot(filePath, { signal } = {}) {
  signal?.throwIfAborted();
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error('This document is too large to edit.');
  const bytes = await fs.promises.readFile(filePath);
  signal?.throwIfAborted();
  if (!await wordBridgeAvailable({ signal })) throw new Error('Editing .doc files needs Microsoft Word and Python with pywin32.');
  // The preview loads without Word; opening the editor asks Word for the exact
  // Paragraphs collection. Nothing is exposed as editable before that list
  // arrives, because a piece-table decode cannot reproduce Word's indexing.
  return { path: filePath, revision: revision(bytes), paragraphs: [], wordParagraphs: null, wordRevision: null };
}

async function exactDocParagraphs(snapshot) {
  const paragraphs = await listDocParagraphs(snapshot);
  snapshot.paragraphEditability = paragraphs.map(item => item.editable !== false);
  snapshot.wordParagraphs = paragraphs.map(item => item.text);
  snapshot.wordRevision = snapshot.revision;
  // Word's list replaces the empty placeholder so every later save uses the
  // same ordering the editor was shown.
  snapshot.paragraphs = snapshot.wordParagraphs;
  return snapshot.paragraphs;
}

async function listDocParagraphs(snapshot) {
  const bytes = await fs.promises.readFile(snapshot.path);
  if (revision(bytes) !== snapshot.revision) throw new Error('The file changed on disk. Reopen the document before saving.');
  if (snapshot.wordRevision === snapshot.revision && Array.isArray(snapshot.wordParagraphs)) {
    return snapshot.wordParagraphs.map((text, index) => ({ text, editable: snapshot.paragraphEditability?.[index] !== false }));
  }
  const result = await runWordBridge({ path: snapshot.path, revision: snapshot.revision }, [], 60_000, true);
  try {
    return Array.isArray(result.paragraphs)
      ? result.paragraphs.map((item, index) => {
        const text = typeof item === 'string' ? item : item.text;
        // Picture, page-break and similar markers are read-only even if Word's
        // count is unavailable, so saving can never overwrite them with text.
        const marker = /[\u0000-\u0006\u0008\u000e-\u001f]/.test(text);
        return { text, editable: !marker && (typeof item === 'string' || item.editable !== false) };
      })
      : [];
  } finally { await removeTree(result.directory); }
}

async function runWordBridge(snapshot, edits, timeout = WORD_TIMEOUT_MS, readOnly = false, convert = null, signal = null) {
  let directory;
  try {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'camellia-doc-bridge-'));
    const request = path.join(directory, 'request.json');
    await fs.promises.writeFile(request, JSON.stringify({ path: snapshot.path, edits, readOnly, convert }));
    const python = await findBridgePython();
    if (!python) throw new Error('Editing .doc files needs Microsoft Word and Python with pywin32.');
    let result;
    try {
      result = await execFile(python, ['-X', 'utf8', BRIDGE, request], {
        windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, signal,
      });
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
      if (error.code === 'ETIMEDOUT' || error.signal) throw new Error('Word took too long to save this document.');
      if (typeof error.code === 'number') throw new Error(String(error.stderr || '').trim() || 'The Word bridge failed.');
      throw new Error(error.message || 'Could not start the Word bridge.');
    }
    let payload;
    try { payload = JSON.parse(String(result.stdout).trim().split(/\r?\n/).pop()); }
    catch { throw new Error('Word did not return a usable result.'); }
    if (!payload?.ok) throw new Error(payload?.error || 'Word could not save this document.');
    // A conversion run is responsible for its own output directory, but the
    // caller still needs the bridge's request directory cleaned up.
    return { copy: payload.copy, paragraphs: payload.paragraphs, path: payload.path, directory };
  } catch (error) {
    await removeTree(directory);
    throw error;
  }
}

let convertedDocuments = 0;
// Word's own conversion is the only local path that reproduces pictures,
// tables and theme styling for a legacy .doc. The OOXML copy is cached for a
// short while so the preview does not start Word on every open, and is removed
// when the cache rotates or the process exits.
const convertedCache = new Map();
const convertingDocuments = new Map();

function conversionCancelled() {
  const error = new Error('Document preview was cancelled');
  error.name = 'AbortError';
  return error;
}

async function waitForConversion(entry, signal) {
  entry.users++;
  let rejectAbort;
  const cancelled = new Promise((resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(conversionCancelled());
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    return await Promise.race([entry.promise, cancelled]);
  } finally {
    signal?.removeEventListener('abort', abort);
    entry.users--;
    if (!entry.users) entry.controller.abort();
  }
}

async function convertDocToDocx(filePath, { signal } = {}) {
  const key = await fs.promises.realpath(filePath);
  const stat = await fs.promises.stat(key);
  signal?.throwIfAborted();
  const cached = convertedCache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && await fileExists(cached.path)) return cached.path;
  const pending = convertingDocuments.get(key);
  if (pending && pending.mtimeMs === stat.mtimeMs && pending.size === stat.size && !pending.controller.signal.aborted) {
    return waitForConversion(pending, signal);
  }
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, controller: new AbortController(), users: 0, promise: null };
  entry.promise = (async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'camellia-doc-preview-'));
    const target = path.join(directory, `converted-${process.pid}-${++convertedDocuments}.docx`);
    let bridgeDirectory = null;
    try {
      bridgeDirectory = (await runWordBridge({ path: key }, [], 60_000, false, target, entry.controller.signal)).directory;
      if (!await fileExists(target)) throw new Error('Word did not produce a converted preview.');
    } catch (error) {
      await removeTree(directory);
      throw error;
    } finally { await removeTree(bridgeDirectory); }
    if (cached) await removeTree(path.dirname(cached.path));
    convertedCache.set(key, { path: target, mtimeMs: stat.mtimeMs, size: stat.size });
    return target;
  })();
  convertingDocuments.set(key, entry);
  const clear = () => { if (convertingDocuments.get(key) === entry) convertingDocuments.delete(key); };
  entry.promise.then(clear, clear);
  return waitForConversion(entry, signal);
}

function clearConvertedDocuments() {
  for (const pending of convertingDocuments.values()) pending.controller.abort();
  convertingDocuments.clear();
  for (const cached of convertedCache.values()) {
    try { fs.rmSync(path.dirname(cached.path), { recursive: true, force: true }); } catch {}
  }
  convertedCache.clear();
}

async function saveDocEdit(snapshot, edits) {
  if (!Array.isArray(edits)) throw new Error('Invalid Word edits.');
  if (edits.some(edit => !Number.isInteger(edit?.index) || typeof edit.text !== 'string' || edit.text.includes('\0') || !edit.text.isWellFormed())) {
    throw new Error('Enter valid text without null characters.');
  }
  const target = await fs.promises.realpath(snapshot.path);
  if (revision(await fs.promises.readFile(target)) !== snapshot.revision) throw new Error('The file changed on disk. Reopen the document before saving.');
  await fs.promises.access(target, fs.constants.W_OK);
  // The indices were produced by Word, so saving refuses to proceed unless
  // Word has confirmed the same paragraph list for this revision.
  await exactDocParagraphs(snapshot);
  for (const edit of edits) {
    if (snapshot.paragraphEditability?.[edit.index] === false) {
      throw new Error('This paragraph contains a picture or page break and cannot be edited.');
    }
  }
  if (!edits.length) return { file: { modifiedAt: (await fs.promises.stat(target)).mtimeMs }, paragraphs: snapshot.paragraphs, snapshot };

  const { copy, directory } = await runWordBridge(snapshot, edits);
  const temporary = path.join(path.dirname(target), `.camellia-office-${randomUUID()}.tmp`);
  let replaced = false;
  try {
    const bytes = await fs.promises.readFile(copy);
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      if (process.platform !== 'win32') await handle.chmod((await fs.promises.stat(target)).mode & 0o777);
      await handle.sync();
    } finally { await handle.close(); }
    if (revision(await fs.promises.readFile(target)) !== snapshot.revision) throw new Error('The file changed on disk. Reopen the document before saving.');
    await fs.promises.rename(temporary, target);
    replaced = true;
    const stat = await fs.promises.stat(target);
    const updated = { ...snapshot, path: target, revision: revision(await fs.promises.readFile(target)) };
    updated.paragraphs = edits.reduce((paragraphs, edit) => {
      if (edit.index < paragraphs.length) paragraphs[edit.index] = edit.text;
      return paragraphs;
    }, snapshot.paragraphs.slice());
    // Word recomputed the layout; if a save somehow merged or split a
    // paragraph, do not advertise one editability list for another one.
    updated.wordParagraphs = null;
    updated.wordRevision = null;
    return { file: { size: stat.size, modifiedAt: stat.mtimeMs }, paragraphs: updated.paragraphs, snapshot: updated };
  } finally {
    if (!replaced) try { await fs.promises.unlink(temporary); } catch {}
    await removeTree(directory);
  }
}

module.exports = { wordBridgeAvailable, readDocSnapshot, exactDocParagraphs, saveDocEdit, convertDocToDocx, clearConvertedDocuments };
