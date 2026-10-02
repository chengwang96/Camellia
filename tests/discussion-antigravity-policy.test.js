'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { antigravitySpawnSpec, subscriptionSpawnSpec } = require('../src/engines/antigravity');

const options = () => ({ runtime: { custom: true, version: '0.1.17' }, home: path.resolve('fixture-home'),
  env: {}, route: { baseUrl: 'http://127.0.0.1:1234' } });
const config = spec => JSON.parse(spec.env.CAMELLIA_ANTIGRAVITY_CONFIG);

test('tool-free SDK launch requires the reviewed policy and runtime version', () => {
  for (const executionPolicy of [null, '', 'plan', 'tool-free', 'tool-free-v2', {}]) {
    assert.throws(() => antigravitySpawnSpec({ ...options(), executionPolicy }), /Unverified/);
  }
  for (const version of [undefined, '0.1.16', '0.1.18']) {
    assert.throws(() => antigravitySpawnSpec({ ...options(), runtime: { custom: true, version }, executionPolicy: 'tool-free-v1' }), /Unverified/);
  }
  for (const version of ['0.1.17', '0.1.20']) {
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

test('CLI literal input is explicit and pinned to the verified CLI build', () => {
  const input = { runtime: { file: 'fixture-cli', version: '1.2.3' }, home: '/fixture', env: {} };
  for (const literalInput of [null, 'true', 1]) {
    assert.throws(() => subscriptionSpawnSpec({ ...input, literalInput }), /Unverified/);
  }
  for (const version of [undefined, '1.2.2', '1.2.4']) {
    assert.throws(() => subscriptionSpawnSpec({ ...input, runtime: { ...input.runtime, version }, literalInput: true }), /Unverified/);
  }
  const inherited = { CAMELLIA_ANTIGRAVITY_CLI: JSON.stringify({ literalInput: true }) };
  const ordinary = JSON.parse(subscriptionSpawnSpec({ ...input, env: inherited }).env.CAMELLIA_ANTIGRAVITY_CLI);
  assert.equal(ordinary.literalInput, undefined);
  const explicit = JSON.parse(subscriptionSpawnSpec({ ...input, literalInput: true }).env.CAMELLIA_ANTIGRAVITY_CLI);
  assert.equal(explicit.literalInput, true); assert.equal(explicit.executionPolicy, undefined);
});
