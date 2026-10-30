'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativeSettings } = require('../src/cli/native-settings');
const { dshAcpSpec } = require('../src/engines/dsh-session');
const { kimiSpawnSpec } = require('../src/engines/kimi-session');
const { claudeSpec } = require('../src/cli/engine-drivers');
const { removeTree } = require('./test-fs.cjs');

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-server-settings-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); context.after(() => removeTree(root));
  const settings = createNativeSettings({ dataDir: root, ...options });
  const save = (engine, id, text, extra = {}) => settings.save({ engine, id, text, revision: settings.get(engine).files.find(file => file.id === id).revision, confirmed: true, ...extra });
  return { root, settings, save };
}

test('Grok server instructions reach the runtime and invalidate cached sessions', context => {
  const { root, settings, save } = fixture(context);
  const { createGrokChat } = require('../src/engines/grok-session');
  let config = {};
  const driver = createGrokChat({ dataDir: root, loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; }, getModels: () => ['test-model'],
    getRoute: () => ({ baseUrl: 'http://127.0.0.1:1234' }), runtimes: () => ({ locate: () => ({ file: '/grok/grok.exe' }) }),
    environment: () => ({}), accounts: {}, onEvent() {}, nativeConfig: () => settings.config('grok'),
    nativeRevision: () => settings.fingerprint('grok'), nativeInstructions: () => settings.config('grok', 'instructions') });
  context.after(() => driver.shutdown());
  const opts = { cwd: root, settings: { model: 'test-model' } };
  const first = driver.ensure(opts);
  assert.equal(driver.ensure({ ...opts }), first);
  save('grok', 'instructions', 'Use the server workspace.');
  const next = driver.ensure({ ...opts });
  assert.notEqual(next, first);
  assert.equal(next.spec.args[next.spec.args.indexOf('--rules') + 1], 'Use the server workspace.');
  driver.saveSettings({ connection: 'subscription' });
  assert.equal(driver.settings().connection, 'subscription');
  assert.throws(() => settings.save({ engine: 'grok', id: 'auth', confirmed: true }), /Unknown/);
});

test('six native settings collections expose only predefined documents and no filesystem paths', context => {
  const { settings } = fixture(context);
  for (const engine of ['claude', 'codex', 'kimi', 'dsh', 'antigravity', 'grok']) {
    const view = settings.get(engine);
    assert.equal(view.engine, engine); assert.equal(view.editable, true);
    for (const file of view.files) { assert.equal(file.path, undefined); assert.equal(file.file, undefined); assert.match(file.revision, /^[a-f0-9]{64}$/); }
  }
  assert.throws(() => settings.get('__proto__'));
  assert.throws(() => settings.save({ engine: 'codex', id: '../auth.json', confirmed: true }), /Unknown/);
});

test('native settings redact and preserve protected provider/account fields', context => {
  const { root, settings, save } = fixture(context);
  const file = settings.path('claude', 'settings'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ language: 'zh', model: 'account-model', env: { ANTHROPIC_API_KEY: 'secret', SAFE_OPTION: 'yes' } }));
  const view = settings.get('claude');
  assert.equal(JSON.stringify(view).includes('secret'), false);
  assert.equal(JSON.stringify(view).includes('account-model'), false);
  save('claude', 'settings', '{"language":"en","env":{"SAFE_OPTION":"new"}}');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.env.ANTHROPIC_API_KEY, 'secret'); assert.equal(raw.env.SAFE_OPTION, 'new'); assert.equal(raw.model, 'account-model');
  assert.equal(fs.existsSync(path.join(root, 'claude-native/auth.json')), false);
  assert.throws(() => save('claude', 'settings', '{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"never"}}'), /protected/);
  assert.throws(() => save('codex', 'settings', 'model_provider = "untrusted"'), /managed separately/);
  assert.throws(() => save('kimi', 'settings', '[providers.external]\napi_key="secret"'), /managed separately/);
  assert.throws(() => save('dsh', 'settings', 'llm-pi-ai: {}'), /managed separately/);
  assert.throws(() => save('antigravity', 'google', '{"modelProvider":"other"}'), /managed separately/);
});

test('native writes require confirmation, current revision and an idle engine', context => {
  let busy = false;
  const { settings, save } = fixture(context, { isBusy: () => busy });
  const initial = settings.get('codex').files[0];
  assert.throws(() => save('codex', 'settings', 'web_search="cached"', { confirmed: false }), /confirmation/);
  save('codex', 'settings', 'web_search="cached"');
  assert.throws(() => save('codex', 'settings', 'web_search="live"', { revision: initial.revision }), /changed/);
  busy = true; assert.equal(settings.get('codex').editable, false);
  assert.throws(() => save('codex', 'settings', 'web_search="disabled"'), /Stop engine/);
});

test('invalid native syntax, oversized text, prototype keys and YAML cycles never alter files', context => {
  const { settings, save } = fixture(context);
  assert.throws(() => save('claude', 'settings', '{"secret-token":'), /syntax/);
  assert.throws(() => save('dsh', 'settings', 'loop: &loop { next: *loop }'), /aliases/);
  assert.throws(() => save('claude', 'settings', '{"__proto__":{"polluted":true}}'), /Unsupported/);
  assert.throws(() => save('claude', 'instructions', 'x'.repeat(256 * 1024 + 1)), /limits/);
  assert.equal(fs.existsSync(settings.path('claude', 'settings')), false);
  assert.equal({}.polluted, undefined);
});

