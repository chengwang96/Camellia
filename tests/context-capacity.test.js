'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { removeTree } = require('./test-fs.cjs');
const { createContextCapacity, contextError, UNKNOWN_CONTEXT_BUDGET } = require('../src/api/context-capacity');

function fixture(testCase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-capacity-'));
  testCase.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('camellia-capacity-')); removeTree(root); });
  const file = path.join(root, 'capacity.json');
  const provider = { id: 'provider', enabled: true, baseUrl: 'https://relay.example/v1', protocol: 'openai', keys: [{ id: 'key', key: 'private-secret', enabled: true }],
    models: [{ id: 'model', upstream: 'upstream-model', protocol: 'auto', maxContext: 131072 }] };
  const config = { enabled: true, providers: [provider] }, make = () => createContextCapacity({ file, getConfig: () => config });
  const service = make();
  return { service, config, provider, file, make };
}

test('context errors require explicit structured context evidence, never rate limits or body size', () => {
  const detail = { error: { code: 'context_length_exceeded', message: 'maximum context length is 32,768 tokens' } };
  assert.deepEqual(contextError(400, detail), { kind: 'context', declared: 32768 });
  for (const status of [401, 403, 413, 429, 500, 502]) assert.equal(contextError(status, detail), null);
  assert.equal(contextError(400, { error: { message: 'max_tokens is not supported' } }), null);
  assert.equal(contextError(400, '<html>maximum context length is 100 tokens</html>'), null);
  assert.equal(contextError(422, { error: { message: 'prompt is too long: 9000 > 8000' } }).kind, 'context');
});

test('credential edits preserve shared evidence; protocol, upstream and endpoint edits invalidate evidence', testCase => {
  const { service, provider } = fixture(testCase);
  const evidence = () => ({ provider, key: provider.keys[0], model: provider.models[0], protocol: provider.protocol, ok: true, tokens: { input: 9000 } });
  service.observe(evidence());
  provider.keys[0].key = 'replacement';
  assert.equal(service.state().entries[0].bounds.acceptedLowerBound, 9000);
  service.observe(evidence()); assert.equal(service.state().entries[0].passive.maxReportedInput, 9000);
  provider.models[0].upstream = 'new-upstream'; assert.equal(service.state().entries[0].passive, undefined);
  service.observe(evidence()); provider.baseUrl = 'https://other.example/v1'; assert.equal(service.state().entries[0].passive, undefined);
  service.observe(evidence()); provider.protocol = 'anthropic'; assert.equal(service.state().entries[0].passive, undefined);
});

test('normal requests persist the largest reported input and explicit errors without secrets', testCase => {
  const { service, provider, make, file } = fixture(testCase);
  const route = { provider, key: provider.keys[0], model: provider.models[0], protocol: 'openai' };
  service.observe({ ...route, ok: true, tokens: { input: 30000 }, maxOutputTokens: 2048 });
  service.observe({ ...route, ok: true, tokens: { input: 2000 } });
  service.observe({ ...route, ok: false, status: 400, detail: JSON.stringify({ error: { code: 'context_length_exceeded' } }) });
  const passive = service.state().entries[0].passive;
  assert.equal(passive.maxReportedInput, 30000); assert.equal(passive.outputBudget, 2048); assert.ok(passive.lastContextError);
  assert.deepEqual(make().state().entries[0].passive, passive);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('private-secret'));
});

test('accepted counts never become confirmed maxima or enlarge configured windows', t => {
  const h = fixture(t);
  delete h.provider.models[0].maxContext;
  const options = { model: 'model', protocol: 'openai' };
  assert.equal(h.service.budget(options).source, 'unknown');
  assert.equal(h.service.budget(options).cap, UNKNOWN_CONTEXT_BUDGET);
  h.service.observe({ provider: h.provider, model: h.provider.models[0], protocol: 'openai', ok: true, tokens: { input: 50000 } });
  assert.equal(h.service.budget(options).cap, 50000);
  assert.equal(h.service.budget(options).source, 'accepted-lower-bound');
  assert.equal(h.service.budget(options).routes[0].confirmedUpperBound, null);
  h.provider.models[0].contextWindow = 16000;
  assert.equal(h.service.budget(options).cap, 16000);
  assert.equal(h.service.budget({ ...options, contextWindow: 8000 }).cap, 8000);
  assert.equal(h.make().budget(options).routes[0].acceptedLowerBound, 50000);
});

