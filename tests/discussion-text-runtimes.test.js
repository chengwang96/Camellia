'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const YAML = require('yaml');
const TOML = require('smol-toml');
const { googleDiscussionSpec, extraTextSpec, kimiCredentialFile } = require('../src/engines/discussions/text-runtimes');
const { CONNECTIONS } = require('../src/engines/discussions/capabilities');
const { isolatedEnvironment } = require('../src/engines/isolated-environment');
const { removeTree } = require('./test-fs.cjs');
const { DiscussionProduction } = require('../src/engines/discussions/production');
const { codexTextSpec } = require('../src/engines/discussions/codex-text-policy');
const { UnixJobJournal } = require('../src/engines/discussions/unix-job');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-text-policy-'));
  t.after(() => removeTree(root));
  const home = path.join(root, 'native'), cwd = path.join(root, 'work');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  return { root, home, cwd, env: isolatedEnvironment(path.join(root, 'profile'), process.execPath), node: process.execPath,
    route: { baseUrl: 'http://127.0.0.1:3333/scopes/fixed', authToken: 'proxy-managed' } };
}

test('Codex discussion catalogs keep text-only instructions in both native schema fields', t => {
  const input = setup(t);
  const spec = codexTextSpec({ ...input, runtime: { version: '99.0.0-next.1', file: path.join(input.root, 'codex') },
    model: 'fixture-model', connection: 'api', inherited: input.env });
  const config = TOML.parse(fs.readFileSync(path.join(input.home, 'config.toml'), 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(config.model_catalog_json, 'utf8'));
  assert.ok(catalog.models.some(entry => entry.slug === 'fixture-model'));
  for (const entry of catalog.models) {
    assert.equal(entry.base_instructions, spec.discussionInstructions, entry.slug);
    assert.equal(entry.model_messages.instructions_template, spec.discussionInstructions);
    assert.equal(entry.apply_patch_tool_type, null);
  }
});

test('macOS production registers all six engines with the Unix supervisor and Windows keeps its own backend', t => {
  const { root } = setup(t);
  for (const platform of ['darwin', 'win32', 'linux']) {
    const registered = new Map();
    const production = new DiscussionProduction({ dataDir:path.join(root,platform), platform,
      registry:{get:engine=>registered.get(engine),register:entry=>registered.set(entry.engine,entry)},
      codex:{ensureSession(){}}, antigravity:{ensureSession(){}}, runtimes:()=>({locate:()=>null}), getCatalog:()=>[] });
    production.refresh();
    assert.deepEqual([...registered.keys()].sort(), platform === 'linux' ? [] : ['antigravity','claude','codex','dsh','grok','kimi']);
    assert.equal(production.journal instanceof UnixJobJournal, platform === 'darwin');
    for (const entry of registered.values()) for (const method of ['prepare','verify','confirmStopped']) assert.equal(typeof entry.policy[method],'function');
  }
});

test('every configured harness can verify future and prerelease runtimes without an application update', () => {
  const production = Object.create(DiscussionProduction.prototype);
  const installed = {};
  production.registry = { get: () => ({}) };
  production.runtimes = () => ({ locate: (engine, connection) => ({ version: installed[engine + ':' + connection] }) });
  for (const [engine, connections] of Object.entries(CONNECTIONS)) {
    for (const connection of connections) {
      const binding = { engine, connection }, key = engine + ':' + connection;
      installed[key] = '99.0.0';
      assert.equal(production.canVerify(binding), true);
      assert.equal(production.canInstall(binding), false);
      const before = production.runtimeInfo(binding);
      installed[key] = '100.0.0-next.1';
      assert.equal(production.canVerify(binding), true);
      assert.notDeepEqual(production.runtimeInfo(binding), before, 'Old evidence cannot admit an upgraded runtime');
    }
  }
});

test('missing runtimes and unsupported connections cannot enter verification', () => {
  const production = Object.create(DiscussionProduction.prototype);
  production.registry = { get: () => ({}) };
  let runtime = { version: '99.0.0' };
  production.runtimes = () => ({ locate: () => runtime });
  for (const connection of ['api', 'subscription']) {
    const binding = { engine: 'codex', connection };
    assert.equal(production.canVerify(binding), true);
    assert.match(production.reason(binding), /Verify this connection/);
    runtime = null;
    assert.equal(production.canVerify(binding), false);
    assert.equal(production.canInstall(binding), true);
    assert.equal(production.reason(binding), 'No harness runtime was found. Install it or set its executable path in Settings, then refresh models.');
    runtime = { version: '99.0.0' };
  }
  for (const binding of [{ engine: 'unknown', connection: 'api' }, { engine: 'claude', connection: 'subscription' },
    { engine: 'codex', connection: 'unknown' }]) {
    assert.equal(production.canVerify(binding), false);
    assert.equal(production.canInstall(binding), false);
  }
  production.runtimes = () => ({ locate() { throw new Error('Invalid configured executable'); } });
  assert.equal(production.canVerify({ engine: 'codex', connection: 'api' }), false);
  assert.equal(production.canInstall({ engine: 'codex', connection: 'api' }), false, 'Installation must not replace an invalid custom path');
  production.registry.get = () => null;
  assert.equal(production.canVerify({ engine: 'codex', connection: 'api' }), false);
});

test('shipped Claude and Codex installer versions can enter discussion verification', () => {
  const production = Object.create(DiscussionProduction.prototype);
  production.registry = { get: () => ({}) };
  const installed = Object.fromEntries(Object.entries({ claude: '@anthropic-ai/claude-code', codex: '@openai/codex' }).map(([engine, dependency]) => {
    const manifest = require('../runtimes/' + engine + '/package.json');
    return [engine, manifest.dependencies[dependency]];
  }));
  production.runtimes = () => ({ locate: engine => ({ version: installed[engine] }) });
  for (const engine of ['claude', 'codex']) {
    for (const connection of engine === 'codex' ? ['api', 'subscription'] : ['api']) {
      const binding = { engine, connection };
      assert.equal(production.canVerify(binding), true, engine + ' installer can enter online verification');
      assert.equal(production.runtimeInfo(binding).version, installed[engine]);
    }
  }
});

test('Kimi subscriptions use the selected account credential key, including regional keys', t => {
  const { home } = setup(t);
  const config = key => ({ providers: { 'managed:kimi-code': { oauth: { key } } } });
  for (const key of ['oauth/kimi-code', 'oauth/kimi-code-global', 'kimi-code-custom'])
    assert.equal(kimiCredentialFile(home, config(key)), path.join(home, 'credentials', key.replace(/^oauth\//, '') + '.json'));
  for (const key of ['oauth/../outside', 'oauth/a/b', 'C:\\outside', '.hidden']) assert.throws(() => kimiCredentialFile(home, config(key)));
});

test('Google discussion keeps native subscription auth, selects effort, and has no user extensions or API route', t => {
  const input = setup(t);
  Object.assign(input.env, { GEMINI_API_KEY: 'must-not-inherit', GOOGLE_API_KEY: 'must-not-inherit' });
  const spec = googleDiscussionSpec({ ...input, runtime: { version: '1.2.3', file: path.join(input.root, 'agy.exe') },
    profile: { model: 'gemini-test', thinking: '' }, models: [{ id: 'gemini-test', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'high'] }] });
  const config = JSON.parse(spec.env.CAMELLIA_ANTIGRAVITY_CLI);
  assert.equal(config.model, 'gemini-test'); assert.equal(config.effort, 'high');
  assert.equal(config.discussion, true); assert.equal(config.literalInput, true);
  assert.equal(spec.env.GEMINI_API_KEY, undefined); assert.equal(spec.env.GOOGLE_API_KEY, undefined);
  const native = JSON.parse(fs.readFileSync(path.join(input.env.HOME, '.gemini/antigravity-cli/settings.json')));
  assert.equal(native.modelProvider, 'antigravity');
  for (const action of ['read_file', 'write_file', 'command', 'unsandboxed', 'read_url', 'execute_url', 'mcp']) assert.ok(native.permissions.deny.includes(action + '(*)'));
  assert.match(fs.readFileSync(path.join(input.cwd, '.agents/agents/camellia-discussion.md'), 'utf8'), /tools: \[\]/);
  assert.equal(fs.existsSync(path.join(input.env.HOME, '.gemini/config/mcp_config.json')), false);
});

for (const verification of [false, true]) for (const mode of ['auto', 'direct']) {
  test(`Google discussion ${verification ? 'verification' : 'chat'} preserves the ${mode} subscription network route`, async t => {
    const { root, node } = setup(t);
    const profile = { engine: 'antigravity', connection: 'subscription', model: 'gemini-test', accountRef: 'default', thinking: '', contextWindow: 32768 };
    const runtime = { file: path.join(root, 'agy.exe'), dir: root, version: '1.4.3' };
    const proxy = mode === 'auto' ? 'http://127.0.0.1:54321' : '';
    const subscriptionProxy = mode === 'auto' ? 'http://127.0.0.1:7890' : '';
    const inherited = { ...process.env, CAMELLIA_NETWORK_MODE: mode, CAMELLIA_NETWORK_PROXY: proxy,
      CAMELLIA_SUBSCRIPTION_PROXY: subscriptionProxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy,
      GEMINI_API_KEY: 'must-not-inherit', CAMELLIA_UNRELATED_SECRET: 'must-not-inherit' };
    const production = new DiscussionProduction({ dataDir: root, node: () => node, environment: () => inherited,
      registry: { get: () => ({}), updateRuntime() {} },
      antigravity: { ensureSession() {}, handlers: { 'account-state': async () => ({ models: [] }) } },
      runtimes: () => ({ locate: engine => engine === 'antigravity' ? runtime : null }), getCatalog: async () => [{ binding: profile }] });
    const identity = { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 };
    production.jobs = { prepare: async () => ({ spawn() { assert.fail('Building a launch must not send a prompt'); }, stop: async () => ({ stopped: true }) }) };
    t.after(() => production.confirmStopped({ identity }));
    const cwd = path.join(production.root, 'work', randomUUID());
    const prepared = await production.prepare({ identity, profile, cwd, verification });
    const spec = prepared.launch.buildSpec({ runtime });
    assert.equal(spec.env.CAMELLIA_SUBSCRIPTION_PROXY, subscriptionProxy);
    assert.equal(spec.env.HTTP_PROXY, subscriptionProxy);
    assert.equal(spec.env.HTTPS_PROXY, subscriptionProxy);
    assert.equal(spec.env.CAMELLIA_NETWORK_PROXY, proxy);
    assert.equal(spec.env.NO_PROXY, subscriptionProxy ? 'localhost,127.0.0.1,::1' : '*');
    assert.equal(spec.env.GEMINI_API_KEY, undefined);
    assert.equal(spec.env.CAMELLIA_UNRELATED_SECRET, undefined);
    assert.equal(spec.env.HOME, path.join(production.root, 'native-antigravity', identity.runtimeId, 'profile'));
    assert.equal(inherited.HTTPS_PROXY, proxy, 'Preparing a member must not change the parent network route');
  });
}

test('Grok subscription verification keeps OAuth authentication and never builds an API route', async t => {
  const { root, node } = setup(t);
  const profile = { engine: 'grok', connection: 'subscription', accountRef: 'default', model: 'grok-4.7', thinking: '', contextWindow: 500000 };
  const runtime = { file: path.join(root, 'grok'), version: '1.0.70' }, refreshed = [];
  const accountHome = path.join(root, 'grok-subscription');
  fs.mkdirSync(accountHome);
  fs.writeFileSync(path.join(accountHome, 'auth.json'), JSON.stringify({ access_token: 'fixture-only', refresh_token: 'must-not-copy', user_id: 'user', expires_at: Date.now() / 1000 + 3600 }));
  const production = new DiscussionProduction({ dataDir: root, node: () => node,
    registry: { get: () => ({}), updateRuntime() {} },
    runtimes: () => ({ locate: engine => engine === 'grok' ? runtime : null }),
    getRouter: () => { assert.fail('Subscription verification must not use the API router'); },
    refreshGrok: async id => refreshed.push(id), getCatalog: async () => [{ binding: profile }] });
  const identity = { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 };
  production.jobs = { prepare: async () => ({ spawn() { assert.fail('Preparation must not start a turn'); }, stop: async () => ({ stopped: true }) }) };
  t.after(() => production.confirmStopped({ identity }));
  const prepared = await production.prepare({ identity, profile, cwd: path.join(production.root, 'work', randomUUID()), verification: true });
  const spec = prepared.launch.buildSpec({ runtime });
  assert.deepEqual(refreshed, ['default']);
  assert.equal(spec.authMethod, 'cached_token');
  assert.equal(spec.modelValue, profile.model);
  assert.equal(prepared.settings.connection, 'subscription');
  const credential = JSON.parse(fs.readFileSync(path.join(spec.env.GROK_HOME, 'auth.json'), 'utf8'));
  assert.equal(credential.access_token, 'fixture-only');
  assert.equal(credential.refresh_token, '');
});

test('new API harness launches keep the exact route and disable native tool discovery', t => {
  const input = setup(t);
  for (const engine of ['claude', 'kimi', 'grok', 'dsh']) {
    const home = path.join(input.home, engine); fs.mkdirSync(home);
    const runtime = { version: '99.0.0-next.1', file: path.join(input.root, engine + '.js'), dir: input.root };
    if (engine === 'dsh') {
      const base = path.join(input.root, 'node_modules/@deepseek-ai/dsh-base'); fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, 'cordis.patch.yml'), '- insert:\n    - id: tool-bash\n    - id: tool-future-tool\n    - id: tools\n');
    }
    const spec = extraTextSpec({ ...input, home, runtime, profile: { engine, connection: 'api', model: 'chosen-model', thinking: '', contextWindow: 64000 } });
    assert.equal(spec.cwd, input.cwd);
    if (engine === 'claude') {
      assert.equal(spec.env.ANTHROPIC_BASE_URL, input.route.baseUrl);
      assert.equal(spec.args[spec.args.indexOf('--tools') + 1], '');
      assert.ok(spec.args.includes('--strict-mcp-config')); assert.ok(spec.args.includes('--disable-slash-commands'));
    } else if (engine === 'kimi') {
      const config = TOML.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
      assert.deepEqual(config.tools.enabled, ['camellia_discussion_text_only']);
      assert.ok(JSON.stringify(config).includes(input.route.baseUrl));
    } else if (engine === 'grok') {
      assert.ok(spec.args.indexOf('--model') < spec.args.indexOf('agent'));
      const config = TOML.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
      assert.equal(config.model.camellia.base_url, input.route.baseUrl + '/v1');
    } else {
      const patch = YAML.parse(fs.readFileSync(path.join(home, 'discussion.patch.yml'), 'utf8'));
      assert.ok(patch.some(row => row.id === 'tool-future-tool' && row.disabled));
      assert.ok(patch.some(row => row.insert?.some(plugin => plugin.id === 'camellia-discussion-policy')));
    }
  }
});
