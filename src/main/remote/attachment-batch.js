'use strict';

const fs = require('node:fs');
const path = require('node:path');
const normalize = value => {
  const text = value.replace(/\\+/g, '/');
  return process.platform === 'win32' ? text.toLowerCase() : text;
};

function hasAttachmentReferences(value, files) {
  const paths = files.map(file => normalize(file.path));
  const visit = value => {
    if (typeof value === 'string') return paths.some(file => normalize(value).includes(file));
    if (Array.isArray(value)) return value.some(visit);
    return value && typeof value === 'object' && Object.entries(value).some(([key, item]) => visit(key) || visit(item));
  };
  return Boolean(visit(value));
}

// Only the files just created by this request can be rolled back. Once a row
// or queue entry is durable, a lost acknowledgement does not release its files.
class AttachmentBatch {
  constructor(root, onError = () => {}) { this.root = path.resolve(root); this.onError = onError; this.files = []; }
  add(files) {
    this.realRoot ||= fs.realpathSync(this.root);
    for (const file of files) {
      const relative = path.relative(this.root, file.path);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Invalid attachment batch path');
      this.files.push({ ...file, relative, stat: fs.lstatSync(file.path) });
    }
    return files;
  }
  rollback(retained) {
    if (!this.files.length) return;
    try { if (retained()) return; }
    catch (error) { this.onError(error); return; } // Uncertain durable state keeps ownership.
    for (const file of this.files) try {
      if (fs.lstatSync(this.root).isSymbolicLink() || fs.realpathSync(this.root) !== this.realRoot
        || fs.realpathSync(file.path) !== path.join(this.realRoot, file.relative)) throw new Error('Attachment path changed during submission');
      const stat = fs.lstatSync(file.path), before = file.stat;
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== before.size || stat.ino !== before.ino
        || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs) throw new Error('Attachment changed during submission');
      fs.unlinkSync(file.path);
      if (file.id && path.basename(path.dirname(file.path)) === file.id) fs.rmdirSync(path.dirname(file.path));
    } catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
  }
}

module.exports = { AttachmentBatch, hasAttachmentReferences };
