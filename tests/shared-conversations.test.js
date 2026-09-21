'use strict';
const { removeTree } = require('./test-fs.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedConversations, preferences, ENGINES } = require('../src/engines/shared-conversations');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-chat-'));
  t.after(() => { manager?.pauseGoals(); removeTree(root); });
  let config = {}, gen = 0, manager;
  const sent = [], events = [], sessions = {};
  const drivers = Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => ({ model: 'fixture' }), saveSettings: v => v,
    ensure(opts) {
      const session = { gen: ++gen, sessionId: opts.sessionId || engine + '-' + gen, running: false, settings: { cwd: opts.cwd }, opts,
        sendUserMessage(prompt) {
          session.running = true; sent.push({ engine, prompt, opts, session });
          manager.capture(engine, { type: 'system', subtype: 'init', session_id: session.sessionId, runId: session.gen });
          return true;
        },
        interrupt() { finish(engine, 'stopped', 'Stopped', session); }, answerPermission: (...args) => { session.permissions = args; return true; },
      };
      sessions[engine] = session; return session;
    } }]));
  const args = { dir: root, loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; }, drivers,
    onEvent: event => events.push(event), ...overrides };
  manager = new SharedConversations(args);
  function finish(engine, subtype = 'success', text = 'Answer from ' + engine, session = sessions[engine]) { session.running = false;
    manager.capture(engine, { type: 'result', subtype, is_error: subtype === 'error', result: text, session_id: session.sessionId, runId: session.gen });
  }
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  return { manager, args, root, sent, events, finish, drivers, flush, get goal() { return [...manager.goals.values()].at(-1); }, setConfig: c => { config = c; },
    restart: () => { manager = new SharedConversations(args); return manager; } };
}
test('defaults continue directly with no warning or origin badge', () => assert.deepEqual(preferences({}), { mode: 'direct', warnOnSwitch: false, showOrigin: false }));

test('usage survives reloading shared conversations without mixing per-call and turn totals', async t => {
  for (const engine of ['claude', 'codex']) {
    const f = fixture(t);
    const run = await f.manager.send(engine, { prompt: 'Check usage' });
    const runId = f.sent.at(-1).session.gen;
    const lastCallUsage = { input_tokens: 40000, cache_read_input_tokens: 5000, output_tokens: 100 };
    const usage = { input_tokens: 1300000, output_tokens: 500 };
    f.manager.capture(engine, engine === 'claude'
      ? { type: 'assistant', runId, message: { content: [{ type: 'text', text: 'Answer' }], usage: lastCallUsage } }
      : { type: 'gui:usage', runId, usage: lastCallUsage });
    f.manager.capture(engine, { type: 'result', runId, subtype: 'success', result: 'Answer', usage });
    await run.done;
    const manager = f.restart();
    const reloaded = manager.load(engine, run.sessionId).messages.at(-1);
    assert.deepEqual(reloaded.usage, usage);
    assert.deepEqual(reloaded.lastCallUsage, lastCallUsage);
    const next = await manager.send(engine, { sessionId: run.sessionId, prompt: 'No usage' });
    f.finish(engine); await next.done;
    assert.equal(manager.load(engine, run.sessionId).messages.at(-1).usage, undefined);
    assert.equal(manager.load(engine, run.sessionId).messages.at(-1).lastCallUsage, undefined);
  }
});

test('new conversations use the default model to generate a title of at most ten characters', async t => {
  const calls = [];
  const f = fixture(t, { generateTitle: async (message, model) => { calls.push({ message, model }); return '  修复会话默认标题生成逻辑。  '; } });
  const run = await f.manager.send('claude', { prompt: '请不要直接使用这条消息作为会话标题' });
  await f.flush();
  assert.deepEqual(calls, [{ message: '请不要直接使用这条消息作为会话标题', model: 'fixture' }]);
  assert.equal(f.manager.get(run.sessionId).title, '修复会话默认标题生成');
  assert.ok([...f.manager.get(run.sessionId).title].length <= 10);
  assert.ok(f.events.some(event => event.type === 'conversation:title' && event.title === '修复会话默认标题生成'));
});

test('all five engines restart the last turn without its old reply or tool context, preserving earlier turns', async t => {
  for (const engine of ENGINES) {
    const f = fixture(t);
    const first = await f.manager.send(engine, { prompt: 'Prior task' }); f.finish(engine, 'success', 'Prior answer');
    const old = await f.manager.send(engine, { sessionId: first.sessionId, prompt: 'SUPERSEDED_REQUEST', displayText: 'Original message', attachments: [{ path: 'data.csv', name: 'data.csv' }] });
    const native = f.sent.at(-1).session, c = f.manager.get(first.sessionId);
    f.manager.capture(engine, { type: 'gui:tool', id: 'write-1', name: 'Write', output: 'WROTE output.txt', runId: native.gen });
    await f.manager.cancel({ sessionId: c.id, runId: old.runId });
    const raw = fs.readFileSync(path.join(f.root, c.id + '.jsonl'), 'utf8');
    c.segments.kimi = { nativeId: 'stale-kimi', cursor: c.seq, isolated: true };
    const other = await f.manager.send(engine, { prompt: 'Independent work' });
    const revised = await f.manager.send(engine, { sessionId: c.id, editSeq: old.userSeq, prompt: 'Corrected message', displayText: 'Corrected message', attachments: [{ path: 'data.csv', name: 'data.csv' }] });
    assert.equal(revised.sessionId, c.id);
    assert.ok(revised.userSeq > old.userSeq);
    assert.equal(f.sent.at(-1).opts.sessionId, undefined);
    assert.match(f.sent.at(-1).prompt, /Prior task/);
    assert.doesNotMatch(f.sent.at(-1).prompt, /WROTE output.txt/);
    assert.match(f.sent.at(-1).prompt, /were not rolled back/);
    assert.doesNotMatch(f.sent.at(-1).prompt, /SUPERSEDED_REQUEST/);
    assert.equal(f.manager.active.has(other.sessionId), true);
    assert.equal(f.manager.get(c.id).retiredSegments.some(s => s.nativeId === 'stale-kimi'), true);
    assert.equal(f.manager.live(engine, c.id).live.userSeq, revised.userSeq);
    assert.deepEqual(f.manager.load(engine, c.id).messages.filter(m => m.role === 'user').map(m => m.displayText ?? m.text), ['Prior task', 'Corrected message']);
    assert.ok(fs.readFileSync(path.join(f.root, c.id + '.jsonl'), 'utf8').startsWith(raw));
    f.finish(engine, 'success', 'Corrected answer');
    const restored = f.restart().load(engine, c.id);
    assert.equal(restored.messages.at(-1).text, 'Corrected answer');
    assert.equal(restored.messages.at(-2).attachments[0].name, 'data.csv');
    assert.doesNotMatch(JSON.stringify(restored.messages), /WROTE output.txt|SUPERSEDED_REQUEST|previousAttempt/);
    const otherEngine = engine === 'kimi' ? 'dsh' : 'kimi';
    assert.doesNotMatch(f.manager.context(f.manager.get(c.id), otherEngine), /WROTE output.txt|SUPERSEDED_REQUEST/);
  }
});

