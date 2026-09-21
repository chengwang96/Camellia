'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { MAX_TEXT_BYTES, describePreview, previewKind } = require('../src/main/file-preview');

test('common files map to built-in preview types', () => {
  assert.equal(previewKind('notes.txt'), 'text');
  assert.equal(previewKind('paper.pdf'), 'pdf');
  assert.equal(previewKind('figure.PNG'), 'image');
  assert.equal(previewKind('demo.mp4'), 'video');
  assert.equal(previewKind('voice.mp3'), 'audio');
  assert.equal(previewKind('archive.zip'), 'unsupported');
});

test('text previews are bounded and local media receives file URLs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-preview-'));
  t.after(() => removeTree(directory));
  const textPath = path.join(directory, 'notes.txt');
  fs.writeFileSync(textPath, Buffer.alloc(MAX_TEXT_BYTES + 12, 97));
  const text = describePreview(textPath);
  assert.equal(text.kind, 'text');
  assert.equal(text.text.length, MAX_TEXT_BYTES);
  assert.equal(text.truncated, true);

  const videoPath = path.join(directory, 'clip.mp4');
  fs.writeFileSync(videoPath, 'fixture');
  const video = describePreview(videoPath);
  assert.equal(video.kind, 'video');
  assert.match(video.url, /^file:\/\//);
  assert.equal(video.name, 'clip.mp4');
});

test('preview rejects directories and missing paths', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-preview-'));
  t.after(() => removeTree(directory));
  assert.throws(() => describePreview(directory), /not a file/);
  assert.throws(() => describePreview(path.join(directory, 'missing.txt')), /ENOENT/);
});

test('renderer exposes previews only from attachments and successful file outputs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.html'), 'utf8');
  assert.doesNotMatch(html, /id="openFileViewer"/);
  assert.doesNotMatch(source, /pickPreviewFile/);
  assert.match(source, /c\.addEventListener\('click', \(\) => void openFilePreview\(a\.path\)\)/);
  assert.match(source, /previewableToolPath/);
  assert.match(source, /tool-preview-file/);
});