test('externally damaged native settings never expose parser fragments in engine errors', context => {
  const { settings } = fixture(context);
  const file = settings.path('kimi', 'settings'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'secret-value="never-expose');
  assert.throws(() => settings.config('kimi'), error => error.message === 'Native configuration is invalid; repair it on the server');
});

test('Linux native settings reject symlink directories and hardlinked files', { skip: process.platform !== 'linux' }, context => {
  const { root, settings } = fixture(context);
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'codex'));
  assert.throws(() => settings.get('codex'), /symbolic/);
  fs.mkdirSync(path.join(root, 'claude-native'));
  fs.writeFileSync(path.join(root, 'source'), '{}'); fs.linkSync(path.join(root, 'source'), settings.path('claude', 'settings'));
  assert.throws(() => settings.get('claude'), /unavailable/);
});

test('edited native preferences feed real spawn configuration without overriding API routing', context => {
  const { root, settings, save } = fixture(context);
  save('dsh', 'settings', 'custom-server-option: true');
  const dshHome = path.join(root, 'dsh-run');
  dshAcpSpec({ runtime: { file: '/runtime/dsh' }, home: dshHome, model: 'model', route: { baseUrl: 'http://127.0.0.1:8788' }, permissionMode: 'ask', env: {}, nativeConfig: settings.config('dsh') });
  const dsh = require('yaml').parse(fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8'));
  assert.equal(dsh['custom-server-option'], true); assert.equal(dsh['agent-default-model'].provider, 'api-pool');
  save('kimi', 'settings', 'telemetry=false\n[loop_control]\nmax_attempts_per_step=7');
  save('kimi', 'mcp', '{"mcpServers":{"test":{"command":"node","args":["fixture.js"]}}}');
  const kimiHome = path.join(root, 'kimi-run');
  kimiSpawnSpec({ home: kimiHome, runtime: '/runtime/kimi', route: { baseUrl: 'http://127.0.0.1:8788', authToken: 'managed' }, model: 'model', config: settings.config('kimi'), mcp: JSON.stringify(settings.config('kimi', 'mcp')) });
  const kimi = require('smol-toml').parse(fs.readFileSync(path.join(kimiHome, 'config.toml'), 'utf8'));
  assert.equal(kimi.loop_control.max_attempts_per_step, 7);
  assert.equal(JSON.parse(fs.readFileSync(path.join(kimiHome, 'mcp.json'), 'utf8')).mcpServers.test.command, 'node');
  save('claude', 'mcp', '{"mcpServers":{}}');
  const spec = claudeSpec({ settings: { model: 'model', connection: 'api', permissionMode: 'ask' }, opts: { conversationId: 'fixture' }, home: path.join(root, 'claude-native'), environment: {}, history: { find: () => null }, route: { baseUrl: 'http://127.0.0.1:8788', authToken: 'managed' }, mcpFile: settings.path('claude', 'mcp') });
  assert.ok(spec.args.includes(settings.path('claude', 'mcp')));
});

test('headless Claude resumes a frozen native cut and gives each branch its own MCP overlay', t => {
  const { root, settings, save } = fixture(t);
  save('claude', 'mcp', '{"mcpServers":{"existing":{"command":"custom-server"}}}');
  const mcpFile = settings.path('claude', 'mcp'), original = fs.readFileSync(mcpFile, 'utf8');
  const home = path.join(root, 'claude-native'), frozen = path.join(root, 'frozen.jsonl');
  const boundary = { resumeSessionAt: '12345678-1234-4234-8234-123456789abc', resumeDropsTurn: '23456789-1234-4234-8234-123456789abc' };
  const overlays = [];
  for (const conversationId of ['parent', 'child']) {
    const bridge = { command: 'node', args: ['goal-server'], env: { OWNER: conversationId } };
    const spec = claudeSpec({ home, environment: {}, mcpFile, history: { find() { assert.fail('Frozen forks must not depend on the source transcript'); } },
      settings: { model: 'fixture', connection: 'api', permissionMode: 'full' }, route: { baseUrl: 'http://127.0.0.1:8788', authToken: 'local' },
      opts: { conversationId, sessionId: 'source', resumeFile: frozen, fork: true, ...boundary, goalBridge: { config: bridge } } });
    assert.equal(spec.args[spec.args.indexOf('--resume') + 1], frozen);
    assert.equal(spec.args[spec.args.indexOf('--resume-session-at') + 1], boundary.resumeSessionAt);
    assert.equal(spec.args[spec.args.indexOf('--resume-drops-turn') + 1], boundary.resumeDropsTurn);
    assert.ok(spec.args.includes('--fork-session'));
    const file = spec.args[spec.args.indexOf('--mcp-config') + 1]; overlays.push(file);
    const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(merged.mcpServers.existing.command, 'custom-server');
    assert.deepEqual(merged.mcpServers.camellia_goals, bridge);
  }
  assert.notEqual(overlays[0], overlays[1]);
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), original);
});
