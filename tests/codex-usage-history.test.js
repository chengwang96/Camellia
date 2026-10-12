'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { removeTree } = require('./test-fs.cjs');
const { readCodexPricingHistory } = require('../src/engines/codex-usage-history');

const MODEL = 'gpt-6.1-sol', DAY = '2026-10-06', at = new Date(`${DAY}T12:00:00`).toISOString();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-codex-usage-history-'));
  t.after(() => removeTree(root));
  const targets = [{ account: 'codex:default', accountId: 'default', engine: 'codex', day: DAY, model: MODEL }];
  return { root, targets };
}
const event = (type, value = {}) => ({ timestamp: at, type: 'event_msg', payload: { type, ...value } });
const usage = (input, output, cacheRead = 0, reasoning = 0) => ({ input_tokens: input, output_tokens: output,
  cached_input_tokens: cacheRead, cache_write_input_tokens: 0, reasoning_output_tokens: reasoning });
const count = (total, last = total) => event('token_count', { info: { total_token_usage: total, last_token_usage: last } });
function rollout(root, { accountId = 'default', threadId = randomUUID(), turnId = randomUUID(), records = [], complete = true,
  source = 'vscode', originator = 'camellia', archived = false } = {}) {
  const home = accountId === 'default' ? path.join(root, 'codex', 'subscription') : path.join(root, 'subscription-accounts', 'codex', accountId);
  const dir = path.join(home, archived ? 'archived_sessions' : 'sessions', '2026', '10', '06');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${DAY}T12-00-00-${threadId}.jsonl`);
  const rows = [{ timestamp: at, type: 'session_meta', payload: { id: threadId, source, originator, model_provider: 'openai' } },
    event('task_started', { turn_id: turnId }), { timestamp: at, type: 'turn_context', payload: { model: MODEL, turn_id: turnId } },
    ...records, ...(complete ? [event('task_complete', { turn_id: turnId })] : [])];
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { file, rows, turnId };
}

test('native usage recovery ignores duplicate totals and forked copies while retaining every request tier', async t => {
  const f = fixture(t), first = usage(300000, 10, 100000, 4), total = usage(400000, 30, 150000, 9);
  const original = rollout(f.root, { records: [count(first), count(first), count(total, usage(100000, 20, 50000, 5))] });
  rollout(f.root, { turnId: original.turnId, records: [count(first), count(first), count(total, usage(100000, 20, 50000, 5))], archived: true });
  const before = fs.readFileSync(original.file, 'utf8');
  const rows = await readCodexPricingHistory({ userData: f.root, targets: f.targets });
  assert.equal(rows.length, 1); assert.equal(rows[0].turns, 1);
  assert.deepEqual(rows[0].samples, [{ input: 300000, output: 10, cacheRead: 100000, cacheWrite: 0, reasoning: 4 },
    { input: 100000, output: 20, cacheRead: 50000, cacheWrite: 0, reasoning: 5 }]);
  assert.equal(fs.readFileSync(original.file, 'utf8'), before);
});

test('native history uses the live meter compaction reset rule and does not include unfinished turns', async t => {
  const f = fixture(t);
  rollout(f.root, { records: [count(usage(1000, 10, 50)), count(usage(100, 0), usage(1000, 10, 50)),
    count(usage(600, 20, 300), usage(500, 20, 300))] });
  rollout(f.root, { records: [count(usage(99999, 1))], complete: false });
  const rows = await readCodexPricingHistory({ userData: f.root, targets: f.targets });
  assert.equal(rows.length, 1); assert.equal(rows[0].turns, 1);
  assert.deepEqual(rows[0].samples.map(v => [v.input, v.output, v.cacheRead]), [[1000, 10, 50], [500, 20, 300]]);
});

test('history is scoped to each subscription account and excludes native subagents and other apps', async t => {
  const f = fixture(t);
  rollout(f.root, { records: [count(usage(1000, 10))] });
  rollout(f.root, { accountId: 'account-1', records: [count(usage(2000, 20))] });
  rollout(f.root, { source: { subAgent: { thread_spawn: {} } }, records: [count(usage(90000, 90))] });
  rollout(f.root, { originator: 'other-app', records: [count(usage(80000, 80))] });
  f.targets.push({ ...f.targets[0], account: 'codex:account-1', accountId: 'account-1' });
  const rows = await readCodexPricingHistory({ userData: f.root, targets: f.targets });
  assert.equal(rows.length, 2);
  const sums = Object.fromEntries(rows.map(row => [row.account, row.samples.reduce((sum, sample) => sum + sample.input, 0)]));
  assert.deepEqual(sums, { 'codex:default': 1000, 'codex:account-1': 2000 });
});

test('missing, damaged and over-budget journals provide no partial recovery', async t => {
  const f = fixture(t);
  assert.deepEqual(await readCodexPricingHistory({ userData: f.root, targets: f.targets }), []);
  const saved = rollout(f.root, { records: [count(usage(1000, 10))] });
  assert.deepEqual(await readCodexPricingHistory({ userData: f.root, targets: f.targets, maxBytes: 10 }), []);
  fs.appendFileSync(saved.file, '{"type":"event_msg","payload":');
  assert.deepEqual(await readCodexPricingHistory({ userData: f.root, targets: f.targets }), []);
});

test('conflicting fork copies cannot certify a native daily total', async t => {
  const f = fixture(t), first = rollout(f.root, { records: [count(usage(1000, 10))] });
  rollout(f.root, { turnId: first.turnId, records: [count(usage(1200, 12))], archived: true });
  rollout(f.root, { records: [count(usage(500, 5))], archived: true });
  assert.deepEqual(await readCodexPricingHistory({ userData: f.root, targets: f.targets }), []);
});
