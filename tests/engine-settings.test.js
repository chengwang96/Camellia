'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createEngineSettings, parse } = require('../src/engines/engine-settings');
const { createRuntimeManager, ENGINES } = require('../src/main/runtime-manager');
const { kimiSpawnSpec } = require('../src/engines/kimi-session');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-engine-test-'));
  t.after(() => { assert.equal(path.dirname(home), os.tmpdir()); assert.ok(path.basename(home).startsWith('workbench-engine-test-')); fs.rmSync(home, { recursive: true, force: true }); });
  const desktop = { claude: { model: 'model-exact' }, kimi: { model: 'model-exact', contextWindow: 131072 } };
  const route = { baseUrl: 'http://127.0.0.1:17890', authToken: 'proxy-managed' };
  const service = createEngineSettings({ home, dshHome: () => path.join(home, '.dsh'), kimiHome: path.join(home, '.kimi-code'),
    getDesktop: engine => desktop[engine] || {}, saveDesktop: (engine, value) => { desktop[engine] = { ...desktop[engine], ...value }; }, getRoute: () => route });
  const put = (file, text) => { file = path.join(home, file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  return { home, service, desktop, route, put };
}
test('Claude native settings, MCP and instructions save together without overwriting account state; one original backup', t => {
  const f = fixture(t);
  const settings = f.put('.claude/settings.json', JSON.stringify({ language: 'Japanese', hooks: { Stop: [] }, env: { ANTHROPIC_API_KEY: 'private-old-key', CUSTOM_VAR: 'keep' } }));
  const global = f.put('.claude.json', JSON.stringify({ oauthAccount: { marker: 'keep' }, projects: { fixture: true }, mcpServers: {} }));
  const value = f.service.get('claude');
  assert.ok(!value.files[0].text.includes('private-old-key'));
  value.files.find(file => file.id === 'mcp').text = '{"local":{"command":"fixture-mcp"}}';
  value.files.find(file => file.id === 'instructions').text = 'User instructions';
  const saved = f.service.save('claude', { ...value, common: { language: 'Chinese', 'permissions.defaultMode': 'plan' } });
  const native = JSON.parse(fs.readFileSync(settings));
  assert.equal(native.language, 'Chinese'); assert.deepEqual(native.hooks, { Stop: [] });
  assert.equal(native.env.CUSTOM_VAR, 'keep'); assert.equal(native.env.ANTHROPIC_AUTH_TOKEN, 'proxy-managed');
  assert.equal(native.model, 'model-exact'); assert.equal(f.desktop.claude.permissionMode, 'plan');
  const account = JSON.parse(fs.readFileSync(global));
  assert.deepEqual(account.oauthAccount, { marker: 'keep' }); assert.deepEqual(account.projects, { fixture: true });
  assert.deepEqual(account.mcpServers, { local: { command: 'fixture-mcp' } });
  assert.match(fs.readFileSync(settings + '.workbench.bak', 'utf8'), /private-old-key/);
  f.service.save('claude', { ...saved, common: { language: 'English' } });
  assert.match(fs.readFileSync(settings + '.workbench.bak', 'utf8'), /Japanese/);
});
test('invalid or concurrently edited native files cause no partial overwrite', t => {
  const f = fixture(t), file = f.put('.claude/settings.json', '{"language":"Chinese"}');
  const value = f.service.get('claude'); value.files.find(file => file.id === 'mcp').text = '{invalid';
  assert.throws(() => f.service.save('claude', value));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"language":"Chinese"}');
  assert.equal(fs.existsSync(file + '.workbench.bak'), false);
  const stale = f.service.get('claude'); fs.writeFileSync(file, '{"language":"English"}');
  assert.throws(() => f.service.save('claude', stale), /modified by another application/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"language":"English"}');
});
test('Kimi settings reach the actual spawn config with MCP, hooks and tools preserved and only the selected route', t => {
  const f = fixture(t);
  f.put('.kimi-code/config.toml', 'telemetry = false\n[loop_control]\nmax_attempts_per_step = 6\n[tools]\nenable_view_image = false\n[providers.old]\napi_key = "private-old-key"\n');
  const value = f.service.get('kimi'); assert.ok(!value.files[0].text.includes('private-old-key'));
  value.files.find(file => file.id === 'mcp').text = '{"mcpServers":{"fixture":{"command":"test"}}}';
  f.service.save('kimi', { ...value, common: { 'loop_control.max_attempts_per_step': 8, default_permission_mode: 'manual' } });
  const home = path.join(f.home, 'isolated-runtime');
  const spec = kimiSpawnSpec({ home, runtime: 'fixture', route: f.route, model: 'model-exact', ...f.service.kimiConfig() });
  const config = parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'toml');
  assert.equal(config.loop_control.max_attempts_per_step, 8); assert.equal(config.tools.enable_view_image, false);
  assert.deepEqual(Object.keys(config.providers), ['workbench']); assert.deepEqual(Object.keys(config.models), ['model-exact']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'))).mcpServers.fixture.command, 'test');
  assert.equal(spec.env.KIMI_CODE_HOME, process.platform === 'win32' ? fs.realpathSync.native(home) : home);
  const tunedHome = path.join(f.home, 'isolated-tuned');
  kimiSpawnSpec({ home: tunedHome, runtime: 'fixture', route: f.route, model: 'model-exact', contextWindow: 65536 });
  const tuned = parse(fs.readFileSync(path.join(tunedHome, 'config.toml'), 'utf8'), 'toml');
  assert.equal(tuned.models['model-exact'].max_context_size, 65536);
});
test('fresh profiles can save native settings before choosing a model', t => {
  const f = fixture(t); delete f.desktop.kimi.model;
  const saved = f.service.save('kimi', { ...f.service.get('kimi'), common: { default_permission_mode: 'manual' } });
  assert.equal(parse(saved.files[0].text, 'toml').default_permission_mode, 'manual');
});
test('saving subscription preferences retains the API model in global Kimi routes', t => {
  const f = fixture(t);
  f.desktop.kimi = { connection: 'subscription', model: 'kimi-code/coding', apiModel: 'api-remembered', contextWindow: 131072 };
  f.service.save('kimi', { ...f.service.get('kimi'), common: { default_permission_mode: 'manual' } });
  const config = parse(fs.readFileSync(path.join(f.home, '.kimi-code/config.toml'), 'utf8'), 'toml');
  assert.equal(config.default_model, 'api-remembered');
  assert.equal(config.models['kimi-code/coding'], undefined);
});
test('changing the router port follows only connections already managed by the workbench', t => {
  const f = fixture(t);
  const claude = f.put('.claude/settings.json', '{"env":{"ANTHROPIC_AUTH_TOKEN":"proxy-managed","ANTHROPIC_BASE_URL":"http://127.0.0.1:10000"},"language":"Chinese"}');
  const kimi = f.put('.kimi-code/config.toml', '[providers.workbench]\nbase_url="http://127.0.0.1:10000/v1"\napi_key="proxy-managed"\n');
  f.service.syncManagedRoutes();
  assert.equal(JSON.parse(fs.readFileSync(claude)).env.ANTHROPIC_BASE_URL, f.route.baseUrl);
  assert.equal(parse(fs.readFileSync(kimi, 'utf8'), 'toml').providers.workbench.base_url, f.route.baseUrl + '/v1');
  fs.writeFileSync(claude, '{"env":{"ANTHROPIC_AUTH_TOKEN":"personal","ANTHROPIC_BASE_URL":"https://example.invalid"}}');
  f.service.syncManagedRoutes();
  assert.equal(JSON.parse(fs.readFileSync(claude)).env.ANTHROPIC_BASE_URL, 'https://example.invalid');
});
test('managed runtime install resolves linked prefixes, coalesces installs, and retries a failure', async t => {
  const f = fixture(t), root = path.join(f.home, 'distribution'), target = path.join(f.home, 'installed');
  const physical = path.join(f.home, 'App Data');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, target, process.platform === 'win32' ? 'junction' : 'dir');
  for (const engine of ['kimi']) {
    for (const file of ['package.json', 'package-lock.json']) f.put(path.join('distribution/runtimes', engine, file), '{}');
  }
  let calls = 0, prompts = 0, fail = true;
  const manager = createRuntimeManager({ root, installRoot: target, node: process.execPath, npm: 'fixture-npm',
    downloadOptions: () => { prompts++; return { mode: fail ? 'proxy' : 'direct', url: 'http://proxy.example:8080/' }; },
    runCommand: async (_exe, args, options) => {
    calls++; assert.ok(args.includes('ci')); assert.ok(args.includes('--ignore-scripts'));
    const installedDir = fs.realpathSync.native(path.join(physical, 'runtimes/kimi'));
    assert.equal(args[args.indexOf('--prefix') + 1], installedDir);
    assert.equal(options.cwd, installedDir);
    assert.equal(options.env.HTTPS_PROXY, fail ? 'http://proxy.example:8080/' : '');
    if (fail) throw new Error('temporary network failure');
    const info = ENGINES.kimi, dir = path.join(target, 'runtimes/kimi/node_modules', info.package);
    fs.mkdirSync(path.dirname(path.join(dir, info.entry)), { recursive: true });
    fs.writeFileSync(path.join(dir, info.entry), ''); fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.43.0"}');
  } });
  assert.ok(manager.state().every(row => row.status === 'missing'));
  assert.equal(calls, 0, 'Listing runtimes must not start downloads');
  const a = manager.ensure('kimi'); assert.equal(a, manager.ensure('kimi')); await assert.rejects(a, /network/);
  assert.equal(manager.state().find(row => row.id === 'kimi').status, 'error');
  fail = false; const ready = await manager.ensure('kimi');
  assert.equal(ready.source, "Installed by Camellia"); assert.equal(calls, 2);
  await manager.ensure('kimi'); assert.equal(calls, 2); assert.equal(prompts, 2, 'Retry can choose a new connection; installed engines do not prompt');
  assert.ok(manager.state().filter(row => row.id !== 'kimi').every(row => row.status === 'missing'));
  assert.deepEqual(fs.readdirSync(path.join(target, 'runtimes')), ['kimi'], 'Only the selected engine is installed');
});

test('source setup and startup checks leave missing engines uninstalled', async t => {
  const f = fixture(t), root = path.join(f.home, 'fresh-checkout');
  fs.mkdirSync(root);
  const prepare = require('../scripts/prepare-runtimes.cjs');
  for (const options of [{}, { check: true }]) {
    const rows = await prepare({ root, ...options });
    assert.deepEqual(rows.map(row => row.id), ['claude', 'codex', 'dsh', 'kimi', 'antigravity']);
    assert.ok(rows.every(row => row.status === 'missing'));
    assert.deepEqual(fs.readdirSync(root), [], 'No engine files are downloaded by default');
  }
});
