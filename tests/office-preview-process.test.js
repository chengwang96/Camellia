'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { removeTree } = require('./test-fs.cjs');
const { renderOfficePreview } = require('../src/main/office-preview-process');

test('the Office worker previews, edits, reorders and renders DOCX cells asynchronously', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-office-worker-'));
  t.after(() => removeTree(root));
  const file = path.join(root, 'worker.docx');
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="word"><w:body>'
    + '<w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>'
    + '</w:body></w:document>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));

  let yielded = false;
  const pending = renderOfficePreview({ type: 'word', filePath: file, language: 'en' });
  setImmediate(() => { yielded = true; });
  const preview = await pending;
  assert.equal(yielded, true);
  assert.match(preview.office.wordHtml, /docx\.renderAsync/);
  assert.deepEqual(preview.snapshot.blocks, ['First', 'Second']);
  assert.equal(preview.editError, '');

  const saved = await renderOfficePreview({ type: 'save', snapshot: preview.snapshot,
    paragraphs: [{ index: 0, text: 'Edited' }] });
  assert.deepEqual(saved.snapshot.blocks, ['Edited', 'Second']);
  const moved = await renderOfficePreview({ type: 'structure', snapshot: saved.snapshot,
    operation: { type: 'move', from: 0, to: 1, position: 'after' } });
  assert.deepEqual(moved.snapshot.blocks, ['Second', 'Edited']);
  const cell = await renderOfficePreview({ type: 'cell', snapshot: moved.snapshot, index: 1 });
  assert.match(cell.html, /Edited/);
  assert.deepEqual(saved.snapshot.blocks, ['Edited', 'Second']);

  const content = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
  assert.match(content, /<w:t>Second<\/w:t><\/w:r><\/w:p><w:p><w:r><w:t xml:space="preserve">Edited<\/w:t>/);
});

test('the edit scan reuses decoded XML instead of reopening the DOCX package', async t => {
  const { readDocxEdit } = require('../src/main/docx-edit');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-office-reuse-'));
  t.after(() => removeTree(root));
  const file = path.join(root, 'reuse.docx');
  const content = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Shared source</w:t></w:r></w:p></w:body></w:document>';
  const zip = new JSZip();
  zip.file('word/document.xml', content);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  t.mock.method(JSZip, 'loadAsync', () => { throw new Error('DOCX package was reopened'); });
  const snapshot = await readDocxEdit(file, { source: fs.readFileSync(file), content });
  assert.deepEqual(snapshot.blocks, ['Shared source']);
});

test('the Office worker enforces the source size limit before reading the file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-office-limit-'));
  t.after(() => removeTree(root));
  const file = path.join(root, 'oversized.docx');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, 100 * 1024 * 1024 + 1);
  await assert.rejects(renderOfficePreview({ type: 'word', filePath: file, language: 'en' }), /too large to preview/);
});

test('the Office worker cancels stale work without rejecting later work', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-office-cancel-'));
  t.after(() => removeTree(root));
  const file = path.join(root, 'cancel.docx');
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Cancel</w:t></w:r></w:p></w:body></w:document>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const controller = new AbortController();
  const pending = renderOfficePreview({ type: 'word', filePath: file, language: 'en' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  const later = await renderOfficePreview({ type: 'word', filePath: file, language: 'en' });
  assert.deepEqual(later.snapshot.blocks, ['Cancel']);
});

test('the Office worker rejects invalid jobs without rejecting later work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-office-worker-error-'));
  t.after(() => removeTree(root));
  const file = path.join(root, 'invalid.doc');
  fs.writeFileSync(file, 'not a Word OLE document');
  assert.deepEqual(await renderOfficePreview({ type: 'legacy', filePath: file }), { office: null });
  await assert.rejects(renderOfficePreview({ type: 'unknown', filePath: file }), /Unsupported Office preview operation/);
  assert.deepEqual(await renderOfficePreview({ type: 'legacy', filePath: file }), { office: null });
});