test('a failed turn with oversized tool output can be discarded and resent within the existing context limit', async t => {
  const f = fixture(t), c = f.manager.create('claude', null, 'Restart large failed turn');
  f.manager.append(c, { role: 'user', text: 'Prior completed request' });
  f.manager.append(c, { role: 'tool', text: 'PRIOR_WORK_' + 'a'.repeat(129000) });
  f.manager.append(c, { role: 'assistant', text: 'Prior work completed' });
  const old = f.manager.append(c, { role: 'user', text: 'ORIGINAL_REQUEST' });
  f.manager.append(c, { role: 'tool', text: 'DISCARDED_TOOL_' + 'b'.repeat(307000) });
  f.manager.append(c, { role: 'assistant', text: 'DISCARDED_REPLY' });
  f.manager.save(c);
  const revised = await f.manager.send('claude', { sessionId: c.id, editSeq: old.seq, prompt: 'REVISED_REQUEST' });
  const sent = f.sent.at(-1).prompt;
  assert.ok(sent.length < 220000);
  assert.match(sent, /Prior work completed|PRIOR_WORK_/);
  assert.doesNotMatch(sent, /DISCARDED_|ORIGINAL_REQUEST/);
  f.finish('claude', 'success', 'Revised response');
  const again = await f.manager.send('claude', { sessionId: c.id, editSeq: revised.userSeq, prompt: 'REVISED_AGAIN' });
  assert.doesNotMatch(f.sent.at(-1).prompt, /DISCARDED_|ORIGINAL_REQUEST|REVISED_REQUEST|Revised response/);
  f.finish('claude');
  assert.equal(f.manager.messages(c).filter(row => row.role === 'user').at(-1).seq, again.userSeq);
});

test('an edit resend that replays an oversized history is auto-compacted instead of refused', async t => {
  const f = fixture(t), c = f.manager.create('claude', null, 'Edit a huge conversation');
  f.manager.append(c, { role: 'user', text: 'First task' });
  f.manager.append(c, { role: 'tool', text: 'EARLY_WORK_' + 'a'.repeat(129000) });
  f.manager.append(c, { role: 'assistant', text: 'Early work done' });
  f.manager.append(c, { role: 'user', text: 'Second task' });
  f.manager.append(c, { role: 'tool', text: 'MORE_WORK_' + 'b'.repeat(129000) });
  f.manager.append(c, { role: 'assistant', text: 'More work done' });
  const old = f.manager.append(c, { role: 'user', text: 'ORIGINAL_REQUEST' });
  f.manager.save(c);
  const revised = f.manager.send('claude', { sessionId: c.id, editSeq: old.seq, prompt: 'REVISED_REQUEST' });
  await f.flush();
  f.finish('claude', 'success', 'SUMMARY_TEXT of the earlier work');
  await f.flush();
  const run = await revised;
  const sent = f.sent.at(-1).prompt;
  assert.ok(sent.length < 220000);
  assert.match(sent, /SUMMARY_TEXT/);
  assert.doesNotMatch(sent, /EARLY_WORK_|MORE_WORK_|ORIGINAL_REQUEST/);
  f.finish('claude', 'success', 'Revised response');
  assert.equal((await run.done).result, 'Revised response');
  assert.equal(f.manager.messages(c).filter(row => row.role === 'user').at(-1).seq, run.userSeq);
});

test('revision guards reject busy, stale, oversized and forked edits without changing saved history', async t => {
  const f = fixture(t), run = await f.manager.send('claude', { prompt: 'Original' }), c = f.manager.get(run.sessionId);
  const payload = { sessionId: c.id, editSeq: run.userSeq, prompt: 'Edited' };
  const file = path.join(f.root, c.id + '.jsonl'), before = fs.readFileSync(file, 'utf8');
  await assert.rejects(f.manager.send('claude', payload), /Wait/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  f.finish('claude');
  const idle = fs.readFileSync(file, 'utf8');
  for (const patch of [{ editSeq: 0 }, { editSeq: run.userSeq + 1 }, { prompt: '' }, { prompt: 'x'.repeat(230000) }, { fork: true }])
    await assert.rejects(f.manager.send('claude', { ...payload, ...patch }));
  assert.equal(f.manager.items.size, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), idle);
  const revised = await f.manager.send('claude', payload); f.finish('claude');
  await assert.rejects(f.manager.send('claude', payload), /latest message/);
  f.manager.prepare = async () => { throw new Error('Fixture unavailable'); };
  const failed = await f.manager.send('claude', { ...payload, editSeq: revised.userSeq, prompt: 'Retry' });
  assert.equal((await failed.done).is_error, true);
  assert.equal(f.manager.active.size, 0);
  assert.equal(f.manager.messages(c).filter(m => m.role === 'user').at(-1).seq, failed.userSeq);
});

test('live replay merges only adjacent supported deltas and retains message boundaries and usage', async t => {
  const f = fixture(t), run = await f.manager.send('claude', { prompt: 'Read' });
  const emit = event => f.manager.capture('claude', { type: 'stream_event', runId: f.sent.at(-1).session.gen, event });
  emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } });
  emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'B' } });
  emit({ type: 'content_block_stop', index: 0 });
  emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
  emit({ type: 'message_delta', delta: {}, usage: { output_tokens: 9 } });
  emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'C' } });
  const events = f.manager.live('claude', run.sessionId).live.events;
  assert.deepEqual(events.filter(e => e.event?.delta?.type === 'text_delta').map(e => e.event.delta.text), ['AB', 'C']);
  assert.deepEqual(events.filter(e => e.event?.usage).map(e => e.event.usage.output_tokens), [7, 9]);
  f.finish('claude');
});

test('each engine continues a shared goal in the same conversation and recognizes streamed completion', async t => {
  const f = fixture(t);
  for (const engine of ENGINES) {
    const started = await f.manager.command(engine, 'goal-start', { objective: 'Complete and verify ' + engine });
    assert.equal(started.goal.engine, engine);
    f.goal.drive(); await new Promise(resolve => setImmediate(resolve));
    const id = f.goal.view().sessionId, nativeId = f.sent.at(-1).session.sessionId;
    assert.equal(f.manager.get(id).title, 'Complete and verify ' + engine);
    assert.equal(f.sent.at(-1).engine, engine);
    assert.match(f.sent.at(-1).prompt, /<goal:complete>/);
    assert.equal(f.manager.messages(f.manager.get(id))[0].text, 'Complete and verify ' + engine);
    f.finish(engine, 'success', 'Implementation finished; verification remains.');
    assert.equal(f.goal.view().phase, 'active');
    f.goal.drive(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.goal.view().sessionId, id);
    assert.equal(f.sent.at(-1).opts.sessionId, nativeId);
    const session = f.sent.at(-1).session;
    f.manager.capture(engine, { type: 'stream_event', runId: session.gen, event: { delta: { type: 'text_delta', text: 'Verification passed.\n<goal:complete>' } } });
    f.finish(engine, 'success', '');
    assert.equal(f.goal.view().phase, 'active');
    assert.ok(f.goal.view().verifying);
    await f.flush();
    assert.match(f.sent.at(-1).prompt, /independent verifier/);
    assert.match(f.sent.at(-1).prompt, /Complete and verify/);
    f.finish(engine, 'success', 'Checked.\n<verify:pass> confirmed by re-running the tests');
    await f.flush();
    assert.equal(f.goal.view().phase, 'complete');
    assert.ok(f.goal.view().verified);
    assert.equal(f.goal.timer, null);
  }
});

test('pausing during engine setup cancels the pending goal before it can send; resume and clear work', async t => {
  const f = fixture(t);
  let release;
  f.manager.prepare = () => new Promise(resolve => { release = resolve; });
  await f.manager.command('codex', 'goal-start', { objective: 'Finish' });
  f.goal.drive();
  await f.manager.command('codex', 'goal-pause', { sessionId: f.goal.goal.sessionId });
  assert.equal(f.goal.view().phase, 'paused');
  assert.equal((await f.manager.command('codex', 'goal-resume', { sessionId: f.goal.goal.sessionId })).ok, false);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 0); assert.equal(f.manager.active.size, 0);
  f.manager.prepare = async () => {};
  await f.manager.command('codex', 'goal-resume', { sessionId: f.goal.goal.sessionId }); f.goal.drive();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1);
  await f.manager.command('codex', 'goal-clear', { sessionId: f.goal.goal.sessionId });
  assert.equal(f.manager.active.size, 0); assert.equal(f.goal.view(), null);
});

