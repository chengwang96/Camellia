'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataPackage, importDataPackage, inspectDataPackage, readManifest, FORMAT } = require('../src/main/data-migration');
const { removeTree } = require('./test-fs.cjs');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-migration-'));
  return { root, dataDir: path.join(root, 'app'), home: path.join(root, 'home') };
}

function dispose(box) {
  const resolved = path.resolve(box.root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('camellia-migration-')) {
    throw new Error('Unsafe test cleanup path');
  }
  removeTree(resolved);
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A minimal but representative profile: shared conversations with Goal and
// scheduled task state, an engine native home under the user home, an absolute
// workspace path in config and session metadata, a large streamed file, and
// things that must not travel (dependency junctions and caches).
function seedProfile(box) {
  write(path.join(box.dataDir, 'desktop-config.json'), JSON.stringify({
    dshHome: path.join(box.home, '.dsh'), mode: 'codex', language: 'zh-CN',
    memoryDirectory: path.join(box.root, 'memory'), runtimePaths: {},
  }, null, 2));
  write(path.join(box.dataDir, 'conversations', 'abc.json'), JSON.stringify({
    id: 'abc', segments: [], workspace: { id: 'w1', name: 'Repo', path: path.join(box.home, 'projects', 'repo') },
    sessionCwd: path.join(box.home, 'projects', 'repo'),
    // A project folder outside the profile is an external reference and must
    // not be rewritten to another machine's location.
    externalCwd: path.join(box.root, 'external', 'repo'),
  }));
  write(path.join(box.dataDir, 'conversations', 'abc.jsonl'), '{"seq":1,"role":"user"}\n');
  write(path.join(box.dataDir, 'conversations', 'goals', 'abc.json'), JSON.stringify({ objective: 'keep going', armed: true }));
  write(path.join(box.dataDir, 'conversations', 'tasks', 'task-1.json'), JSON.stringify({ instruction: 'check hourly' }));
  write(path.join(box.dataDir, 'conversations', 'handoffs', 'abc.md'), '# handoff\n');
  write(path.join(box.dataDir, 'dsh-chat', 'conversations', 'abc', 'config.json'), JSON.stringify({ cwd: path.join(box.home, 'projects', 'repo') }));
  write(path.join(box.home, '.dsh', 'ollama-proxy.json'), JSON.stringify({ providers: [{ id: 'test', keys: [{ key: 'secret' }] }] }));
  write(path.join(box.home, '.dsh', 'sessions', 's1.jsonl'), '{"turn":1}\n');
  write(path.join(box.home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  write(path.join(box.home, '.claude', 'projects', 'repo', 's1.jsonl'), '{"type":"user"}\n');
  write(path.join(box.home, '.claude', 'CLAUDE.md'), '# instructions\n');
  write(path.join(box.home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  // Skipped: dependency junctions, engine caches and the download-on-demand runtime tree.
  write(path.join(box.dataDir, 'runtimes', 'codex', 'node_modules', 'x.js'), 'binary');
  write(path.join(box.dataDir, 'dsh-chat', 'conversations', 'abc', 'profiles', 'node_modules', 'y.js'), 'link');
  write(path.join(box.dataDir, 'logs', 'dsh-desktop.log'), 'noise');
  write(path.join(box.home, '.dsh', 'cache', 'blob'), 'cache');
}

test('a data package round-trips, rewrites moved paths and skips caches', async t => {
  const source = scratch();
  const target = scratch();
  try {
    seedProfile(source);
    const packageFile = path.join(source.root, 'camellia-data-test.zip');
    const exported = await createDataPackage({ dataDir: source.dataDir, home: source.home, appVersion: '1.0.0', destination: packageFile });
    assert.equal(exported.files > 0, true);
    assert.equal(fs.existsSync(packageFile), true);
    const { manifest } = await readManifest(packageFile);
    assert.equal(manifest.format, FORMAT);
    assert.equal(manifest.source.appDataDir, source.dataDir);

    const imported = await importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: 'all' });
    assert.equal(imported.restored, exported.files);
    assert.equal(imported.overwritten, 0);
    // Conversations, Goal and scheduled task state survive.
    assert.equal(fs.readFileSync(path.join(target.dataDir, 'conversations', 'abc.jsonl'), 'utf8'), '{"seq":1,"role":"user"}\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'conversations', 'goals', 'abc.json'), 'utf8')).objective, 'keep going');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'conversations', 'tasks', 'task-1.json'), 'utf8')).instruction, 'check hourly');
    // Engine native history and provider keys come across.
    assert.equal(fs.existsSync(path.join(target.home, '.claude', 'projects', 'repo', 's1.jsonl')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.home, '.dsh', 'ollama-proxy.json'), 'utf8')).providers[0].keys[0].key, 'secret');
    // Absolute source paths in metadata now point at the target installation.
    const config = JSON.parse(fs.readFileSync(path.join(target.dataDir, 'desktop-config.json'), 'utf8'));
    assert.equal(config.dshHome, path.join(target.home, '.dsh'));
    const conversation = JSON.parse(fs.readFileSync(path.join(target.dataDir, 'conversations', 'abc.json'), 'utf8'));
    assert.equal(conversation.workspace.path, path.join(target.home, 'projects', 'repo'));
    assert.equal(conversation.sessionCwd, path.join(target.home, 'projects', 'repo'));
    assert.equal(conversation.externalCwd, path.join(source.root, 'external', 'repo'), 'external project paths are preserved');
    // Caches, junctions and the runtime tree do not travel.
    assert.equal(fs.existsSync(path.join(target.dataDir, 'runtimes')), false);
    assert.equal(fs.existsSync(path.join(target.dataDir, 'dsh-chat', 'conversations', 'abc', 'profiles', 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(target.dataDir, 'logs')), false);
    assert.equal(fs.existsSync(path.join(target.home, '.dsh', 'cache')), false);
  } finally { dispose(source); dispose(target); }
});

test('import backs up files it overwrites and can be repeated', async t => {
  const source = scratch();
  const target = scratch();
  try {
    seedProfile(source);
    seedProfile(target);
    write(path.join(target.dataDir, 'conversations', 'abc.jsonl'), '{"seq":99,"role":"user"}\n');
    const packageFile = path.join(source.root, 'camellia-data-test.zip');
    await createDataPackage({ dataDir: source.dataDir, home: source.home, destination: packageFile });
    const imported = await importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: 'all' });
    assert.equal(imported.overwritten > 0, true);
    assert.equal(Boolean(imported.backupDir), true);
    assert.equal(fs.readFileSync(path.join(target.dataDir, 'conversations', 'abc.jsonl'), 'utf8'), '{"seq":1,"role":"user"}\n');
    const backup = path.join(imported.backupDir, 'app', 'conversations', 'abc.jsonl');
    assert.equal(fs.readFileSync(backup, 'utf8'), '{"seq":99,"role":"user"}\n');

    const again = await importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: 'all' });
    assert.equal(again.restored > 0, true);
  } finally { dispose(source); dispose(target); }
});

