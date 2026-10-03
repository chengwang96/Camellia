'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { createSubscriptionUsage } = require('../src/api/subscription-usage');
const { createSubscriptionMeter } = require('../src/engines/subscription-meter');
const { estimateTokens, priceFor } = require('../src/api/subscription-pricing');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-subscription-usage-'));
  t.after(() => removeTree(root));
  const file = path.join(root, 'usage.json');
  const store = createSubscriptionUsage({ file });
  return { root, file, store, account: (engine, id = 'default') => store.state().accounts.find(a => a.id === `${engine}:${id}`) };
}
const tokens = (input, cache, output, reasoning = 0) => ({ inputTokens: input, cachedInputTokens: cache, outputTokens: output, reasoningOutputTokens: reasoning });
const turnEnd = JSON.stringify({ type: 'turn.ended' }) + '\n';

test('Codex counts all requests in a turn, ignores repeated totals, and keeps the next turn separate', async t => {
  const f = fixture(t);
  const meter = createSubscriptionMeter({ engine: 'codex', accountId: 'account-1', model: 'gpt-5.4', record: f.store.record });
  await meter.begin('native');
  // A resumed thread contains 10,000 tokens of old history. Only last is new.
  meter.codex({ total: tokens(11000, 5000, 150), last: tokens(1000, 200, 50, 10) });
  meter.codex({ total: tokens(12000, 5600, 250, 20), last: tokens(1000, 600, 100, 20) });
  meter.codex({ total: tokens(12000, 5600, 250, 20), last: tokens(1000, 600, 100, 20) });
  await meter.end({ subtype: 'success' });
  await meter.end({ subtype: 'success' });
  let usage = f.account('codex', 'account-1').usage;
  assert.equal(usage.requests, 1);
  assert.equal(usage.inputTokens, 2000);
  assert.equal(usage.cacheReadTokens, 800);
  assert.equal(usage.outputTokens, 150);
  assert.equal(usage.pricedTokens, 2150);
  assert.ok(usage.estimatedCostUsd > 0);
  await meter.begin('native');
  meter.codex({ total: tokens(12500, 5900, 275, 20), last: tokens(500, 300, 25) });
  await meter.end({ subtype: 'stopped' });
  usage = f.account('codex', 'account-1').usage;
  assert.equal(usage.requests, 1);
  assert.equal(usage.cancelled, 1);
  assert.equal(usage.inputTokens, 2500);
  assert.equal(usage.outputTokens, 175);
  assert.equal(usage.byModel['gpt-5.4'].inputTokens, 2500);
});

test('account/model/date aggregation survives restart and duplicate delivery', t => {
  const f = fixture(t), at = new Date(2026, 8, 29, 12);
  const row = { id: 'unique-turn', engine: 'kimi', accountId: 'account-2', model: 'kimi-code/k3', at,
    samples: [{ model: 'kimi-code/k3', input: 23000, cacheRead: 19000, output: 300, cacheWrite: 0 }] };
  assert.equal(f.store.record(row), true);
  const restarted = createSubscriptionUsage({ file: f.file });
  assert.equal(restarted.record(row), false);
  const account = restarted.state([{ id: 'kimi:account-2', label: 'Work account' }]).accounts[0];
  assert.equal(account.label, 'Work account');
  assert.equal(account.usage.inputTokens, 23000);
  assert.equal(account.usage.daily['2026-09-29']['kimi-code/k3'].requests, 1);
  assert.ok(account.usage.estimatedCostUsd > 0);
  assert.equal(f.store.record({ ...row, id: 'api-turn', engine: 'claude' }), false);
  assert.equal(f.store.record({ ...row, id: 'bad-account', accountId: '../../other' }), false);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /prompt|credential|access_token/);
});

test('Codex compaction resets do not replay the previous request as new usage', async t => {
  const f = fixture(t);
  const meter = createSubscriptionMeter({ engine: 'codex', model: 'gpt-5.4', record: f.store.record });
  await meter.begin('native');
  meter.codex({ total: tokens(1000, 200, 50), last: tokens(1000, 200, 50) });
  meter.codex({ total: tokens(100, 0, 0), last: tokens(1000, 200, 50) });
  meter.codex({ total: tokens(600, 100, 20), last: tokens(500, 100, 20) });
  await meter.end({ subtype: 'success' });
  const usage = f.account('codex').usage;
  assert.equal(usage.inputTokens, 1500);
  assert.equal(usage.outputTokens, 70);
  assert.equal(usage.unreported, 1);
});