test('a late initialization error cannot recreate a goal that the user removed', async t => {
  const f = fixture(t);
  let rejectSetup;
  f.manager.prepare = () => new Promise((_, reject) => { rejectSetup = reject; });
  await f.manager.command('dsh', 'goal-start', { objective: 'Finish' }); f.goal.drive();
  await f.manager.command('dsh', 'goal-clear', { sessionId: f.goal.goal.sessionId }); rejectSetup(new Error('Unavailable engine'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.goal.view(), null); assert.equal(f.manager.active.size, 0);
  assert.equal(f.sent.length, 0);
});

test('resuming a goal in another engine completes its Markdown handoff before arming continuation', async t => {
  const f = fixture(t); f.setConfig({ conversations: { mode: 'markdown' } });
  await f.manager.command('claude', 'goal-start', { objective: 'Finish the experiment' });
  f.goal.drive(); await new Promise(resolve => setImmediate(resolve));
  f.finish('claude', 'success', 'The implementation is ready. Tests remain.');
  await f.manager.command('claude', 'goal-pause', { sessionId: f.goal.goal.sessionId });
  const resumed = f.manager.command('kimi', 'goal-resume', { sessionId: f.goal.goal.sessionId });
  await new Promise(resolve => setImmediate(resolve));
  f.finish('claude', 'success', '## Next\nRun the tests.');
  await new Promise(resolve => setImmediate(resolve));
  f.finish('kimi', 'success', 'Handoff received.');
  assert.equal((await resumed).ok, true);
  assert.equal(f.goal.view().armed, true);
  assert.equal(f.goal.view().engine, 'kimi');
  f.goal.drive(); await new Promise(resolve => setImmediate(resolve));
  f.finish('kimi', 'success', 'Tests are running.');
  assert.equal(f.goal.view().phase, 'active');
  assert.notEqual(f.goal.timer, null);
});
test('all 20 directed engine switches carry context and resume their own native ID', async t => {
  const f = fixture(t);
  for (const from of ENGINES) for (const to of ENGINES.filter(e => e !== from)) {
    const first = await f.manager.send(from, { prompt: 'Remember unique goal ' + from + to }); f.finish(from);
    const nativeId = f.sent.at(-1).session.sessionId;
    await f.manager.switchEngine(first.sessionId, to);
    await f.manager.send(to, { sessionId: first.sessionId, prompt: 'Continue in B' });
    assert.match(f.sent.at(-1).prompt, /Remember unique goal/); f.finish(to);
    await f.manager.switchEngine(first.sessionId, from);
    await f.manager.send(from, { sessionId: first.sessionId, prompt: 'Return to A' });
    const last = f.sent.at(-1);
    assert.equal(last.opts.sessionId, nativeId); assert.match(last.prompt, /Continue in B/); assert.doesNotMatch(last.prompt, /Remember unique goal/);
    f.finish(from);
    const c = f.manager.load(to, first.sessionId);
    assert.equal(c.messages.length, 6); assert.equal(c.origin, from); assert.equal(c.preferences.showOrigin, false);
    assert.deepEqual(c.messages.map(message => message.engine), [from, from, to, to, from, from]);
  }
});
test('each message keeps its harness attribution across switches and restart', async t => {
  const f = fixture(t);
  const first = await f.manager.send('claude', { prompt: 'Claude turn' }); f.finish('claude');
  await f.manager.send('codex', { sessionId: first.sessionId, prompt: 'Codex turn' }); f.finish('codex');
  await f.manager.send('kimi', { sessionId: first.sessionId, prompt: 'Kimi turn' }); f.finish('kimi');
  const expected = ['claude', 'claude', 'codex', 'codex', 'kimi', 'kimi'];
  assert.deepEqual(f.manager.load('kimi', first.sessionId).messages.map(message => message.engine), expected);
  assert.deepEqual(f.restart().load('kimi', first.sessionId).messages.map(message => message.engine), expected);
});
test('Markdown handoff is generated by the source and a fresh target gets it automatically', async t => {
  const f = fixture(t);
  const first = await f.manager.send('claude', { prompt: 'Build an experiment' }); f.finish('claude');
  const switching = f.manager.switchEngine(first.sessionId, 'kimi', 'markdown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.at(-1).engine, 'claude'); assert.match(f.sent.at(-1).prompt, /self-contained Markdown/);
  f.finish('claude', 'success', '## Goal\nBuild an experiment\n## Next\nValidate it.');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.at(-1).engine, 'kimi'); assert.equal(f.sent.at(-1).opts.sessionId, null);
  assert.match(f.sent.at(-1).prompt, /Validate it/); f.finish('kimi'); await switching;
  const c = f.manager.get(first.sessionId); assert.equal(c.handoffs[0].status, 'complete');
  assert.match(fs.readFileSync(c.handoffs[0].file, 'utf8'), /Validate it/);
  assert.equal(f.manager.messages(c).filter(m => m.role === 'user').length, 1);
  assert.equal(f.restart().load('dsh', first.sessionId).origin, 'claude');
});
test('a working conversation locks its harness while other conversations run concurrently', async t => {
  const f = fixture(t), a = await f.manager.send('codex', { prompt: 'Work A' });
  await assert.rejects(f.manager.send('dsh', { sessionId: a.sessionId, prompt: 'race' }), /Wait/);
  await assert.rejects(f.manager.switchEngine(a.sessionId, 'dsh'), /Wait/);
  const b = await f.manager.send('codex', { prompt: 'Work B' });
  const c = await f.manager.send('dsh', { prompt: 'Work C' });
  assert.equal(f.manager.active.size, 3);
  assert.equal(f.manager.get(a.sessionId).currentEngine, 'codex');
  assert.equal(f.sent[0].session.running, true);
  const result = await f.manager.command('codex', 'cancel', { sessionId: b.sessionId, runId: b.runId });
  assert.equal(result.ok, true);
  assert.equal(f.manager.active.size, 2);
  assert.equal(f.sent[0].session.running, true);
  assert.equal(f.sent[2].session.running, true);
  assert.equal(f.manager.messages(f.manager.get(b.sessionId)).at(-1).text, 'Stopped');
  f.finish('codex', 'success', 'A finished', f.sent[0].session);
  await f.manager.switchEngine(a.sessionId, 'kimi');
  assert.equal(f.manager.get(a.sessionId).currentEngine, 'kimi');
  assert.equal(f.manager.active.has(c.sessionId), true);
});

test('failed handoff keeps source selected and never starts the target', async t => {
  const f = fixture(t); const first = await f.manager.send('claude', { prompt: 'work' }); f.finish('claude');
  const switching = f.manager.switchEngine(first.sessionId, 'dsh', 'markdown');
  const rejected = assert.rejects(switching, /handoff failed/);
  await new Promise(resolve => setImmediate(resolve)); f.finish('claude', 'error', 'Network error'); await rejected;
  assert.equal(f.manager.get(first.sessionId).currentEngine, 'claude'); assert.equal(f.sent.some(s => s.engine === 'dsh'), false);
});
test('long history is never silently truncated; restart does not replay an ambiguous request', async t => {
  const f = fixture(t); const first = await f.manager.send('claude', { prompt: 'x'.repeat(25000) }); f.finish('claude');
  await f.manager.send('kimi', { sessionId: first.sessionId, prompt: 'next' });
  assert.ok(f.sent.at(-1).prompt.includes('x'.repeat(25000)));
  const count = f.sent.length, restarted = f.restart();
  assert.equal(restarted.get(first.sessionId).interrupted, true); assert.equal(f.sent.length, count);
});
test('failed target initialization restores an existing native mapping and preserves the Markdown', async t => {
  const f = fixture(t); const first = await f.manager.send('kimi', { prompt: 'work' }); f.finish('kimi');
  const original = { ...f.manager.get(first.sessionId).segments.kimi };
  await f.manager.send('claude', { sessionId: first.sessionId, prompt: 'review' }); f.finish('claude');
  const switching = f.manager.switchEngine(first.sessionId, 'kimi', 'markdown');
  const rejected = assert.rejects(switching, /target engine/);
  await new Promise(resolve => setImmediate(resolve)); f.finish('claude', 'success', '## Summary\nA handoff.');
  await new Promise(resolve => setImmediate(resolve)); f.finish('kimi', 'error', 'rejected'); await rejected;
  const c = f.manager.get(first.sessionId);
  assert.deepEqual(c.segments.kimi, original); assert.equal(c.currentEngine, 'claude');
  assert.equal(c.handoffs[0].status, 'failed'); assert.ok(fs.existsSync(c.handoffs[0].file));
});
test('Markdown cancellation never starts the target and torn append recovery keeps the original tail', async t => {
  const f = fixture(t); const first = await f.manager.send('claude', { prompt: 'work' }); f.finish('claude');
  const switching = f.manager.switchEngine(first.sessionId, 'kimi', 'markdown');
  const rejected = assert.rejects(switching, /canceled/);
  await new Promise(resolve => setImmediate(resolve)); await f.manager.command('claude', 'cancel', { sessionId: first.sessionId }); await rejected;
  assert.equal(f.sent.some(s => s.engine === 'kimi'), false);
  const file = path.join(f.root, first.sessionId + '.jsonl'); fs.appendFileSync(file, '{"role":');
  const next = f.restart(); assert.equal(next.get(first.sessionId).interrupted, true);
  assert.ok(fs.readdirSync(f.root).some(name => name.includes('.torn-')));
  assert.equal(next.messages(next.get(first.sessionId)).length, 2);
});
test('shared session lists never inspect or import legacy native histories', async t => {
  const f = fixture(t);
  let reads = 0;
  for (const driver of Object.values(f.drivers)) driver.history = { list: async () => { reads++; throw new Error('Legacy format cannot be decoded'); } };
  assert.deepEqual((await f.manager.list('dsh')).sessions, []);
  const current = f.manager.create('dsh', null, 'Current conversation');
  for (const engine of ENGINES) assert.deepEqual((await f.manager.list(engine)).sessions.map(s => s.id), [current.id]);
  assert.equal(reads, 0);
  assert.deepEqual((await f.restart().list('dsh')).sessions.map(s => s.id), [current.id]);
});

test('a conversation keeps its API model across all engines, other conversations and restarts', async t => {
  const f = fixture(t);
  f.manager.saveSettings('claude', { model: 'api-model-a' });
  const first = await f.manager.send('claude', { prompt: 'Use model A for this task' }); f.finish('claude');
  f.manager.saveSettings('kimi', { model: 'api-model-b' });
  const second = await f.manager.send('kimi', { prompt: 'A separate task uses B' }); f.finish('kimi');
  for (const engine of ENGINES) {
    await f.manager.switchEngine(first.sessionId, engine);
    assert.equal(f.manager.settings(engine, first.sessionId).model, 'api-model-a');
    await f.manager.send(engine, { sessionId: first.sessionId, prompt: 'Continue A' });
    assert.equal(f.sent.at(-1).opts.settings.model, 'api-model-a'); f.finish(engine);
  }
  f.manager.saveSettings('dsh', { sessionId: first.sessionId, model: 'api-model-c' });
  const manager = f.restart();
  for (const engine of ENGINES) assert.equal(manager.settings(engine, first.sessionId).model, 'api-model-c');
  assert.equal(manager.settings('claude', second.sessionId).model, 'api-model-b');
  assert.equal(manager.settings('kimi').model, 'api-model-c', 'The last explicit choice is the new-session default');
  await manager.send('codex', { sessionId: first.sessionId, fork: true, prompt: 'Branch this work' });
  assert.equal(f.sent.at(-1).opts.settings.model, 'api-model-c'); f.finish('codex');
});

test('account models and per-engine permissions are retained without copying them to another engine', async t => {
  const f = fixture(t);
  let accountModel = 'account-original';
  f.drivers.codex.settings = () => ({ connection: 'subscription', model: accountModel, permissionMode: 'default' });
  f.drivers.codex.saveSettings = patch => { if (patch.model) accountModel = patch.model; return f.drivers.codex.settings(); };
  f.manager.saveSettings('claude', { model: 'api-original' });
  const first = await f.manager.send('claude', { prompt: 'Shared work' }); f.finish('claude');
  f.manager.saveSettings('claude', { sessionId: first.sessionId, permissionMode: 'plan', thinkingBudget: 'high' });
  await f.manager.send('codex', { sessionId: first.sessionId, prompt: 'Use the account' }); f.finish('codex');
  f.manager.saveSettings('codex', { sessionId: first.sessionId, model: 'account-picked' });
  accountModel = 'another-conversation';
  assert.equal(f.manager.settings('codex', first.sessionId).model, 'account-picked');
  assert.equal(f.manager.settings('codex', first.sessionId).permissionMode, 'default');
  assert.equal(f.manager.settings('claude', first.sessionId).model, 'api-original');
  assert.equal(f.manager.settings('claude', first.sessionId).permissionMode, 'plan');
  assert.equal(f.manager.settings('claude', first.sessionId).thinkingBudget, 'high');
  assert.equal(f.restart().settings('codex', first.sessionId).model, 'account-picked');
});

test('Kimi account selections stay in their conversation when the new-session default returns to API', async t => {
  const { kimiConnectionSettings, updateKimiConnectionSettings } = require('../src/engines/kimi-session');
  const f = fixture(t), config = { kimi: { connection: 'subscription', subscriptionModel: 'kimi-code/first', apiModel: 'api-model' }, kimiSessionConnections: {} };
  const ensure = f.drivers.kimi.ensure;
  f.drivers.kimi.settings = id => kimiConnectionSettings(config, id);
  f.drivers.kimi.saveSettings = patch => { config.kimi = updateKimiConnectionSettings(config, patch); return kimiConnectionSettings(config, patch.sessionId); };
  f.drivers.kimi.ensure = opts => {
    const session = ensure(opts); config.kimiSessionConnections[session.sessionId] = opts.settings.connection; return session;
  };
  const original = await f.manager.send('kimi', { prompt: 'Research using my account' }); f.finish('kimi');
  f.manager.saveSettings('kimi', { sessionId: original.sessionId, model: 'kimi-code/picked' });
  config.kimi = updateKimiConnectionSettings(config, { connection: 'api', model: 'api-model' });
  const second = await f.manager.send('kimi', { prompt: 'Separate work through the API' }); f.finish('kimi');
  await f.manager.switchEngine(original.sessionId, 'claude');
  assert.equal(f.manager.settings('claude', original.sessionId).model, 'fixture');
  await f.manager.switchEngine(original.sessionId, 'kimi');
  assert.equal(f.manager.settings('kimi', original.sessionId).connection, 'subscription');
  assert.equal(f.manager.settings('kimi', original.sessionId).model, 'kimi-code/picked');
  assert.equal(f.restart().settings('kimi', second.sessionId).connection, 'api');
  assert.equal(f.manager.settings('kimi', second.sessionId).model, 'api-model');
});

test('picking an API route model in a subscription conversation switches connection on a fresh native session', async t => {
  const { kimiConnectionSettings, updateKimiConnectionSettings } = require('../src/engines/kimi-session');
  const f = fixture(t), config = { kimi: { connection: 'subscription', subscriptionModel: 'kimi-code/first', apiModel: 'api-model' }, kimiSessionConnections: {} };
  const ensure = f.drivers.kimi.ensure;
  f.drivers.kimi.settings = id => kimiConnectionSettings(config, id);
  f.drivers.kimi.saveSettings = patch => { config.kimi = updateKimiConnectionSettings(config, patch); return kimiConnectionSettings(config, patch.sessionId); };
  f.drivers.kimi.ensure = opts => {
    const session = ensure(opts); config.kimiSessionConnections[session.sessionId] = opts.settings.connection; return session;
  };
  const first = await f.manager.send('kimi', { prompt: 'Account turn' }); f.finish('kimi');
  const nativeBefore = f.manager.get(first.sessionId).segments.kimi.nativeId;
  f.manager.saveSettings('kimi', { sessionId: first.sessionId, connection: 'api', model: 'kimi-k2.5' });
  assert.equal(f.manager.settings('kimi', first.sessionId).connection, 'api');
  assert.equal(f.manager.settings('kimi', first.sessionId).model, 'kimi-k2.5');
  await f.manager.send('kimi', { sessionId: first.sessionId, prompt: 'API turn' });
  const segment = f.manager.get(first.sessionId).segments.kimi;
  assert.notEqual(segment.nativeId, nativeBefore);
  assert.equal(config.kimiSessionConnections[segment.nativeId], 'api');
  assert.match(f.sent.at(-1).prompt, /Conversation context[\s\S]*Account turn/);
  f.finish('kimi');
  f.manager.saveSettings('kimi', { sessionId: first.sessionId, connection: 'subscription', model: 'kimi-code/first' });
  await f.manager.send('kimi', { sessionId: first.sessionId, prompt: 'Back on account' });
  const back = f.manager.get(first.sessionId).segments.kimi;
  assert.notEqual(back.nativeId, segment.nativeId);
  assert.equal(config.kimiSessionConnections[back.nativeId], 'subscription');
  f.finish('kimi');
});

test('archived conversations cannot be loaded back into the chat surface', async t => {
  const f = fixture(t);
  const run = await f.manager.send('kimi', { prompt: 'One' }); f.finish('kimi');
  assert.equal(f.manager.load('kimi', run.sessionId).ok, true);
  await f.manager.command('kimi', 'archive-session', { id: run.sessionId, archived: true });
  const res = f.manager.load('kimi', run.sessionId);
  assert.equal(res.ok, false); assert.match(res.error, /archived/);
  await f.manager.command('kimi', 'archive-session', { id: run.sessionId, archived: false });
  assert.equal(f.manager.load('kimi', run.sessionId).ok, true);
});

test('compact summarizes once, defers the fresh native session, and re-fires on later context overflow', async t => {
  const f = fixture(t);
  const waitFor = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setImmediate(r)); };
  const first = await f.manager.send('kimi', { prompt: 'Long work' }); f.finish('kimi');
  const nativeBefore = f.manager.get(first.sessionId).segments.kimi.nativeId;
  const compacting = f.manager.command('kimi', 'compact', { sessionId: first.sessionId });
  await waitFor(() => /compact working context/.test(f.sent.at(-1)?.prompt || ''));
  assert.equal(f.sent.at(-1).opts.sessionId, null);
  f.finish('kimi', 'success', '## Summary Long work in progress');
  const res = await compacting;
  assert.equal(res.ok, true);
  const c = f.manager.get(first.sessionId);
  assert.equal(c.segments.kimi.nativeId, undefined);
  assert.equal(c.segments.kimi.cursor, c.seq);
  assert.ok(c.retiredSegments.some(s => s.nativeId === nativeBefore));
  assert.ok(f.manager.messages(c).some(m => m.role === 'notice' && /Context compacted/.test(m.text)));

  await f.manager.send('kimi', { sessionId: first.sessionId, prompt: 'continue' });
  assert.match(f.sent.at(-1).prompt, /Summary Long work in progress/);
  f.finish('kimi', 'error', 'Request failed: context_length_exceeded, maximum context length reached');
  await waitFor(() => /compact working context/.test(f.sent.at(-1)?.prompt || ''));
  f.finish('kimi', 'success', '## Summary shrunk');
  await waitFor(() => f.manager.messages(f.manager.get(first.sessionId)).some(m => m.role === 'notice' && /compacted automatically/.test(m.text)));
  assert.ok(f.manager.messages(f.manager.get(first.sessionId)).some(m => m.role === 'notice' && /compacted automatically/.test(m.text)));
  await f.flush();
  assert.match(f.sent.at(-1).prompt, /Continue the unfinished user task/);
  f.finish('kimi');

  await f.manager.send('kimi', { sessionId: first.sessionId, prompt: 'again' }); f.finish('kimi');
  await f.manager.send('kimi', { sessionId: first.sessionId, prompt: 'again2' });
  f.finish('kimi', 'error', 'context_length_exceeded');
  await waitFor(() => /compact working context/.test(f.sent.at(-1)?.prompt || ''));
  f.finish('kimi', 'success', '## Summary again');
  await waitFor(() => f.manager.messages(f.manager.get(first.sessionId)).filter(m => m.role === 'notice' && /compacted automatically/.test(m.text)).length === 2);
  assert.equal(f.manager.messages(f.manager.get(first.sessionId)).filter(m => m.role === 'notice' && /compacted automatically/.test(m.text)).length, 2);
  await f.flush(); f.finish('kimi');
});

