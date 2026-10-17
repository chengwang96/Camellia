'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { antigravitySpawnSpec, subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { locatePythonRuntime, detectSystemPython } = require('../src/main/python-runtime');

const options = () => ({ runtime: { custom: true, version: '0.1.17' }, home: path.resolve('fixture-home'),
  env: {}, route: { baseUrl: 'http://127.0.0.1:1234' } });
const config = spec => JSON.parse(spec.env.CAMELLIA_ANTIGRAVITY_CONFIG);

test('the Python bridge accepts SDK upgrades while keeping its verification policy enforced', t => {
  const runtime = locatePythonRuntime(path.resolve(__dirname, '../runtimes/antigravity')) || detectSystemPython();
  if (!runtime?.file) return t.skip('Python is unavailable');
  const result = spawnSync(runtime.file, ['-I', '-X', 'utf8', path.join(__dirname, 'fixtures/antigravity-discussion-policy.py')],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /upgraded SDKs can verify/);
});

test('tool-free SDK launch requires the explicit policy and accepts runtime upgrades for verification', () => {
  for (const executionPolicy of [null, '', 'plan', 'tool-free', 'tool-free-v2', {}]) {
    assert.throws(() => antigravitySpawnSpec({ ...options(), executionPolicy }), /Unverified/);
  }
  for (const version of ['0.1.17', '0.1.20', '99.0.0-next.1']) {
    const prepared = config(antigravitySpawnSpec({ ...options(), runtime: { custom: true, version }, executionPolicy: 'tool-free-v1', config: { instructions: 'Fixture instructions' } }));
    assert.equal(prepared.executionPolicy, 'tool-free-v1');
    assert.equal(prepared.settings.instructions, 'Fixture instructions');
  }
});

test('tool-free SDK launch refuses MCP and skill configuration before a process can start', () => {
  for (const native of [{ mcpServers: { command: { command: 'must-not-start' } } },
    { mcpServers: { remote: { url: 'https://must-not-connect.invalid', disabled: true } } },
    { skillsPaths: ['must-not-load'] }]) {
    assert.throws(() => antigravitySpawnSpec({ ...options(), executionPolicy: 'tool-free-v1', config: native }), /cannot load MCP servers or skills/);
  }
  assert.equal(config(antigravitySpawnSpec({ ...options(), executionPolicy: 'tool-free-v1',
    config: { mcpServers: {}, skillsPaths: [] } })).executionPolicy, 'tool-free-v1');
});

test('ordinary native settings and inherited environment cannot select or remove a launch policy', () => {
  const inherited = { CAMELLIA_ANTIGRAVITY_CONFIG: JSON.stringify({ executionPolicy: 'tool-free-v1' }) };
  const native = { executionPolicy: 'tool-free-v1', mcpServers: { ordinary: { command: 'ordinary-server' } } };
  const ordinary = config(antigravitySpawnSpec({ ...options(), env: inherited, config: native }));
  assert.equal(ordinary.executionPolicy, undefined); assert.deepEqual(ordinary.settings, native);
  const restricted = config(antigravitySpawnSpec({ ...options(), env: { CAMELLIA_ANTIGRAVITY_CONFIG: '{}' },
    config: { executionPolicy: null }, executionPolicy: 'tool-free-v1' }));
  assert.equal(restricted.executionPolicy, 'tool-free-v1');
});

test('CLI literal input stays explicit across runtime upgrades', () => {
  const input = { runtime: { file: 'fixture-cli', version: '1.2.3' }, home: '/fixture', env: {} };
  for (const literalInput of [null, 'true', 1]) {
    assert.throws(() => subscriptionSpawnSpec({ ...input, literalInput }), /Unverified/);
  }
  assert.throws(() => subscriptionSpawnSpec({ ...input, discussion: true }), /require literal input/);
  const inherited = { CAMELLIA_ANTIGRAVITY_CLI: JSON.stringify({ literalInput: true }) };
  const ordinary = JSON.parse(subscriptionSpawnSpec({ ...input, env: inherited }).env.CAMELLIA_ANTIGRAVITY_CLI);
  assert.equal(ordinary.literalInput, undefined);
  const explicit = JSON.parse(subscriptionSpawnSpec({ ...input, literalInput: true }).env.CAMELLIA_ANTIGRAVITY_CLI);
  assert.equal(explicit.literalInput, true); assert.equal(explicit.executionPolicy, undefined);
  for (const version of ['1.2.14', '1.3.5', '99.0.0-next.1']) {
    const current = JSON.parse(subscriptionSpawnSpec({ ...input, runtime: { ...input.runtime, version }, literalInput: true, discussion: true }).env.CAMELLIA_ANTIGRAVITY_CLI);
    assert.equal(current.literalInput, true);
    assert.equal(current.discussion, true);
  }
});
