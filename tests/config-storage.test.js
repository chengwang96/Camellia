'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('../src/shared/json-store');
const { normalizeConfig, publicState } = require('../src/api/api-router-config');
const { createHarness } = require('./claude-harness.cjs');

test('atomic configuration replacement leaves original data and no temporary files after a failed rename', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const file = path.join(h.root, 'config.json');
  writeJson(file, { keep: 'original' });
  const rename = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk unavailable'), { code: 'EACCES' }); });
  assert.throws(() => writeJson(file, { keep: 'replacement' }), /disk unavailable/);
  rename.mock.restore();
  assert.deepEqual(readJson(file), { keep: 'original' });
  assert.equal(fs.readdirSync(h.root).some(name => name.endsWith('.tmp')), false);
});

test('a transient rename lock is retried and the replacement still succeeds', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const file = path.join(h.root, 'config.json');
  writeJson(file, { keep: 'original' });
  const real = fs.renameSync;
  let calls = 0;
  const rename = t.mock.method(fs, 'renameSync', (...args) => {
    if (++calls <= 2) throw Object.assign(new Error('locked by scanner'), { code: 'EPERM' });
    return real(...args);
  });
  writeJson(file, { keep: 'replacement' });
  rename.mock.restore();
  assert.equal(calls, 3);
  assert.deepEqual(readJson(file), { keep: 'replacement' });
  assert.equal(fs.readdirSync(h.root).some(name => name.endsWith('.tmp')), false);
});

test('BOM is accepted and malformed configuration is never silently overwritten or exposed', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const dir = h.folder('app'), file = path.join(dir, 'desktop-config.json');
  fs.writeFileSync(file, '\uFEFF{"claude":{"model":"preserve"}}');
  assert.equal(h.call('claude-get-settings').model, 'preserve');
  const broken = '{"apiKey":"do-not-display-this-secret"';
  fs.writeFileSync(file, broken);
  const result = h.call('claude-save-settings', { model: 'new' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid JSON/);
  assert.ok(!result.error.includes('do-not-display-this-secret'));
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('invalid new API config shapes cannot be mistaken for an empty legacy pool', () => {
  for (const raw of [null, [], { version: 2 }, { version: 2, providers: {} }, { version: 99, providers: [] }, { keys: 'secret' }, { providers: [null] }]) {
    assert.throws(() => normalizeConfig(raw));
  }
  assert.deepEqual(normalizeConfig().providers, []);
});

test('per-model context windows are validated against catalog-learned limits', () => {
  const model = { id: 'm', upstream: 'u', contextWindow: 128000, maxContext: 200000 };
  const ok = normalizeConfig({ providers: [{ id: 'p', baseUrl: 'https://example.test/v1', models: [model], keys: [{ id: 'k', key: 's' }] }] });
  assert.equal(ok.providers[0].models[0].contextWindow, 128000);
  assert.equal(ok.providers[0].models[0].maxContext, 200000);
  assert.throws(() => normalizeConfig({ providers: [{ id: 'p', baseUrl: 'https://example.test/v1', models: [{ id: 'm', upstream: 'u', contextWindow: 1000 }], keys: [{ id: 'k', key: 's' }] }] }), /Context window/);
  assert.throws(() => normalizeConfig({ providers: [{ id: 'p', baseUrl: 'https://example.test/v1', models: [{ id: 'm', upstream: 'u', contextWindow: 256000, maxContext: 200000 }], keys: [{ id: 'k', key: 's' }] }] }), /exceeds the model's maximum/);
  assert.equal(normalizeConfig({ providers: [{ id: 'p', baseUrl: 'https://example.test/v1', models: [{ id: 'm', upstream: 'u', contextWindow: '' }], keys: [{ id: 'k', key: 's' }] }] }).providers[0].models[0].contextWindow, undefined);
});

test('API state snapshots cannot mutate live model mappings or usage; saved counters are finite numbers', () => {
  const when = '2026-09-14T10:00:00.000Z';
  const cfg = normalizeConfig({ providers: [{ id: 'p', baseUrl: 'https://example.test/v1', models: [{ id: 'model', upstream: 'upstream' }], keys: [{ id: 'k', key: 'secret' }] }],
    usage: { k: { requests: '2', inputTokens: '300', outputTokens: -12, failures: 'invalid', lastUsedAt: when, models: { model: { until: Date.now() + 60000, reason: 'cooldown' } } } } });
  assert.equal(cfg.usage.k.requests, 2);
  assert.equal(cfg.usage.k.inputTokens, 300);
  assert.equal(cfg.usage.k.outputTokens, 0);
  assert.equal(cfg.usage.k.failures, 0);
  assert.equal(cfg.usage.k.lastUsedAt, when);
  const state = publicState(cfg);
  state.providers[0].models[0].upstream = 'other-model';
  state.usage.k.models.model.until = 0;
  assert.equal(cfg.providers[0].models[0].upstream, 'upstream');
  assert.ok(cfg.usage.k.models.model.until > Date.now());
  assert.equal('key' in state.providers[0].keys[0], false);
});

test('custom DSH_HOME is used for credential writes and settings validation rejects an invalid port', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const home = h.folder('custom-home');
  assert.equal(h.call('save-settings', { dshHome: home, port: 0 }).ok, true);
  assert.equal(h.call('save-credentials', { provider: 'deepseek', apiKey: 'local-test' }).ok, true);
  assert.ok(fs.existsSync(path.join(home, '.credentials.yaml')));
  assert.equal(fs.existsSync(path.join(h.home, '.dsh', '.credentials.yaml')), false);
  assert.equal(h.call('save-settings', { port: 65536 }).ok, false);
  assert.equal(readJson(path.join(h.userData, 'desktop-config.json')).port, 0);
});
