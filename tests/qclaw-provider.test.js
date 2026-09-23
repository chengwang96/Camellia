'use strict';

const { removeTree } = require('./test-fs.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverQclaw, gatewayEndpoint, DEFAULT_BASE_URL } = require('../src/api/qclaw-provider');
const { normalizeConfig, publicState, hasRoutes, PRESETS } = require('../src/api/api-router-config');

const CLASH = { gateway: { mode: 'remote', port: 28790, auth: { mode: 'token', token: 'live-token' } } };
const gateway = (port = 28790, token = 'live-token') => ({ gateway: { mode: 'local', port, auth: { mode: 'token', token } } });
const preset = () => structuredClone(PRESETS.find(entry => entry.type === 'qclaw'));

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qclaw-'));
  t.after(() => removeTree(root));
  return root;
}
function state(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'openclaw.json'), JSON.stringify(config));
  return dir;
}
const qclaw = (extra = {}) => ({ ...preset(), id: 'qclaw-local', keys: [{ id: 'qclaw-key', key: '', enabled: true }], ...extra });

test('only a local token gateway is treated as a usable endpoint', () => {
  assert.deepEqual(gatewayEndpoint(gateway(28790)), { baseUrl: 'http://127.0.0.1:28790/v1', token: 'live-token' });
  assert.equal(gatewayEndpoint(CLASH), null, 'a remote gateway is not a local route');
  assert.equal(gatewayEndpoint({ gateway: { mode: 'local', port: 28790, auth: { mode: 'oauth' } } }), null);
  assert.equal(gatewayEndpoint({ gateway: { mode: 'local', port: 70000, auth: { mode: 'token', token: 'x' } } }), null);
  assert.equal(gatewayEndpoint({ gateway: { mode: 'local', port: 28790, auth: { mode: 'token', token: '  ' } } }), null);
  assert.equal(gatewayEndpoint({ gateway: { mode: 'local', port: 28790, auth: { mode: 'token', token: 'a\nb' } } }), null);
  assert.equal(gatewayEndpoint(undefined), null);
  assert.equal(gatewayEndpoint({}), null);
});

test('discovery reads the live port and token from QClaw state', t => {
  const root = scratch(t);
  const dir = state(path.join(root, '.qclaw-oversea'), gateway(28791, 'fresh-token'));
  assert.deepEqual(discoverQclaw({ environment: { HOME: root } }), { baseUrl: 'http://127.0.0.1:28791/v1', token: 'fresh-token', stateDir: dir });
});

test('discovery skips an unusable state file and reports nothing when QClaw is absent', t => {
  const root = scratch(t);
  state(path.join(root, '.qclaw-oversea'), CLASH);
  const dir = state(path.join(root, '.qclaw'), gateway(28792, 'second-token'));
  assert.equal(discoverQclaw({ environment: { HOME: root } }).stateDir, dir, 'falls through to the next candidate directory');
  assert.equal(discoverQclaw({ environment: { HOME: path.join(root, 'nowhere') } }), null);
});

test('a QClaw state directory override wins over the default locations', t => {
  const root = scratch(t);
  const override = state(path.join(root, 'custom-qclaw'), gateway(28793, 'override-token'));
  assert.equal(discoverQclaw({ environment: { HOME: root, QCLAW_STATE_DIR: override } }).baseUrl, 'http://127.0.0.1:28793/v1');
});

test('a QClaw route picks up the discovered endpoint and token without any saved key', () => {
  const config = normalizeConfig({ providers: [qclaw()] }, null,
    { discoverQclaw: () => ({ baseUrl: 'http://127.0.0.1:28791/v1', token: 'auto-token' }) });
  const provider = config.providers[0];
  assert.equal(provider.baseUrl, 'http://127.0.0.1:28791/v1');
  assert.deepEqual(provider.keys.map(entry => entry.id), ['qclaw-auto']);
  assert.equal(provider.keys[0].key, 'auto-token');
  assert.equal(hasRoutes(config), true);
  assert.ok(!JSON.stringify(publicState(config)).includes('auto-token'), 'the token stays out of the published state');
});

test('a stopped QClaw leaves the stored endpoint in place and stays unroutable', () => {
  const config = normalizeConfig({ providers: [qclaw()] }, null, { discoverQclaw: () => null });
  assert.equal(config.providers[0].baseUrl, DEFAULT_BASE_URL);
  assert.deepEqual(config.providers[0].keys, [], 'no placeholder key is invented');
  assert.equal(hasRoutes(config), false);
});

test('a rotating QClaw token keeps one key entry and its counters', () => {
  const first = normalizeConfig({ providers: [qclaw()] }, null,
    { discoverQclaw: () => ({ baseUrl: 'http://127.0.0.1:28790/v1', token: 'day-one' }) });
  first.usage['qclaw-auto'].requests = 7;
  first.usage['qclaw-auto'].inputTokens = 1200;
  const next = normalizeConfig(publicState(first), first,
    { discoverQclaw: () => ({ baseUrl: 'http://127.0.0.1:28794/v1', token: 'day-two' }) });
  assert.equal(next.providers[0].keys.length, 1);
  assert.equal(next.providers[0].keys[0].id, 'qclaw-auto');
  assert.equal(next.providers[0].keys[0].key, 'day-two');
  assert.equal(next.providers[0].keys[0].enabled, true);
  assert.equal(next.providers[0].baseUrl, 'http://127.0.0.1:28794/v1');
  assert.equal(next.usage['qclaw-auto'].requests, 7, 'a rotated token does not reset the counters');
  assert.equal(next.usage['qclaw-auto'].inputTokens, 1200);
});

test('the shipped preset needs no key and points at the documented default port', () => {
  const entry = preset();
  assert.equal(entry.name, 'QClaw (local)');
  assert.equal(entry.protocol, 'openai');
  assert.equal(entry.baseUrl, DEFAULT_BASE_URL);
  assert.deepEqual(entry.models, [{ id: 'openclaw/main', upstream: 'openclaw/main', contextWindow: 88000 }]);
  const saved = { ...entry, id: 'qclaw-local', keys: [{ id: 'blank', key: '', enabled: true }] };
  assert.doesNotThrow(() => normalizeConfig({ providers: [saved] }, null, { discoverQclaw: () => null }),
    'saving a QClaw provider before QClaw runs must not be rejected');
});

test('providers of any other type never read QClaw state from disk', () => {
  const boom = () => { throw new Error('discovery must not run'); };
  const providers = PRESETS.filter(entry => entry.type !== 'qclaw' && entry.type !== 'custom')
    .map((entry, index) => ({ ...structuredClone(entry), id: 'p' + index, keys: [{ id: 'k' + index, key: 'secret-' + index, enabled: true }] }));
  const config = normalizeConfig({ providers }, null, { discoverQclaw: boom });
  assert.equal(config.providers.length, providers.length);
  assert.equal(config.providers[0].baseUrl, providers[0].baseUrl);
});

test('a provider that stores the qclaw type by hand also resolves its endpoint', () => {
  const config = normalizeConfig({ providers: [{ id: 'manual', name: 'QClaw', type: 'qclaw', protocol: 'openai',
    models: [{ id: 'openclaw/main', upstream: 'openclaw/main' }] }] }, null,
  { discoverQclaw: () => ({ baseUrl: 'http://127.0.0.1:28795/v1', token: 'manual-token' }) });
  assert.equal(config.providers[0].baseUrl, 'http://127.0.0.1:28795/v1');
  assert.equal(config.providers[0].keys[0].key, 'manual-token');
});