test('manual compaction after an overflow abandons the full native session and includes its logical history', async t => {
  const f = fixture(t);
  const first = await f.manager.send('kimi', { prompt: 'Remember UNIQUE_EARLY_CONTEXT' });
  f.finish('kimi', 'success', 'Early work complete');
  const nativeBefore = f.manager.get(first.sessionId).segments.kimi.nativeId;
  await f.manager.send('kimi', { sessionId: first.sessionId, prompt: 'Continue after a long pause' });
  f.finish('kimi', 'error', 'context_length_exceeded');
  await f.flush();

  const automatic = f.sent.at(-1);
  assert.equal(automatic.opts.sessionId, null);
  assert.match(automatic.prompt, /UNIQUE_EARLY_CONTEXT/);
  f.finish('kimi', 'error', 'Compaction interrupted');
  await f.flush();

  const compacting = f.manager.command('kimi', 'compact', { sessionId: first.sessionId });
  await f.flush();
  const manual = f.sent.at(-1);
  assert.equal(manual.opts.sessionId, null);
  assert.match(manual.prompt, /UNIQUE_EARLY_CONTEXT/);
  assert.notEqual(manual.session.sessionId, nativeBefore);
  f.finish('kimi', 'success', 'Recovered compact summary');
  assert.equal((await compacting).ok, true);
});

