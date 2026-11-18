'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { MAX_TEXT_BYTES, describePreview, savePreviewText, previewKind } = require('../src/main/file-preview');

function editablePreview(filePath) {
  let edit;
  const file = describePreview(filePath, snapshot => { edit = snapshot; return 'test-token'; });
  return { file, edit };
}

test('common files map to built-in preview types', () => {
  assert.equal(previewKind('notes.txt'), 'text');
  assert.equal(previewKind('paper.pdf'), 'pdf');
  assert.equal(previewKind('figure.PNG'), 'image');
  assert.equal(previewKind('demo.mp4'), 'video');
  assert.equal(previewKind('voice.mp3'), 'audio');
  assert.equal(previewKind('archive.zip'), 'unsupported');
  assert.equal(previewKind('Camellia-Android-debug.apk'), 'package');
  assert.equal(previewKind('Camellia-Setup-1.2.3-win-x64.exe'), 'package');
  assert.equal(previewKind('release.DMG'), 'package');
});

test('text previews are bounded and local media receives file URLs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-preview-'));
  t.after(() => removeTree(directory));
  const textPath = path.join(directory, 'notes.txt');
  fs.writeFileSync(textPath, Buffer.alloc(MAX_TEXT_BYTES + 12, 97));
  const { file: text, edit } = editablePreview(textPath);
  assert.equal(text.kind, 'text');
  assert.equal(text.text.length, MAX_TEXT_BYTES);
  assert.equal(text.truncated, true);
  assert.equal(edit, undefined);

  const videoPath = path.join(directory, 'clip.mp4');
  fs.writeFileSync(videoPath, 'fixture');
  const video = describePreview(videoPath);
  assert.equal(video.kind, 'video');
  assert.match(video.url, /^file:\/\//);
  assert.equal(video.name, 'clip.mp4');
});

test('preview saves UTF-8 edits in place and retains the BOM, line endings and mode', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-preview-'));
  t.after(() => removeTree(directory));
  const filePath = path.join(directory, '一页 notes.md');
  fs.writeFileSync(filePath, '\uFEFF# 初稿\r\n第二行\r\n', { mode: 0o640 });
  const mode = fs.statSync(filePath).mode;
  const { file, edit } = editablePreview(filePath);
  assert.equal(file.editToken, 'test-token');
  const saved = savePreviewText(edit, '# 新稿\n加上一行 😀\n');
  assert.equal(saved.file.text, '\uFEFF# 新稿\r\n加上一行 😀\r\n');
  assert.equal(saved.file.size, fs.statSync(filePath).size);
  assert.equal(fs.readFileSync(filePath, 'utf8'), saved.file.text);
  assert.equal(fs.statSync(filePath).mode, mode);
  const blank = savePreviewText(saved.edit, '');
  assert.deepEqual(fs.readFileSync(filePath), Buffer.from('\uFEFF'));
  savePreviewText(blank.edit, 'Restored line\n');
  assert.equal(fs.readFileSync(filePath, 'utf8'), '\uFEFFRestored line\r\n');
  assert.deepEqual(fs.readdirSync(directory), [path.basename(filePath)]);
});

test('incomplete, binary-like and non-UTF-8 previews cannot be edited', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-preview-'));
  t.after(() => removeTree(directory));
  for (const [name, contents] of [['legacy.txt', Buffer.from([0xd6, 0xd0])], ['nul.txt', 'one\0two'], ['picture.svg', '<svg/>']]) {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, contents);
    assert.equal(editablePreview(filePath).file.editToken, undefined, name);
  }
  const filePath = path.join(directory, 'blank.txt');
  fs.writeFileSync(filePath, '');
  const { edit } = editablePreview(filePath);
  assert.throws(() => savePreviewText(edit, 'invalid\0text'), /valid UTF-8/);
  assert.throws(() => savePreviewText(edit, 'é'.repeat(MAX_TEXT_BYTES / 2 + 1)), /exceeds 20 MB/);
  assert.equal(fs.statSync(filePath).size, 0);
  savePreviewText(edit, 'First draft\n');
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'First draft\n');
});

test('preview edits do not overwrite external changes or recreate removed files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-preview-'));
  t.after(() => removeTree(directory));
  const filePath = path.join(directory, 'notes.txt');
  const timestamp = new Date('2026-01-01T00:00:00Z');
  fs.writeFileSync(filePath, 'base');
  fs.utimesSync(filePath, timestamp, timestamp);
  const { file, edit } = editablePreview(filePath);
  fs.writeFileSync(filePath, 'disk');
  fs.utimesSync(filePath, timestamp, timestamp);
  assert.equal(fs.statSync(filePath).mtimeMs, file.modifiedAt);
  assert.throws(() => savePreviewText(edit, 'draft'), /changed on disk/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'disk');
  fs.unlinkSync(filePath);
  assert.throws(() => savePreviewText(edit, 'draft'), /changed on disk/);
  assert.equal(fs.existsSync(filePath), false);
});

test('preview save checks again after staging and cleans up the temporary file on conflict', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-preview-'));
  t.after(() => removeTree(directory));
  const filePath = path.join(directory, 'notes.txt');
  fs.writeFileSync(filePath, 'Original');
  const { edit } = editablePreview(filePath);
  const flush = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', handle => {
    flush(handle);
    fs.writeFileSync(filePath, 'External edit during save');
  });
  assert.throws(() => savePreviewText(edit, 'Editor draft'), /changed on disk/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'External edit during save');
  assert.deepEqual(fs.readdirSync(directory), ['notes.txt']);
});

test('preview identifies directories for opening in the file manager and rejects missing paths', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-preview-'));
  t.after(() => removeTree(directory));
  const folder = path.join(directory, '中文 outputs, with spaces & (brackets).md');
  fs.mkdirSync(folder);
  assert.deepEqual(describePreview(folder), { path: folder, name: path.basename(folder), kind: 'directory' });
  assert.throws(() => describePreview(path.join(directory, 'missing.txt')), /ENOENT/);
});

test('renderer exposes previews only from attachments and successful file outputs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/chat.js'), 'utf8');
  const controls = fs.readFileSync(path.join(__dirname, '../src/renderer/shared/chat-controls.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/workbench.html'), 'utf8');
  assert.doesNotMatch(html, /id="openFileViewer"/);
  assert.doesNotMatch(source, /pickPreviewFile/);
  assert.match(source, /c\.addEventListener\('click', \(\) => void openFilePreview\(a\.path\)\)/);
  assert.match(source, /CamelliaChatControls\.makeToolCard/);
  assert.match(html, /shared\/chat-controls\.js/);
  assert.match(controls, /previewableToolPath/);
  assert.match(controls, /tool-preview-file/);
});