test('limits survive later nonnumeric errors and failed requests without rewriting model configuration', t => {
  const h = fixture(t);
  const route = { provider: h.provider, key: h.provider.keys[0], model: h.provider.models[0], protocol: 'openai' };
  h.service.observe({ ...route, ok: false, status: 400, detail: { error: { message: 'maximum context length is 32768 tokens' } } });
  h.service.observe({ ...route, ok: false, status: 400, detail: { error: { message: 'Input is too long.' } } });
  h.service.observe({ ...route, ok: true, tokens: { input: 10000 } });
  h.service.observe({ ...route, ok: false, status: 503, detail: { error: { message: 'unavailable' } } });
  const budget = h.make().budget({ model: 'model', protocol: 'openai' });
  assert.equal(budget.cap, 32768);
  assert.equal(budget.source, 'confirmed-upper-bound');
  assert.equal(budget.routes[0].acceptedLowerBound, 10000);
  assert.equal(h.provider.models[0].maxContext, 131072);
  assert.equal(h.provider.models[0].contextWindow, undefined);
});

test('budgets share keys while isolating providers and effective upstream protocols', t => {
  const h = fixture(t);
  h.provider.protocol = 'dual';
  h.provider.keys.push({ id: 'second', key: 'other-secret', enabled: true });
  const other = structuredClone(h.provider);
  other.id = 'other'; other.baseUrl = 'https://other.example/v1'; other.models[0].maxContext = undefined;
  other.keys = [{ id: 'third', key: 'third-secret', enabled: true }];
  h.config.providers.push(other);
  const route = { provider: h.provider, key: h.provider.keys[0], model: h.provider.models[0], protocol: 'anthropic' };
  h.service.observe({ ...route, ok: false, status: 400, detail: { error: { message: 'maximum context length is 16000 tokens' } } });
  const anthropic = h.service.budget({ model: 'model', protocol: 'anthropic' });
  assert.equal(anthropic.cap, 16000);
  assert.deepEqual(anthropic.routes.map(r => r.confirmedUpperBound), [16000, null]);
  assert.deepEqual(anthropic.routes.map(r => r.cap), [16000, UNKNOWN_CONTEXT_BUDGET]);
  const openai = h.service.budget({ model: 'model', protocol: 'responses' });
  assert.equal(openai.cap, UNKNOWN_CONTEXT_BUDGET);
  assert.ok(openai.routes.every(r => r.confirmedUpperBound === null));
  assert.ok(!JSON.stringify(anthropic).includes('secret'));
  const key = anthropic.key;
  h.provider.keys[0].key = 'replacement';
  assert.equal(h.service.budget({ model: 'model', protocol: 'anthropic' }).key, key);
  assert.equal(h.service.budget({ model: 'model', protocol: 'anthropic' }).cap, 16000);
  h.provider.keys.reverse();
  h.provider.keys.push({ id: 'new', key: 'new-secret', enabled: true });
  assert.equal(h.service.budget({ model: 'model', protocol: 'anthropic' }).key, key);
  h.provider.models[0].protocol = 'anthropic';
  h.service.observe({ ...route, ok: false, status: 422, detail: { error: { message: 'prompt is too long: 30000 tokens > 12000 maximum' } } });
  const converted = h.service.budget({ model: 'model', protocol: 'openai' });
  assert.equal(converted.cap, 12000);
  assert.equal(converted.routes[0].protocol, 'anthropic');
  assert.equal(converted.routes[0].upperBoundScope, 'input');
  h.provider.enabled = false;
  assert.equal(h.service.budget({ model: 'model', protocol: 'anthropic' }).cap, UNKNOWN_CONTEXT_BUDGET);
  h.config.enabled = false;
  assert.equal(h.service.budget({ model: 'model', protocol: 'openai' }), null);
});

