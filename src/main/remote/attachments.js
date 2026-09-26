'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail } = require('./access');

const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
function attachmentName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 180 || /[\\/\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value) || value === '.' || value === '..') fail(400, 'Invalid attachment name');
  return value;
}
function decodeAttachments(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 9) fail(400, 'Provide 1 to 9 attachments');
  let total = 0;
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['name', 'data', 'isImage'].includes(key))) fail(400, 'Invalid attachment');
    const name = attachmentName(entry.name);
    if (typeof entry.data !== 'string' || entry.data.length > Math.ceil(MAX_FILE / 3) * 4 || entry.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) fail(400, 'Invalid attachment encoding');
    const bytes = Buffer.from(entry.data, 'base64');
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_TOTAL || bytes.toString('base64') !== entry.data) fail(413, 'Attachments exceed the 8 MiB limit');
    if (typeof entry.isImage !== 'boolean') fail(400, 'Invalid image flag');
    if (entry.isImage && !(bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217)) fail(400, 'Image attachments must be JPEG');
    return { name, bytes, isImage: entry.isImage };
  });
}
function storeAttachments({ directory, deviceId, requestId, entries }) {
  const decoded = decodeAttachments(entries);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(409, 'Attachment storage is unavailable');
  let used = 0;
  for (const name of fs.readdirSync(directory)) {
    const entry = fs.lstatSync(path.join(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink()) fail(409, 'Attachment storage contains unsupported entries');
    used += entry.size;
  }
  if (used + decoded.reduce((sum, entry) => sum + entry.bytes.length, 0) > 256 * 1024 * 1024) fail(409, 'Attachment storage is full; clean up on the server');
  const written = [];
  try {
    for (const [index, entry] of decoded.entries()) {
      const extension = entry.isImage ? '.jpg' : /^\.[a-zA-Z0-9]{1,12}$/.test(path.extname(entry.name)) ? path.extname(entry.name) : '.bin';
      const file = path.join(directory, createHash('sha256').update(`${deviceId}:${requestId}:${index}`).digest('hex') + extension);
      fs.writeFileSync(file, entry.bytes, { flag: 'wx', mode: 0o600 });
      written.push({ path: file, name: entry.name, isImage: entry.isImage });
    }
    return written;
  } catch (error) { for (const entry of written) fs.unlinkSync(entry.path); throw error; }
}

module.exports = { MAX_FILE, MAX_TOTAL, attachmentName, decodeAttachments, storeAttachments };
