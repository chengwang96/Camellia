'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHarness } = require('./claude-harness.cjs');
const { configureProvider, readCredential, syncPoolProvider, cleanupLegacyRoute, dshLaunchArgs } = require('../src/engines/dsh-config');

function setup(t, source = '') {
  const h = createHarness(); t.after(() => h.cleanup());
  const home = h.folder('yaml-home'), file = path.join(home, 'settings.yaml');
  fs.writeFileSync(file, source);
  return { home, file, read: () => YAML.parse(fs.readFileSync(file, 'utf8'), { merge: true }) };
}
const credentials = { providerId: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: 'true', model: 'default-model' };

test('managed launches configure models before DSH 0.2 boots without rewriting legacy user data', t => {
  const h = setup(t, '# existing configuration\npermission: {defaultPreset: read-only}\n');
  const original = fs.readFileSync(h.file, 'utf8');
  const config = { 'agent-default-model': { provider: 'api-pool', model: 'fixture' },
    permission: { defaultPreset: 'workspace-write' }, shell: { timeoutMs: 15000 } };
  const args = dshLaunchArgs({ runtime: { file: 'fixture.js', version: '0.2.0-rc.2' }, home: h.home, profile: 'acp', config });
  assert.deepEqual(args.slice(0, 4), ['fixture.js', '--profile', 'acp', '--patch']);
  const patches = YAML.parse(fs.readFileSync(args[4], 'utf8'));
  assert.deepEqual(patches.slice(0, 2), Object.entries(config).slice(0, 2).map(([id, config]) => ({ id, config })));
  assert.equal(patches[2].id, process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox');
  assert.equal(fs.readFileSync(h.file, 'utf8'), original);
  const old = dshLaunchArgs({ runtime: { file: 'fixture.js', version: '0.1.5-rc.2' }, home: h.home, profile: 'headless', config });
  assert.deepEqual(old, ['fixture.js', '--profile', 'headless']);
  assert.deepEqual(h.read(), config);
});

test('credential edits preserve comments, flow maps, custom provider fields and the selected model', t => {
  const h = setup(t, `# personal settings
agent-default-model: {provider: deepseek, model: chosen-model, reasoningEffort: high} # choice
llm-pi-ai:
    providers:
        deepseek: {baseURL: 'https://example.test/v1', models: [{id: custom}], apiKeyEnv: OLD} # route
permission: {defaultPreset: custom}
other: {providers: {deepseek: {apiKeyEnv: LEAVE_ALONE}}}
`);
  configureProvider(h.home, credentials);
  const next = h.read();
  assert.deepEqual(next['agent-default-model'], { provider: 'deepseek', model: 'chosen-model', reasoningEffort: 'high' });
  assert.deepEqual(next['llm-pi-ai'].providers.deepseek, { baseURL: 'https://example.test/v1', models: [{ id: 'custom' }], apiKeyEnv: 'DEEPSEEK_API_KEY' });
  assert.equal(next.other.providers.deepseek.apiKeyEnv, 'LEAVE_ALONE');
  assert.equal(next.permission.defaultPreset, 'custom');
  assert.match(fs.readFileSync(h.file, 'utf8'), /# personal settings/);
  assert.match(fs.readFileSync(h.file, 'utf8'), /# choice/);
  assert.match(fs.readFileSync(h.file, 'utf8'), /# route/);
  assert.equal(readCredential(h.home, 'DEEPSEEK_API_KEY'), 'true');
  const key = 'quoted "key": # 中文\\line\nsecond';
  configureProvider(h.home, { ...credentials, apiKey: key });
  assert.equal(readCredential(h.home, 'DEEPSEEK_API_KEY'), key);
  configureProvider(h.home, { ...credentials, apiKey: '' });
  assert.equal(readCredential(h.home, 'DEEPSEEK_API_KEY'), '');
});

test('alias and merge updates affect only the selected provider branch', t => {
  const h = setup(t, `defaults: &defaults {apiKeyEnv: ORIGINAL, baseURL: 'https://example.test/v1', models: [{id: shared}]}
providers: &providers {deepseek: *defaults, sibling: *defaults}
llm-pi-ai: {providers: *providers}
`);
  configureProvider(h.home, credentials);
  const next = h.read();
  assert.equal(next['llm-pi-ai'].providers.deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(next['llm-pi-ai'].providers.deepseek.baseURL, next.defaults.baseURL);
  assert.equal(next['llm-pi-ai'].providers.sibling.apiKeyEnv, 'ORIGINAL');
  assert.equal(next.providers.deepseek.apiKeyEnv, 'ORIGINAL');
  assert.match(fs.readFileSync(h.file, 'utf8'), /&defaults/);
});

test('pool injection and legacy cleanup target the actual provider path, including inherited settings', t => {
  const h = setup(t, `defaults: &old {baseURL: 'http://127.0.0.1:19333/v1', apiKeyEnv: OLD}
unrelated: {providers: {opencode-go: {baseURL: 'http://127.0.0.1:19333/v1'}}}
llm-pi-ai: {providers: {opencode-go: *old, api-pool: {custom: retained}}}
`);
  syncPoolProvider(h.file, { active: true, port: 19999, models: ['same-model'], hasOllama: false });
  syncPoolProvider(h.file, { active: true, port: 19999, models: ['same-model'], hasOllama: false });
  assert.equal(h.read()['llm-pi-ai'].providers['api-pool'].custom, 'retained');
  assert.equal(h.read()['llm-pi-ai'].providers['api-pool'].baseURL, 'http://127.0.0.1:19999');
  assert.equal(cleanupLegacyRoute(h.file), true);
  assert.deepEqual(h.read()['llm-pi-ai'].providers['opencode-go'], { apiKeyEnv: 'OLD' });
  assert.equal(h.read().unrelated.providers['opencode-go'].baseURL, 'http://127.0.0.1:19333/v1');
  assert.equal(cleanupLegacyRoute(h.file), false);
});

test('invalid settings stop credential updates without replacing either file or exposing its contents', t => {
  const broken = 'apiKey: "do-not-display-this-secret';
  const h = setup(t, broken);
  const file = path.join(h.home, '.credentials.yaml');
  fs.writeFileSync(file, 'DEEPSEEK_API_KEY: original\n');
  assert.throws(() => configureProvider(h.home, credentials), err => /YAML/.test(err.message) && !err.message.includes('do-not-display'));
  assert.equal(fs.readFileSync(h.file, 'utf8'), broken);
  assert.equal(readCredential(h.home, 'DEEPSEEK_API_KEY'), 'original');
});