test('an in-progress compaction can be stopped without replacing the native session', async t => {
  const f = fixture(t);
  const first = await f.manager.send('kimi', { prompt: 'Long work' }); f.finish('kimi');
  const nativeBefore = f.manager.get(first.sessionId).segments.kimi.nativeId;
  const compacting = f.manager.command('kimi', 'compact', { sessionId: first.sessionId });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.manager.activity(first.sessionId), 'running');
  await f.manager.cancel({ sessionId: first.sessionId });
  f.finish('kimi', 'success', 'Summary that must not be committed');
  await assert.rejects(compacting, /canceled/);
  assert.equal(f.manager.get(first.sessionId).segments.kimi.nativeId, nativeBefore);
  assert.equal(f.manager.activity(first.sessionId), null);
});

test('switching to a shorter window pre-compacts instead of failing on the provider', async t => {
  const f = fixture(t);
  f.manager.modelContextWindow = () => 8000;
  const c = f.manager.create('claude', null, 'Long conversation');
  f.manager.append(c, { role: 'user', text: 'Task' });
  f.manager.append(c, { role: 'tool', text: 'WORK_' + 'a'.repeat(30000) });
  f.manager.append(c, { role: 'assistant', text: 'Done' });
  f.manager.save(c);
  const pending = f.manager.send('claude', { sessionId: c.id, prompt: 'Next' });
  await f.flush();
  while (/compact working context/.test(f.sent.at(-1).prompt)) {
    f.finish('claude', 'success', 'SUMMARY of earlier work');
    await f.flush();
  }
  f.finish('claude', 'success', 'Acknowledged');
  const run = await pending;
  assert.equal(run.ok, true);
  const sent = f.sent.at(-1).prompt;
  assert.match(sent, /Next/);
  assert.doesNotMatch(sent, /WORK_|Conversation context/);
  f.finish('claude');
});