test('import rejects a foreign or damaged package', async t => {
  const box = scratch();
  try {
    const foreign = path.join(box.root, 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify({ hello: 'world' }));
    await assert.rejects(() => importDataPackage({ file: foreign, dataDir: box.dataDir, home: box.home }),
      /not a Camellia data package/);
    await assert.rejects(() => createDataPackage({ dataDir: box.dataDir, home: box.home, destination: foreign }),
      /nothing to export/);
  } finally { dispose(box); }
});

test('export streams a large file without holding it in memory', async t => {
  const source = scratch();
  const target = scratch();
  try {
    const big = path.join(source.dataDir, 'conversations', 'big.jsonl');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const handle = fs.openSync(big, 'w');
    for (let index = 0; index < 64; index++) fs.writeSync(handle, chunk);
    fs.closeSync(handle);
    const before = fs.statSync(big).size;
    const packageFile = path.join(source.root, 'camellia-data-test.zip');
    const baseline = process.memoryUsage().rss;
    await createDataPackage({ dataDir: source.dataDir, home: source.home, destination: packageFile });
    const growth = process.memoryUsage().rss - baseline;
    await importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: 'all' });
    assert.equal(fs.statSync(path.join(target.dataDir, 'conversations', 'big.jsonl')).size, before);
    assert.equal(growth < 256 * 1024 * 1024, true, `export grew RSS by ${(growth / 1024 / 1024).toFixed(1)} MiB`);
  } finally { dispose(source); dispose(target); }
});

