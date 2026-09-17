'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');
const { PRESETS, normalizeConfig } = require('../src/api/api-router-config');
const { GeminiToolState } = require('../src/api/gemini-tool-state');
const { fetchModels, verifyModel, accountCapability } = require('../src/api/provider-accounts');
const { pythonEnvironment } = require('../src/main/python-runtime');

test('Managed Python preserves the system command path without loading global Python packages', () => {
  const dir = path.resolve(__dirname, '../runtimes/antigravity');
  const env = pythonEnvironment(dir, { Path: 'system-shell-path', PYTHONPATH: 'global-packages', PYTHONHOME: 'global-python', VIRTUAL_ENV: 'global-env' });
  assert.ok(env.PATH.endsWith(path.delimiter + 'system-shell-path'));
  assert.equal(env.Path, undefined);
  assert.equal(env.PYTHONPATH, path.join(dir, 'packages'));
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.VIRTUAL_ENV, undefined);
});

test('Gemini discovery, key validation and legacy Ollama migration preserve their protocols', async () => {
  const provider = PRESETS.find(p => p.type === 'gemini');
  assert.equal(provider.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/models')
      ? { data: [{ id: 'gemini-test' }, { id: 'gemini-test' }, { id: 'gemini-other' }] }
      : { choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } };
  };
  const models = await fetchModels(provider, 'fixture-key', { fetchImpl });
  assert.deepEqual(models.map(m => m.id), ['gemini-test', 'gemini-other']);
  assert.equal((await verifyModel(provider, 'fixture-key', models[0], { fetchImpl })).model, 'gemini-test');
  assert.equal(calls[1].url, provider.baseUrl + '/chat/completions');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(accountCapability(provider).supported, false);
  assert.match(accountCapability(provider).label, /Google AI Studio/);
  const legacy = normalizeConfig({ keys: ['legacy-ollama-key'] });
  assert.equal(legacy.providers[0].type, 'ollama');
  assert.equal(legacy.providers[0].baseUrl, 'https://ollama.com/v1');
});

test('Gemini thought signatures survive streamed tools, discarded extension fields and application restarts', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const file = path.join(h.folder('state'), 'tool-signatures.jsonl');
  const state = new GeminiToolState(file);
  const receive = state.response('gemini-test');
  const first = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'reused-upstream-id', type: 'function', function: { name: 'read', arguments: '' } }] } }] };
  receive(first);
  const id = first.choices[0].delta.tool_calls[0].id;
  receive({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'opaque-fixture-signature' } } }] } }] });
  const restored = new GeminiToolState(file);
  const history = { messages: [{ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }] }], thinking: { type: 'enabled' }, reasoning_effort: 'max' };
  restored.restore(history, 'gemini-test');
  assert.equal(history.messages[0].tool_calls[0].extra_content.google.thought_signature, 'opaque-fixture-signature');
  assert.equal(history.thinking, undefined);
  assert.equal(history.reasoning_effort, 'high');
  const unrelated = { messages: [{ tool_calls: [{ id }] }] };
  restored.restore(unrelated, 'different-model');
  assert.equal(unrelated.messages[0].tool_calls[0].extra_content, undefined);
  const other = structuredClone(first); other.choices[0].delta.tool_calls[0].id = 'reused-upstream-id';
  state.response('gemini-test')(other);
  assert.notEqual(other.choices[0].delta.tool_calls[0].id, id, 'Upstream tool IDs can repeat across conversations');
});

test('Antigravity settings and standalone/workspace histories are isolated and editable through unified IPC', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  assert.equal((await h.call('antigravity-save-settings', { model: 'gemini-test', permissionMode: 'plan', apiKey: 'not-a-setting' })).ok, true);
  assert.equal((await h.call('antigravity-get-settings')).apiKey, undefined);
  assert.equal((await h.call('antigravity-save-settings', { permissionMode: 'invalid' })).ok, false);
  const native = await h.call('engine-settings-get', { engine: 'antigravity' });
  assert.equal(native.ok, true);
  const saved = await h.call('engine-settings-save', { engine: 'antigravity', files: native.files,
    common: { permissionMode: 'acceptEdits', instructions: 'Use the project conventions.' }, desktop: {} });
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await h.call('antigravity-get-settings')).permissionMode, 'acceptEdits');
  assert.ok(native.files[0].path.startsWith(h.userData));
  assert.equal(fs.existsSync(path.join(h.home, '.gemini')), false);
  const cwd = h.folder('antigravity-workspace');
  const added = await h.call('antigravity-meta-op', { op: 'create-workspace', name: 'Antigravity project', path: cwd });
  assert.equal(added.ok, true, added.error);
  assert.equal((await h.call('antigravity-list-sessions')).workspaces.length, 1);
  assert.equal((await h.call('kimi-list-sessions')).workspaces.length, 0);
  assert.equal((await h.call('antigravity-load-session', '../desktop-config')).ok, false);
});

test('Antigravity model selections land in the slot of the chosen connection', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  assert.equal((await h.call('antigravity-save-settings', { connection: 'subscription', model: 'account-model' })).ok, true);
  assert.equal((await h.call('antigravity-save-settings', { connection: 'api', model: 'api-model' })).ok, true);
  const settings = await h.call('antigravity-get-settings');
  assert.equal(settings.connection, 'api'); assert.equal(settings.model, 'api-model');
  assert.equal(settings.subscriptionModel, 'account-model'); assert.equal(settings.apiModel, 'api-model');
});
