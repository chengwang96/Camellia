'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { searchFiles } = require('../src/main/file-search');
const { searchContents } = require('../src/main/file-search');
const { extractText } = require('../src/main/file-text');

const rendererSource = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const rendererMarkup = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.html'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/chat-runtime.js'), 'utf8');

test('/find is wired into the desktop composer and the phone command surface', () => {
  assert.match(rendererMarkup, /id="findRow"/);
  assert.match(rendererSource, /id: 'find', label: '\/find'/);
  assert.match(rendererSource, /findUI\.run\(text\)/);
  assert.match(rendererSource, /chatApi\.find\(\{ sessionId: context\.sessionId \|\| null/);
  assert.match(runtimeSource, /'ControlRespond', 'Find'/);
  // The phone can discover the command and the desktop still answers a typed
  // one, so an older client keeps working.
  const android = fs.readFileSync(path.join(__dirname, '../android/app/src/main/java/app/camellia/mobile/MainActivity.java'), 'utf8');
  assert.match(android, /composer\.setText\("\/find "\)/);
  const commands = fs.readFileSync(path.join(__dirname, '../src/main/remote/commands.js'), 'utf8');
  assert.match(commands, /\^\\\/find\(\?:\\s\|\$\)/i);
});

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-find-'));
  t.after(() => removeTree(cwd));
  const write = (relative, body = 'fixture') => {
    const file = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  write('outputs/UDP与TCP试讲.pptx');
  write('outputs/UDP与TCP试讲.pdf');
  write('notes/report-2024.md');
  write('notes/report-2025.md');
  write('media/demo.mp4');
  write('src/main.js');
  write('archive/备份.zip');
  write('node_modules/left-pad/index.js');
  write('dist/app.exe');
  write('package-lock.json');
  return { cwd, write };
}

test('a natural language query matches file names across the workspace', t => {
  const { cwd } = fixture(t);
  const found = searchFiles({ query: 'report', cwd });
  assert.deepEqual(found.results.map(file => file.name).sort(), ['report-2024.md', 'report-2025.md']);
  assert.equal(found.roots.length, 1);
  assert.equal(found.roots[0], fs.realpathSync.native(cwd));
  // Every path is quoted so the artifact panels can pick it up.
  for (const file of found.results) assert.ok(found.text.includes('`' + file.path + '`'));
});

test('queries accept extensions, wildcards and non-ASCII names', t => {
  const { cwd } = fixture(t);
  assert.deepEqual(searchFiles({ query: '.pptx', cwd }).results.map(file => file.name), ['UDP与TCP试讲.pptx']);
  assert.deepEqual(searchFiles({ query: '试讲', cwd }).results.map(file => file.name).sort(),
    ['UDP与TCP试讲.pdf', 'UDP与TCP试讲.pptx']);
  assert.deepEqual(searchFiles({ query: 'report-*', cwd }).results.map(file => file.name).sort(),
    ['report-2024.md', 'report-2025.md']);
});

test('the default walk skips noise while an explicit request still reaches it', t => {
  const { cwd } = fixture(t);
  assert.deepEqual(searchFiles({ query: 'index.js', cwd }).results, []);
  assert.deepEqual(searchFiles({ query: 'left-pad', cwd }).results, []);
  assert.deepEqual(searchFiles({ query: 'main.js', cwd }).results.map(file => path.basename(path.dirname(file.path))), ['src']);
  // A directly named package is still a deliverable, so `dist/` is searched
  // even though builds are skipped by default.
  assert.deepEqual(searchFiles({ query: 'app.exe', cwd }).results.map(file => file.name), ['app.exe']);
});

test('an unmatched query reports the folders that were searched', t => {
  const { cwd } = fixture(t);
  const found = searchFiles({ query: 'nothing-here-xyz', cwd });
  assert.deepEqual(found.results, []);
  assert.ok(found.text.includes('nothing-here-xyz'));
  assert.ok(found.text.includes(found.roots[0]));
});

test('a match that the artifact list cannot serve is listed without being quoted as downloadable', t => {
  const { cwd } = fixture(t);
  const found = searchFiles({ query: '备份.zip', cwd });
  assert.deepEqual(found.results.map(file => [file.name, file.deliverable]), [['备份.zip', false]]);
  assert.ok(found.text.includes('备份.zip'));
  // Not quoted, so neither artifact panel turns it into a download row.
  assert.ok(!found.text.includes('`' + found.results[0].path + '`'));
  assert.ok(found.text.includes('cannot be offered for download'));
});

test('the workspace folder is searched alongside the conversation directory', t => {
  const { cwd } = fixture(t);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-find-ws-'));
  t.after(() => removeTree(workspace));
  fs.writeFileSync(path.join(workspace, 'handbook.txt'), 'x');
  const found = searchFiles({ query: 'handbook', cwd, workspacePath: workspace });
  assert.deepEqual(found.results.map(file => file.name), ['handbook.txt']);
  assert.equal(found.roots.length, 2);
  // A repeated folder, or one already covered, is not searched twice.
  assert.equal(searchFiles({ query: 'handbook', roots: [workspace, workspace] }).roots.length, 1);
});

test('empty and oversized queries are refused with localized wording', t => {
  const { cwd } = fixture(t);
  assert.throws(() => searchFiles({ query: '   ', cwd }), /Describe the file/);
  assert.throws(() => searchFiles({ query: 'x'.repeat(501), cwd }), /too long/);
  assert.throws(() => searchFiles({ query: '', cwd, language: 'zh-CN' }), /请描述/);
  const found = searchFiles({ query: 'UDP', cwd, language: 'zh-CN' });
  assert.ok(found.text.includes('找到 2 个文件'));
});

test('content search finds a document the user can describe but not name', async t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'notes', 'a7f3-草稿.md'), '# 季度复盘\n\n这次季度营收同比增长两成，渠道成本下降。\n');
  fs.writeFileSync(path.join(cwd, 'notes', 'b91c-其他.md'), '# 无关\n\n这是一份普通记录。\n');
  const found = await searchContents({ query: '季度营收 渠道成本', cwd });
  assert.deepEqual(found.results.map(file => file.name), ['a7f3-草稿.md']);
  assert.match(found.results[0].snippet, /季度营收/);
  // The reply quotes the path so both artifact panels can offer it.
  assert.ok(found.text.includes('`' + found.results[0].path + '`'));
  assert.ok(found.text.includes('Found files containing'));
  // Every term must be present: one shared word is not a match.
  assert.deepEqual((await searchContents({ query: '季度营收 完全不存在', cwd })).results, []);
});

