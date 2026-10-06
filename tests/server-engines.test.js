'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngineDrivers, claudeSpec } = require('../src/cli/engine-drivers');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { removeTree } = require('./test-fs.cjs');
const { DiscussionManager } = require('../src/engines/discussions/manager');

function directory(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-engines-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  context.after(() => removeTree(root)); return root;
}

test('Codex runtime discovery selects native Linux x64 and arm64 triplets', context => {
  const root = directory(context);
  for (const [arch, cpu] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
    const file = path.join(root, `runtimes/codex/node_modules/@openai/codex-linux-${arch}/vendor/${cpu}-unknown-linux-musl/bin/codex`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'test');
    const manifest = path.join(root, 'runtimes/codex/node_modules/@openai/codex/package.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true }); fs.writeFileSync(manifest, '{"version":"test"}');
    const runtimes = createRuntimeManager({ root, installRoot: root, platform: 'linux', arch });
    assert.equal(runtimes.locate('codex').file, file);
  }
});

test('server drivers keep isolated native homes and enable only implemented engines', async context => {
  const root = directory(context); let saved = {};
  const system = createEngineDrivers({ root, dataDir: root, loadConfig: () => saved, saveConfig: patch => { saved = { ...saved, ...patch }; },
    onEvent: () => {}, getRoute: () => ({ baseUrl: 'http://127.0.0.1:8788', authToken: 'managed' }), router: () => ({ enabled: false, providers: [], usage: {}, active: {} }),
    isBusy: () => false, runtimeManager: { locate: () => ({ file: '/test/native' }), state: () => [], ensure: async () => ({ file: '/test/native' }) } });
  context.after(() => Promise.all(Object.values(system.drivers).map(driver => driver.shutdown())));
  assert.deepEqual(Object.keys(system.drivers).sort(), ['antigravity', 'claude', 'codex', 'dsh', 'kimi', 'pi']);
  for (const driver of Object.values(system.drivers)) {
    assert.equal(driver.settings().permissionMode, 'ask');
    for (const method of ['settings', 'saveSettings', 'ensure', 'shutdown']) assert.equal(typeof driver[method], 'function');
  }
  assert.equal(system.drivers.pi.history.root, path.join(root, 'pi-history'));
  assert.equal(system.drivers.pi.settings().connection, 'api');
  assert.throws(() => system.drivers.pi.saveSettings({ connection: 'subscription' }), /API connections only/);
  system.drivers.pi.saveSettings({ model: 'pi-test-model', thinkingBudget: 'high' });
  assert.equal(system.drivers.pi.settings().model, 'pi-test-model');
  assert.equal(system.drivers.pi.settings().thinkingBudget, 'high');
  assert.equal(system.drivers.pi.settings().connection, 'api');
  assert.throws(() => system.nativeLogin('pi'), /account command/);
  assert.equal(system.nativeLogin('claude').home, path.join(root, 'claude-native'));
  const codex = system.nativeLogin('codex');
  assert.deepEqual(codex.args, ['login', '--device-auth']);
  assert.deepEqual(system.nativeLogin('claude', 'status').args, ['auth', 'status']);
  assert.deepEqual(system.nativeLogin('codex', 'logout').args, ['logout']);
  assert.equal(system.nativeLogin('antigravity').home, path.join(root, 'google-native'));
  assert.ok(codex.home.startsWith(root + path.sep));
  assert.throws(() => system.nativeLogin('dsh'), /account command/);
  assert.deepEqual((await system.account('kimi', 'state')).models, []);
  system.drivers.claude.saveSettings({ connection: 'subscription', model: 'my-account-model' });
  assert.equal(system.drivers.claude.settings().model, 'my-account-model');
  assert.equal(system.drivers.claude.settings().connection, 'subscription');
});

test('all server entry points reject persisted discussion runtimes and native histories before preparing a launch', async context => {
  const root = directory(context); let saved = {}, runtimeSelections = 0;
  const system = createEngineDrivers({ root, dataDir: root, loadConfig: () => saved, saveConfig: patch => { saved = { ...saved, ...patch }; },
    onEvent() {}, getRoute: () => assert.fail('Rejected launch reached routing'), router: () => assert.fail('Rejected launch reached model selection'),
    isBusy: () => false, runtimeManager: { locate: () => { runtimeSelections++; return { file: path.join(root, 'unused-native') }; } } });
  context.after(() => Promise.all(Object.values(system.drivers).map(driver => driver.shutdown())));
  const manager = new DiscussionManager({ dir: path.join(root, 'discussions') }), group = manager.create({ cwd: root });
  for (const [engine, driver] of Object.entries(system.drivers)) {
    const member = manager.addMember(group.id, { name: engine, engine, connection: 'api', model: 'fixture' });
    manager.store.update(group.id, state => { state.participants.find(p => p.id === member.id).session.nativeId = engine + '-native'; });
    assert.throws(() => driver.ensure({ conversationId: member.session.runtimeId, cwd: root }), /owned by a discussion/);
    assert.throws(() => driver.ensure({ conversationId: 'ordinary', sessionId: engine + '-native', cwd: root }), /owned by a discussion/);
    assert.throws(() => driver.history.remove(engine + '-native'), /owned by a discussion/);
  }
  assert.equal(runtimeSelections, 0);
});

test('Claude API and subscription spawn specs never inherit external API credentials', context => {
  const root = directory(context);
  const common = { home: root, opts: { conversationId: 'test' }, environment: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'do-not-inherit', ANTHROPIC_BASE_URL: 'https://untrusted', CLAUDE_CODE_OAUTH_TOKEN: 'no-copy' }, history: { find: () => null } };
  const api = claudeSpec({ ...common, settings: { connection: 'api', permissionMode: 'ask', model: 'model-a', cwd: root }, route: { baseUrl: 'http://127.0.0.1:8788', authToken: 'managed' } });
  assert.equal(api.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8788');
  assert.equal(api.env.CLAUDE_CONFIG_DIR, root);
  assert.equal(api.env.ANTHROPIC_API_KEY, '');
  assert.equal(api.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  const disabled = claudeSpec({ ...common, settings: { connection: 'api', model: 'model-a', thinkingBudget: 'none' }, route: { baseUrl: 'http://127.0.0.1:8788', authToken: 'managed' } });
  assert.equal(disabled.args.includes('--effort'), false);
  assert.equal(disabled.env.MAX_THINKING_TOKENS, '0');
  const subscription = claudeSpec({ ...common, settings: { connection: 'subscription', permissionMode: 'ask', model: 'account-model', cwd: root } });
  assert.equal(subscription.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(subscription.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(subscription.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'overlays/test.json'), 'utf8')), { env: {} });
  assert.ok(subscription.args.includes('account-model'));
});

test('Linux Antigravity distributions pin official URLs and cryptographic hashes', () => {
  const manifest = require('../runtimes/antigravity/runtime.json');
  for (const arch of ['x64', 'arm64']) {
    const runtime = manifest.platforms[`linux-${arch}`], cli = manifest.cli.platforms[`linux-${arch}`];
    assert.match(runtime.url, /^https:\/\/files\.pythonhosted\.org\//);
    assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
    assert.match(runtime.python, /linux-.*-gnu\/bin\/python3\.13$/);
    assert.match(cli.url, /^https:\/\/storage\.googleapis\.com\/antigravity-public\//);
    assert.match(cli.sha512, /^[a-f0-9]{128}$/);
    assert.equal(cli.version, '1.2.11');
  }
});