test('a failed disk write leaves totals unchanged and the turn can be saved on retry', t => {
  const f = fixture(t), blocked = path.join(f.root, 'blocked');
  const store = createSubscriptionUsage({ file: path.join(blocked, 'usage.json') });
  fs.writeFileSync(blocked, 'not a directory');
  const row = { id: 'retryable-turn', engine: 'codex', model: 'gpt-5.4', samples: [{ input: 100, output: 10 }] };
  assert.throws(() => store.record(row));
  assert.equal(store.state().accounts.length, 0);
  assert.ok(store.state().error);
  fs.unlinkSync(blocked);
  assert.equal(store.record(row), true);
  assert.equal(store.state().accounts[0].usage.inputTokens, 100);
  assert.equal(store.state().error, null);
});

test('unknown prices and missing or failed usage remain visible instead of becoming free usage', async t => {
  const f = fixture(t);
  f.store.record({ id: 'unknown', engine: 'codex', model: 'future-model', samples: [{ input: 12, output: 3 }] });
  f.store.record({ id: 'missing', engine: 'codex', model: 'future-model', samples: [] });
  f.store.record({ id: 'failed', engine: 'codex', model: 'future-model', outcome: 'failures', samples: [{ input: 5, output: 1 }] });
  const usage = f.account('codex').usage;
  assert.equal(usage.inputTokens, 17);
  assert.equal(usage.outputTokens, 4);
  assert.equal(usage.unpricedTokens, 21);
  assert.equal(usage.pricedTokens, 0);
  assert.equal(usage.unreported, 1);
  assert.equal(usage.failures, 1);
  assert.equal(estimateTokens('toString', { input: 1, output: 1 }), null);
});

test('standard API estimate subtracts cache exactly once and prices reasoning inside output', () => {
  const price = priceFor('gpt-5.4');
  const sample = { input: 10000, cacheRead: 8000, cacheWrite: 0, output: 1000, reasoning: 900 };
  assert.equal(estimateTokens('gpt-5.4', sample), (2000 * price.input + 8000 * price.cacheRead + 1000 * price.output) / 1e6);
  const long = { input: 300000, cacheRead: 200000, output: 1000 };
  assert.equal(estimateTokens('gpt-5.4', long), (100000 * price.long.input + 200000 * price.long.cacheRead + 1000 * price.long.output) / 1e6);
  assert.equal(estimateTokens('gpt-5.4', { ...long, aggregate: true }), null);
  assert.equal(estimateTokens('gpt-5.4', { input: 1, output: 1, cacheRead: 2 }), null);
  assert.equal(estimateTokens('unknown', sample), null);
});

test('Kimi skips inherited history and cumulative 0.x records; includes cache and the actual model', async t => {
  const f = fixture(t), home = path.join(f.root, 'kimi');
  const dir = path.join(home, 'sessions', 'workspace', 'native', 'agents', 'root');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wire.jsonl');
  const usage = (n, scope = 'turn') => JSON.stringify({ type: 'usage.record', usageScope: scope, model: 'kimi-code/k3',
    usage: { inputOther: n, output: n / 10, inputCacheRead: n * 2, inputCacheCreation: n / 2 } }) + '\n';
  fs.writeFileSync(file, usage(100000));
  const meter = createSubscriptionMeter({ engine: 'kimi', home, version: '0.43.0', model: 'selected-alias', record: f.store.record });
  await meter.begin('native');
  fs.appendFileSync(file, usage(100) + usage(100100, 'session') + usage(200) + turnEnd);
  await meter.end({ subtype: 'success' });
  assert.equal(f.account('kimi').usage.inputTokens, 1050);
  assert.equal(f.account('kimi').usage.outputTokens, 30);
  assert.equal(f.account('kimi').usage.cacheReadTokens, 600);
  assert.equal(f.account('kimi').usage.cacheWriteTokens, 150);
  assert.equal(f.account('kimi').usage.byModel['selected-alias'], undefined);
  assert.equal(f.account('kimi').usage.unreported, 0);
  await meter.begin('native');
  fs.appendFileSync(file, usage(50) + turnEnd);
  await meter.end({ subtype: 'stopped' });
  assert.equal(f.account('kimi').usage.inputTokens, 1225);
  assert.equal(f.account('kimi').usage.cancelled, 1);
});