test('content search reads text inside an Office document', async t => {
  const { cwd } = fixture(t);
  const JSZip = require('jszip');
  const deck = new JSZip();
  deck.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  deck.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
  deck.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><a:t>供应商谈判的三大要点</a:t></p:sld>');
  fs.writeFileSync(path.join(cwd, 'outputs', '未命名材料.pptx'), await deck.generateAsync({ type: 'nodebuffer' }));
  assert.match(await extractText(path.join(cwd, 'outputs', '未命名材料.pptx')), /供应商谈判/);
  const found = await searchContents({ query: '供应商谈判', cwd, language: 'zh-CN' });
  assert.deepEqual(found.results.map(file => file.name), ['未命名材料.pptx']);
  assert.ok(found.text.includes('找到了包含'));
});

test('content search skips media and unreadable files instead of failing', async t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 1, 2, 3]));
  fs.writeFileSync(path.join(cwd, 'archive', 'raw.bin'), Buffer.from([0, 1, 0, 2, 0, 3]));
  const found = await searchContents({ query: 'anything', cwd });
  assert.deepEqual(found.results, []);
  assert.equal(await extractText(path.join(cwd, 'media', 'clip.mp4')), '');
  assert.equal(await extractText(path.join(cwd, 'archive', 'raw.bin')), '');
});
