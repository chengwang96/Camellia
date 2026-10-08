'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');

test('API route configuration exports raw keys and imports back with usage preserved', async t => {
  const first = createHarness();
  try {
    first.configureApi();
    const configPath = path.join(first.home, '.dsh', 'ollama-proxy.json');
    const { loadConfig, writeConfig } = require('../src/api/api-router-config');
    const config = loadConfig(configPath);
    config.providers[0].models[0].contextWindow = 131072;
    config.providers[0].models[0].maxContext = 262144;
    writeConfig(configPath, config);
    const outFile = path.join(first.root, 'export.json');
    first.dialogBehavior.save = async () => ({ canceled: false, filePath: outFile });
    const exported = await first.call('api-router-export');
    assert.equal(exported.ok, true);
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(bundle.format, 'camellia-api-routes');
    assert.equal(bundle.config.providers[0].keys[0].key, 'isolated-test-key', 'raw keys are exported for migration');
    assert.equal(bundle.config.providers[0].models[0].contextWindow, 131072, 'confirmed context windows are exported');
    assert.equal(bundle.config.providers[0].models[0].maxContext, 262144, 'model context maxima are exported');
    assert.equal(bundle.config.usage, undefined, 'live usage counters are not exported');

    // New machine: import the bundle into an empty configuration.
    const second = createHarness();
    try {
      second.dialogBehavior.open = async () => ({ canceled: false, filePaths: [outFile] });
      const imported = await second.call('api-router-import');
      assert.equal(imported.ok, true);
      const state = second.call('api-router-get-state');
      assert.equal(state.providers[0].models[0].id, 'test-model');
      assert.equal(state.providers[0].models[0].contextWindow, 131072, 'confirmed context windows survive import');
      assert.equal(state.providers[0].models[0].maxContext, 262144, 'model context maxima survive import');
      assert.equal(state.providers[0].keys[0].maskedKey.includes('isolated'), false, 'state stays masked');
    } finally { await second.api.stopRouter(); second.cleanup(); }
  } finally { await first.api.stopRouter(); first.cleanup(); }
});

test('import rejects files that are not Camellia route exports', async t => {
  const h = createHarness();
  try {
    const bad = path.join(h.root, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ hello: 'world' }));
    h.dialogBehavior.open = async () => ({ canceled: false, filePaths: [bad] });
    const result = await h.call('api-router-import');
    assert.equal(result.ok, false);
    assert.match(result.error, /not a Camellia API route export/);
  } finally { h.cleanup(); }
});
