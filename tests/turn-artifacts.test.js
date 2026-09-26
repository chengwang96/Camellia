'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { removeTree } = require('./test-fs.cjs');
const { textPaths, toolPaths, toolRoots, collector } = require('../src/shared/turn-artifacts');
const { resolveArtifacts } = require('../src/main/turn-artifacts');
const { sortArtifacts, documentFormat, VISIBLE_ARTIFACT_LIMIT } = require('../src/shared/turn-artifacts');

test('readable artifacts sort first, stably, without changing the collected order', () => {
  const files = [
    { name: 'main.js', kind: 'text' }, { name: 'report.pdf', kind: 'pdf' },
    { name: 'README.MD', kind: 'text' }, { name: 'figure.png', kind: 'image' },
    { name: 'demo.mp4', kind: 'video' }, { name: 'slides.pptx', kind: 'presentation' },
    { name: 'report.html', kind: 'text' }, { name: 'notes.markdown', kind: 'text' },
    { name: 'legacy.htm', kind: 'text' }, { name: 'test.js', kind: 'text' },
  ];
  const original = [...files];
  assert.deepEqual(sortArtifacts(files).map(file => file.name), [
    'README.MD', 'figure.png', 'demo.mp4', 'slides.pptx', 'report.html', 'notes.markdown', 'legacy.htm', 'report.pdf', 'main.js', 'test.js',
  ]);
  assert.deepEqual(files, original);
  assert.deepEqual(sortArtifacts([{ name: 'report.pdf', kind: 'pdf' }, { name: 'app-debug.apk', kind: 'package' },
    { name: 'figure.png', kind: 'image' }]).map(file => file.name), ['app-debug.apk', 'figure.png', 'report.pdf']);
  assert.deepEqual(sortArtifacts([]), []);
  assert.equal(VISIBLE_ARTIFACT_LIMIT, 4);
  assert.equal(documentFormat({ extension: 'HTM' }), 'html');
  assert.equal(documentFormat({ path: 'C:/outputs/report.MARKDOWN' }), 'markdown');
  assert.equal(documentFormat({ name: 'main.js' }), '');
});

test('final file references include spaces, Unicode and links but not web links or code fences', () => {
  assert.deepEqual(textPaths('[报告](<outputs/实验 report.docx>)\n`table.xlsx`\n[web](https://example.com/file.pdf)\n```\n`not.txt`\n```'), ['outputs/实验 report.docx', 'table.xlsx']);
  assert.deepEqual(textPaths('[报告](outputs/report(final).pdf)已生成。'), ['outputs/report(final).pdf']);
  assert.deepEqual(toolPaths('Read', { path: 'input.pdf' }), []);
  assert.deepEqual(toolPaths('apply_patch', '*** Begin Patch\n*** Add File: new.txt\n*** Update File: old.md\n*** Delete File: removed.txt'), ['new.txt', 'old.md']);
  assert.deepEqual(toolPaths('fileChange', { changes: [{ path: 'new.svg', kind: 'add' }, { path: 'gone.svg', kind: 'delete' }] }), ['new.svg']);
});

test('only successful writes become tool artifacts across event formats', () => {
  const state = collector();
  state.capture({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Write', input: { file_path: 'report.txt' } }] } });
  assert.equal(state.paths.size, 0);
  state.capture({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'done' }] } });
  state.capture({ type: 'gui:tool', id: 'two', name: 'write_file', input: { path: 'failed.txt' }, status: 'failed' });
  state.capture({ type: 'gui:tool', id: 'three', name: 'write_file', input: { path: 'cancelled.txt' }, status: 'cancelled' });
  state.capture({ type: 'gui:tool', id: 'four', name: 'write_file', input: { path: 'plot.svg' }, status: 'in_progress' });
  state.capture({ type: 'gui:tool', id: 'four', status: 'completed' });
  assert.deepEqual([...state.paths], ['report.txt', 'plot.svg']);
});

