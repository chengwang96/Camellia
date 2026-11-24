'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail } = require('./access');

const MAX_COUNT = 20;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_IMAGE_DOWNLOAD = 25 * 1024 * 1024;
// Desktop pastes accept images up to 25 MiB. A phone can display them as
// thumbnails, but their bytes must still be served through the same bounded
// attachment route as files uploaded from the phone.
const MAX_DESKTOP_IMAGE = MAX_IMAGE_DOWNLOAD;
// Base64 plus JSON metadata for a full 32 MiB mobile selection.
const MAX_REQUEST = 48 * 1024 * 1024;
const MANAGED_ROOT_FOLDERS = ['device-attachments', 'mobile-images', 'handoffs', 'clipboard-attachments'];
function attachmentName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 180 || /[\\/\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value) || value === '.' || value === '..') fail(400, 'Invalid attachment name');
  return value;
}
function decodeAttachments(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_COUNT) fail(400, `Provide 1 to ${MAX_COUNT} attachments`);
  let total = 0;
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['name', 'data', 'isImage'].includes(key))) fail(400, 'Invalid attachment');
    const name = attachmentName(entry.name);
    if (typeof entry.data !== 'string' || entry.data.length > Math.ceil(MAX_FILE / 3) * 4 || entry.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) fail(400, 'Invalid attachment encoding');
    const bytes = Buffer.from(entry.data, 'base64');
    total += bytes.length;
    if (bytes.length > MAX_FILE) fail(413, 'Document exceeds the 10 MiB limit');
    if (total > MAX_TOTAL) fail(413, 'Attachments exceed the 32 MiB total limit');
    if (bytes.toString('base64') !== entry.data) fail(400, 'Invalid attachment encoding');
    if (typeof entry.isImage !== 'boolean') fail(400, 'Invalid image flag');
    if (entry.isImage && bytes.length > MAX_IMAGE) fail(413, 'Image exceeds the 4 MiB limit');
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
      written.push({ path: file, name: entry.name, isImage: entry.isImage, size: entry.bytes.length });
    }
    return written;
  } catch (error) { for (const entry of written) fs.unlinkSync(entry.path); throw error; }
}

async function storeDecodedAttachments({ directory, deviceId, requestId, decoded }) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(409, 'Attachment storage is unavailable');
  let used = 0;
  for (const name of await fs.promises.readdir(directory)) {
    const entry = await fs.promises.lstat(path.join(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink()) fail(409, 'Attachment storage contains unsupported entries');
    used += entry.size;
  }
  if (used + decoded.reduce((sum, entry) => sum + entry.bytes.length, 0) > 256 * 1024 * 1024) fail(409, 'Attachment storage is full; clean up on the server');
  const written = [];
  try {
    for (const [index, entry] of decoded.entries()) {
      const extension = entry.isImage ? '.jpg' : /^\.[a-zA-Z0-9]{1,12}$/.test(path.extname(entry.name)) ? path.extname(entry.name) : '.bin';
      const file = path.join(directory, createHash('sha256').update(`${deviceId}:${requestId}:${index}`).digest('hex') + extension);
      await fs.promises.writeFile(file, entry.bytes, { flag: 'wx', mode: 0o600 });
      written.push({ path: file, name: entry.name, isImage: entry.isImage, size: entry.bytes.length });
    }
    return written;
  } catch (error) {
    for (const entry of written) try { await fs.promises.unlink(entry.path); } catch {}
    throw error;
  }
}

async function storeAttachmentsAsync({ directory, deviceId, requestId, entries }) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_COUNT) fail(400, `Provide 1 to ${MAX_COUNT} attachments`);
  const decoded = [];
  let total = 0;
  for (const entry of entries) {
    const decodedEntry = decodeAttachments([entry])[0];
    total += decodedEntry.bytes.length;
    if (total > MAX_TOTAL) fail(413, 'Attachments exceed the 32 MiB total limit');
    decoded.push(decodedEntry);
    await new Promise(resolve => setImmediate(resolve));
  }
  return storeDecodedAttachments({ directory, deviceId, requestId, decoded });
}

