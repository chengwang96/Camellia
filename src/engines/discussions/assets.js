'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const digest = data => createHash('sha256').update(data).digest('hex');
const MAX_FILE = 32 * 1024 * 1024;
function validateAttachments(list, maxCount = 16) {
  if (!Array.isArray(list) || list.length > maxCount) throw new Error(maxCount === 16 ? 'Choose at most 16 attachments.' : 'This discussion has too many attachments for one native context. Start a new group with the files needed for this task.');
  const ids = new Set();
  for (const file of list) {
    if (!file || typeof file.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(file.id) || ids.has(file.id)
      || typeof file.path !== 'string' || !path.isAbsolute(file.path) || file.path.includes('\0')
      || typeof file.name !== 'string' || !file.name || file.name.length > 255 || path.basename(file.name) !== file.name
      || file.isImage !== Boolean(IMAGE_TYPES[path.extname(file.name).toLowerCase()]) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE
      || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('Invalid discussion attachment.');
    ids.add(file.id);
  }
  if (list.filter(file => maxCount === 16 || file.isImage).reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024)
    throw new Error('Attachments exceed 128 MB.');
  return list;
}
class DiscussionAssets {
  constructor(root) { this.root = path.resolve(root, 'assets'); }
  importData(groupId, entries) {
    if (!Array.isArray(entries) || entries.length > 16) throw new Error('Choose at most 16 attachments.');
    const directory = this.directory(groupId), created = [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || path.basename(entry.name) !== entry.name || /[\\/\x00-\x1f]/.test(entry.name)
        || !Buffer.isBuffer(entry.bytes) || entry.bytes.length > MAX_FILE
        || entry.isImage !== Boolean(IMAGE_TYPES[path.extname(entry.name).toLowerCase()])) throw new Error('Invalid discussion attachment.');
    }
    try {
      return entries.map(entry => {
        const id = randomUUID(), dir = path.join(directory, id), target = path.join(dir, entry.name);
        fs.mkdirSync(dir, { recursive: true });
        if (fs.realpathSync(dir) !== path.join(fs.realpathSync(this.root), groupId, id)) throw new Error('Invalid discussion attachment directory.');
        created.push(dir); fs.writeFileSync(target, entry.bytes, { flag: 'wx', mode: 0o600 });
        return { id, path: target, name: entry.name, isImage: entry.isImage, size: entry.bytes.length, sha256: digest(entry.bytes) };
      });
    } catch (error) {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  directory(groupId) {
    if (typeof groupId !== 'string' || !/^[0-9a-f-]{36}$/i.test(groupId)) throw new Error('Invalid discussion ID');
    return path.join(this.root, groupId);
  }
  import(groupId, paths) {
    const directory = this.directory(groupId);
    if (!Array.isArray(paths) || paths.length > 16) throw new Error('Choose at most 16 attachments.');
    const sources = paths.map(source => {
      if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Choose a local file.');
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Each attachment must be a file of at most 32 MB.');
      const name = path.basename(source), ext = path.extname(name).toLowerCase();
      if (['.svg', '.bmp'].includes(ext)) throw new Error('Use PNG, JPEG, GIF or WebP for image input.');
      return { source, name, stat, ext };
    });
    if (sources.reduce((size, source) => size + source.stat.size, 0) > 128 * 1024 * 1024) throw new Error('Attachments exceed 128 MB.');
    return sources.map(({ source, name, ext }) => {
      const id = randomUUID(), dir = path.join(directory, id), target = path.join(dir, name);
      const data = fs.readFileSync(source);
      if (data.length > MAX_FILE) throw new Error('Attachment changed while reading.');
      fs.mkdirSync(dir, { recursive: true });
      if (fs.realpathSync(dir) !== path.join(fs.realpathSync(this.root), groupId, id)) throw new Error('Invalid discussion attachment directory.');
      fs.writeFileSync(target, data, { flag: 'wx' });
      return { id, path: target, name, isImage: Boolean(IMAGE_TYPES[ext]), size: data.length, sha256: digest(data) };
    });
  }
  resolve(groupId, list, maxCount = 16) {
    validateAttachments(list, maxCount);
    const directory = this.directory(groupId);
    for (const file of list) {
      const expected = path.join(directory, file.id, file.name);
      if (path.resolve(file.path) !== expected || fs.realpathSync(file.path) !== path.join(fs.realpathSync(this.root), groupId, file.id, file.name))
        throw new Error('Attachment does not belong to this discussion.');
      const stat = fs.lstatSync(expected);
      if (!stat.isFile() || stat.size !== file.size || stat.nlink !== 1) throw new Error('A saved attachment changed or is missing. Add it again before sending.');
      const data = fs.readFileSync(expected);
      if (data.length !== file.size || digest(data) !== file.sha256) throw new Error('A saved attachment changed or is missing. Add it again before sending.');
    }
    return structuredClone(list);
  }
  remove(groupId) {
    const directory = this.directory(groupId);
    if (!fs.existsSync(directory)) return;
    const expected = path.join(fs.realpathSync(this.root), groupId);
    if (fs.realpathSync(directory) !== expected || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Invalid discussion attachment directory.');
    // Only the validated, discussion-owned copies; source files and work products remain intact.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { DiscussionAssets, validateAttachments, IMAGE_TYPES };