// A profile larger than one archive is written as numbered parts. This builds
// that layout directly so the reader's part discovery and its fail-closed check
// are covered without a multi-gigabyte fixture.
async function writePart(file, entries) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  await new Promise((resolve, reject) => {
    const stream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' });
    const output = fs.createWriteStream(file);
    stream.on('error', reject); output.on('error', reject); output.on('close', resolve);
    stream.pipe(output);
  });
}

test('a split package restores every part and refuses to start when one is missing', async t => {
  const source = scratch();
  const target = scratch();
  try {
    const directory = path.join(source.root, 'split');
    fs.mkdirSync(directory, { recursive: true });
    const first = path.join(directory, 'camellia-data-01.zip');
    const second = path.join(directory, 'camellia-data-02.zip');
    const manifest = {
      format: FORMAT, version: 1, createdAt: new Date(0).toISOString(), appVersion: '1.0.0',
      source: { platform: process.platform, home: source.home, appDataDir: source.dataDir },
      roots: { app: 'app', home: 'home' }, counts: { files: 2, bytes: 20, skipped: 0 },
      parts: [{ name: path.basename(first), files: 1 }, { name: path.basename(second), files: 1 }],
    };
    await writePart(first, {
      'camellia-migration.json': JSON.stringify(manifest),
      'app/desktop-config.json': JSON.stringify({ dshHome: path.join(source.home, '.dsh'), language: 'zh-CN' }),
    });
    await writePart(second, { 'app/conversations/abc.jsonl': '{"seq":1}\n' });

    const imported = await importDataPackage({ file: first, dataDir: target.dataDir, home: target.home, scope: 'all' });
    assert.equal(imported.restored, 2);
    assert.equal(fs.readFileSync(path.join(target.dataDir, 'conversations', 'abc.jsonl'), 'utf8'), '{"seq":1}\n');
    const config = JSON.parse(fs.readFileSync(path.join(target.dataDir, 'desktop-config.json'), 'utf8'));
    assert.equal(config.dshHome, path.join(target.home, '.dsh'), 'paths are rewritten after a split import');

    // Removing one part must stop the import instead of restoring half the set.
    const third = scratch();
    try {
      fs.rmSync(second);
      await assert.rejects(() => importDataPackage({ file: first, dataDir: third.dataDir, home: third.home, scope: 'all' }),
        /package is incomplete; missing/);
    } finally { dispose(third); }
  } finally { dispose(source); dispose(target); }
});

