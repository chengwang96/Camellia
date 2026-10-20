'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelDiscovery } = require('../src/api/model-discovery');
const { fetchModels } = require('../src/api/provider-accounts');
const { normalizeConfig, publicState } = require('../src/api/api-router-config');
const { levelsFor } = require('../src/shared/model-levels');
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const thinking = { values: [false, 'low', 'high', 'max'], default: 'high' };
function config() {
  return normalizeConfig({ providers: [{ id: 'ollama', type: 'ollama', baseUrl: 'https://ollama.com/v1',
    models: [{ id: 'flash', upstream: 'deepseek-v4.1-flash:cloud' }], keys: [{ id: 'key', key: 'secret' }] }] });
}
function merge(provider, models) {
  for (const model of provider.models) {
    const found = models.find(entry => entry.upstream === model.upstream);
    if (found?.thinking) model.thinking = found.thinking;
  }
}

test('background discovery fills existing routes from native metadata without listing or inference, with a daily cache', async t => {
  const cfg = config();
  let now = 0, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const discovery = createModelDiscovery({ getConfig: () => cfg, apply: merge, now: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://ollama.com/api/show');
      assert.deepEqual(JSON.parse(options.body), { model: 'deepseek-v4.1-flash:cloud' });
      await gate;
      return response({ thinking });
    } });
  t.after(() => discovery.close());
  const first = discovery.refresh(), duplicate = discovery.refresh();
  release(); await Promise.all([first, duplicate]);
  assert.equal(calls, 1);
  assert.deepEqual(levelsFor('flash', publicState(cfg)), ['none', 'low', 'high', 'max']);
  assert.equal(cfg.providers[0].models.length, 1);
  await discovery.refresh(); assert.equal(calls, 1);
  now += 24 * 60 * 60000;
  await discovery.refresh(); assert.equal(calls, 2);
});

test('an edited route is discovered immediately and an old pending response cannot overwrite it', async t => {
  const cfg = config();
  let release, oldSignal;
  const discovery = createModelDiscovery({ getConfig: () => cfg, apply: merge,
    fetchImpl: async (url, options) => {
      if (JSON.parse(options.body).model === 'deepseek-v4.1-flash:cloud') {
        oldSignal = options.signal;
        await new Promise(resolve => { release = resolve; });
        return response({ thinking });
      }
      return response({ thinking: { values: [true], default: true } });
    } });
  t.after(() => discovery.close());
  const old = discovery.refresh();
  cfg.providers[0].models[0].upstream = 'new-model:cloud';
  await discovery.refresh();
  assert.equal(oldSignal.aborted, true);
  release(); await old;
  assert.deepEqual(cfg.providers[0].models[0].thinking, { values: [true], default: true });
});

test('failed metadata calls retain saved controls, retry with backoff, and never enumerate inactive routes', async t => {
  const cfg = config();
  cfg.providers[0].models[0].thinking = thinking;
  let now = 0, calls = 0;
  const discovery = createModelDiscovery({ getConfig: () => cfg, apply: merge, now: () => now,
    fetchImpl: async () => { calls++; return response({}, 503); } });
  t.after(() => discovery.close());
  await discovery.refresh(); await discovery.refresh();
  assert.equal(calls, 1);
  assert.deepEqual(cfg.providers[0].models[0].thinking, thinking);
  now += 5 * 60000;
  await discovery.refresh(); assert.equal(calls, 2);
  cfg.providers[0].keys[0].enabled = false;
  await discovery.refresh(); assert.equal(calls, 2);
  cfg.providers[0].keys[0].enabled = true;
  await discovery.refresh(); assert.equal(calls, 3);
  cfg.enabled = false;
  await discovery.refresh(); assert.equal(calls, 3);
});

test('discovery tries another enabled key when the first cannot read metadata and cancels on shutdown', async () => {
  const cfg = config();
  cfg.providers[0].keys.push({ id: 'disabled', key: 'disabled-secret', enabled: false }, { id: 'second', key: 'second-secret', enabled: true });
  const keys = [];
  const discovery = createModelDiscovery({ getConfig: () => cfg, apply: merge,
    fetchImpl: async (url, options) => {
      keys.push(options.headers.Authorization);
      return options.headers.Authorization === 'Bearer secret' ? response({}, 401) : response({ thinking });
    } });
  await discovery.refresh(); discovery.close();
  assert.deepEqual(keys, ['Bearer secret', 'Bearer second-secret']);
  assert.deepEqual(cfg.providers[0].models[0].thinking, thinking);
  await discovery.refresh(); assert.equal(keys.length, 2);

  let signal, release;
  const pending = createModelDiscovery({ getConfig: config, apply: () => assert.fail('closed discovery applied metadata'),
    fetchImpl: async (url, options) => {
      signal = options.signal;
      await new Promise(resolve => { release = resolve; });
      return response({ thinking });
    } });
  const task = pending.refresh(); pending.close();
  assert.equal(signal.aborted, true);
  release(); await task;
});

test('official DeepSeek documented controls fill absent metadata, while relay and unknown models remain unknown', async () => {
  for (const host of ['api.deepseek.com', 'relay.example']) {
    const provider = { type: 'custom', baseUrl: 'https://' + host + '/v1',
      models: [{ id: 'flash', upstream: 'deepseek-flash' }, { id: 'unknown', upstream: 'future-model' }] };
    const models = await fetchModels(provider, 'secret', { configuredOnly: true, fetchImpl: async () => response({}, 404) });
    assert.deepEqual(models[0].thinking, host === 'api.deepseek.com' ? { values: ['none', 'low', 'high', 'max'], default: 'high' } : undefined);
    assert.equal(models[1].thinking, undefined);
  }
});

test('manually configured routes can discover details without list access; explicit live levels override documentation', async () => {
  const provider = { baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'alias', upstream: 'deepseek-flash' }] };
  const calls = [];
  // Live list metadata takes precedence over the documented fallback.
  const models = await fetchModels(provider, 'secret', { configuredOnly: true, fetchImpl: async url => {
    calls.push(url);
    return response({ data: [{ id: 'deepseek-flash', thinking: { values: ['high'], default: 'high' } }, { id: 'not-configured' }] });
  } });
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].thinking, { values: ['none', 'high'], default: 'high' });
  assert.equal(calls.length, 1);
  provider.baseUrl = 'https://custom.example/v1';
  const detail = await fetchModels(provider, 'secret', { configuredOnly: true, fetchImpl: async url =>
    url.endsWith('/models') ? response({}, 403) : response({ id: 'deepseek-flash', thinking: { values: ['low'] } }) });
  assert.deepEqual(detail[0].thinking, { values: ['low'] });
});

test('stale settings saves keep discovered metadata only for unchanged routes', () => {
  const cfg = config(), draft = structuredClone(cfg);
  cfg.providers[0].models[0].thinking = thinking;
  assert.deepEqual(normalizeConfig(draft, cfg).providers[0].models[0].thinking, thinking);
  draft.providers[0].baseUrl = 'https://other.example/v1';
  assert.equal(normalizeConfig(draft, cfg).providers[0].models[0].thinking, undefined);
});
