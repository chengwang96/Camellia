'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const TOML = require('smol-toml');
const { googleDiscussionSpec, extraTextSpec, kimiCredentialFile, VERSIONS } = require('../src/engines/discussions/text-runtimes');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { removeTree } = require('./test-fs.cjs');
const { DiscussionProduction } = require('../src/engines/discussions/production');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-text-policy-'));
  t.after(() => removeTree(root));
  const home = path.join(root, 'native'), cwd = path.join(root, 'work');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  return { root, home, cwd, env: isolatedEnvironment(path.join(root, 'profile'), process.execPath), node: process.execPath,
    route: { baseUrl: 'http://127.0.0.1:3333/bench/fixed', authToken: 'proxy-managed' } };
}

test('validated runtime upgrades stay available and produce distinct evidence; unknown versions remain blocked', () => {
  const production = Object.create(DiscussionProduction.prototype);
  const installed = {};
  production.registry = { get: () => ({}) };
  production.runtimes = () => ({ locate: (engine, connection) => ({ version: installed[engine + ':' + connection] }) });
  for (const [engine, previous, next] of [['codex', '0.154.0', '0.160.0'], ['codex', '0.160.0', '0.160.1'], ['claude', '2.1.273', '2.1.287'],
    ['claude', '2.1.287', '2.1.288'], ['claude', '2.1.288', '2.1.289'], ['claude', '2.1.289', '2.1.291'], ['dsh', '0.1.5-rc.2', '0.2.0-rc.2'],
    ['kimi', '2.0.0', '2.1.1'], ['antigravity', '0.1.17', '0.1.20']]) {
    const binding = { engine, connection: 'api' }, key = engine + ':api';
    installed[key] = previous;
    assert.equal(production.canVerify(binding), true);
    const before = production.runtimeInfo(binding);
    installed[key] = next;
    assert.equal(production.canVerify(binding), true);
    assert.notEqual(production.runtimeInfo(binding).version, before.version, 'Old evidence cannot admit an upgraded runtime');
    installed[key] = '99.0.0';
    assert.equal(production.canVerify(binding), false);
  }
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
      assert.equal(production.canVerify(binding), true, engine + ' installer must match the validated discussion policy');
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

test('new API harness launches keep the exact route and disable native tool discovery', t => {
  const input = setup(t);
  for (const engine of ['claude', 'kimi', 'pi', 'dsh']) {
    const home = path.join(input.home, engine); fs.mkdirSync(home);
    const runtime = { version: VERSIONS[engine], file: path.join(input.root, engine + '.js'), dir: input.root };
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
    } else if (engine === 'pi') {
      assert.ok(spec.args.includes('--no-tools')); assert.ok(spec.args.includes('--no-extensions')); assert.ok(!spec.args.includes('-e'));
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'models.json'))).providers.camellia.baseUrl, input.route.baseUrl);
    } else {
      const patch = YAML.parse(fs.readFileSync(path.join(home, 'discussion.patch.yml'), 'utf8'));
      assert.ok(patch.some(row => row.id === 'tool-future-tool' && row.disabled));
      assert.ok(patch.some(row => row.insert?.some(plugin => plugin.id === 'camellia-discussion-policy')));
    }
  }
});
