'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/svg+xml', '.svg'],
]);

function saveClipboardImage(userData, payload) {
  const mimeType = String(payload?.type || '').toLowerCase();
  const extension = IMAGE_EXTENSIONS.get(mimeType);
  if (!extension) throw new Error('Unsupported clipboard image type');

  const bytes = Buffer.from(payload?.bytes || []);
  if (!bytes.length) throw new Error('Clipboard image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Clipboard image is larger than 25 MB');

  const directory = path.join(userData, 'clipboard-attachments');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `pasted-image-${Date.now()}-${randomUUID()}${extension}`);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { path: file, name: path.basename(file), isImage: true };
}

module.exports = { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, saveClipboardImage };