test('importing only settings leaves conversations and engine history untouched', async t => {
  const source = scratch();
  const target = scratch();
  try {
    seedProfile(source);
    // The target keeps its own conversations and its own engine home.
    write(path.join(target.dataDir, 'conversations', 'mine.jsonl'), '{"seq":7}\n');
    write(path.join(target.home, '.dsh', 'ollama-proxy.json'), JSON.stringify({ providers: [{ id: 'local' }] }));
    const packageFile = path.join(source.root, 'camellia-data-settings.zip');
    const exported = await createDataPackage({ dataDir: source.dataDir, home: source.home, destination: packageFile });
    assert.equal(exported.categories.conversations.files > 0, true);
    assert.equal(exported.categories.api.files > 0, true);
    assert.equal(exported.categories.settings.files > 0, true);

    const imported = await importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: 'settings' });
    assert.deepEqual(imported.scope, ['settings']);
    assert.equal(imported.restored < exported.files, true, 'not every file belongs to the settings scope');
    // Desktop preferences arrive, but the API route file is left alone.
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'desktop-config.json'), 'utf8')).language, 'zh-CN');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.home, '.dsh', 'ollama-proxy.json'), 'utf8')).providers[0].id, 'local');
    // Conversations and their Goal/task state are not touched.
    assert.equal(fs.readFileSync(path.join(target.dataDir, 'conversations', 'mine.jsonl'), 'utf8'), '{"seq":7}\n');
    assert.equal(fs.existsSync(path.join(target.dataDir, 'conversations', 'abc.json')), false);
    assert.equal(fs.existsSync(path.join(target.dataDir, 'conversations', 'goals', 'abc.json')), false);
  } finally { dispose(source); dispose(target); }
});

test('importing only conversations leaves settings and credentials untouched', async t => {
  const source = scratch();
  const target = scratch();
  try {
    seedProfile(source);
    write(path.join(target.dataDir, 'desktop-config.json'), JSON.stringify({ dshHome: path.join(target.home, '.dsh'), language: 'en' }));
    write(path.join(target.home, '.dsh', 'ollama-proxy.json'), JSON.stringify({ providers: [{ id: 'local' }] }));
    const packageFile = path.join(source.root, 'camellia-data-conversations.zip');
    await createDataPackage({ dataDir: source.dataDir, home: source.home, destination: packageFile });
    const imported = await importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: 'conversations' });
    assert.deepEqual(imported.scope, ['conversations']);
    // Conversations, Goal and scheduled task state arrive.
    assert.equal(fs.readFileSync(path.join(target.dataDir, 'conversations', 'abc.jsonl'), 'utf8'), '{"seq":1,"role":"user"}\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'conversations', 'goals', 'abc.json'), 'utf8')).objective, 'keep going');
    // Settings and credentials keep the target's own values.
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'desktop-config.json'), 'utf8')).language, 'en');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.home, '.dsh', 'ollama-proxy.json'), 'utf8')).providers[0].id, 'local');
  } finally { dispose(source); dispose(target); }
});

test('an unknown scope and an empty scope both fail before writing', async t => {
  const source = scratch();
  const target = scratch();
  try {
    seedProfile(source);
    const packageFile = path.join(source.root, 'camellia-data-scope.zip');
    await createDataPackage({ dataDir: source.dataDir, home: source.home, destination: packageFile });
    await assert.rejects(() => importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: 'sessions' }),
      /Choose what to import/);
    assert.equal(fs.existsSync(path.join(target.dataDir, 'desktop-config.json')), false);
  } finally { dispose(source); dispose(target); }
});

test('a multi-select import restores only the chosen categories', async t => {
  const source = scratch();
  const target = scratch();
  try {
    seedProfile(source);
    write(path.join(target.dataDir, 'desktop-config.json'), JSON.stringify({ dshHome: path.join(target.home, '.dsh'), language: 'en' }));
    write(path.join(target.home, '.dsh', 'ollama-proxy.json'), JSON.stringify({ providers: [{ id: 'local' }] }));
    const packageFile = path.join(source.root, 'camellia-data-multi.zip');
    await createDataPackage({ dataDir: source.dataDir, home: source.home, destination: packageFile });
    // API and settings, but not conversations, is a valid combination.
    const imported = await importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: ['api', 'settings'] });
    assert.deepEqual(imported.scope, ['api', 'settings']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.home, '.dsh', 'ollama-proxy.json'), 'utf8')).providers[0].id, 'test');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'desktop-config.json'), 'utf8')).language, 'zh-CN');
    assert.equal(fs.existsSync(path.join(target.dataDir, 'conversations', 'abc.json')), false, 'conversations were not selected');
  } finally { dispose(source); dispose(target); }
});