test('Kimi 2.x records session-scoped compaction deltas and new subagent journals', async t => {
  const f = fixture(t), home = path.join(f.root, 'kimi');
  const meter = createSubscriptionMeter({ engine: 'kimi', home, version: '2.0.0', model: 'kimi-code/k3', record: f.store.record });
  await meter.begin('native');
  for (const agent of ['root', 'child']) {
    const dir = path.join(home, 'sessions', 'workspace', 'native', 'agents', agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'wire.jsonl'), JSON.stringify({ type: 'usage.record', usageScope: 'session', model: 'kimi-code/k3',
      usage: { inputOther: 10, output: 2, inputCacheRead: 20, inputCacheCreation: 0 } }) + '\n' + turnEnd);
  }
  await meter.end({ subtype: 'success' });
  assert.equal(f.account('kimi').usage.inputTokens, 60);
  assert.equal(f.account('kimi').usage.outputTokens, 4);
  assert.equal(f.account('kimi').usage.unreported, 0);
});

test('Kimi waits for journal writes delayed beyond 1.5 seconds before the next turn snapshots history', async t => {
  const f = fixture(t), home = path.join(f.root, 'kimi');
  const dir = path.join(home, 'sessions', 'workspace', 'native', 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wire.jsonl');
  const usage = JSON.stringify({ type: 'usage.record', usageScope: 'turn', model: 'kimi-code/k3',
    usage: { inputOther: 10, output: 2, inputCacheRead: 20, inputCacheCreation: 0 } }) + '\n';
  fs.writeFileSync(file, '');
  const meter = createSubscriptionMeter({ engine: 'kimi', home, version: '2.0.0', model: 'kimi-code/k3', record: f.store.record });
  await meter.begin('native');
  const finished = meter.end({ subtype: 'success' });
  const next = meter.begin('native');
  const writer = setTimeout(() => fs.appendFileSync(file, usage + turnEnd), 1800);
  t.after(() => clearTimeout(writer));
  await finished;
  assert.equal(await next, true);
  fs.appendFileSync(file, usage + turnEnd);
  await meter.end({ subtype: 'success' });
  const total = f.account('kimi').usage;
  assert.equal(total.requests, 2);
  assert.equal(total.inputTokens, 60);
  assert.equal(total.outputTokens, 4);
  assert.equal(total.unreported, 0);

  await meter.begin('native');
  const third = meter.end({ subtype: 'success' });
  let active = true;
  const cancelled = meter.begin('native', () => active);
  active = false;
  fs.appendFileSync(file, usage + turnEnd);
  await third;
  assert.equal(await cancelled, false);
  await meter.end({ subtype: 'stopped' });
  assert.equal(f.account('kimi').usage.requests, 3);
  assert.equal(f.account('kimi').usage.cancelled, 0, 'a prompt cancelled before sending does not incur usage');
});

test('Antigravity deduplicates step snapshots, includes cache, and preserves usage on failure', async t => {
  const f = fixture(t);
  const meter = createSubscriptionMeter({ engine: 'antigravity', model: 'gemini-3.8-flash', record: f.store.record });
  await meter.begin('native');
  const raw = { input_tokens: 100, output_tokens: 30, cache_read_tokens: 900, thinking_tokens: 20 };
  meter.antigravityStep(1, raw); meter.antigravityStep(1, raw);
  await meter.end({ subtype: 'success', usage: raw });
  assert.equal(f.account('antigravity').usage.inputTokens, 1000);
  assert.equal(f.account('antigravity').usage.outputTokens, 30);
  assert.equal(f.account('antigravity').usage.reasoningTokens, 20);
  await meter.begin('native');
  meter.antigravityStep(2, raw);
  await meter.end({ subtype: 'error', is_error: true });
  assert.equal(f.account('antigravity').usage.inputTokens, 2000);
  assert.equal(f.account('antigravity').usage.failures, 1);
  assert.equal(f.account('antigravity').usage.unreported, 1);
});
