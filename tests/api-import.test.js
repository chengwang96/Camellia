'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createApiImport, exportProviders } = require('../src/main/remote/api-import');
const { createApiImportClient } = require('../src/main/remote/api-import-client');
const config = require('../src/api/api-router-config');
const { removeTree } = require('./test-fs.cjs');

function provider(id = 'provider-a') {
  return { id, type: 'custom', name: 'Example', enabled: true, priority: 0, protocol: 'openai', baseUrl: `https://${id}.example/v1`, anthropicBaseUrl: '',
    models: [{ id: 'model-a', upstream: 'upstream-a', protocol: 'auto' }], keys: [{ id: id + '-key', key: 'private-api-key-value', name: 'Key', enabled: true }] };
}
function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-import-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  context.after(() => removeTree(root));
  const configFile = path.join(root, 'routes.json'), journalFile = path.join(root, 'imports.json');
  config.writeConfig(configFile, config.normalizeConfig({ enabled: false, port: 9000, providers: [provider('existing')] }));
  const service = createApiImport({ configFile, journalFile, isBusy: () => false, ...options });
  const payload = () => ({ requestId: randomUUID(), expectedRevision: service.state().revision, providers: [provider()] });
  return { root, configFile, journalFile, service, payload };
}

test('API import exports only explicit API fields and skips local account-backed providers', () => {
  const source = provider(); source.subscription = { refreshToken: 'subscription-secret' }; source.keys[0].cookie = 'cookie-secret';
  const result = exportProviders({ providers: [source, { ...provider('local'), baseUrl: 'http://127.0.0.1:1234/v1' }, { ...provider('qclaw'), type: 'qclaw' }], port: 1234, usage: { secret: true } });
  assert.equal(result.skipped, 2);
  assert.equal(result.providers.length, 1);
  assert.equal(JSON.stringify(result).includes('subscription-secret'), false);
  assert.equal(JSON.stringify(result).includes('cookie-secret'), false);
  assert.equal(Object.hasOwn(result, 'port'), false);
});

test('API import is additive, preserves server routing state and never journals raw keys', context => {
  const { service, payload, configFile, journalFile } = fixture(context);
  const request = payload(); request.providers.push({ ...provider('existing'), name: 'Do not overwrite', keys: [{ id: 'replacement', key: 'replacement-secret' }] });
  const result = service.apply('gui-device', request);
  assert.equal(result.added, 1); assert.equal(result.keys, 1); assert.equal(result.skipped, 1);
  const saved = config.loadConfig(configFile);
  assert.equal(saved.port, 9000); assert.equal(saved.enabled, false);
  assert.equal(saved.providers[0].name, 'Example');
  assert.equal(saved.providers[0].keys[0].key, 'private-api-key-value');
  assert.deepEqual(service.apply('gui-device', request), result);
  assert.equal(config.loadConfig(configFile).providers.length, 2);
  assert.equal(fs.readFileSync(journalFile, 'utf8').includes('private-api-key-value'), false);
  assert.equal(fs.readFileSync(journalFile, 'utf8').includes('replacement-secret'), false);
  assert.throws(() => service.apply('gui-device', { ...request, providers: [provider('changed')] }), /already used/);
});

test('API import rejects stale configuration, busy engines and non-allowlisted fields before writing', context => {
  let busy = false;
  const { service, payload, configFile, journalFile } = fixture(context, { isBusy: () => busy });
  const original = fs.readFileSync(configFile, 'utf8');
  busy = true; assert.throws(() => service.apply('gui', payload()), /Stop server/); busy = false;
  assert.throws(() => service.apply('gui', { ...payload(), expectedRevision: '0'.repeat(64) }), /changed/);
  assert.throws(() => service.apply('gui', { ...payload(), subscription: 'secret' }), /schema/);
  for (const change of [entry => { entry.keys[0].cookie = 'secret'; }, entry => { entry.baseUrl = 'file:///secret'; }, entry => { entry.type = 'qclaw'; }, entry => { entry.keys[0].key = 'secret\r\n'; }]) {
    const request = payload(); change(request.providers[0]);
    assert.throws(() => service.apply('gui', request), /validation failed/);
  }
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  assert.equal(fs.existsSync(journalFile), false);
});

test('reload failure restores old configuration and retry returns the failure receipt', context => {
  let reloads = 0;
  const { service, payload, configFile } = fixture(context, { reload: () => { if (++reloads === 1) throw new Error('secret must not escape'); } });
  const old = config.loadConfig(configFile), request = payload();
  const result = service.apply('gui', request);
  assert.equal(result.ok, false); assert.equal(result.state, 'failed');
  assert.deepEqual(config.loadConfig(configFile), old);
  assert.deepEqual(service.apply('gui', request), result);
  assert.equal(reloads, 2); assert.equal(JSON.stringify(result).includes('secret must not escape'), false);
});

test('incomplete durable receipt never replays an import after restart', context => {
  const { service, payload, configFile, journalFile } = fixture(context);
  const request = payload(); service.apply('gui', request);
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')); delete journal[0].result;
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  const restarted = createApiImport({ configFile, journalFile, isBusy: () => false });
  assert.equal(restarted.apply('gui', request).state, 'unknown');
  assert.equal(config.loadConfig(configFile).providers.length, 2);
});

test('desktop import preview never exposes keys and binds confirmation to target and request identity', async () => {
  const posts = [];
  let time = 1000, fail = true;
  const client = { list: () => [{ id: 'server', name: 'GPU' }], async json(deviceId, endpoint, options) {
    assert.equal(deviceId, 'server'); assert.equal(endpoint, '/v1/api-import');
    if (!options) return { revision: 'a'.repeat(64), policy: 'keep-server' };
    posts.push(options.body);
    if (fail) throw new Error('Disconnected');
    return { ok: true, state: 'accepted', added: 1, keys: 1, skipped: 0, token: 'never-expose', enabled: true };
  } };
  const imports = createApiImportClient({ client, source: () => ({ providers: [provider()] }), now: () => time });
  const preview = await imports.prepare('server');
  assert.equal(preview.keys, 1); assert.equal(preview.target, 'GPU');
  assert.equal(JSON.stringify(preview).includes('private-api-key-value'), false);
  await assert.rejects(imports.apply('other', preview.id), /target changed/);
  await assert.rejects(imports.apply('server', preview.id), /Disconnected/);
  fail = false;
  const result = await imports.apply('server', preview.id);
  assert.equal(result.ok, true); assert.equal(Object.hasOwn(result, 'token'), false);
  assert.deepEqual(posts[0], posts[1]);
  const expired = await imports.prepare('server'); time += 300001;
  await assert.rejects(imports.apply('server', expired.id), /expired/);
});