for (const scope of [['api'], ['settings'], ['conversations'], ['api', 'settings'], ['settings', 'conversations']]) {
  test('export contains only selected categories: ' + scope.join(', '), async () => {
    const source = scratch(), target = scratch();
    try {
      seedProfile(source);
      const packageFile = path.join(source.root, 'selected.zip');
      const exported = await createDataPackage({ dataDir: source.dataDir, home: source.home, destination: packageFile, scope });
      const preview = await inspectDataPackage(packageFile);
      assert.deepEqual(Object.keys(preview.categories).sort(), [...scope].sort());
      assert.deepEqual(preview.categories, exported.categories);
      assert.equal(Object.values(preview.categories).reduce((sum, entry) => sum + entry.files, 0), exported.files);
      const imported = await importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope });
      assert.equal(imported.restored, exported.files);
      assert.equal(fs.existsSync(path.join(target.dataDir, 'desktop-config.json')), scope.includes('settings'));
      assert.equal(fs.existsSync(path.join(target.home, '.dsh/ollama-proxy.json')), scope.includes('api'));
      assert.equal(fs.existsSync(path.join(target.dataDir, 'conversations/abc.json')), scope.includes('conversations'));
    } finally { dispose(source); dispose(target); }
  });
}

test('import availability comes from archive entries, not claimed manifest categories', async () => {
  const source = scratch(), target = scratch();
  try {
    const packageFile = path.join(source.root, 'claimed.zip');
    const manifest = { format: FORMAT, version: 1, source: { appDataDir: source.dataDir, home: source.home }, counts: { files: 1 },
      categories: { api: { files: 99, bytes: 500 }, settings: { files: 0, bytes: 0 } } };
    await writePart(packageFile, { 'camellia-migration.json': JSON.stringify(manifest), 'app/desktop-config.json': '{}' });
    const preview = await inspectDataPackage(packageFile);
    assert.deepEqual(preview.categories, { settings: { files: 1, bytes: 2 } });
    await assert.rejects(() => importDataPackage({ file: packageFile, dataDir: target.dataDir, home: target.home, scope: ['api', 'settings'] }), /no data for the selected/);
    assert.equal(fs.existsSync(target.dataDir), false);
    delete manifest.categories;
    await writePart(packageFile, { 'camellia-migration.json': JSON.stringify(manifest), 'app/desktop-config.json': '{}' });
    assert.deepEqual((await inspectDataPackage(packageFile)).categories, preview.categories);
  } finally { dispose(source); dispose(target); }
});

test('export rejects empty and invalid selections before creating a package', async () => {
  const source = scratch();
  try {
    seedProfile(source);
    const destination = path.join(source.root, 'invalid.zip');
    for (const scope of [[], ['settings', 'unknown']]) {
      await assert.rejects(() => createDataPackage({ dataDir: source.dataDir, home: source.home, destination, scope }), /Choose what to import/);
      assert.equal(fs.existsSync(destination), false);
    }
  } finally { dispose(source); }
});

test('native Codex database files travel with conversations rather than settings', async () => {
  const source = scratch();
  try {
    write(path.join(source.dataDir, 'codex/api/state_5.sqlite'), 'native database');
    write(path.join(source.dataDir, 'codex/api/state_5.sqlite-wal'), 'native WAL');
    const destination = path.join(source.root, 'history.zip');
    const exported = await createDataPackage({ dataDir: source.dataDir, home: source.home, destination, scope: ['conversations'] });
    assert.equal(exported.files, 2);
    assert.deepEqual(Object.keys((await inspectDataPackage(destination)).categories), ['conversations']);
  } finally { dispose(source); }
});
