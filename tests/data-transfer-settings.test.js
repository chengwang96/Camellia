'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { randomBytes } = require('node:crypto');
const { removeTree } = require('./test-fs.cjs');
const { createDataPackage, importDataPackage, inspectDataPackage, FORMAT, VERSION } = require('../src/main/data-migration');

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-transfer-settings-'));
  t.after(() => removeTree(root));
  return { root, dataDir: path.join(root, 'app'), home: path.join(root, 'home') };
}
function write(box, relative, value) {
  const file = path.join(box.root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
  return file;
}
function json(box, relative) { return JSON.parse(fs.readFileSync(path.join(box.root, relative), 'utf8')); }
const allInstalled = { claude: true, codex: true, dsh: true, kimi: true, antigravity: true, pi: true };
async function legacyPackage(box, entries) {
  const zip = new JSZip();
  zip.file('camellia-migration.json', JSON.stringify({ format: FORMAT, version: 1,
    source: { appDataDir: box.dataDir, home: box.home }, counts: { files: Object.keys(entries).length,
      bytes: Object.values(entries).reduce((n, value) => n + Buffer.byteLength(value), 0) } }), { createFolders: false });
  for (const [name, value] of Object.entries(entries)) zip.file(name, value, { createFolders: false });
  const file = path.join(box.root, 'legacy.zip');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

test('API and settings remain small even when the source has attachments, plugins and installed tools', async t => {
  const source = profile(t);
  const desktop = { language: 'zh-CN', theme: 'dark', runtimePaths: { codex: { file: 'C:/source/codex.exe' } },
    claude: { thinkingBudget: 'high', cwd: 'C:/work', model: 'source-model' },
    sharedMeta: { titles: { chat: 'History title' } }, codexSessionAccounts: { chat: 'source-account' } };
  write(source, 'app/desktop-config.json', desktop);
  write(source, 'home/.dsh/ollama-proxy.json', { providers: [{ id: 'api', keys: [{ key: 'fixture-key' }] }] });
  write(source, 'app/codex/config.toml', 'approval_policy = "on-request"\n');
  write(source, 'home/.claude/settings.json', { language: 'Chinese' });
  write(source, 'home/.claude.json', { mcpServers: { remote: { url: 'https://example.invalid/mcp' } },
    projects: { source: { history: 'private native state' } }, oauthAccount: { id: 'source' } });
  const junk = randomBytes(512 * 1024);
  const omitted = ['app/clipboard-attachments/image.png', 'app/remote/device-attachments/image.png',
    'app/remote/mobile-images/image.jpg', 'home/.dsh/attachments/v1/objects/a', 'home/.kimi-code/files/upload.png',
    'home/.claude/skills/example/assets/big.png', 'home/.claude/plugins/marketplaces/official/.git/objects/pack/data.pack',
    'home/.claude/plugins/marketplaces/official/plugins/demo/assets/example.png', 'home/.gemini/antigravity-cli/bin/tool.exe',
    'home/.kimi-code/bin/rg.exe', 'home/.kimi-code/search-index/generations/index', 'app/unknown-state.bin'];
  for (const relative of omitted) write(source, relative, junk);
  // API-like filenames inside an installed skill are not route configuration.
  write(source, 'home/.claude/skills/example/ollama-proxy.json', '{"example":true}');
  const file = path.join(source.root, 'settings.zip');
  const exported = await createDataPackage({ ...source, scope: ['api', 'settings'], destination: file });
  assert.ok(exported.bytes < 16 * 1024, 'only a few preference documents, independent of installed payload size');
  const zip = await JSZip.loadAsync(fs.readFileSync(file), { checkCRC32: true });
  assert.equal(JSON.parse(await zip.file('camellia-migration.json').async('string')).version, 2);
  assert.equal(VERSION, 2, 'new preference documents cannot be applied by a legacy whole-file importer');
  for (const relative of omitted) assert.equal(zip.file(relative), null, relative);
  assert.equal(zip.file('home/.claude/skills/example/ollama-proxy.json'), null);
  assert.equal(zip.file('app/conversation-config.json'), null);
  assert.deepEqual(JSON.parse(await zip.file('app/desktop-config.json').async('string')),
    { language: 'zh-CN', theme: 'dark', claude: { thinkingBudget: 'high', cwd: 'C:/work' } });
  assert.deepEqual(JSON.parse(await zip.file('home/.claude.json').async('string')),
    { mcpServers: { remote: { url: 'https://example.invalid/mcp' } } });
  assert.deepEqual(json(source, 'app/desktop-config.json'), desktop, 'export never edits the live profile');
});

test('a partly installed destination keeps local runtime paths and accounts and skips unavailable harness settings', async t => {
  const source = profile(t), target = profile(t);
  write(source, 'app/desktop-config.json', { language: 'zh-CN', theme: 'dark',
    claude: { thinkingBudget: 'high' }, codex: { thinkingBudget: 'xhigh' }, pi: { permissionMode: 'full' },
    quickSwitchModels: { claude: 'source-claude', codex: 'source-codex' },
    memoryDirectory: path.join(source.root, 'nonexistent-memory'),
    runtimePaths: { codex: { file: 'C:/source/codex.exe' } }, dshHome: 'C:/source/dsh' });
  write(source, 'home/.claude/settings.json', { language: 'Chinese', env: { ANTHROPIC_BASE_URL: 'http://source' } });
  write(source, 'app/codex/config.toml', 'model_reasoning_effort = "xhigh"\n');
  write(source, 'app/pi-native/AGENTS.md', '# Source Pi instructions');
  write(source, 'home/.kimi-code/config.toml', 'default_permission_mode = "auto"\n');
  write(source, 'app/antigravity/settings.json', { permissionMode: 'plan' });
  write(source, 'home/.gemini/antigravity-cli/settings.json', { agentMode: 'accept-edits' });
  const runtimePaths = { claude: { file: 'C:/target/claude.exe', version: '1.2.3' }, python: { file: 'C:/target/python.exe' } };
  const current = { language: 'en', runtimePaths, dshHome: 'C:/target/dsh', memoryDirectory: 'C:/target/memory',
    subscriptionAccounts: { codex: [{ id: 'target' }] }, codexSessionAccounts: { targetChat: 'target' },
    codex: { permissionMode: 'default', connection: 'subscription', subscriptionModel: 'target-model' },
    quickSwitchModels: { codex: 'local-codex' }, sharedMeta: { titles: { targetChat: 'Target title' } } };
  write(target, 'app/desktop-config.json', current);
  write(target, 'home/.claude/settings.json', { language: 'English', env: { ANTHROPIC_BASE_URL: 'http://target', ANTHROPIC_AUTH_TOKEN: 'target-token' } });
  const file = path.join(source.root, 'source.zip');
  await createDataPackage({ ...source, scope: 'settings', destination: file });
  const installedEngines = { claude: true, antigravity: { api: true, subscription: false } };
  const preview = await inspectDataPackage(file, { installedEngines });
  assert.deepEqual(preview.skippedEngines.sort(), ['antigravity', 'codex', 'kimi', 'pi']);
  assert.deepEqual(json(target, 'app/desktop-config.json'), current, 'preview is read-only');
  const imported = await importDataPackage({ ...target, file, scope: 'settings', installedEngines });
  assert.deepEqual(imported.skippedEngines.sort(), ['antigravity', 'codex', 'kimi', 'pi']);
  assert.deepEqual(imported.skippedPaths, ['memoryDirectory']);
  const restored = json(target, 'app/desktop-config.json');
  assert.equal(restored.language, 'zh-CN'); assert.equal(restored.theme, 'dark');
  assert.deepEqual(restored.claude, { thinkingBudget: 'high' });
  for (const key of ['runtimePaths', 'dshHome', 'memoryDirectory', 'subscriptionAccounts', 'codexSessionAccounts', 'codex', 'sharedMeta'])
    assert.deepEqual(restored[key], current[key], key);
  assert.deepEqual(restored.quickSwitchModels, { codex: 'local-codex', claude: 'source-claude' });
  assert.equal(fs.existsSync(path.join(target.dataDir, 'codex')), false);
  assert.equal(fs.existsSync(path.join(target.dataDir, 'pi-native')), false);
  assert.equal(fs.existsSync(path.join(target.home, '.kimi-code')), false);
  assert.equal(fs.existsSync(path.join(target.home, '.gemini')), false);
  assert.equal(json(target, 'app/antigravity/settings.json').permissionMode, 'plan');
  assert.deepEqual(json(target, 'home/.claude/settings.json').env,
    { ANTHROPIC_BASE_URL: 'http://target', ANTHROPIC_AUTH_TOKEN: 'target-token' });
});

test('an unavailable native-only package is a reported no-op and never creates an engine home', async t => {
  const source = profile(t), target = profile(t);
  write(source, 'app/codex/config.toml', 'sandbox_mode = "read-only"\n');
  const file = path.join(source.root, 'codex.zip');
  await createDataPackage({ ...source, scope: 'settings', destination: file });
  const result = await importDataPackage({ ...target, file, scope: 'settings', installedEngines: {} });
  assert.equal(result.restored, 0); assert.deepEqual(result.skippedEngines, ['codex']);
  assert.equal(fs.existsSync(path.join(target.dataDir, 'codex')), false);
});

test('legacy settings imports exclude payloads while conversation imports still restore their attachments', async t => {
  const source = profile(t), settingsTarget = profile(t), conversationTarget = profile(t);
  const entries = { 'app/desktop-config.json': '{"theme":"dark"}',
    'app/clipboard-attachments/image.png': 'image fixture', 'home/.dsh/attachments/object': 'DSH fixture',
    'home/.kimi-code/files/upload.txt': 'Kimi fixture', 'home/.claude/skills/demo/SKILL.md': 'installed skill',
    'home/.gemini/antigravity-cli/bin/tool.exe': 'installed binary', 'app/unknown.json': '{"private":"state"}' };
  const file = await legacyPackage(source, entries);
  const preview = await inspectDataPackage(file);
  assert.equal(preview.categories.settings.files, 1);
  assert.equal(preview.categories.conversations.files, 3);
  const result = await importDataPackage({ ...settingsTarget, file, scope: 'settings', installedEngines: allInstalled });
  assert.equal(result.restored, 1); assert.equal(json(settingsTarget, 'app/desktop-config.json').theme, 'dark');
  for (const relative of Object.keys(entries).slice(1)) assert.equal(fs.existsSync(path.join(settingsTarget.root, relative)), false, relative);
  const history = await importDataPackage({ ...conversationTarget, file, scope: 'conversations', installedEngines: {} });
  assert.equal(history.restored, 3);
  assert.equal(fs.readFileSync(path.join(conversationTarget.dataDir, 'clipboard-attachments/image.png'), 'utf8'), 'image fixture');
  assert.equal(fs.existsSync(path.join(conversationTarget.home, '.claude')), false);
});

test('missing MCP and skills paths do not replace working local references, remote MCP remains portable', async t => {
  const source = profile(t), target = profile(t);
  const missing = path.join(source.root, 'missing-server.js');
  const localSkills = path.join(target.root, 'local-skills'); fs.mkdirSync(localSkills);
  write(source, 'app/antigravity/settings.json', { permissionMode: 'plan', skillsPaths: [path.join(source.root, 'missing-skills')],
    mcpServers: { broken: { command: 'node', args: [missing] }, remote: { url: 'https://example.invalid/mcp' } } });
  write(target, 'app/antigravity/settings.json', { skillsPaths: [localSkills], mcpServers: { broken: { command: 'local-server' } } });
  const file = path.join(source.root, 'paths.zip');
  await createDataPackage({ ...source, destination: file, scope: 'settings' });
  const result = await importDataPackage({ ...target, file, scope: 'settings', installedEngines: allInstalled });
  assert.equal(result.skippedPaths.length, 2);
  const value = json(target, 'app/antigravity/settings.json');
  assert.deepEqual(value.skillsPaths, [localSkills]);
  assert.deepEqual(value.mcpServers.broken, { command: 'local-server' });
  assert.deepEqual(value.mcpServers.remote, { url: 'https://example.invalid/mcp' });
  assert.equal(value.permissionMode, 'plan');
});

test('history metadata is separate from settings and restores without changing destination preferences', async t => {
  const source = profile(t), target = profile(t);
  write(source, 'app/desktop-config.json', { language: 'zh-CN', sharedMeta: { titles: { chat: 'Source title' } } });
  write(source, 'app/conversations/chat.jsonl', '{"role":"user"}\n');
  write(target, 'app/desktop-config.json', { language: 'en', runtimePaths: { codex: { file: 'C:/target.exe' } } });
  const file = path.join(source.root, 'history.zip');
  await createDataPackage({ ...source, destination: file, scope: 'conversations' });
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  assert.equal(zip.file('app/desktop-config.json'), null);
  assert.ok(zip.file('app/conversation-config.json'));
  await importDataPackage({ ...target, file, scope: 'conversations', installedEngines: {} });
  assert.equal(json(target, 'app/desktop-config.json').language, 'en');
  assert.deepEqual(json(target, 'app/desktop-config.json').sharedMeta, { titles: { chat: 'Source title' } });
});

test('plugin flags only enable installed payloads and preserve destination flags for missing plugins', async t => {
  const source = profile(t), target = profile(t);
  write(source, 'home/.claude/settings.json', { enabledPlugins: { 'ready@official': true, 'missing@official': true,
    'stale@official': true, 'off@official': false }, language: 'Chinese' });
  write(target, 'home/.claude/settings.json', { enabledPlugins: { 'missing@official': false } });
  const installed = path.join(target.home, '.claude/plugins/cache/ready'); fs.mkdirSync(installed, { recursive: true });
  write(target, 'home/.claude/plugins/installed_plugins.json', { version: 2, plugins: {
    'ready@official': [{ installPath: installed }], 'stale@official': [{ installPath: path.join(target.root, 'removed-plugin') }],
  } });
  const file = path.join(source.root, 'plugins.zip');
  await createDataPackage({ ...source, destination: file, scope: 'settings' });
  const result = await importDataPackage({ ...target, file, scope: 'settings', installedEngines: { claude: true } });
  assert.equal(result.skippedPaths.length, 2);
  assert.deepEqual(json(target, 'home/.claude/settings.json').enabledPlugins,
    { 'ready@official': true, 'missing@official': false, 'off@official': false });
  assert.equal(json(target, 'home/.claude/settings.json').language, 'Chinese');
});

test('settings imports validate default directories and keep the destination conversation metadata', async t => {
  const source = profile(t), target = profile(t);
  const cwd = path.join(target.root, 'working-directory'); fs.mkdirSync(cwd);
  write(source, 'app/desktop-config.json', { network: { mode: 'system' },
    claude: { cwd: path.join(source.root, 'missing-directory'), thinkingBudget: 'high' },
    sharedMeta: { titles: { source: 'Source history' } } });
  write(target, 'app/desktop-config.json', { claude: { cwd, thinkingBudget: 'low' }, sharedMeta: { titles: { target: 'Target history' } } });
  const file = path.join(source.root, 'directories.zip');
  await createDataPackage({ ...source, destination: file, scope: 'settings' });
  const result = await importDataPackage({ ...target, file, scope: 'settings', installedEngines: { claude: true } });
  assert.deepEqual(result.skippedPaths, ['claude.cwd']);
  assert.deepEqual(json(target, 'app/desktop-config.json').claude, { cwd, thinkingBudget: 'high' });
  assert.deepEqual(json(target, 'app/desktop-config.json').sharedMeta, { titles: { target: 'Target history' } });
  assert.deepEqual(json(target, 'app/desktop-config.json').network, { mode: 'system' });
});
