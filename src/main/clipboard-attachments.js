'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/svg+xml', '.svg'],
]);

function attachmentDirectory(userData) {
  const directory = path.join(userData, 'clipboard-attachments');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function saveClipboardImage(userData, payload) {
  const mimeType = String(payload?.type || '').toLowerCase();
  const extension = IMAGE_EXTENSIONS.get(mimeType);
  if (!extension) throw new Error('Unsupported clipboard image type');

  const bytes = Buffer.from(payload?.bytes || []);
  if (!bytes.length) throw new Error('Clipboard image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Clipboard image is larger than 25 MB');

  const file = path.join(attachmentDirectory(userData), `pasted-image-${Date.now()}-${randomUUID()}${extension}`);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { path: file, name: path.basename(file), isImage: true };
}

// Long pasted text becomes a readable .txt attachment instead of a very large
// prompt, which engines truncate or reject.
function savePastedText(userData, payload) {
  const text = payload?.text;
  if (typeof text !== 'string') throw new Error('Pasted text is missing');
  if (!text.trim()) throw new Error('Pasted text is empty');
  if (text.length > MAX_TEXT_CHARS) throw new Error('Pasted text is larger than 4 million characters');

  const file = path.join(attachmentDirectory(userData), `pasted-text-${Date.now()}-${randomUUID()}.txt`);
  fs.writeFileSync(file, text, { flag: 'wx', encoding: 'utf8' });
  return { path: file, name: path.basename(file), isImage: false, isText: true, characters: text.length };
}

module.exports = { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, MAX_TEXT_CHARS, saveClipboardImage, savePastedText };
