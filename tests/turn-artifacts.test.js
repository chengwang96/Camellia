'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { removeTree } = require('./test-fs.cjs');
const { textPaths, toolPaths, toolRoots, toolDirectories, collector } = require('../src/shared/turn-artifacts');
const { resolveArtifacts } = require('../src/main/turn-artifacts');
const { sortArtifacts, documentFormat, VISIBLE_ARTIFACT_LIMIT } = require('../src/shared/turn-artifacts');

test('readable artifacts sort first, stably, without changing the collected order', () => {
  assert.equal(documentFormat({ extension: '.MD' }), 'markdown');
  assert.equal(documentFormat({ extension: '.HTML' }), 'html');
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

test('a reply that names its output folder resolves the bare file names that follow', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-out-'));
  t.after(() => removeTree(cwd));
  t.after(() => removeTree(output));
  const folder = path.join(output, '面试材料');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, '试讲测评表.doc'), 'doc');
  fs.writeFileSync(path.join(folder, '学术评价表.doc'), 'doc');
  fs.writeFileSync(path.join(folder, '自查表.docx'), 'docx');
  // The reply names the folder once, exactly as a platform would render it.
  const text = `**生成的文件**（\`${folder}${path.sep}\`）\n- \`试讲测评表.doc\`\n- \`学术评价表.doc\`\n- \`自查表.docx\``;
  assert.deepEqual(resolveArtifacts({ cwd, text: text.replace(folder, 'missing-folder') }), []);
  const result = resolveArtifacts({ cwd, text });
  assert.deepEqual(sortArtifacts(result).map(file => [file.name, file.kind]), [
    ['试讲测评表.doc', 'document'], ['学术评价表.doc', 'document'], ['自查表.docx', 'word'],
  ]);
  // A folder that only exists relative to some other base must not become one.
  assert.deepEqual(resolveArtifacts({ cwd, text: '`outputs`\n- `试讲测评表.doc`' }), []);
});

test('a reply that names a relative folder resolves the bare file names that follow', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-'));
  t.after(() => removeTree(cwd));
  fs.mkdirSync(path.join(cwd, '.build'));
  fs.writeFileSync(path.join(cwd, '.build', 'review_flat_gallery_ring.png'), 'png');
  fs.writeFileSync(path.join(cwd, '.build', 'review_flat_gallery_loop.png'), 'png');
  fs.mkdirSync(path.join(cwd, 'output'));
  fs.writeFileSync(path.join(cwd, 'output', 'Fig1_01_editorial_ring_flat_tasks_preview.png'), 'png');
  // The folder is named relatively, once, then its bare file names are listed.
  const text = '`.build/` 里还留着 `review_flat_gallery_ring.png` / `review_flat_gallery_loop.png`';
  const result = resolveArtifacts({ cwd, text });
  assert.deepEqual(result.map(file => file.name), ['review_flat_gallery_ring.png', 'review_flat_gallery_loop.png']);
  assert.equal(result[0].path, path.join(cwd, '.build', 'review_flat_gallery_ring.png'));

  // A relative word that is not an existing directory in any base must not
  // widen the search: the file lives only inside `.build/`, so without a real
  // base for it the bare name stays unresolved.
  assert.deepEqual(resolveArtifacts({ cwd, text: '`nodir/`\n- `review_flat_gallery_ring.png`' }), []);
  assert.deepEqual(resolveArtifacts({ cwd, text: '`.build/`\n- `review_flat_gallery_ring.png`' }).map(file => file.name),
    ['review_flat_gallery_ring.png']);
});

test('an absolute path a command used becomes a base for the reply that names its folder', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-'));
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-desktop-'));
  t.after(() => removeTree(cwd));
  t.after(() => removeTree(desktop));
  const folder = path.join(desktop, '东南大学面试材料');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, '王诚-东南面试-v3.pptx'), 'pptx');
  fs.writeFileSync(path.join(folder, '课程试讲_v4.pptx'), 'pptx');
  // A model that never changed directory only leaves the folder in its commands,
  // and its shell escapes the separators it records.
  const quoted = (folder + path.sep).replace(/\\/g, '\\\\');
  const input = { command: `Get-ChildItem -LiteralPath '${quoted}' | Select-Object Name`, cwd };
  // The folder itself is a base, and the run that named it also offers its
  // parent, which keeps a path that actually names a file usable.
  assert.ok(toolDirectories(input).includes(folder));
  // The parent of a file the command read is a base too, and a relative word or
  // a bare option value is never mistaken for an absolute path.
  const file = path.join(folder, '王诚-东南面试-v3.pptx');
  assert.ok(toolDirectories({ command: `python -X utf8 -c "open(r'${file.replace(/\\/g, '\\\\')}')"` }).includes(folder));
  assert.deepEqual(toolDirectories({ command: 'node slides/build_deck.js', cwd }), []);
  assert.deepEqual(toolDirectories('raw command text'), []);

  const state = collector();
  state.capture({ type: 'gui:tool', id: 'one', name: 'commandExecution', input, status: 'completed' });
  assert.ok([...state.roots].includes(folder));

  // The reply names the folder without a path, then lists the bare file names.
  const text = '桌面上的文件夹是 `东南大学面试材料`，里面有 `王诚-东南面试-v3.pptx` 和 `课程试讲_v4.pptx`。';
  assert.deepEqual(resolveArtifacts({ cwd, text }), []);
  const result = resolveArtifacts({ cwd, roots: [...state.roots], text });
  assert.deepEqual(result.map(entry => entry.path), [path.join(folder, '王诚-东南面试-v3.pptx'), path.join(folder, '课程试讲_v4.pptx')]);
});

test('a folder the reply names outranks one only inferred from a command', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-source-'));
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-artifacts-desktop-'));
  t.after(() => removeTree(cwd));
  t.after(() => removeTree(source));
  t.after(() => removeTree(desktop));
  const filled = path.join(desktop, '面试材料');
  fs.mkdirSync(filled);
  fs.writeFileSync(path.join(filled, '自查表.docx'), 'filled');
  // The same file name also exists where the command read its template from, so
  // the reply's own folder has to win instead of the first base that matches.
  fs.writeFileSync(path.join(source, '自查表.docx'), 'template');
  const text = `**生成的文件**（\`${filled}${path.sep}\`）\n- \`自查表.docx\``;
  const result = resolveArtifacts({ cwd, roots: [source], text });
  assert.deepEqual(result.map(entry => entry.path), [path.join(filled, '自查表.docx')]);
});
