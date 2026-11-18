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
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const WORD_TIMEOUT_MS = 120_000;
const BRIDGE = path.join(__dirname, 'word-com-edit.py');

function revision(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
// Probing starts a Python process, and this is consulted on every legacy
// preview, so the answer is cached for the lifetime of the main process.
function findBridgePython() {
  if (bridgePython !== undefined) return bridgePython;
  bridgePython = pythonCandidates().find(python => {
    const probe = spawnSync(python, ['-c', 'import win32com.client'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    return probe.status === 0;
  }) || null;
  return bridgePython;
}

function wordBridgeAvailable() {
  if (process.platform !== 'win32' || !fs.existsSync(BRIDGE)) return false;
  return Boolean(findBridgePython());
}

function readDocSnapshot(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error('This document is too large to edit.');
  const bytes = fs.readFileSync(filePath);
  if (!wordBridgeAvailable()) throw new Error('Editing .doc files needs Microsoft Word and Python with pywin32.');
  // The preview loads without Word; opening the editor asks Word for the exact
  // Paragraphs collection. Nothing is exposed as editable before that list
  // arrives, because a piece-table decode cannot reproduce Word's indexing.
  return { path: filePath, revision: revision(bytes), paragraphs: [], wordParagraphs: null, wordRevision: null };
}

function exactDocParagraphs(snapshot) {
  const paragraphs = listDocParagraphs(snapshot);
  snapshot.paragraphEditability = paragraphs.map(item => item.editable !== false);
  snapshot.wordParagraphs = paragraphs.map(item => item.text);
  snapshot.wordRevision = snapshot.revision;
  // Word's list replaces the empty placeholder so every later save uses the
  // same ordering the editor was shown.
  snapshot.paragraphs = snapshot.wordParagraphs;
  return snapshot.paragraphs;
}

function listDocParagraphs(snapshot) {
  const bytes = fs.readFileSync(snapshot.path);
  if (revision(bytes) !== snapshot.revision) throw new Error('The file changed on disk. Reopen the document before saving.');
  if (snapshot.wordRevision === snapshot.revision && Array.isArray(snapshot.wordParagraphs)) {
    return snapshot.wordParagraphs.map((text, index) => ({ text, editable: snapshot.paragraphEditability?.[index] !== false }));
  }
  const result = runWordBridge({ path: snapshot.path, revision: snapshot.revision }, [], 60_000, true);
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
  } finally {
    try { fs.rmSync(result.directory, { recursive: true, force: true }); } catch {}
  }
}

function runWordBridge(snapshot, edits, timeout = WORD_TIMEOUT_MS, readOnly = false, convert = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-doc-bridge-'));
  const request = path.join(directory, 'request.json');
  fs.writeFileSync(request, JSON.stringify({ path: snapshot.path, edits, readOnly, convert }));
  try {
    const python = findBridgePython();
    if (!python) throw new Error('Editing .doc files needs Microsoft Word and Python with pywin32.');
    const result = spawnSync(python, ['-X', 'utf8', BRIDGE, request], {
      windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error?.code === 'ETIMEDOUT' || result.signal) throw new Error('Word took too long to save this document.');
    if (result.error) throw new Error(result.error.message || 'Could not start the Word bridge.');
    if (result.status !== 0) throw new Error(String(result.stderr || '').trim() || 'The Word bridge failed.');
    let payload;
    try { payload = JSON.parse(String(result.stdout).trim().split(/\r?\n/).pop()); }
    catch { throw new Error('Word did not return a usable result.'); }
    if (!payload?.ok) throw new Error(payload?.error || 'Word could not save this document.');
    // A conversion run is responsible for its own output directory, but the
    // caller still needs the bridge's request directory cleaned up.
    return { copy: payload.copy, paragraphs: payload.paragraphs, path: payload.path, directory };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

let convertedDocuments = 0;
// Word's own conversion is the only local path that reproduces pictures,
// tables and theme styling for a legacy .doc. The OOXML copy is cached for a
// short while so the preview does not start Word on every open, and is removed
// when the cache rotates or the process exits.
const convertedCache = new Map();

function convertDocToDocx(filePath) {
  const key = fs.realpathSync.native(filePath);
  const stat = fs.statSync(key);
  const cached = convertedCache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && fs.existsSync(cached.path)) return cached.path;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-doc-preview-'));
  const target = path.join(directory, `converted-${process.pid}-${++convertedDocuments}.docx`);
  let bridgeDirectory = null;
  try {
    bridgeDirectory = runWordBridge({ path: key }, [], 60_000, false, target).directory;
    if (!fs.existsSync(target)) throw new Error('Word did not produce a converted preview.');
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (bridgeDirectory) try { fs.rmSync(bridgeDirectory, { recursive: true, force: true }); } catch {}
  }
  if (cached) fs.rmSync(path.dirname(cached.path), { recursive: true, force: true });
  convertedCache.set(key, { path: target, mtimeMs: stat.mtimeMs, size: stat.size });
  return target;
}

function clearConvertedDocuments() {
  for (const cached of convertedCache.values()) {
    try { fs.rmSync(path.dirname(cached.path), { recursive: true, force: true }); } catch {}
  }
  convertedCache.clear();
}

function saveDocEdit(snapshot, edits) {
  if (!Array.isArray(edits)) throw new Error('Invalid Word edits.');
  if (edits.some(edit => !Number.isInteger(edit?.index) || typeof edit.text !== 'string' || edit.text.includes('\0') || !edit.text.isWellFormed())) {
    throw new Error('Enter valid text without null characters.');
  }
  const target = fs.realpathSync.native(snapshot.path);
  if (revision(fs.readFileSync(target)) !== snapshot.revision) throw new Error('The file changed on disk. Reopen the document before saving.');
  fs.accessSync(target, fs.constants.W_OK);
  // The indices were produced by Word, so saving refuses to proceed unless
  // Word has confirmed the same paragraph list for this revision.
  exactDocParagraphs(snapshot);
  for (const edit of edits) {
    if (snapshot.paragraphEditability?.[edit.index] === false) {
      throw new Error('This paragraph contains a picture or page break and cannot be edited.');
    }
  }
  if (!edits.length) return { file: { modifiedAt: fs.statSync(target).mtimeMs }, paragraphs: snapshot.paragraphs, snapshot };

  const { copy, directory } = runWordBridge(snapshot, edits);
  const temporary = path.join(path.dirname(target), `.camellia-office-${randomUUID()}.tmp`);
  let replaced = false;
  try {
    const bytes = fs.readFileSync(copy);
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, bytes);
      if (process.platform !== 'win32') fs.fchmodSync(handle, fs.statSync(target).mode & 0o777);
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    if (revision(fs.readFileSync(target)) !== snapshot.revision) throw new Error('The file changed on disk. Reopen the document before saving.');
    fs.renameSync(temporary, target);
    replaced = true;
    const stat = fs.statSync(target);
    const updated = { ...snapshot, path: target, revision: revision(fs.readFileSync(target)) };
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
    if (!replaced) try { fs.unlinkSync(temporary); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { wordBridgeAvailable, readDocSnapshot, exactDocParagraphs, saveDocEdit, convertDocToDocx, clearConvertedDocuments };
