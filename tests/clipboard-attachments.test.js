'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { MAX_IMAGE_BYTES, MAX_TEXT_CHARS, saveClipboardImage, savePastedText } = require('../src/main/clipboard-attachments');
const { LONG_PASTE_CHARS, shouldAttach } = require('../src/shared/long-paste');

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

test('only pasted blocks above the threshold become attachments', () => {
  assert.equal(LONG_PASTE_CHARS, 5000);
  assert.equal(shouldAttach('a'.repeat(LONG_PASTE_CHARS - 1)), false);
  assert.equal(shouldAttach('a'.repeat(LONG_PASTE_CHARS)), true);
  assert.equal(shouldAttach('   \n\t  '), false);
  assert.equal(shouldAttach(undefined), false);
});

test('long pasted text is stored as a readable .txt attachment', t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-clipboard-'));
  t.after(() => removeTree(userData));
  const text = '会议纪要\n'.repeat(LONG_PASTE_CHARS) ;
  const attachment = savePastedText(userData, { text });
  assert.equal(attachment.isImage, false);
  assert.equal(attachment.isText, true);
  assert.equal(attachment.characters, text.length);
  assert.match(attachment.name, /^pasted-text-.*\.txt$/);
  assert.equal(fs.readFileSync(attachment.path, 'utf8'), text);
  assert.equal(path.dirname(attachment.path), path.join(userData, 'clipboard-attachments'));
});

test('pasted text storage rejects empty and oversized payloads', t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-clipboard-'));
  t.after(() => removeTree(userData));
  assert.throws(() => savePastedText(userData, { text: '   ' }), /empty/);
  assert.throws(() => savePastedText(userData, {}), /missing/);
  assert.throws(() => savePastedText(userData, { text: 'a'.repeat(MAX_TEXT_CHARS + 1) }), /4 million/);
});

test('the composer turns long pastes into attachments and keeps short ones inline', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
  assert.match(source, /if \(!files\.length\) \{\s*await attachLongPastedText\(e\);[\s\S]*?\n\s*return;/);
  assert.match(source, /if \(goalUI\.isDraft\(\)\) return;[\s\S]*?if \(!window\.CamelliaLongPaste\.shouldAttach\(text\)\) return;[\s\S]*?savePastedText/);
  assert.match(source, /insertPlainText\(text\)[\s\S]*?Could not save the pasted text\./);
  assert.match(source, /input\.setRangeText\(text, start, end, 'end'\);[\s\S]*?renderSlash\(\)/);
});
