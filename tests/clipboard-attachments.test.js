'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { MAX_IMAGE_BYTES, saveClipboardImage } = require('../src/main/clipboard-attachments');

test('clipboard paste keeps the in-memory image fallback outside path resolution', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
  assert.match(source, /try \{ p = window\.dshDesktop\.attachmentPath\(f\) \|\| p; \}\s*catch \(_error\)/);
  assert.match(source, /catch \(_error\)[\s\S]*if \(p\)[\s\S]*await f\.arrayBuffer\(\)[\s\S]*saveClipboardImage/);
});

test('clipboard images are persisted as reusable attachments', t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-clipboard-'));
  t.after(() => removeTree(userData));
  const bytes = Buffer.from([137, 80, 78, 71]);
  const attachment = saveClipboardImage(userData, { type: 'image/png', bytes });
  assert.equal(attachment.isImage, true);
  assert.match(attachment.name, /^pasted-image-.*\.png$/);
  assert.deepEqual(fs.readFileSync(attachment.path), bytes);
  assert.equal(path.dirname(attachment.path), path.join(userData, 'clipboard-attachments'));
});

test('clipboard attachment storage rejects invalid image payloads', t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-clipboard-'));
  t.after(() => removeTree(userData));
  assert.throws(() => saveClipboardImage(userData, { type: 'text/plain', bytes: [1] }), /Unsupported/);
  assert.throws(() => saveClipboardImage(userData, { type: 'image/png', bytes: [] }), /empty/);
  assert.throws(() => saveClipboardImage(userData, { type: 'image/png', bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) }), /25 MB/);
});
