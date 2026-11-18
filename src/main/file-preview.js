'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus']);
// Installable application artifacts. They cannot be previewed inline, but they
// are the deliverable of a build turn, so they must not be discarded as noise.
const PACKAGE_EXTENSIONS = new Set(['.apk', '.aab', '.ipa', '.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage']);
// The pre-2007 `.doc`, `.xls` and `.ppt` files are OLE2 compound binaries rather
// than ZIP archives, so each has a dedicated reader: a BIFF decoder for
// workbooks, a FIB/piece-table decoder for Word, and a record-tree decoder for
// PowerPoint. `.doc`/`.ppt` keep their `document` kind so artifact ordering and
// the remote list stay unchanged; the preview handler routes them by extension.
const LEGACY_DOCUMENT_EXTENSIONS = new Set(['.doc', '.ppt']);
const BIFF_SPREADSHEET_EXTENSIONS = new Set(['.xls']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.scss',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.csv', '.tsv', '.sql',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh',
  '.ps1', '.bat', '.cmd', '.dockerfile', '.gitignore', '.env', '.tex', '.rst', '.vue', '.svelte',
]);

function previewKind(filePath) {
  const name = path.basename(filePath).toLowerCase();
  const extension = path.extname(name);
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'word';
  if (extension === '.pptx') return 'presentation';
  if (extension === '.xlsx') return 'spreadsheet';
  if (BIFF_SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (PACKAGE_EXTENSIONS.has(extension)) return 'package';
  if (LEGACY_DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (TEXT_EXTENSIONS.has(extension) || ['dockerfile', 'makefile', 'license', 'readme'].includes(name)) return 'text';
  return 'unsupported';
}

function readPreviewText(filePath) {
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw new Error('The selected path is not a file.');
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, MAX_TEXT_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(handle, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    return { stat, bytes: buffer.subarray(0, Math.min(length, MAX_TEXT_BYTES)), truncated: stat.size > MAX_TEXT_BYTES || length > MAX_TEXT_BYTES };
  } finally { fs.closeSync(handle); }
}

function textRevision(stat, bytes) {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${createHash('sha256').update(bytes).digest('hex')}`;
}

function editableTarget(filePath, { stat, bytes, truncated }) {
  if (truncated || stat.size !== bytes.length || !isUtf8(bytes) || bytes.includes(0)) return null;
  try {
    const target = fs.realpathSync.native(filePath);
    fs.accessSync(target, fs.constants.W_OK);
    return { path: filePath, target, revision: textRevision(stat, bytes) };
  } catch { return null; }
}

function readUnchangedText(edit) {
  let current;
  try {
    if (fs.realpathSync.native(edit.path) === edit.target) current = readPreviewText(edit.target);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
  }
  if (!current || current.truncated || current.stat.size !== current.bytes.length || textRevision(current.stat, current.bytes) !== edit.revision) {
    throw new Error('The file changed on disk. Copy your edits and reopen the file before saving.');
  }
  return current;
}

function savePreviewText(edit, text) {
  if (typeof text !== 'string' || !text.isWellFormed() || text.includes('\0')) throw new Error('Enter valid UTF-8 text without null characters.');
  if (text.length > MAX_TEXT_BYTES) throw new Error('The edited file exceeds 20 MB.');
  const current = readUnchangedText(edit);
  const source = current.bytes.toString('utf8');
  const lineEnding = edit.lineEnding || source.match(/\r\n?|\n/)?.[0] || '\n';
  const savedText = (source.startsWith('\uFEFF') ? '\uFEFF' : '') + text.replace(/\r\n?|\n/g, lineEnding);
  const size = Buffer.byteLength(savedText);
  if (size > MAX_TEXT_BYTES) throw new Error('The edited file exceeds 20 MB.');
  const file = { text: savedText, size, modifiedAt: current.stat.mtimeMs };
  if (savedText === source) return { edit, file };

  fs.accessSync(edit.target, fs.constants.W_OK);
  const bytes = Buffer.from(savedText);
  const temporary = path.join(path.dirname(edit.target), `.camellia-preview-${randomUUID()}.tmp`);
  const handle = fs.openSync(temporary, 'wx', 0o600);
  let replaced = false;
  try {
    let stat;
    try {
      fs.writeFileSync(handle, bytes);
      if (process.platform !== 'win32') fs.fchmodSync(handle, current.stat.mode & 0o777);
      fs.fsyncSync(handle);
      stat = fs.fstatSync(handle);
    } finally { fs.closeSync(handle); }
    const updated = { ...edit, lineEnding, revision: textRevision(stat, bytes) };
    readUnchangedText(edit);
    fs.renameSync(temporary, edit.target);
    replaced = true;
    return { edit: updated, file: { ...file, modifiedAt: stat.mtimeMs } };
  } finally {
    if (!replaced) try { fs.unlinkSync(temporary); } catch {}
  }
}

function describePreview(filePath, issueEditToken) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A file path is required.');
  const resolvedPath = path.resolve(filePath);
  const stat = fs.statSync(resolvedPath);
  if (stat.isDirectory()) {
    return { path: resolvedPath, name: path.basename(resolvedPath) || resolvedPath, kind: 'directory' };
  }
  if (!stat.isFile()) throw new Error('The selected path is not a file.');
  const kind = previewKind(resolvedPath);
  const preview = {
    path: resolvedPath,
    name: path.basename(resolvedPath),
    extension: path.extname(resolvedPath).slice(1).toUpperCase(),
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    kind,
    url: pathToFileURL(resolvedPath).href,
  };
  if (kind === 'text') {
    const content = readPreviewText(resolvedPath);
    preview.size = content.stat.size;
    preview.modifiedAt = content.stat.mtimeMs;
    preview.truncated = content.truncated;
    preview.text = content.bytes.toString('utf8');
    const edit = issueEditToken && editableTarget(resolvedPath, content);
    const editToken = edit && issueEditToken(edit);
    if (editToken) preview.editToken = editToken;
  }
  return preview;
}

module.exports = { MAX_TEXT_BYTES, describePreview, savePreviewText, previewKind, LEGACY_DOCUMENT_EXTENSIONS, BIFF_SPREADSHEET_EXTENSIONS };