test('artifacts resolve against the workspace and are existing, supported, deduplicated files', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-'));
  t.after(() => removeTree(cwd));
  const file = path.join(cwd, '实验 report.pdf');
  fs.writeFileSync(file, 'pdf');
  fs.writeFileSync(path.join(cwd, 'report.docx'), 'fixture');
  fs.writeFileSync(path.join(cwd, 'archive.zip'), 'fixture');
  fs.mkdirSync(path.join(cwd, 'directory.txt'));
  const result = resolveArtifacts({ cwd, paths: [file, pathToFileURL(file).href, './实验 report.pdf', 'missing.txt', 'archive.zip', 'directory.txt'],
    text: '`report.docx` [report](%E5%AE%9E%E9%AA%8C%20report.pdf)' });
  assert.deepEqual(result.map(entry => entry.kind), ['pdf', 'word']);
  assert.equal(result[0].path, file);
  assert.equal(result[0].size, 3);
  assert.deepEqual(resolveArtifacts({ paths: ['report.docx'] }), []);
  assert.deepEqual(resolveArtifacts({ cwd, paths: ['https://example.com/report.pdf'] }), []);
});

test('edited source and configuration are not deliverables unless explicitly linked without line numbers', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-'));
  t.after(() => removeTree(cwd));
  const paths = ['main.js', 'main.test.js', 'package.json', 'debug.log', 'helper.py',
    'report.md', 'page.html', 'figure.png', 'video.mp4', 'slides.pptx', 'data.csv', 'notes.txt'];
  for (const file of paths) fs.writeFileSync(path.join(cwd, file), 'fixture');
  const result = resolveArtifacts({ cwd, paths, text: '`main.js:12` [test](main.test.js#L3) [script](helper.py)' });
  assert.deepEqual(sortArtifacts(result).map(file => file.name), [
    'report.md', 'page.html', 'figure.png', 'video.mp4', 'slides.pptx', 'data.csv', 'notes.txt', 'helper.py',
  ]);
  assert.deepEqual(resolveArtifacts({ cwd, paths: ['main.js', 'package.json', 'debug.log'] }), []);
  assert.deepEqual(resolveArtifacts({ cwd, text: '`main.test.js` `package.json` `debug.log`' }), []);
  const restored = resolveArtifacts({ cwd, paths: result.map(file => file.path), text: '[script](helper.py)' });
  assert.deepEqual(restored, result);
  assert.deepEqual(resolveArtifacts({ cwd, text: '`main.js:12:5` [source](main.js#L12C5)' }), []);
});

test('built application packages stay deliverables instead of being discarded as unsupported', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-'));
  t.after(() => removeTree(cwd));
  const apk = path.join(cwd, 'dist/Camellia-Android-0.3.27-debug.apk');
  for (const file of ['android/README.md', 'dist/Camellia-Android-0.3.27-debug.apk']) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), 'fixture');
  }
  const result = resolveArtifacts({ cwd, paths: ['android/README.md'], text: '- `dist/Camellia-Android-0.3.27-debug.apk`' });
  assert.deepEqual(sortArtifacts(result).map(file => [file.name, file.kind]), [
    ['Camellia-Android-0.3.27-debug.apk', 'package'], ['README.md', 'text'],
  ]);
  assert.equal(sortArtifacts(result)[0].extension, 'APK');
  assert.equal(result.find(file => file.kind === 'package').path, apk);
});

test('a turn that worked outside the workspace still yields its deliverables', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-root-'));
  t.after(() => removeTree(cwd));
  t.after(() => removeTree(project));
  fs.mkdirSync(path.join(project, 'outputs'));
  fs.writeFileSync(path.join(project, 'outputs', 'UDP与TCP试讲.pptx'), 'pptx');
  fs.writeFileSync(path.join(project, 'outputs', 'UDP与TCP试讲.pdf'), 'pdf');
  const state = collector();
  state.capture({ type: 'gui:tool', id: 'one', name: 'commandExecution',
    input: { command: 'node slides/build_deck.js', cwd: project }, status: 'completed' });
  assert.deepEqual([...state.roots], [project]);
  assert.deepEqual(toolRoots({ cwd: project, command: 'x' }), [project]);
  assert.deepEqual(toolRoots('raw command text'), []);

  // Reply text uses the platform's own separator, as a native command would.
  const reference = name => path.join('outputs', name);
  const text = `- \`${reference('UDP与TCP试讲.pptx')}\` 可编辑\n- \`${reference('UDP与TCP试讲.pdf')}\` 放映用`;
  assert.deepEqual(resolveArtifacts({ cwd, text }), []);
  const result = resolveArtifacts({ cwd, roots: [...state.roots], text });
  assert.deepEqual(result.map(file => file.name), ['UDP与TCP试讲.pptx', 'UDP与TCP试讲.pdf']);
  assert.equal(result[0].path, path.join(project, 'outputs', 'UDP与TCP试讲.pptx'));
});