async function storeImagesAsync({ directory, deviceId, requestId, images }) {
  if (!Array.isArray(images) || !images.length || images.length > MAX_COUNT) fail(400, `Provide 1 to ${MAX_COUNT} images`);
  const decoded = [];
  let total = 0;
  for (const [index, image] of images.entries()) {
    if (typeof image !== 'string' || image.length > Math.ceil(MAX_IMAGE / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) fail(400, 'Invalid image');
    const bytes = Buffer.from(image, 'base64');
    if (bytes.length > MAX_IMAGE || bytes.length < 4 || bytes.toString('base64') !== image || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail(400, 'JPEG image required');
    total += bytes.length;
    if (total > MAX_TOTAL) fail(413, 'Images exceed the 32 MiB total limit');
    decoded.push({ name: `mobile-image-${index + 1}.jpg`, bytes, isImage: true });
    await new Promise(resolve => setImmediate(resolve));
  }
  return storeDecodedAttachments({ directory, deviceId, requestId, decoded });
}

function storedAttachmentRoot({ root, source, managedRoot } = {}) {
  if (typeof source !== 'string' || !path.isAbsolute(source)) return null;
  const inside = (base, folders) => {
    const relative = path.relative(path.resolve(base), path.resolve(source));
    return Boolean(relative) && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
      && folders.includes(relative.split(path.sep)[0]);
  };
  if (inside(root, ['device-attachments', 'mobile-images', 'handoffs'])) return path.resolve(root);
  if (managedRoot && inside(managedRoot, ['clipboard-attachments'])) return path.resolve(managedRoot);
  return null;
}

async function openStoredAttachment({ root, managedRoot, file }) {
  const source = typeof file?.path === 'string' ? file.path : file?.fullPath;
  if (typeof source !== 'string' || typeof file?.name !== 'string') fail(404, 'Attachment not found');
  const selected = storedAttachmentRoot({ root, source, managedRoot });
  if (!selected) fail(404, 'Attachment not found');
  let canonicalRoot, canonical;
  try {
    canonicalRoot = await fs.promises.realpath(selected);
    canonical = await fs.promises.realpath(source);
  } catch {
    fail(404, 'Attachment unavailable; refresh the conversation');
  }
  const relative = path.relative(canonicalRoot, canonical);
  const folder = relative.split(path.sep)[0];
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)
    || !MANAGED_ROOT_FOLDERS.includes(folder)) {
    fail(404, 'Attachment not found');
  }
  const maximum = folder === 'clipboard-attachments'
    ? file.isImage === true ? MAX_DESKTOP_IMAGE : MAX_FILE
    : file.isImage === true ? MAX_IMAGE : MAX_FILE;
  let handle;
  try {
    // The handle must name the file that was validated, not a symlink that was
    // swapped in after realpath(). O_NOFOLLOW is not available everywhere, so
    // compare the opened inode with the one that was resolved as well.
    handle = await fs.promises.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    const resolved = await fs.promises.stat(canonical);
    if (!stat.isFile() || stat.dev !== resolved.dev || stat.ino !== resolved.ino) fail(404, 'Attachment not found');
    if (!stat.isFile() || stat.size > maximum) fail(404, 'Attachment unavailable; refresh the conversation');
    return { handle, size: stat.size, name: file.name, isImage: file.isImage === true };
  } catch (error) {
    await handle?.close();
    if (error.status) throw error;
    fail(404, 'Attachment unavailable; refresh the conversation');
  }
}

module.exports = { MAX_COUNT, MAX_IMAGE, MAX_IMAGE_DOWNLOAD, MAX_FILE, MAX_TOTAL, MAX_REQUEST, attachmentName, decodeAttachments, storeAttachments, storeAttachmentsAsync, storeImagesAsync,
  storedAttachmentRoot, openStoredAttachment };
