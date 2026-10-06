'use strict';
const { removeTree } = require('./test-fs.cjs');
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
  t.after(() => { assert.equal(path.dirname(home), os.tmpdir()); assert.ok(path.basename(home).startsWith('workbench-engine-test-')); removeTree(home); });
  const desktop = { claude: { model: 'model-exact' }, kimi: { model: 'model-exact', contextWindow: 131072 } };
  const route = { baseUrl: 'http://127.0.0.1:17890', authToken: 'proxy-managed' };
  const service = createEngineSettings({ home, dshHome: () => path.join(home, '.dsh'), kimiHome: path.join(home, '.kimi-code'),
    piHome: path.join(home, 'app/pi-native'),
    getDesktop: engine => desktop[engine] || {}, saveDesktop: (engine, value) => { desktop[engine] = { ...desktop[engine], ...value }; }, getRoute: () => route });
  const put = (file, text) => { file = path.join(home, file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  return { home, service, desktop, route, put };
}

test('Pi defaults and global instructions reach the runtime without changing personal CLI settings', async t => {
  const f = fixture(t);
  const personal = f.put('.pi/agent/settings.json', '{"theme":"personal"}');
  const instructions = f.put('app/pi-native/AGENTS.md', 'Original instructions');
  f.desktop.pi = { model: 'model-exact', permissionMode: 'ask', connection: 'api' };
  const value = f.service.get('pi');
  assert.equal(value.scope, 'app');
  assert.equal(value.fields.find(field => field.key === 'contextWindow').value, 65536);
  value.files[0].text = 'Follow the project style.\n保留中文说明。';
  f.service.save('pi', { ...value, common: { permissionMode: 'auto', thinkingBudget: 'high', contextWindow: 131072 } });
  assert.equal(f.desktop.pi.model, 'model-exact');
  assert.equal(fs.readFileSync(personal, 'utf8'), '{"theme":"personal"}');
  assert.equal(fs.readFileSync(instructions + '.workbench.bak', 'utf8'), 'Original instructions');

  const { createPiChat } = require('../src/engines/pi-session');
  const driver = createPiChat({ dataDir: path.join(f.home, 'runtime'), loadConfig: () => ({ pi: f.desktop.pi }), saveConfig() {},
    getModels: () => ['model-exact'], getRoute: () => f.route, runtime: () => ({ file: '/pi/cli.js' }),
    node: () => process.execPath, environment: () => ({}), onEvent() {}, instructions: f.service.piInstructions });
  t.after(() => driver.shutdown());
  const session = driver.ensure({ cwd: f.home });
  assert.equal(session.spec.env.CAMELLIA_PI_PERMISSION, 'auto');
  assert.equal(session.spec.args[session.spec.args.indexOf('--thinking') + 1], 'high');
  assert.equal(session.spec.env.CAMELLIA_PI_EFFORT, 'high');
  assert.equal(session.spec.args[session.spec.args.indexOf('--append-system-prompt') + 1], value.files[0].text);
  const model = JSON.parse(fs.readFileSync(path.join(f.home, 'runtime/pi', session.sessionId, 'models.json'))).providers.camellia.models[0];
  assert.equal(model.contextWindow, 131072);
  const updated = f.service.get('pi'); updated.files[0].text = 'Updated instructions';
  f.service.save('pi', { ...updated, desktop: { model: 'stale-model', contextWindow: 1 }, common: { thinkingBudget: '' } });
  assert.equal(f.desktop.pi.contextWindow, 131072, 'Only edited common fields update Pi defaults');
  assert.equal(f.desktop.pi.model, 'model-exact', 'Model selection remains owned by the conversation');
  const next = driver.ensure({ cwd: f.home, sessionId: session.sessionId });
  assert.notEqual(next, session);
  assert.equal(next.spec.args.includes('--thinking'), false);
  assert.equal(next.spec.env.CAMELLIA_PI_EFFORT, '');
  assert.equal(next.spec.args[next.spec.args.indexOf('--append-system-prompt') + 1], 'Updated instructions');
});

test('Pi provider requests retain exact discovered efforts and never inject an effort for Default', async () => {
  const { default: extension } = await import('../src/engines/pi-extension.mjs');
  const previous = process.env.CAMELLIA_PI_EFFORT;
  const handlers = new Map();
  extension({ on: (name, handler) => handlers.set(name, handler), registerTool() {} });
  const handler = handlers.get('before_provider_request');
  try {
    for (const effort of ['', 'max', 'ultra', 'custom-depth', 'none']) {
      process.env.CAMELLIA_PI_EFFORT = effort;
      const payload = { model: 'glm-5.3', thinking: { type: 'enabled', budget_tokens: 10000 }, output_config: { effort: 'medium', format: 'text' } };
      assert.equal(handler({ payload }), payload);
      assert.equal(payload.output_config.effort, effort && effort !== 'none' ? effort : undefined);
      assert.equal(payload.output_config.format, 'text');
      assert.deepEqual(payload.thinking, effort === 'none' ? { type: 'disabled' } : effort ? { type: 'enabled', budget_tokens: 10000 } : undefined);
    }
    delete process.env.CAMELLIA_PI_EFFORT;
    const untouched = { thinking: { type: 'enabled', budget_tokens: 1000 } };
    assert.equal(handler({ payload: untouched }), undefined);
    assert.deepEqual(untouched.thinking, { type: 'enabled', budget_tokens: 1000 });
  } finally {
    if (previous === undefined) delete process.env.CAMELLIA_PI_EFFORT;
    else process.env.CAMELLIA_PI_EFFORT = previous;
  }
});

test('DSH launch profiles declare reported reasoning capabilities instead of guessing from model names', context => {
  const fixtureState = fixture(context);
  const { dshAcpSpec } = require('../src/engines/dsh-session');
  for (const thinking of [{ values: ['low', 'high', 'max'], default: 'max' }, { values: [false, true], default: true }, { values: [false] }, undefined]) {
    const home = path.join(fixtureState.home, 'dsh-profile');
    const spec = dshAcpSpec({ runtime: { file: '/runtime/dsh', version: '0.1.0' }, home, model: 'glm-5.3', route: fixtureState.route, env: {}, thinking });
    const model = parse(fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8'), 'yaml')['llm-pi-ai'].providers['api-pool'].models[0];
    const expected = !thinking ? { low: 'low', medium: 'medium', high: 'high' } : thinking.values.length === 1 ? false
      : thinking.values.includes(true) ? { off: 'none', high: 'high' } : { low: 'low', high: 'high', max: 'max' };
    assert.deepEqual(model.reasoningEfforts, expected);
    assert.equal(spec.applyThinking, expected !== false);
  }
});

test('invalid or stale Pi settings do not partially overwrite defaults or instructions', t => {
  const f = fixture(t);
  const file = f.put('app/pi-native/AGENTS.md', 'Keep me');
  f.desktop.pi = { permissionMode: 'ask' };
  for (const common of [{ permissionMode: 'unsupported' }, { thinkingBudget: 'unknown' }, { contextWindow: 1 }, { contextWindow: 4096.5 }, { model: 'not-a-common-field' }]) {
    const value = f.service.get('pi'); value.files[0].text = 'Do not write';
    assert.throws(() => f.service.save('pi', { ...value, common }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'Keep me');
    assert.deepEqual(f.desktop.pi, { permissionMode: 'ask' });
    assert.equal(fs.existsSync(file + '.workbench.bak'), false);
  }
  const stale = f.service.get('pi'); fs.writeFileSync(file, 'An external edit');
  assert.throws(() => f.service.save('pi', { ...stale, common: { permissionMode: 'full' } }), /modified by another application/);
  assert.equal(f.desktop.pi.permissionMode, 'ask');
  assert.equal(fs.readFileSync(file, 'utf8'), 'An external edit');
});

test('desktop IPC exposes Pi settings, blocks running sessions and retires idle sessions after saving', async t => {
  const { createHarness } = require('./claude-harness.cjs');
  const h = createHarness(); t.after(() => h.cleanup());
  const driver = h.api.sharedConversations.drivers.pi;
  let retired = false;
  const session = { running: true, shutdown: async () => { retired = true; } };
  driver.sessions.set({}, session);
  const value = await h.call('engine-settings-get', { engine: 'pi' });
  assert.equal(value.ok, true, value.error);
  value.files[0].text = 'Use the desktop project conventions.';
  const payload = { ...value, common: { permissionMode: 'full', thinkingBudget: 'minimal', contextWindow: 98304 } };
  const blocked = await h.call('engine-settings-save', payload);
  assert.equal(blocked.ok, false); assert.match(blocked.error, /Stop/);
  assert.equal(retired, false);
  session.running = false;
  const saved = await h.call('engine-settings-save', payload);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(retired, true);
  assert.equal(driver.sessions.active, false);
  assert.equal(driver.settings().permissionMode, 'full');
  assert.equal(driver.settings().thinkingBudget, 'minimal');
  assert.equal(Number(driver.settings().contextWindow), 98304);
  assert.equal(fs.readFileSync(path.join(h.userData, 'pi-native/AGENTS.md'), 'utf8'), value.files[0].text);
  assert.ok(h.events.some(event => event.channel === 'dsh:engine-settings-changed' && event.data.engine === 'pi'));
});
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
  const manager = createRuntimeManager({ root, installRoot: target, node: process.execPath, npm: 'fixture-npm', discoverLocal: false,
    downloadOptions: () => { prompts++; return { mode: fail ? 'proxy' : 'direct', url: 'http://proxy.example:8080/' }; },
    runCommand: async (_exe, args, options) => {
    calls++; assert.ok(args.includes('ci')); assert.ok(args.includes('--ignore-scripts'));
    // The install builds into a staging directory beside the final one, and the
    // prefix must still be the physical path (npm 11 rejects a symlinked prefix).
    const prefix = args[args.indexOf('--prefix') + 1];
    assert.equal(path.dirname(prefix), fs.realpathSync.native(path.join(physical, 'runtimes')));
    assert.match(path.basename(prefix), /^\.kimi\.staging-/);
    assert.equal(options.cwd, prefix);
    assert.equal(options.env.HTTPS_PROXY, fail ? 'http://proxy.example:8080/' : '');
    if (fail) throw new Error('temporary network failure');
    const info = ENGINES.kimi, dir = path.join(prefix, 'node_modules', info.package);
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

test('a wiped companion plugin reports missing and an interrupted install keeps the previous files', async t => {
  const f = fixture(t), root = path.join(f.home, 'distribution'), target = path.join(f.home, 'installed');
  for (const file of ['package.json', 'package-lock.json']) f.put(path.join('distribution/runtimes/dsh', file), '{}');
  // A partially damaged install: the entry file survives while a companion
  // plugin is gone, which is exactly what a wiped `npm ci` leaves behind.
  f.put(path.join('installed/runtimes/dsh/node_modules/@deepseek-ai/dsh', 'package.json'), '{"version":"0.1.5-rc.2"}');
  const entry = f.put(path.join('installed/runtimes/dsh/node_modules/@deepseek-ai/dsh', 'lib/bin.js'), '// keep me');
  const manager = createRuntimeManager({ root, installRoot: target, node: process.execPath, npm: 'fixture-npm', discoverLocal: false,
    downloadOptions: () => ({ mode: 'direct', url: '' }),
    runCommand: async () => { throw new Error('killed mid-install'); } });
  assert.equal(manager.state().find(row => row.id === 'dsh').status, 'missing', 'A missing companion plugin must not look installed');
  await assert.rejects(manager.ensure('dsh'), /killed mid-install/);
  assert.equal(fs.readFileSync(entry, 'utf8'), '// keep me', 'An interrupted install must not empty the previous files');
  assert.deepEqual(fs.readdirSync(path.join(target, 'runtimes')), ['dsh'], 'No staging or backup directories are left behind');
});

test('source setup and startup checks leave missing engines uninstalled', async t => {
  const f = fixture(t), root = path.join(f.home, 'fresh-checkout');
  fs.mkdirSync(root);
  const prepare = require('../scripts/prepare-runtimes.cjs');
  for (const options of [{}, { check: true }]) {
    const rows = await prepare({ root, ...options });
    assert.deepEqual(rows.map(row => row.id), ['claude', 'codex', 'dsh', 'kimi', 'pi', 'antigravity']);
    assert.ok(rows.every(row => row.status === 'missing' || (row.status === 'ready' && row.external)), 'Only pre-existing external runtimes may be ready');
    assert.deepEqual(fs.readdirSync(root), [], 'No engine files are downloaded by default');
  }
});