test('stopping ordinary pre-send compaction never sends the pending task on any engine', async t => {
  for (const engine of ENGINES) {
    const f = fixture(t, { modelContextWindow: () => 20000 });
    const first = await f.manager.send(engine, { prompt: 'Earlier task' });
    f.finish(engine);
    const conversation = f.manager.get(first.sessionId);
    f.manager.append(conversation, { role: 'tool', text: 'x'.repeat(52000) });
    const nativeId = conversation.segments[engine].nativeId;
    const sending = f.manager.send(engine, { sessionId: conversation.id, prompt: 'Do not run after stop' });
    const rejected = assert.rejects(sending, /canceled/);
    await f.flush();
    assert.match(f.sent.at(-1).prompt, /compact working context/);
    await f.manager.cancel({ sessionId: conversation.id });
    await rejected;
    await f.flush();
    assert.equal(f.sent.length, 2);
    assert.equal(conversation.segments[engine].nativeId, nativeId);
    assert.equal(f.manager.busy(conversation.id), false);
    assert.equal(f.manager.messages(conversation).some(row => row.text === 'Do not run after stop' || row.file), false);
    assert.equal(f.events.filter(event => event.type === 'conversation:started').length, 1);
  }
});

test('stopping pre-send compaction during setup sends neither summary nor task', async t => {
  const f = fixture(t, { modelContextWindow: () => 20000 });
  const conversation = f.manager.create('codex', null, 'Pending setup');
  f.manager.append(conversation, { role: 'tool', text: 'x'.repeat(52000) });
  let release;
  f.manager.prepare = () => new Promise(resolve => { release = resolve; });
  const rejected = assert.rejects(f.manager.send('codex', { sessionId: conversation.id, prompt: 'Do not run' }), /canceled/);
  await f.manager.cancel({ sessionId: conversation.id });
  release();
  await rejected;
  assert.equal(f.sent.length, 0);
  assert.equal(f.manager.busy(conversation.id), false);
});

test('stopping a later summary chunk discards partial compaction and the pending task', async t => {
  const f = fixture(t, { modelContextWindow: () => 20000 });
  const conversation = f.manager.create('kimi', null, 'Chunked history');
  f.manager.append(conversation, { role: 'tool', text: 'x'.repeat(100000) });
  const rejected = assert.rejects(f.manager.send('kimi', { sessionId: conversation.id, prompt: 'Do not run' }), /canceled/);
  await f.flush();
  f.finish('kimi', 'success', 'Partial summary');
  await f.flush();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent.at(-1).prompt, /Partial summary/);
  await f.manager.cancel({ sessionId: conversation.id });
  await rejected;
  assert.equal(f.sent.length, 2);
  assert.equal(f.manager.messages(conversation).some(row => row.file), false);
  assert.equal(f.manager.busy(conversation.id), false);
});

test('failed pre-send compaction rejects the task instead of sending oversized history', async t => {
  const f = fixture(t, { modelContextWindow: () => 20000 });
  const conversation = f.manager.create('dsh', null, 'Failed summary');
  f.manager.append(conversation, { role: 'tool', text: 'x'.repeat(52000) });
  const rejected = assert.rejects(f.manager.send('dsh', { sessionId: conversation.id, prompt: 'Do not run' }), /Provider unavailable/);
  await f.flush();
  f.finish('dsh', 'error', 'Provider unavailable');
  await rejected;
  assert.equal(f.sent.length, 1);
  assert.equal(f.manager.busy(conversation.id), false);
  assert.equal(f.manager.messages(conversation).some(row => row.role === 'user' || row.file), false);
});

test('a conversation under its window cap sends without pre-compaction', async t => {
  const f = fixture(t);
  f.manager.modelContextWindow = () => 8000;
  const first = await f.manager.send('claude', { prompt: 'Small question' });
  f.finish('claude');
  assert.equal(f.sent.length, 1);
  const again = await f.manager.send('claude', { sessionId: first.sessionId, prompt: 'Another small question' });
  f.finish('claude');
  assert.equal(f.sent.length, 2);
  assert.doesNotMatch(f.sent.at(-1).prompt, /compact working context/);
});

test('the estimate follows the compaction summary, and an explicit contextWindow wins over the catalog', async t => {
  const f = fixture(t);
  const c = f.manager.create('claude', null, 'Estimate');
  f.manager.append(c, { role: 'tool', text: 'x'.repeat(30000) });
  f.manager.save(c);
  const full = f.manager.estimateTokens(c);
  assert.ok(full > 9000);
  f.manager.append(c, { role: 'notice', text: 'Context compacted: summary saved', file: path.join(f.root, 'summary.md') });
  fs.writeFileSync(path.join(f.root, 'summary.md'), 'short summary');
  f.manager.save(c);
  const shrunk = f.manager.estimateTokens(c);
  assert.ok(shrunk < full / 10);
  let catalogCalls = 0;
  f.manager.modelContextWindow = () => { catalogCalls++; return 99999; };
  const settings = f.manager.settings('claude', c.id);
  settings.contextWindow = 5000;
  assert.equal(f.manager.contextCap('claude', settings), 5000);
  assert.equal(catalogCalls, 0);
  delete settings.contextWindow;
  assert.equal(f.manager.contextCap('claude', settings), 99999);
  f.manager.modelContextWindow = () => undefined;
  assert.equal(f.manager.contextCap('claude', settings), 200000);
});

test('all engines compact at tool boundaries and resume the same logical turn without duplicating the user request', async t => {
  for (const engine of ENGINES) {
    const f = fixture(t, { modelContextWindow: () => 20000 });
    const run = await f.manager.send(engine, { prompt: 'Finish the original task', attachments: [{ path: 'input.txt' }] });
    const original = f.sent.at(-1).session;
    const emit = event => f.manager.capture(engine, { ...event, runId: original.gen });
    emit({ type: 'gui:tool', id: 'write', status: 'in_progress', output: 'x'.repeat(52000) });
    assert.equal(f.manager.recovering.size, 0);
    emit({ type: 'gui:tool', id: 'write', status: 'completed', output: 'File written successfully' });
    assert.equal(f.manager.recovering.has(run.sessionId), true);
    assert.equal(f.manager.busy(run.sessionId), true);
    assert.equal(f.manager.live(engine, run.sessionId).live.runId, run.runId);
    assert.equal(f.events.filter(event => event.type === 'result').length, 0);
    await f.flush();
    let chunks = 0;
    while (/compact working context/.test(f.sent.at(-1).prompt)) {
      assert.ok(f.sent.at(-1).prompt.length <= 36000);
      assert.equal(f.sent.at(-1).opts.sessionId, null);
      assert.ok(++chunks < 10);
      f.finish(engine, 'success', 'Summary: original task; file already written. Next: verify.');
      await f.flush();
    }
    assert.ok(chunks >= 2);
    assert.match(f.sent.at(-1).prompt, /file already written/);
    assert.match(f.sent.at(-1).prompt, /Do not restart or repeat completed actions/);
    assert.notEqual(f.sent.at(-1).session.sessionId, original.sessionId);
    assert.equal(f.manager.active.get(run.sessionId).facade.gen, run.runId);
    assert.equal(f.events.filter(event => event.type === 'conversation:started').length, 1);
    assert.equal(f.manager.messages(f.manager.get(run.sessionId)).filter(row => row.role === 'user').length, 1);
    assert.equal(emit({ type: 'result', subtype: 'success', result: 'Stale native result' }), false);
    f.finish(engine, 'success', 'Verified and done');
    assert.equal((await run.done).result, 'Verified and done');
    assert.equal(f.events.filter(event => event.type === 'result').length, 1);
    assert.equal(f.manager.busy(run.sessionId), false);
  }
});

test('parallel Claude tools and pending approvals delay proactive compaction', async t => {
  const f = fixture(t, { modelContextWindow: () => 20000 });
  const run = await f.manager.send('claude', { prompt: 'Work' });
  const emit = event => f.manager.capture('claude', { ...event, runId: f.sent.at(-1).session.gen });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'first' }, { type: 'tool_use', id: 'second' }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'first', content: 'x'.repeat(52000) }] } });
  assert.equal(f.manager.recovering.size, 0);
  emit({ type: 'gui:permission', requestId: 'approval' });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'second', content: 'Done' }] } });
  assert.equal(f.manager.recovering.size, 0);
  await f.manager.cancel({ sessionId: run.sessionId, runId: run.runId });
  assert.equal((await run.done).subtype, 'stopped');
});

