'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { createContextCapacity, contextError, probeText } = require('../src/api/context-capacity');

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const accepted = (tokens = 1234) => response({ choices: [{ message: { content: probeText(1).markers.join(' ') } }], usage: { prompt_tokens: tokens } });
const exceeded = () => response({ error: { code: 'context_length_exceeded', message: 'maximum context length is 32,768 tokens' } }, 400);

function fixture(testCase, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-capacity-'));
  testCase.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('camellia-capacity-')); removeTree(root); });
  const file = path.join(root, 'capacity.json');
  const provider = { id: 'provider', enabled: true, baseUrl: 'https://relay.example/v1', protocol: 'openai', keys: [{ id: 'key', key: 'private-secret', enabled: true }],
    models: [{ id: 'model', upstream: 'upstream-model', protocol: 'auto', maxContext: 131072 }] };
  const config = { providers: [provider] }, make = () => createContextCapacity({ file, getConfig: () => config, fetchImpl });
  const service = make();
  const start = extra => service.start({ providerId: 'provider', keyId: 'key', model: 'model', protocol: 'openai', confirmed: true, ...extra });
  return { service, start, config, provider, file, make };
}

test('context errors require explicit structured context evidence, never rate limits or body size', () => {
  const detail = { error: { code: 'context_length_exceeded', message: 'maximum context length is 32,768 tokens' } };
  assert.deepEqual(contextError(400, detail), { kind: 'context', declared: 32768 });
  for (const status of [401, 403, 413, 429, 500, 502]) assert.equal(contextError(status, detail), null);
  assert.equal(contextError(400, { error: { message: 'max_tokens is not supported' } }), null);
  assert.equal(contextError(400, '<html>maximum context length is 100 tokens</html>'), null);
  assert.equal(contextError(422, { error: { message: 'prompt is too long: 9000 > 8000' } }).kind, 'context');
});

test('probe uses one route, doubles then bisects, records estimates separately, persists without secrets', async testCase => {
  const sizes = [];
  const { service, start, make, file, provider } = fixture(testCase, async (url, options) => {
    assert.equal(url, 'https://relay.example/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer private-secret');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'upstream-model'); assert.equal(body.max_tokens, 128); assert.equal(body.stream, false);
    const estimate = Math.floor(body.messages[0].content.length / 4);
    sizes.push(estimate);
    return estimate > 25000 ? exceeded() : accepted(estimate * 2);
  });
  start(); await service.settled();
  const entry = service.state().entries[0], probe = entry.probe;
  assert.equal(probe.status, 'range');
  assert.equal(probe.acceptedEstimate, 24576); assert.equal(probe.rejectedEstimate, 26624);
  assert.equal(probe.samples.length, 6); assert.ok(sizes[1] > sizes[0] && sizes[3] < sizes[2]);
  assert.equal(probe.samples[0].markersFound, true);
  assert.ok(probe.samples[0].reportedInput > probe.samples[0].estimate);
  assert.equal(provider.models[0].contextWindow, undefined); assert.equal(entry.declared, 131072);
  assert.deepEqual(make().state().entries[0], entry);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('private-secret'));
  assert.ok(!JSON.stringify(service.state()).includes('identity'));
});

test('budget and confirmation are enforced and cap successes remain only a lower bound', async testCase => {
  let calls = 0;
  const { service, start } = fixture(testCase, async () => { calls++; return accepted(); });
  assert.throws(() => start({ confirmed: false }), /Confirm/);
  assert.throws(() => start({ maxEstimate: 300000 }), /budget/);
  assert.throws(() => start({ maxRequests: 99 }), /budget/);
  assert.equal(calls, 0);
  start({ maxEstimate: 262144, maxRequests: 12 }); await service.settled();
  const result = service.state().entries[0].probe;
  assert.equal(result.status, 'input_cap'); assert.equal(result.rejectedEstimate, null);
  assert.ok(result.totalEstimate <= 524288); assert.ok(calls <= 12);
  start({ maxRequests: 1 }); await service.settled();
  assert.equal(service.state().entries[0].probe.status, 'request_cap');
});

