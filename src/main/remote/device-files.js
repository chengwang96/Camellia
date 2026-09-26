'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MAX_TOTAL, attachmentName } = require('./attachments');

async function readAttachment(file, nativeImage) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_TOTAL) throw new Error('Each attachment must be a regular file no larger than 8 MiB');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > stat.size) throw new Error('Attachment changed while reading');
    let bytes = buffer.subarray(0, size), name = attachmentName(path.basename(file)), isImage = false;
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('The selected image cannot be decoded');
      const dimensions = image.getSize();
      const scale = Math.min(1, 2048 / Math.max(dimensions.width, dimensions.height));
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(dimensions.width * scale)), height: Math.max(1, Math.round(dimensions.height * scale)), quality: 'best' }) : image;
      bytes = resized.toJPEG(85); name = name.replace(/\.[^.]+$/, '.jpg'); isImage = true;
    }
    if (bytes.length > MAX_TOTAL) throw new Error('Converted attachment is too large');
    return { name, data: bytes.toString('base64'), isImage, size: bytes.length };
  } finally { await handle.close(); }
}

function createAttachmentTray({ now = Date.now } = {}) {
  const entries = new Map();
  function prune() { for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id); }
  return {
    add(deviceId, conversationId, files) {
      prune();
      const size = files.reduce((total, entry) => total + entry.size, 0);
      if (entries.size + files.length > 36 || [...entries.values()].reduce((total, entry) => total + entry.size, 0) + size > 32 * 1024 * 1024) throw new Error('Remove existing attachments before selecting more');
      const added = files.map(file => ({ ...file, id: randomUUID(), deviceId, conversationId, expiresAt: now() + 30 * 60_000 }));
      for (const entry of added) entries.set(entry.id, entry);
      return added.map(({ id, name, size, isImage }) => ({ id, name, size, isImage }));
    },
    resolve(deviceId, conversationId, ids) {
      prune();
      if (!Array.isArray(ids) || !ids.length || ids.length > 9 || new Set(ids).size !== ids.length) throw new Error('Select 1 to 9 attachments');
      const files = ids.map(id => {
        const entry = entries.get(id);
        if (!entry || entry.deviceId !== deviceId || entry.conversationId !== conversationId) throw new Error('Attachment expired or belongs to another device/conversation; select it again');
        return entry;
      });
      if (files.reduce((total, entry) => total + entry.size, 0) > MAX_TOTAL) throw new Error('Attachments exceed 8 MiB total');
      return files.map(({ name, data, isImage }) => ({ name, data, isImage }));
    },
    remove(ids) { if (Array.isArray(ids)) for (const id of ids) entries.delete(id); },
    clear() { entries.clear(); },
  };
}

function downloadName(value) {
  const cleaned = String(value || 'artifact').replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/g, '').slice(0, 160);
  return !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? 'artifact' : cleaned;
}

async function saveDownload({ response, file, expectedSize, signal, onProgress = () => {} }) {
  const limit = 512 * 1024 * 1024;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > limit) { response.destroy(); throw new Error('Artifact exceeds the 512 MiB download limit'); }
  if (response.statusCode !== 200 || response.headers['content-length'] !== String(expectedSize)) { response.destroy(); throw new Error('Artifact changed or is unavailable; refresh the list'); }
  const temporary = path.join(path.dirname(file), `.camellia-download-${randomUUID()}.part`);
  let transferred = 0, lastProgress = 0, created = false;
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600); created = true;
    const stream = handle.createWriteStream();
    try {
      await pipeline(response, new Transform({ transform(chunk, _encoding, callback) {
        transferred += chunk.length;
        if (transferred > expectedSize) { callback(new Error('Artifact size exceeded its listing')); return; }
        if (Date.now() - lastProgress >= 200) { lastProgress = Date.now(); onProgress(transferred, expectedSize); }
        callback(null, chunk);
      } }), stream, { signal });
    } finally { await handle.close(); }
    if (transferred !== expectedSize || signal?.aborted) throw new Error('Download was incomplete or cancelled');
    await fs.promises.rename(temporary, file); created = false;
    onProgress(transferred, expectedSize);
    return { size: transferred };
  } finally {
    response.destroy();
    if (created) await fs.promises.unlink(temporary).catch(() => {});
  }
}

module.exports = { readAttachment, createAttachmentTray, downloadName, saveDownload };
