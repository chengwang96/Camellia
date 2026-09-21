'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus']);
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
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (TEXT_EXTENSIONS.has(extension) || ['dockerfile', 'makefile', 'license', 'readme'].includes(name)) return 'text';
  return 'unsupported';
}

function describePreview(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A file path is required.');
  const resolvedPath = path.resolve(filePath);
  const stat = fs.statSync(resolvedPath);
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
    const handle = fs.openSync(resolvedPath, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES + 1));
      const bytesRead = fs.readSync(handle, bytes, 0, bytes.length, 0);
      preview.truncated = stat.size > MAX_TEXT_BYTES;
      preview.text = bytes.subarray(0, Math.min(bytesRead, MAX_TEXT_BYTES)).toString('utf8');
    } finally { fs.closeSync(handle); }
  }
  return preview;
}

module.exports = { MAX_TEXT_BYTES, describePreview, previewKind };