test('automatic compaction waits for native stop acknowledgement and a user stop prevents recovery', async t => {
  for (const stopByUser of [false, true]) {
    const f = fixture(t, { modelContextWindow: () => 20000 });
    const run = await f.manager.send('codex', { prompt: 'Finish the task' });
    const original = f.sent.at(-1).session;
    let interrupts = 0;
    original.interrupt = () => { interrupts++; };
    f.manager.capture('codex', { type: 'gui:tool', id: 'tool', status: 'completed', output: 'x'.repeat(52000), runId: original.gen });
    await f.flush();
    assert.equal(interrupts, 1);
    assert.equal(f.sent.length, 1);
    assert.equal(f.manager.busy(run.sessionId), true);
    if (stopByUser) await f.manager.cancel({ sessionId: run.sessionId, runId: run.runId });
    f.finish('codex', 'stopped', 'Stopped', original);
    await f.flush();
    if (stopByUser) {
      assert.equal((await run.done).subtype, 'stopped');
      assert.equal(f.sent.length, 1);
    } else {
      assert.match(f.sent.at(-1).prompt, /compact working context/);
      while (/compact working context/.test(f.sent.at(-1).prompt)) {
        f.finish('codex', 'success', 'Tool finished. Verify next.');
        await f.flush();
      }
      f.finish('codex', 'success', 'Verified');
      assert.equal((await run.done).result, 'Verified');
    }
    assert.equal(f.events.filter(event => event.type === 'result').length, 1);
    assert.equal(f.manager.busy(run.sessionId), false);
  }
});

test('overflow retries once without progress, and the original done promise waits for recovery', async t => {
  const f = fixture(t), run = await f.manager.send('kimi', { prompt: 'Finish' });
  let settled = false; run.done.then(() => { settled = true; });
  f.finish('kimi', 'error', 'context_length_exceeded');
  await f.flush();
  assert.equal(settled, false);
  f.finish('kimi', 'success', 'Compact summary');
  await f.flush();
  f.finish('kimi', 'error', 'context_length_exceeded');
  assert.equal((await run.done).is_error, true);
  await f.flush();
  assert.equal(f.sent.length, 3);
  assert.equal(f.manager.busy(run.sessionId), false);
});

test('stopping automatic compaction preserves history and never resumes the task', async t => {
  const f = fixture(t), run = await f.manager.send('codex', { prompt: 'Original task' });
  const nativeId = f.sent.at(-1).session.sessionId;
  f.finish('codex', 'error', 'maximum context length exceeded');
  await f.flush();
  assert.equal(f.manager.live('codex', run.sessionId).live.runId, run.runId);
  await f.manager.cancel({ sessionId: run.sessionId, runId: run.runId });
  assert.equal((await run.done).subtype, 'stopped');
  await f.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(f.manager.get(run.sessionId).segments.codex.nativeId, nativeId);
  assert.equal(f.manager.busy(run.sessionId), false);
  assert.equal(f.manager.messages(f.manager.get(run.sessionId)).filter(row => row.file).length, 0);
});

test('summary failure surfaces a terminal error without replaying the original task', async t => {
  const f = fixture(t), run = await f.manager.send('dsh', { prompt: 'Original task' });
  f.finish('dsh', 'error', 'too many tokens');
  await f.flush();
  f.finish('dsh', 'error', 'Provider unavailable');
  assert.match((await run.done).result, /Context recovery failed.*Provider unavailable/);
  await f.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(f.manager.busy(run.sessionId), false);
});

test('goal overflow compacts and continues without advancing goal rounds or losing ownership', async t => {
  const f = fixture(t);
  const { sessionId } = await f.manager.command('claude', 'goal-start', { objective: 'Finish the experiment' });
  f.goal.drive(); await f.flush();
  const facade = f.manager.facades.get(sessionId);
  f.finish('claude', 'error', 'context_length_exceeded');
  await f.flush();
  assert.equal(f.goal.timer, null);
  assert.equal(f.goal.ownedSession(), facade);
  f.finish('claude', 'success', 'Summary of the experiment');
  await f.flush();
  assert.match(f.sent.at(-1).prompt, /<goal:complete>/);
  assert.equal(f.goal.goal.roundsStarted, 1);
  assert.equal(f.goal.ownedSession(), facade);
  f.finish('claude', 'success', 'More work remains');
  assert.equal(f.goal.goal.phase, 'active');
  assert.equal(f.goal.goal.errorStreak, 0);
  assert.notEqual(f.goal.timer, null);
});

test('goal pause during recovery cancels summarization and does not resume', async t => {
  const f = fixture(t);
  const { sessionId } = await f.manager.command('kimi', 'goal-start', { objective: 'Finish' });
  f.goal.drive(); await f.flush();
  f.finish('kimi', 'error', 'context_length_exceeded');
  await f.flush();
  await f.manager.command('kimi', 'goal-pause', { sessionId });
  await f.flush();
  assert.equal(f.goal.goal.phase, 'paused');
  assert.equal(f.sent.length, 2);
  assert.equal(f.manager.busy(sessionId), false);
});

test('goal rounds pre-compact oversized history and rebuild the goal prompt from the summary', async t => {
  const f = fixture(t, { modelContextWindow: () => 20000 });
  const { sessionId } = await f.manager.command('claude', 'goal-start', { objective: 'Finish the experiment' });
  f.goal.cancelTimer();
  const conversation = f.manager.get(sessionId);
  f.manager.append(conversation, { role: 'tool', text: 'OLD_CONTEXT_' + 'x'.repeat(52000) });
  f.manager.save(conversation);
  f.goal.drive(); await f.flush();
  while (/compact working context/.test(f.sent.at(-1).prompt)) {
    f.finish('claude', 'success', 'Summary: experiment in progress'); await f.flush();
  }
  assert.match(f.sent.at(-1).prompt, /Summary: experiment/);
  assert.match(f.sent.at(-1).prompt, /<goal:complete>/);
  assert.doesNotMatch(f.sent.at(-1).prompt, /OLD_CONTEXT_/);
  f.finish('claude', 'success', 'Progress');
  assert.equal(f.goal.goal.phase, 'active');
  assert.notEqual(f.goal.timer, null);
});

test('pausing a goal during pre-send compaction never sends the goal request', async t => {
  const f = fixture(t, { modelContextWindow: () => 20000 });
  const { sessionId } = await f.manager.command('claude', 'goal-start', { objective: 'Finish' });
  f.goal.cancelTimer();
  const conversation = f.manager.get(sessionId);
  f.manager.append(conversation, { role: 'tool', text: 'x'.repeat(52000) });
  f.goal.drive(); await f.flush();
  await f.manager.command('claude', 'goal-pause', { sessionId });
  await f.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.goal.goal.phase, 'paused');
  assert.equal(f.manager.busy(sessionId), false);
});

test('summary failure before a goal round blocks the goal without starting its task', async t => {
  const f = fixture(t, { modelContextWindow: () => 20000 });
  const { sessionId } = await f.manager.command('claude', 'goal-start', { objective: 'Finish' });
  f.goal.cancelTimer();
  f.manager.append(f.manager.get(sessionId), { role: 'tool', text: 'x'.repeat(52000) });
  f.goal.drive(); await f.flush();
  f.finish('claude', 'error', 'Summary unavailable');
  await f.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.goal.goal.phase, 'blocked');
  assert.equal(f.goal.timer, null);
  assert.equal(f.manager.busy(sessionId), false);
});