test('legacy per-key files merge evidence once and preserve it after key replacement', t => {
  const h = fixture(t);
  h.provider.protocol = 'dual';
  h.provider.keys.push({ id: 'second', key: 'second-secret', enabled: false });
  h.service.observe({ provider: h.provider, key: h.provider.keys[0], model: h.provider.models[0], protocol: 'openai', ok: true, tokens: { input: 18000 } });
  const data = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  const legacy = (key, protocol) => createHash('sha256').update(JSON.stringify([h.provider.id, h.provider.baseUrl, '',
    key.id, key.key, 'model', 'upstream-model', protocol])).digest('hex');
  data.entries[legacy(h.provider.keys[0], 'openai')] = {
    passive: { maxReportedInput: 26000, outputBudget: 512, at: '2026-01-01T00:00:00.000Z',
      lastContextError: { declared: 32000, at: '2026-01-01T00:00:00.000Z' } },
    probe: { at: '2026-01-01T00:00:00.000Z', status: 'range', outputBudget: 128, acceptedEstimate: 65000,
      samples: [{ kind: 'accepted', reportedInput: 50000 }, { kind: 'context', declared: 32000 }] },
  };
  data.entries[legacy(h.provider.keys[1], 'openai')] = {
    passive: { maxReportedInput: 20000, at: '2026-02-01T00:00:00.000Z', lastContextError: { inputLimit: 22000, at: '2026-02-01T00:00:00.000Z' } },
    limits: { context: { tokens: 16000, at: '2026-02-01T00:00:00.000Z' } },
    probe: { at: '2026-02-01T00:00:00.000Z', status: 'running', samples: [] },
  };
  data.entries[legacy(h.provider.keys[0], 'anthropic')] = { passive: { maxReportedInput: 6000, lastContextError: { declared: 7000 } } };
  fs.writeFileSync(h.file, JSON.stringify(data));
  const restored = h.make(), [openai, anthropic] = restored.state().entries;
  assert.deepEqual(openai.bounds, { acceptedLowerBound: 50000, confirmedUpperBound: 16000, upperBoundScope: 'context' });
  assert.equal(openai.limits.input.tokens, 22000);
  assert.equal(openai.passive.maxReportedInput, 26000);
  assert.equal(openai.passive.outputBudget, 512);
  assert.equal(openai.passive.lastContextError.inputLimit, 22000);
  assert.equal(openai.accepted.tokens, 50000);
  assert.deepEqual(anthropic.bounds, { acceptedLowerBound: 6000, confirmedUpperBound: 7000, upperBoundScope: 'context' });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(h.file, 'utf8')).entries).length, 2);
  assert.ok(!fs.readFileSync(h.file, 'utf8').includes('secret'));
  h.provider.keys = [{ id: 'replacement', key: 'new-secret', enabled: true }];
  assert.deepEqual(h.make().state(), restored.state());
  assert.equal(h.make().budget({ model: 'model', protocol: 'openai' }).cap, 16000);
  h.provider.models.push({ id: 'other-model', upstream: 'upstream-model', protocol: 'auto' });
  assert.equal(h.make().budget({ model: 'other-model', protocol: 'openai' }).routes[0].confirmedUpperBound, null);
});

test('legacy observed tokens and explicit limits affect budgets but legacy estimates do not', t => {
  const h = fixture(t);
  const route = { provider: h.provider, key: h.provider.keys[0], model: h.provider.models[0], protocol: 'openai' };
  h.service.observe({ ...route, ok: true, tokens: { input: 12000 } });
  const data = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  const entry = Object.values(data.entries)[0];
  entry.probe = { status: 'range', acceptedEstimate: 50000, rejectedEstimate: 52000, samples: [{ kind: 'context', estimate: 52000 }] };
  fs.writeFileSync(h.file, JSON.stringify(data));
  assert.equal(h.make().budget({ model: 'model', protocol: 'openai' }).cap, 131072);
  assert.equal(h.make().state().entries[0].bounds.confirmedUpperBound, null);
  entry.passive.lastContextError = { declared: 24000 };
  fs.writeFileSync(h.file, JSON.stringify(data));
  const restored = h.make();
  assert.equal(restored.budget({ model: 'model', protocol: 'openai' }).cap, 24000);
  restored.observe({ ...route, ok: false, status: 400, detail: { error: { message: 'Input is too long.' } } });
  assert.equal(h.make().budget({ model: 'model', protocol: 'openai' }).cap, 24000);
  restored.observe({ ...route, ok: false, status: 400, detail: { error: { message: 'prompt is too long: 200000 tokens > 100000 maximum' } } });
  assert.equal(h.make().budget({ model: 'model', protocol: 'openai' }).cap, 24000, 'a newer input limit does not erase the existing total-context limit');
});

test('desktop conversations read persisted evidence through the main-process capacity service', t => {
  const h = require('./claude-harness.cjs').createHarness();
  t.after(() => h.cleanup());
  const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
  const config = normalizeConfig({ enabled: true, providers: [{ id: 'local', protocol: 'dual', baseUrl: 'https://mock.invalid/v1',
    keys: [{ id: 'test-key', key: 'local-only' }], models: [{ id: 'model', upstream: 'model', maxContext: 131072 }] }] });
  writeConfig(path.join(h.home, '.dsh', 'ollama-proxy.json'), config);
  const capacity = createContextCapacity({ file: path.join(h.userData, 'context-capacity.json'), getConfig: () => config });
  const provider = config.providers[0];
  capacity.observe({ provider, key: provider.keys[0], model: provider.models[0], protocol: 'anthropic', ok: false,
    status: 400, detail: { error: { message: 'maximum context length is 16000 tokens' } } });
  const settings = { model: 'model', connection: 'api' };
  assert.equal(h.api.sharedConversations.contextCap('claude', settings), 16000);
  assert.equal(h.api.sharedConversations.contextCap('codex', settings), 131072);
  assert.equal(h.api.sharedConversations.contextCap('claude', { ...settings, connection: 'subscription', contextWindow: 64000 }), 64000);
});