test('unrelated errors and missing markers never fabricate context boundaries or leak API bodies', async testCase => {
  let reply = response({ error: { message: 'private-secret too many tokens' } }, 429);
  const { service, start, file } = fixture(testCase, async () => reply);
  for (const [status, expected] of [[429, 'rate_limit'], [413, 'body_limit'], [500, 'http_error'], [400, 'http_error']]) {
    reply = response({ error: { message: 'private-secret too many tokens' } }, status);
    start(); await service.settled();
    const probe = service.state().entries[0].probe;
    assert.equal(probe.status, expected); assert.equal(probe.rejectedEstimate, null); assert.equal(probe.samples.length, 1);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('private-secret'));
  }
  reply = response({ choices: [{ message: { content: 'OK' } }] });
  start({ maxRequests: 1 }); await service.settled();
  const sample = service.state().entries[0].probe.samples[0];
  assert.equal(sample.reportedInput, null); assert.equal(sample.markersFound, false); assert.equal(sample.kind, 'accepted');
});

test('cancellation aborts in-flight network work and prevents concurrent or subsequent requests', async testCase => {
  let calls = 0;
  const { service, start } = fixture(testCase, async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  start(); assert.throws(() => start(), /already running/);
  const pending = service.settled(); service.cancel(); await pending;
  assert.equal(service.state().active, null); assert.equal(calls, 1);
  assert.equal(service.state().entries[0].probe.status, 'cancelled');
});

test('credentials, protocol, upstream and endpoint edits invalidate cached and in-flight evidence', async testCase => {
  let resolve;
  const { service, start, provider } = fixture(testCase, () => new Promise(done => { resolve = done; }));
  start(); const pending = service.settled();
  provider.keys[0].key = 'replacement'; resolve(accepted()); await pending;
  assert.equal(service.state().entries[0].probe, undefined);
  const evidence = () => ({ provider, key: provider.keys[0], model: provider.models[0], protocol: provider.protocol, ok: true, tokens: { input: 9000 } });
  service.observe(evidence()); assert.equal(service.state().entries[0].passive.maxReportedInput, 9000);
  provider.models[0].upstream = 'new-upstream'; assert.equal(service.state().entries[0].passive, undefined);
  service.observe(evidence()); provider.baseUrl = 'https://other.example/v1'; assert.equal(service.state().entries[0].passive, undefined);
  service.observe(evidence()); provider.protocol = 'anthropic'; assert.equal(service.state().entries[0].passive, undefined);
});

test('passive successes and explicit errors coexist with probes without sending requests', async testCase => {
  let calls = 0;
  const { service, provider, start } = fixture(testCase, async () => { calls++; return accepted(); });
  const route = { provider, key: provider.keys[0], model: provider.models[0], protocol: 'openai' };
  service.observe({ ...route, ok: true, tokens: { input: 30000 }, maxOutputTokens: 2048 });
  service.observe({ ...route, ok: true, tokens: { input: 2000 } });
  service.observe({ ...route, ok: false, status: 400, detail: JSON.stringify({ error: { code: 'context_length_exceeded' } }) });
  assert.equal(calls, 0);
  const passive = service.state().entries[0].passive;
  assert.equal(passive.maxReportedInput, 30000); assert.equal(passive.outputBudget, 2048); assert.ok(passive.lastContextError);
  start({ maxRequests: 1 }); await service.settled();
  assert.deepEqual(service.state().entries[0].passive, passive);
});

test('Anthropic requests pin their endpoint and include cached input in usage', async testCase => {
  const { service, start, provider } = fixture(testCase, async (url, options) => {
    assert.equal(url, 'https://messages.example/v1/messages');
    assert.equal(options.headers['x-api-key'], 'private-secret');
    return response({ content: [{ type: 'text', text: probeText(1).markers.join(' ') }], usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } });
  });
  provider.protocol = 'dual'; provider.anthropicBaseUrl = 'https://messages.example/v1';
  start({ protocol: 'anthropic', maxRequests: 1 }); await service.settled();
  const entries = service.state().entries;
  assert.equal(entries[0].probe, undefined); assert.equal(entries[1].probe.samples[0].reportedInput, 1050);
});

test('restart marks an unfinished probe interrupted without resuming paid work', testCase => {
  const { service, provider, file, make } = fixture(testCase, () => { throw new Error('must not fetch'); });
  service.observe({ provider, key: provider.keys[0], model: provider.models[0], protocol: 'openai', ok: true, tokens: { input: 30 } });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.values(data.entries)[0].probe = { status: 'running' };
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(make().state().entries[0].probe.status, 'interrupted'); assert.equal(make().state().active, null);
});