test('continuation setup failure finishes once and releases the conversation', async t => {
  const f = fixture(t), run = await f.manager.send('dsh', { prompt: 'Finish' });
  f.finish('dsh', 'error', 'context_length_exceeded'); await f.flush();
  f.manager.prepare = async () => { throw new Error('Engine unavailable'); };
  f.finish('dsh', 'success', 'Summary');
  assert.equal((await run.done).is_error, true);
  await f.flush();
  assert.equal(f.events.filter(event => event.type === 'result').length, 1);
  assert.equal(f.manager.busy(run.sessionId), false);
});

test('permissions and live snapshots are addressed by conversation and run, including duplicate request IDs', async t => {
  const f = fixture(t);
  const a = await f.manager.send('kimi', { prompt: 'private A' }), sa = f.sent.at(-1).session;
  const b = await f.manager.send('kimi', { prompt: 'private B' }), sb = f.sent.at(-1).session;
  for (const session of [sa, sb]) f.manager.capture('kimi', { type: 'gui:permission', requestId: 'same-id', runId: session.gen });
  let listed = await f.manager.list('kimi');
  assert.equal(listed.sessions.filter(s => s.activity === 'permission').length, 2);
  assert.equal(f.manager.live('kimi').live, null, 'no implicit global active session');
  assert.equal(f.manager.load('kimi', a.sessionId).live.prompt, 'private A');
  assert.equal(f.manager.live('kimi', b.sessionId).live.prompt, 'private B');
  const answer = { sessionId: a.sessionId, runId: a.runId, requestId: 'same-id', allow: false };
  assert.equal((await f.manager.command('kimi', 'control-respond', { ...answer, runId: b.runId })).ok, false);
  assert.equal((await f.manager.command('kimi', 'control-respond', answer)).ok, true);
  assert.equal(sa.permissions[1], false);
  assert.equal(sb.permissions, undefined);
  assert.equal(f.manager.live('kimi', a.sessionId).live.events.filter(e => e.type === 'gui:permission').length, 0);
  assert.equal(f.manager.live('kimi', b.sessionId).live.events.filter(e => e.type === 'gui:permission').length, 1);
  f.finish('kimi', 'success', 'only B', sb);
  assert.equal(f.manager.active.has(a.sessionId), true);
  f.finish('kimi', 'success', 'only A', sa);
  for (const [run, text] of [[a, 'only A'], [b, 'only B']]) assert.equal(f.manager.messages(f.manager.get(run.sessionId)).at(-1).text, text);
  assert.equal((await f.manager.command('kimi', 'cancel', answer)).ok, false, 'late stop cannot stop a later turn');
});

test('startup reservations, failures and stop affect only their conversation', async t => {
  const f = fixture(t), a = f.manager.create('claude', null, 'A'), b = f.manager.create('claude', null, 'B');
  let release; f.manager.prepare = () => new Promise(resolve => { release = resolve; });
  const starting = f.manager.send('claude', { sessionId: a.id, prompt: 'A' });
  await assert.rejects(f.manager.send('claude', { sessionId: a.id, prompt: 'duplicate' }), /Wait/);
  await assert.rejects(f.manager.switchEngine(a.id, 'kimi'), /Wait/);
  await f.manager.command('claude', 'cancel', { sessionId: a.id });
  f.manager.prepare = async () => {};
  await f.manager.send('claude', { sessionId: b.id, prompt: 'B' });
  release(); assert.equal((await (await starting).done).subtype, 'stopped');
  assert.equal(f.manager.active.has(b.id), true);
  assert.equal(f.sent.length, 1);
  assert.throws(() => f.manager.saveSettings('claude', { sessionId: b.id, model: 'changed' }), /Wait/);
  f.manager.saveSettings('claude', { sessionId: a.id, model: 'other' });
  assert.equal(f.manager.active.get(b.id).session.opts.settings.model, 'fixture');
});

test('questions use an input-needed state while approvals remain distinct and answers stay in their conversation', async t => {
  const f = fixture(t);
  const a = await f.manager.send('claude', { prompt: 'A' }), sa = f.sent.at(-1).session;
  const b = await f.manager.send('claude', { prompt: 'B' }), sb = f.sent.at(-1).session;
  f.manager.capture('claude', { type: 'gui:permission', requestId: 'same-id', runId: sa.gen, questions: [{ id: 'scope', question: 'Scope?' }] });
  f.manager.capture('claude', { type: 'gui:permission', requestId: 'same-id', runId: sb.gen, toolName: 'Bash' });
  assert.equal(f.manager.activity(a.sessionId), 'question'); assert.equal(f.manager.activity(b.sessionId), 'permission');
  assert.equal(f.manager.load('claude', a.sessionId).live.events.at(-1).questions[0].question, 'Scope?');
  const input = { scope: 'Only the main workflow' };
  assert.equal((await f.manager.command('claude', 'control-respond', { sessionId: a.sessionId, runId: b.runId, requestId: 'same-id', allow: true, input })).ok, false);
  assert.equal((await f.manager.command('claude', 'control-respond', { sessionId: a.sessionId, runId: a.runId, requestId: 'same-id', allow: true, input })).ok, true);
  assert.deepEqual(sa.permissions[2], input); assert.equal(sb.permissions, undefined);
  assert.equal(f.manager.activity(a.sessionId), 'running'); assert.equal(f.manager.activity(b.sessionId), 'permission');
  assert.equal(f.manager.live('claude', a.sessionId).live.events.some(e => e.type === 'gui:permission'), false);
  f.finish('claude', 'success', 'A done', sa); f.finish('claude', 'success', 'B done', sb);
});

test('two goals and an ordinary conversation progress independently on one engine', async t => {
  const f = fixture(t);
  const first = await f.manager.command('claude', 'goal-start', { objective: 'Goal A' });
  const second = await f.manager.command('claude', 'goal-start', { objective: 'Goal B' });
  const a = f.manager.goalFor(first.sessionId), b = f.manager.goalFor(second.sessionId);
  a.drive(); b.drive(); await new Promise(resolve => setImmediate(resolve));
  const sa = f.sent[0].session, sb = f.sent[1].session;
  const chat = await f.manager.send('claude', { prompt: 'Ordinary question' });
  assert.equal(f.manager.active.size, 3);
  f.finish('claude', 'success', 'A finished.\n<goal:complete>', sa);
  assert.equal(a.goal.phase, 'active'); assert.ok(a.goal.verifying);
  await f.flush();
  f.finish('claude', 'success', '<verify:pass> A verified');
  await f.flush();
  assert.equal(a.goal.phase, 'complete'); assert.equal(b.armed, true);
  f.finish('claude', 'success', 'B continues', sb);
  assert.ok(b.timer);
  await assert.rejects(f.manager.switchEngine(second.sessionId, 'kimi'), /Wait/, 'goal is working even between turns');
  await f.manager.command('claude', 'goal-pause', { sessionId: second.sessionId });
  assert.equal(b.armed, false); assert.equal(f.manager.active.has(chat.sessionId), true);
  const restored = f.restart();
  assert.equal(restored.goalFor(first.sessionId).goal.phase, 'complete');
  assert.equal(restored.goalFor(second.sessionId).goal.phase, 'paused');
  assert.equal(restored.isBusy(), false);
});

test('late events from a previous native turn cannot finish a conversation during fresh setup', async t => {
  const f = fixture(t), first = await f.manager.send('claude', { prompt: 'First turn' });
  const old = f.sent.at(-1).session; f.finish('claude');
  let release; f.manager.prepare = () => new Promise(resolve => { release = resolve; });
  const pending = f.manager.send('claude', { sessionId: first.sessionId, prompt: 'Next turn' });
  assert.equal(f.manager.capture('claude', { type: 'result', subtype: 'success', conversationId: first.sessionId, runId: old.gen, result: 'Late old reply' }), false);
  assert.equal(f.manager.active.has(first.sessionId), true);
  release(); const next = await pending;
  f.finish('claude', 'success', 'New reply');
  assert.equal((await next.done).result, 'New reply');
  assert.ok(!f.manager.messages(f.manager.get(first.sessionId)).some(m => m.text === 'Late old reply'));
});
