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

async function nativeFixture(context, compact) {
  const harness = fixture(context);
  harness.drivers.codex.nativeCompaction = true;
  const ensure = harness.drivers.codex.ensure;
  harness.drivers.codex.ensure = options => {
    const session = ensure(options);
    session.compact = options => compact(session, options);
    return session;
  };
  const run = await harness.manager.send('codex', { prompt: 'Remember the original task' });
  harness.finish('codex'); await run.done;
  const conversation = harness.manager.get(run.sessionId);
  return { ...harness, conversation };
}

for (const engine of ['claude', 'kimi', 'dsh', 'antigravity']) test(engine + ' native automatic compaction owns same-session pressure without requiring a manual API', async context => {
  const harness = fixture(context), manager = harness.manager;
  harness.drivers[engine].nativeAutoCompaction = true;
  const first = await manager.send(engine, { prompt: 'Task' });
  harness.finish(engine); await first.done;
  const conversation = manager.get(first.sessionId);
  conversation.engineSettings[engine].contextWindow = 1000;
  manager.append(conversation, { role: 'tool', text: 'Old history '.repeat(1000) });
  conversation.segments[engine].cursor = conversation.seq;
  const next = await manager.send(engine, { sessionId: conversation.id, prompt: 'Continue' });
  const session = harness.sent.at(-1).session;
  manager.capture(engine, { type: 'gui:tool', id: 'read', status: 'completed', runId: session.gen });
  assert.equal(harness.sent.length, 2);
  assert.equal(manager.recovering.size, 0);
  harness.finish(engine); await next.done;
  conversation.engineSettings[engine].contextWindow = 200000;
  const manual = manager.compact(conversation.id);
  await harness.flush();
  assert.match(harness.sent.at(-1).prompt, /compact working context/);
  harness.finish(engine, 'success', 'Portable summary');
  assert.ok((await manual).file);
});

test('native manual compaction retains thread/history and resumes without replay even after restart', async context => {
  let complete;
  const harness = await nativeFixture(context, () => new Promise(resolve => { complete = resolve; }));
  const { manager, conversation } = harness;
  const nativeId = conversation.segments.codex.nativeId;
  const messages = manager.messages(conversation);
  const pending = manager.compact(conversation.id);
  await harness.flush();
  assert.equal(manager.busy(conversation.id), true);
  assert.equal(harness.sent.length, 1);
  assert.equal(manager.load('codex', conversation.id).compaction.state, 'running');
  complete({ ok: true });
  assert.equal((await pending).native, true);
  assert.equal(conversation.segments.codex.nativeId, nativeId);
  assert.equal(conversation.segments.codex.compactFile, undefined);
  assert.deepEqual(manager.messages(conversation).slice(0, messages.length), messages);
  const restarted = harness.restart();
  const run = await restarted.send('codex', { sessionId: conversation.id, prompt: 'Continue now' });
  assert.equal(harness.sent.at(-1).opts.sessionId, nativeId);
  assert.equal(harness.sent.at(-1).prompt, 'Continue now');
  harness.finish('codex'); await run.done;
});

test('native-owned context bypasses proactive thresholds but still shows native progress', async context => {
  const harness = await nativeFixture(context, async () => { throw new Error('Should not compact manually'); });
  const { manager, conversation } = harness;
  conversation.engineSettings.codex.contextWindow = 1000;
  manager.append(conversation, { role: 'tool', text: 'old'.repeat(4000) });
  conversation.segments.codex.cursor = conversation.seq;
  const run = await manager.send('codex', { sessionId: conversation.id, prompt: 'Continue' });
  const session = harness.sent.at(-1).session;
  manager.capture('codex', { type: 'gui:tool', id: 'tool', status: 'completed', runId: session.gen });
  assert.equal(harness.sent.length, 2);
  assert.equal(manager.recovering.size, 0);
  manager.capture('codex', { type: 'gui:compaction', state: 'running', runId: session.gen });
  assert.equal(manager.load('codex', conversation.id).compaction.state, 'running');
  manager.capture('codex', { type: 'gui:compaction', state: 'completed', runId: session.gen });
  assert.equal(manager.load('codex', conversation.id).compaction, null);
  assert.equal(manager.rows(conversation).at(-1).compaction.native, true);
  harness.finish('codex'); await run.done;
  assert.equal(harness.events.filter(event => event.type === 'result').length, 2);
});

test('native compaction failure and cancellation retain mappings without silent summary requests', async context => {
  for (const mode of ['failure', 'cancel']) {
    let started;
    const harness = await nativeFixture(context, session => {
      if (mode === 'failure') return Promise.reject(new Error('Provider unavailable'));
      return new Promise((resolve, reject) => { started = true; session.interrupt = () => reject(new Error('Canceled')); });
    });
    const { manager, conversation } = harness;
    const snapshot = JSON.stringify(conversation.segments);
    const done = manager.compact(conversation.id);
    const rejected = assert.rejects(done, mode === 'failure' ? /Provider unavailable/ : /Canceled/);
    await harness.flush();
    if (mode === 'cancel') { assert.ok(started); await manager.cancel({ sessionId: conversation.id }); }
    await rejected;
    assert.equal(JSON.stringify(conversation.segments), snapshot);
    assert.equal(harness.sent.length, 1);
    assert.equal(manager.busy(conversation.id), false);
    assert.equal(conversation.pending, null);
  }
});

test('unsupported native compaction falls back to portable summary', async context => {
  const harness = await nativeFixture(context, async () => { throw Object.assign(new Error('Unknown method'), { code: -32601 }); });
  const { manager, conversation } = harness;
  const done = manager.compact(conversation.id);
  await harness.flush();
  assert.match(harness.sent.at(-1).prompt, /compact working context/);
  harness.finish('codex', 'success', 'Keep the original task.');
  const result = await done;
  assert.ok(result.file);
  assert.equal(conversation.segments.codex.nativeCompactionUnsupported, true);
  assert.equal(conversation.segments.codex.nativeId, undefined);
});

test('native overflow recovery keeps one user turn and waits for the continued result', async context => {
  const harness = await nativeFixture(context, async () => ({ ok: true }));
  const { manager, conversation } = harness;
  const nativeId = conversation.segments.codex.nativeId;
  const run = await manager.send('codex', { sessionId: conversation.id, prompt: 'Finish the work' });
  harness.finish('codex', 'error', 'context_length_exceeded');
  await harness.flush();
  assert.equal(harness.sent.length, 3);
  assert.equal(harness.sent.at(-1).opts.sessionId, nativeId);
  assert.match(harness.sent.at(-1).prompt, /Continue the unfinished user task/);
  assert.equal(manager.messages(conversation).filter(row => row.role === 'user').length, 2);
  harness.finish('codex', 'success', 'Finished');
  assert.equal((await run.done).result, 'Finished');
});

test('pausing a goal during native overflow compaction interrupts it without advancing rounds', async context => {
  let interrupted = false;
  const harness = await nativeFixture(context, session => new Promise((resolve, reject) => {
    session.interrupt = () => { interrupted = true; reject(new Error('Canceled')); };
  }));
  const { manager, conversation } = harness;
  await manager.command('codex', 'goal-start', { sessionId: conversation.id, objective: 'Finish the experiment' });
  const goal = manager.goals.get(conversation.id);
  goal.drive(); await harness.flush();
  const rounds = goal.goal.roundsStarted;
  harness.finish('codex', 'error', 'context_length_exceeded');
  await harness.flush();
  assert.ok(manager.switching.get(conversation.id)?.session);
  await manager.command('codex', 'goal-pause', { sessionId: conversation.id });
  await harness.flush();
  assert.equal(interrupted, true);
  assert.equal(goal.goal.phase, 'paused');
  assert.equal(goal.goal.roundsStarted, rounds);
  assert.equal(manager.busy(conversation.id), false);
  assert.equal(harness.sent.length, 2);
});

test('unsynchronized history uses portable compaction instead of discarding records after the native cursor', async context => {
  const harness = await nativeFixture(context, async () => { throw new Error('Must not compact an incomplete native history'); });
  const { manager, conversation } = harness;
  manager.append(conversation, { role: 'assistant', text: 'Imported work not yet sent to Codex' });
  const done = manager.compact(conversation.id);
  await harness.flush();
  assert.match(harness.sent.at(-1).prompt, /Imported work not yet sent/);
  harness.finish('codex', 'success', 'Portable checkpoint with imported work');
  assert.ok((await done).file);
});

test('switching harness after native compaction retains public history for the receiving engine', async context => {
  const harness = await nativeFixture(context, async () => ({ ok: true }));
  const { manager, conversation } = harness;
  await manager.compact(conversation.id);
  const run = await manager.send('kimi', { sessionId: conversation.id, prompt: 'Take over' });
  assert.match(harness.sent.at(-1).prompt, /Remember the original task/);
  assert.match(harness.sent.at(-1).prompt, /Answer from codex/);
  harness.finish('kimi'); await run.done;
});

for (const finalText of ['Verified answer', '']) test('Codex structured output survives shared history reload: ' + (finalText || 'process only'), async context => {
  const harness = fixture(context), manager = harness.manager;
  const run = await manager.send('codex', { prompt: 'Inspect the code' });
  const session = harness.sent.at(-1).session;
  const outputBlocks = [{ type: 'text', phase: 'commentary', text: 'I will inspect.' },
    ...(finalText ? [{ type: 'text', phase: 'final_answer', text: finalText }] : [])];
  manager.capture('codex', { type: 'stream_event', runId: session.gen, event: {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will inspect.' + finalText },
  } });
  manager.capture('codex', { type: 'result', subtype: 'success', runId: session.gen, result: finalText, outputBlocks });
  assert.equal((await run.done).result, finalText);
  const answer = harness.restart().load('codex', run.sessionId).messages.at(-1);
  assert.equal(answer.text, finalText);
  assert.deepEqual(answer.outputBlocks, outputBlocks);
});
test('loading a live conversation reads its historical messages only once', async context => {
  const harness = fixture(context), manager = harness.manager;
  const conversation = manager.create('codex');
  manager.append(conversation, { role: 'user', text: 'Earlier request' });
  manager.append(conversation, { role: 'assistant', text: 'Earlier answer' });
  const run = await manager.send('codex', { sessionId: conversation.id, prompt: 'Continue' });
  const original = manager.messages.bind(manager);
  let reads = 0;
  manager.messages = conversation => { reads++; return original(conversation); };
  const loaded = manager.load('codex', conversation.id);
  assert.equal(reads, 1);
  assert.deepEqual(loaded.messages.map(row => row.text), ['Earlier request', 'Earlier answer', 'Continue']);
  assert.deepEqual(loaded.live.messages.map(row => row.text), ['Earlier request', 'Earlier answer']);
  assert.equal(loaded.live.prompt, 'Continue');
  harness.finish('codex');
  await run.done;
  assert.equal(manager.load('codex', conversation.id).messages.length, 4);
});

for (const engine of ENGINES) test(engine + ' sidebar fork is immediately persisted, renameable and independent before sending', async context => {
  const harness = fixture(context), manager = harness.manager;
  const workspace = manager.workspaces.metaOp({ op: 'create-workspace', name: 'Research', path: harness.root }).workspace;
  const source = manager.create(engine, workspace.id, 'Original');
  source.apiModel = 'chosen-model';
  source.engineSettings[engine] = { thinkingBudget: 'high', permissionMode: 'plan' };
  source.segments[engine] = { nativeId: 'source-native', cursor: 0 };
  manager.append(source, { role: 'user', text: 'Initial request' });
  manager.append(source, { role: 'assistant', text: 'Initial answer' });
  manager.append(source, { role: 'assistant', text: 'Internal details', internal: true });
  manager.save(source);
  await manager.command(engine, 'rename-session', { id: source.id, title: 'Renamed original' });
  const snapshot = JSON.stringify(source);
  const result = await manager.command(engine, 'fork-session', { sessionId: source.id });
  assert.equal(result.ok, true);
  assert.notEqual(result.sessionId, source.id);
  assert.equal(harness.sent.length, 0);
  const fork = manager.get(result.sessionId);
  assert.equal(fork.title, 'Fork of Renamed original');
  assert.equal(fork.workspaceId, workspace.id);
  assert.equal(fork.cwd, source.cwd);
  assert.equal(fork.apiModel, source.apiModel);
  assert.deepEqual(fork.engineSettings, source.engineSettings);
  assert.notEqual(fork.engineSettings[engine], source.engineSettings[engine]);
  assert.deepEqual(fork.segments, {});
  assert.deepEqual(manager.messages(fork).map(row => row.text), ['Initial request', 'Initial answer']);
  assert.equal(JSON.stringify(source), snapshot);
  const second = await manager.command(engine, 'fork-session', { sessionId: source.id });
  assert.equal(manager.get(second.sessionId).title, 'Fork of Renamed original (2)');
  const localized = await manager.command(engine, 'fork-session', { sessionId: source.id, title: '分叉 · Renamed original' });
  assert.equal(manager.get(localized.sessionId).title, '分叉 · Renamed original');
  const listed = (await manager.list(engine)).sessions.find(session => session.id === fork.id);
  assert.equal(listed.title, fork.title);
  await manager.command(engine, 'rename-session', { id: fork.id, title: 'Alternative approach' });
  const restarted = harness.restart();
  assert.equal((await restarted.list(engine)).sessions.find(session => session.id === fork.id).title, 'Alternative approach');
  assert.deepEqual(restarted.load(engine, fork.id).messages.map(row => row.text), ['Initial request', 'Initial answer']);
  const run = await restarted.send(engine, { sessionId: fork.id, prompt: 'Continue the branch' });
  assert.equal(run.sessionId, fork.id);
  assert.equal(restarted.items.size, 4);
  assert.match(harness.sent.at(-1).prompt, /Initial request/);
  assert.equal(restarted.messages(restarted.get(source.id)).length, 2);
  harness.finish(engine);
  await run.done;
});

test('default fork prefixes follow the configured language without renaming existing branches', async context => {
  const harness = fixture(context), manager = harness.manager;
  const source = manager.create('codex', null, 'Research $&');
  harness.args.saveConfig({ language: 'zh-CN' });
  const chinese = manager.fork('codex', { sessionId: source.id });
  assert.equal(chinese.title, '分叉 · Research $&');
  assert.equal(manager.fork('codex', { sessionId: source.id }).title, '分叉 · Research $& (2)');
  harness.args.saveConfig({ language: 'en' });
  assert.equal(manager.fork('codex', { sessionId: source.id }).title, 'Fork of Research $&');
  assert.equal(manager.get(chinese.id).title, '分叉 · Research $&');
  assert.equal(manager.fork('codex', { sessionId: source.id, title: 'Custom title' }).title, 'Custom title');
});

test('sidebar fork rejects busy, archived and missing sources without creating conversations', async context => {
  const harness = fixture(context), manager = harness.manager;
  const run = await manager.send('claude', { prompt: 'Working' });
  await assert.rejects(manager.command('claude', 'fork-session', { sessionId: run.sessionId }), /finish before forking/);
  harness.finish('claude');
  await run.done;
  await manager.command('claude', 'archive-session', { id: run.sessionId });
  await assert.rejects(manager.command('claude', 'fork-session', { sessionId: run.sessionId }), /Restore/);
  await assert.rejects(manager.command('claude', 'fork-session', { sessionId: 'missing' }), /not found/);
  assert.equal(manager.items.size, 1);
});

test('sidebar fork copies revised history without discarded turns', async context => {
  const harness = fixture(context), manager = harness.manager;
  const source = manager.create('codex', null, 'Revised conversation');
  const original = manager.append(source, { role: 'user', text: 'Discarded request' });
  manager.append(source, { role: 'assistant', text: 'Discarded answer' });
  manager.append(source, { role: 'revision', replacesSeq: original.seq, text: 'Revised request' });
  manager.append(source, { role: 'assistant', text: 'Revised answer' });
  manager.save(source);
  const result = await manager.command('codex', 'fork-session', { sessionId: source.id });
  assert.deepEqual(manager.messages(manager.get(result.sessionId)).map(row => row.text), ['Revised request', 'Revised answer']);
  assert.equal(harness.sent.length, 0);
});

for (const mode of ['sidebar', 'tool']) for (const first of ['source', 'fork']) test(`${mode} fork retains shared handoffs after deleting ${first}, including after restart`, context => {
  const harness = fixture(context, { conversationModels: () => [{ id: 'fixture', thinking: [] }] });
  let manager = harness.manager;
  const source = manager.create('claude', null, 'Original');
  const file = path.join(harness.root, 'handoffs', 'shared.md');
  const summary = path.join(harness.root, 'handoffs', 'summary.md');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'Important handoff');
  fs.writeFileSync(summary, 'Important compacted context');
  source.handoffs.push({ file, status: 'complete' });
  manager.append(source, { role: 'notice', text: 'Markdown handoff', file });
  manager.append(source, { role: 'notice', text: 'Context compacted: summary saved', file: summary });
  manager.save(source);
  const fork = mode === 'sidebar' ? manager.fork('claude', { sessionId: source.id })
    : manager.get(require('../src/engines/conversation-control').callConversationTool(manager, source.id,
      'camellia_conversation_fork', { request_id: 'fork-with-handoff', title: 'Fork' }, { userSeq: source.seq }).conversation.id);
  const kept = first === 'source' ? fork.id : source.id;
  manager.workspaces.archiveSession(kept, true);
  manager = harness.restart();
  manager.purge(first === 'source' ? source.id : fork.id);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Important handoff');
  assert.equal(fs.readFileSync(summary, 'utf8'), 'Important compacted context');
  assert.deepEqual([...manager.handoffFiles(manager.get(kept))].sort(), [file, summary].sort());
  assert.match(manager.compactionContext(manager.get(kept)), /Important compacted context/);
  const handlers = new Map(), opened = [];
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const start = main.indexOf("  ipcMain.handle('dsh:conversation-open-handoff'");
  require('node:vm').runInNewContext(main.slice(start, main.indexOf('\n  });', start) + 6), {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, sharedConversations: manager,
    path, shell: { openPath: target => { opened.push(target); } },
  });
  const open = target => handlers.get('dsh:conversation-open-handoff')(null, { sessionId: kept, file: target });
  assert.equal(open(file).ok, true);
  assert.equal(open(summary).ok, true);
  assert.equal(open(path.join(harness.root, 'unrelated.md')).ok, false);
  assert.deepEqual(opened, [file, summary]);
  manager.purge(kept);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(summary), false);
});

test('shared conversation pagination selects the newest entries before and after restart', async context => {
  const harness = fixture(context);
  let manager = harness.manager;
  const conversations = Array.from({ length: 65 }, (_, index) => {
    const conversation = manager.create('claude', null, `Conversation ${index}`);
    conversation.updatedAt = 1000 + index;
    manager.save(conversation);
    return conversation;
  });
  for (const restart of [false, true]) {
    if (restart) manager = harness.restart();
    const page = await manager.list('claude', {});
    assert.equal(page.pagination.recent.total, 65);
    assert.deepEqual(page.sessions.map(entry => entry.id), conversations.slice(5).reverse().map(entry => entry.id));
    const more = await manager.list('claude', { limits: { recent: 65 } });
    assert.deepEqual(more.sessions.map(entry => entry.id), [...conversations].reverse().map(entry => entry.id));
  }
  const updated = manager.get(conversations[0].id);
  updated.updatedAt = 2000; manager.save(updated);
  assert.equal((await manager.list('claude', {})).sessions[0].id, updated.id);
});

for (const engine of ENGINES) test(engine + ' conversation tools create, fork, configure, send, read and cancel owned children', async context => {
  const harness = fixture(context, {
    createGoalBridge: async options => ({ call: options.call, close() {} }),
    conversationModels: () => [{ id: 'fixture', thinking: ['high'] }, { id: 'alternative', thinking: ['low'], contextWindow: 64000 }],
  });
  context.after(() => harness.manager.closeGoalTools());
  const manager = harness.manager;
  harness.drivers[engine].settings = () => ({ model: 'fixture', connection: 'api', permissionMode: 'default', thinkingBudget: 'high', contextWindow: 100000 });
  const prior = await manager.send(engine, { prompt: 'First request' });
  harness.finish(engine); await prior.done;
  manager.append(manager.get(prior.sessionId), { role: 'assistant', text: 'Internal secret', internal: true });
  const parent = await manager.send(engine, { sessionId: prior.sessionId, prompt: 'Delegate the next task' });
  const parentSession = harness.sent.at(-1).session;
  const bridge = harness.sent.at(-1).opts.goalBridge;
  const token = manager.active.get(parent.sessionId).goalRunToken;
  const call = (operation, args = {}) => bridge.call('camellia_conversation_' + operation, { run_token: token, ...args });
  manager.capture(engine, { type: 'assistant', conversationId: parent.sessionId, runId: parentSession.gen, message: { content: [{ type: 'text', text: 'In-flight answer' }] } });
  assert.equal(call('models').models.length, 2);
  const fork = call('fork', { request_id: 'fork', title: 'Snapshot', model: 'alternative', thinking: 'low' });
  assert.equal(fork.ok, true, fork.error);
  const child = manager.get(fork.conversation.id);
  assert.equal(child.cwd, manager.get(parent.sessionId).cwd);
  assert.equal(child.workspaceId, manager.get(parent.sessionId).workspaceId);
  assert.deepEqual(child.segments, {});
  assert.deepEqual(manager.messages(child).map(row => row.text), ['First request', 'Answer from ' + engine, 'Delegate the next task']);
  assert.equal(manager.settings(engine, child.id).contextWindow, 64000);
  assert.equal(manager.settings(engine, child.id).permissionMode, 'default');
  assert.equal(manager.settings(engine, parent.sessionId).model, 'fixture');
  assert.equal(call('fork', { request_id: 'fork', title: 'Snapshot', model: 'alternative', thinking: 'low' }).replayed, true);
  assert.equal(call('create', { request_id: 'fork', title: 'Snapshot' }).ok, false);
  assert.equal(call('configure', { conversation_id: child.id, thinking: 'high' }).ok, false);
  assert.equal(call('configure', { conversation_id: child.id, model: 'missing' }).ok, false);
  assert.equal(call('configure', { conversation_id: child.id, thinking: '' }).ok, true);
  assert.equal(call('configure', { conversation_id: child.id, permissionMode: 'dangerous' }).ok, false);
  const stranger = manager.create(engine);
  assert.equal(call('read', { conversation_id: stranger.id }).ok, false);
  assert.equal(call('models', { conversation_id: stranger.id }).ok, false);
  assert.equal(call('send', { conversation_id: parent.sessionId, request_id: 'self', prompt: 'No' }).ok, false);
  assert.equal(call('list').conversations.length, 2);
  assert.equal(bridge.call('camellia_conversation_list', { run_token: 'stale' }).ok, false);
  const sendArgs = { conversation_id: child.id, request_id: 'work', prompt: 'Set a goal: Keep working' };
  assert.equal(call('send', sendArgs).ok, true);
  assert.equal(call('send', sendArgs).replayed, true);
  assert.equal(call('send', { ...sendArgs, prompt: 'Different' }).ok, false);
  assert.equal(call('send', { ...sendArgs, request_id: 'duplicate' }).ok, false);
  assert.equal(call('configure', { conversation_id: child.id, model: 'fixture' }).ok, false);
  assert.throws(() => manager.purge(child.id), /Stop/);
  await harness.flush();
  const childSession = harness.sent.at(-1).session;
  assert.equal(childSession.opts.sessionId, undefined);
  assert.equal(childSession.opts.settings.model, 'alternative');
  const childToken = manager.active.get(child.id).goalRunToken;
  const childCall = (name, args) => manager.callGoalTool(child.id, name, { run_token: childToken, ...args });
  assert.equal(childCall('camellia_conversation_create', { request_id: 'recursive', title: 'Forbidden' }).ok, false);
  assert.equal(childCall('camellia_create_goal', { objective: 'Keep working', user_request: 'Set a goal:' }).ok, false);
  assert.equal(childCall('camellia_task_create', { instruction: 'Loop', user_request: '创建定时任务' }).ok, false);
  harness.finish(engine, 'success', 'Child answer', childSession);
  await harness.flush();
  const read = call('read', { conversation_id: child.id });
  assert.equal(read.requests.at(-1).state, 'finished');
  assert.equal(read.messages.at(-1).text, 'Child answer');
  assert.equal(call('send', { ...sendArgs, request_id: 'second' }).ok, true);
  await harness.flush();
  assert.equal((await call('cancel', { conversation_id: child.id })).ok, true);
  await harness.flush();
  assert.equal(call('read', { conversation_id: child.id }).requests.at(-1).state, 'stopped');
  const empty = call('create', { request_id: 'empty', title: 'Empty' });
  assert.equal(manager.messages(manager.get(empty.conversation.id)).length, 0);
  harness.finish(engine, 'success', 'Parent finished', parentSession); await parent.done;
  assert.equal(call('list').ok, false);
});

for (const mode of ['cancel', 'close', 'failure', 'compact-cancel', 'compact-close']) test('child startup reservation handles ' + mode, async context => {
  const harness = fixture(context, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  context.after(() => harness.manager.closeGoalTools());
  const manager = harness.manager;
  const parent = await manager.send('codex', { prompt: 'Delegate work' });
  const token = manager.active.get(parent.sessionId).goalRunToken;
  const call = (operation, args = {}) => manager.callGoalTool(parent.sessionId, 'camellia_conversation_' + operation, { run_token: token, ...args });
  const created = call(mode.startsWith('compact-') ? 'fork' : 'create', { request_id: 'child', title: 'Worker' });
  const child = manager.get(created.conversation.id);
  let release, rejectStart;
  manager.prepare = () => new Promise((resolve, reject) => { release = resolve; rejectStart = reject; });
  if (mode.startsWith('compact-')) manager.estimateTokens = () => 1000000;
  assert.equal(call('send', { conversation_id: child.id, request_id: 'start', prompt: 'Work' }).ok, true);
  assert.equal(manager.busy(child.id), true);
  await assert.rejects(manager.send('codex', { sessionId: child.id, prompt: 'Race' }), /starting/);
  assert.equal(call('configure', { conversation_id: child.id, thinking: '' }).ok, false);
  assert.throws(() => manager.purge(child.id), /Stop/);
  if (mode.endsWith('close')) manager.closeGoalTools();
  else if (mode !== 'failure') await call('cancel', { conversation_id: child.id });
  if (mode === 'failure') rejectStart(new Error('Runtime unavailable'));
  else release();
  await harness.flush();
  assert.equal(harness.sent.length, 1);
  assert.equal(child.controlSends[0].state, mode === 'failure' ? 'error' : 'stopped');
  assert.equal(manager.busy(child.id), false);
  if (mode === 'failure') assert.match(call('read', { conversation_id: child.id }).requests[0].error, /Runtime unavailable/);
});

test('cancelling a child during MCP bridge startup prevents native dispatch', async context => {
  const harness = fixture(context, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  context.after(() => harness.manager.closeGoalTools());
  const manager = harness.manager;
  const parent = await manager.send('codex', { prompt: 'Delegate' });
  const token = manager.active.get(parent.sessionId).goalRunToken;
  const call = (operation, args = {}) => manager.callGoalTool(parent.sessionId, 'camellia_conversation_' + operation, { run_token: token, ...args });
  const child = manager.get(call('create', { request_id: 'child', title: 'Worker' }).conversation.id);
  let release;
  manager.createGoalBridge = () => new Promise(resolve => { release = resolve; });
  call('send', { conversation_id: child.id, request_id: 'work', prompt: 'Work' });
  await harness.flush();
  await call('cancel', { conversation_id: child.id });
  release({ close() {} });
  await harness.flush();
  assert.equal(harness.sent.length, 1);
  assert.equal(child.controlSends[0].state, 'stopped');
  assert.equal(manager.busy(child.id), false);
});

test('fork uses revised visible history rather than superseded requests and responses', async context => {
  const harness = fixture(context, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  context.after(() => harness.manager.closeGoalTools());
  const manager = harness.manager;
  const initial = await manager.send('codex', { prompt: 'Superseded request' });
  harness.finish('codex', 'success', 'Superseded response'); await initial.done;
  const revised = await manager.send('codex', { sessionId: initial.sessionId, editSeq: initial.userSeq, prompt: 'Revised request' });
  const token = manager.active.get(revised.sessionId).goalRunToken;
  const fork = manager.callGoalTool(revised.sessionId, 'camellia_conversation_fork', { run_token: token, request_id: 'fork', title: 'Revised snapshot' });
  assert.equal(fork.ok, true);
  assert.deepEqual(manager.messages(manager.get(fork.conversation.id)).map(row => row.text), ['Revised request']);
});

test('child sends survive pre-compaction and overflow recovery without duplicate dispatch', async context => {
  const harness = fixture(context, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  context.after(() => harness.manager.closeGoalTools());
  const manager = harness.manager;
  const parent = await manager.send('codex', { prompt: 'Delegate' });
  const token = manager.active.get(parent.sessionId).goalRunToken;
  const call = (operation, args = {}) => manager.callGoalTool(parent.sessionId, 'camellia_conversation_' + operation, { run_token: token, ...args });
  const child = manager.get(call('fork', { request_id: 'child', title: 'Worker' }).conversation.id);
  manager.modelContextWindow = () => 8000;
  manager.append(child, { role: 'assistant', text: 'Prior work ' + 'x'.repeat(30000) });
  manager.save(child);
  assert.equal(call('send', { conversation_id: child.id, request_id: 'work', prompt: 'Finish the work' }).ok, true);
  await harness.flush();
  for (let attempt = 0; /compact working context/.test(harness.sent.at(-1).prompt); attempt++) {
    assert.ok(attempt < 10);
    assert.equal(manager.active.get(child.id).internal, true);
    harness.finish('codex', 'success', 'Summary of prior work');
    await harness.flush();
  }
  assert.match(harness.sent.at(-1).prompt, /Finish the work/);
  assert.equal(child.controlSends[0].state, 'running');
  harness.finish('codex', 'error', 'context_length_exceeded');
  await harness.flush();
  assert.equal(manager.active.get(child.id).internal, true);
  harness.finish('codex', 'success', 'Recovered summary');
  await harness.flush();
  assert.equal(manager.active.get(child.id).internal, false);
  harness.finish('codex', 'success', 'Completed');
  await harness.flush();
  assert.equal(child.controlSends[0].state, 'finished');
  assert.equal(manager.busy(child.id), false);
});

test('subscription child settings remain local and archived children stay inaccessible', async context => {
  const harness = fixture(context, { createGoalBridge: async options => ({ call: options.call, close() {} }),
    conversationModels: (engine, settings) => settings.connection === 'subscription' ? [{ id: 'account', thinking: [] }] : [] });
  context.after(() => harness.manager.closeGoalTools());
  harness.drivers.kimi.settings = () => ({ model: 'account', connection: 'subscription', permissionMode: 'default' });
  harness.drivers.kimi.saveSettings = () => { throw new Error('Must not mutate global settings'); };
  const manager = harness.manager;
  const parent = await manager.send('kimi', { prompt: 'Delegate' });
  const token = manager.active.get(parent.sessionId).goalRunToken;
  const call = (operation, args = {}) => manager.callGoalTool(parent.sessionId, 'camellia_conversation_' + operation, { run_token: token, ...args });
  const child = call('create', { request_id: 'child', title: 'Account worker', model: 'account', thinking: '' }).conversation;
  assert.equal(manager.settings('kimi', child.id).connection, 'subscription');
  assert.equal(manager.get(child.id).engineSettings.kimi.subscriptionModel, 'account');
  assert.equal(call('configure', { conversation_id: child.id, thinking: 'high' }).ok, false);
  assert.equal(call('configure', { conversation_id: child.id, thinking: '' }).ok, true);
  manager.workspaces.archiveSession(child.id, true);
  assert.equal(call('list').conversations.length, 1);
  assert.equal(call('read', { conversation_id: child.id }).ok, false);
  assert.equal(call('create', { request_id: 'child', title: 'Account worker', model: 'account', thinking: '' }).ok, false);
});

test('late child callbacks never overwrite a replaced conversation object', async context => {
  const harness = fixture(context, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  context.after(() => harness.manager.closeGoalTools());
  const manager = harness.manager;
  const parent = await manager.send('codex', { prompt: 'Delegate' });
  const token = manager.active.get(parent.sessionId).goalRunToken;
  const call = (operation, args = {}) => manager.callGoalTool(parent.sessionId, 'camellia_conversation_' + operation, { run_token: token, ...args });
  const child = manager.get(call('create', { request_id: 'child', title: 'Worker' }).conversation.id);
  let release;
  manager.send = () => new Promise(resolve => { release = resolve; });
  call('send', { conversation_id: child.id, request_id: 'work', prompt: 'Work' });
  const replacement = { ...child, title: 'Replacement', controlSends: [] };
  manager.save(replacement);
  release({ ok: true, runId: 999, done: Promise.resolve({ subtype: 'success', result: 'Late' }) });
  await harness.flush();
  assert.equal(manager.get(child.id), replacement);
  assert.equal(JSON.parse(fs.readFileSync(manager.file(child.id))).title, 'Replacement');
  assert.deepEqual(manager.get(child.id).controlSends, []);
});

test('child request limits, bounded reads and interrupted restart states are persisted', async context => {
  const harness = fixture(context, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  context.after(() => harness.manager.closeGoalTools());
  const manager = harness.manager;
  const parent = await manager.send('codex', { prompt: 'Delegate' });
  const token = manager.active.get(parent.sessionId).goalRunToken;
  const call = (operation, args = {}) => manager.callGoalTool(parent.sessionId, 'camellia_conversation_' + operation, { run_token: token, ...args });
  const child = manager.get(call('create', { request_id: 'child', title: 'Worker' }).conversation.id);
  for (let index = 1; index < 8; index++) assert.equal(call('create', { request_id: 'child-' + index, title: 'Worker' }).ok, true);
  assert.equal(call('create', { request_id: 'overflow', title: 'Worker' }).ok, false);
  manager.active.get(parent.sessionId).controlSendCount = 32;
  assert.equal(call('send', { conversation_id: child.id, request_id: 'limit', prompt: 'Work' }).ok, false);
  for (let index = 0; index < 10; index++) manager.append(child, { role: 'assistant', text: 'x'.repeat(5000) });
  const read = call('read', { conversation_id: child.id });
  assert.equal(read.messages.length, 8);
  assert.equal(read.messages[0].text.length, 4000);
  assert.equal(read.truncated, true);
  child.controlSends = [{ requestId: 'starting', state: 'starting' }, { requestId: 'running', state: 'running' }, { requestId: 'finished', state: 'finished' }];
  manager.save(child);
  manager.closeGoalTools();
  const restarted = harness.restart();
  context.after(() => restarted.closeGoalTools());
  assert.deepEqual(restarted.get(child.id).controlSends.map(entry => entry.state), ['interrupted', 'interrupted', 'finished']);
  assert.equal(restarted.busy(child.id), false);
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(restarted.file(child.id))).controlSends.map(entry => entry.state), ['interrupted', 'interrupted', 'finished']);
});

test('scheduled checks use current-turn tools, report once and cannot create autonomous loops', async t => {
  const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  t.after(() => harness.manager.closeGoalTools());
  const run = await harness.manager.send('codex', { prompt: '创建定时任务：每分钟检查日志，允许自动恢复一次' });
  const bridge = harness.sent.at(-1).opts.goalBridge;
  const token = harness.manager.active.get(run.sessionId).goalRunToken;
  const created = bridge.call('camellia_task_create', { run_token: token, user_request: '创建定时任务', instruction: 'Inspect logs', intervalMinutes: 1, maxRepairs: 1 });
  assert.equal(created.ok, true);
  assert.equal(harness.sent.length, 1);
  assert.equal(bridge.call('camellia_task_report', { run_token: token, task_id: created.task.id, status: 'complete', summary: 'Fake' }).ok, false);
  harness.finish('codex'); await run.done;
  assert.equal(bridge.call('camellia_task_list', { run_token: token }).ok, false);
  const task = harness.manager.tasks.get(created.task.id, run.sessionId);
  task.nextRunAt = Date.now() - 1;
  await harness.manager.tasks.tick(); await harness.flush();
  const active = harness.manager.active.get(run.sessionId), checkToken = active.goalRunToken;
  assert.equal(active.scheduledTaskId, task.id);
  assert.equal(bridge.call('camellia_conversation_create', { run_token: checkToken, request_id: 'scheduled', title: 'No' }).ok, false);
  assert.match(harness.sent.at(-1).prompt, /Inspect logs/);
  assert.equal(bridge.call('camellia_create_goal', { run_token: checkToken, objective: 'Loop', user_request: 'Set a goal' }).ok, false);
  assert.equal(bridge.call('camellia_task_create', { run_token: checkToken, instruction: 'Loop', user_request: '创建定时任务' }).ok, false);
  assert.equal(bridge.call('camellia_task_repair', { run_token: checkToken, task_id: task.id }).ok, true);
  assert.equal(bridge.call('camellia_task_repair', { run_token: checkToken, task_id: task.id }).ok, false);
  assert.equal(bridge.call('camellia_task_report', { run_token: checkToken, task_id: task.id, status: 'complete', summary: 'Output validated' }).ok, true);
  assert.equal(task.status, 'running');
  harness.finish('codex'); await active.done; await harness.flush();
  assert.equal(task.status, 'complete');
});

test('tasks defer to Goal, reject unsupported engines and pause with conversation cancellation', async t => {
  const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  t.after(() => harness.manager.closeGoalTools());
  const run = await harness.manager.send('claude', { prompt: 'Discuss scheduled tasks' });
  const bridge = harness.sent.at(-1).opts.goalBridge, token = harness.manager.active.get(run.sessionId).goalRunToken;
  assert.equal(bridge.call('camellia_task_create', { run_token: token, instruction: 'Check', user_request: 'scheduled tasks' }).ok, false);
  harness.finish('claude'); await run.done;
  const created = await harness.manager.command('claude', 'task-create', { sessionId: run.sessionId, instruction: 'Check logs' });
  const task = harness.manager.tasks.get(created.task.id, run.sessionId);
  const goal = harness.manager.goalFor(run.sessionId); goal.armed = true;
  task.nextRunAt = Date.now() - 1; await harness.manager.tasks.tick();
  assert.equal(harness.sent.length, 1); assert.equal(task.status, 'scheduled'); goal.armed = false;
  task.nextRunAt = Date.now() - 1; await harness.manager.tasks.tick(); await harness.flush();
  assert.equal(harness.sent.length, 2);
  await harness.manager.cancel({ sessionId: run.sessionId }); await harness.flush();
  assert.equal(task.status, 'paused');
  const unsupported = fixture(t);
  const conversation = unsupported.manager.create('codex');
  await assert.rejects(unsupported.manager.command('codex', 'task-create', { sessionId: conversation.id, instruction: 'Check' }), /tool support/);
});

test('task cancellation during preparation cannot send a late check', async t => {
  let release, hold = false;
  const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }),
    prepare: async () => { if (hold) await new Promise(resolve => { release = resolve; }); } });
  t.after(() => harness.manager.closeGoalTools());
  const run = await harness.manager.send('codex', { prompt: 'Experiment' }); harness.finish('codex'); await run.done;
  const created = await harness.manager.command('codex', 'task-create', { sessionId: run.sessionId, instruction: 'Check logs' });
  const task = harness.manager.tasks.get(created.task.id, run.sessionId); task.nextRunAt = Date.now() - 1;
  hold = true; await harness.manager.tasks.tick(); await harness.flush();
  await harness.manager.command('codex', 'task-cancel', { sessionId: run.sessionId, id: task.id });
  release(); await harness.flush();
  assert.equal(harness.sent.length, 1); assert.equal(task.status, 'cancelled');
  assert.equal(harness.manager.active.has(run.sessionId), false);
});

test('periodic checks finish through the shared tool bridge on all five engines', async t => {
  for (const engine of ENGINES) {
    const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
    t.after(() => harness.manager.closeGoalTools());
    const conversation = harness.manager.create(engine);
    const created = await harness.manager.command(engine, 'task-create', { sessionId: conversation.id, instruction: 'Inspect existing experiment' });
    const task = harness.manager.tasks.get(created.task.id, conversation.id); task.nextRunAt = Date.now() - 1;
    await harness.manager.tasks.tick(); await harness.flush();
    const active = harness.manager.active.get(conversation.id), bridge = harness.sent.at(-1).opts.goalBridge;
    assert.equal(bridge.call('camellia_task_report', { run_token: active.goalRunToken, task_id: task.id, status: 'complete', summary: 'Artifacts checked' }).ok, true, engine);
    harness.finish(engine); await active.done; await harness.flush();
    assert.equal(task.status, 'complete', engine);
  }
});

test('turn artifacts survive restart, deduplicate references, and do not leak into the next turn', async t => {
  const harness = fixture(t);
  const run = await harness.manager.send('codex', { prompt: 'Create a report' });
  const conversation = harness.manager.get(run.sessionId);
  const file = path.join(conversation.cwd, 'report.txt');
  t.after(() => { try { fs.unlinkSync(file); } catch {} });
  fs.writeFileSync(file, 'Report');
  const session = harness.sent.at(-1).session;
  harness.manager.capture('codex', { type: 'gui:tool', runId: session.gen, id: 'write', name: 'write_file', input: { path: 'report.txt' }, status: 'completed' });
  harness.finish('codex', 'success', 'Created `report.txt`.');
  await run.done;
  assert.equal(harness.events.findLast(event => event.type === 'result').artifacts.length, 1);
  const restored = harness.restart();
  assert.equal(restored.messages(restored.get(run.sessionId)).at(-1).artifacts[0].path, file);
  const next = await restored.send('codex', { sessionId: run.sessionId, prompt: 'Thanks' });
  harness.finish('codex', 'success', 'You are welcome.');
  await next.done;
  assert.deepEqual(restored.messages(restored.get(run.sessionId)).at(-1).artifacts, []);
});

test('model goal tools adopt the current turn once and verify completion across all engines', async t => {
  for (const engine of ENGINES) {
    const changes = [];
    const harness = fixture(t, { onGoal: event => changes.push(event), createGoalBridge: async options => ({ call: options.call, close() {} }) });
    const run = await harness.manager.send(engine, { prompt: '请设定目标：完成测试' });
    const active = harness.manager.active.get(run.sessionId);
    const bridge = harness.sent.at(-1).opts.goalBridge;
    const args = { run_token: active.goalRunToken, objective: '完成测试', user_request: '请设定目标' };
    const created = bridge.call('camellia_create_goal', args);
    assert.equal(created.ok, true);
    const driver = harness.manager.goalFor(run.sessionId);
    assert.equal(driver.view().roundsStarted, 1);
    assert.equal(driver.timer, null);
    assert.equal(harness.sent.length, 1);
    assert.equal(driver.ownedSession(), active.facade);
    assert.equal(changes.at(-1).goal.engine, engine);
    assert.equal(bridge.call('camellia_create_goal', args).goal.id, created.goal.id);
    assert.equal(bridge.call('camellia_get_goal', { run_token: 'stale' }).ok, false);
    const report = { run_token: active.goalRunToken, status: 'complete', reason: 'Tests passed' };
    assert.equal(bridge.call('camellia_update_goal', report).status, 'verification_pending');
    assert.equal(driver.view().phase, 'active');
    harness.finish(engine, 'success', 'Done');
    await run.done; await harness.flush();
    assert.equal(driver.view().phase, 'active');
    assert.ok(driver.view().verifying);
    assert.equal(harness.sent.at(-1).opts.goalBridge, undefined);
    assert.equal(bridge.call('camellia_update_goal', report).ok, false);
    harness.finish(engine, 'success', '<verify:pass> Independently checked');
    await harness.flush();
    assert.equal(driver.view().phase, 'complete');
  }
});

test('model goal creation refuses discussion and paused adopted turns cannot continue', async t => {
  const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  const run = await harness.manager.send('claude', { prompt: '检查实现，如果用户要求设定目标是否可以自动进入？' });
  const bridge = harness.sent.at(-1).opts.goalBridge;
  const token = harness.manager.active.get(run.sessionId).goalRunToken;
  assert.equal(bridge.call('camellia_create_goal', { run_token: token, objective: 'Check', user_request: '设定目标' }).ok, false);
  assert.equal(harness.manager.goalFor(run.sessionId).view(), null);
  harness.finish('claude'); await run.done;
  const next = await harness.manager.send('claude', { sessionId: run.sessionId, prompt: 'Set a goal: finish' });
  assert.equal(bridge.call('camellia_get_goal', { run_token: token }).ok, false);
  const currentToken = harness.manager.active.get(run.sessionId).goalRunToken;
  assert.equal(bridge.call('camellia_create_goal', { run_token: currentToken, objective: 'Finish', user_request: 'Set a goal' }).ok, true);
  await harness.manager.command('claude', 'goal-pause', { sessionId: run.sessionId });
  await next.done;
  assert.equal(harness.manager.goalFor(run.sessionId).view().phase, 'paused');
  assert.equal(harness.sent.at(-1).session.running, false);
  assert.equal(bridge.call('camellia_update_goal', { run_token: currentToken, status: 'complete', reason: 'Late' }).ok, false);
});

test('goal tools isolate conversations, reject paused goal replacement and stop after shutdown', async t => {
  const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  const first = await harness.manager.send('claude', { prompt: 'Set a goal: first' });
  const firstBridge = harness.sent.at(-1).opts.goalBridge;
  const firstToken = harness.manager.active.get(first.sessionId).goalRunToken;
  assert.equal(firstBridge.call('camellia_create_goal', { run_token: firstToken, objective: 'First', user_request: 'Set a goal' }).ok, true);
  await harness.manager.command('claude', 'goal-pause', { sessionId: first.sessionId });
  await first.done;
  const next = await harness.manager.send('claude', { sessionId: first.sessionId, prompt: 'Set a goal: replacement' });
  assert.equal(harness.sent.at(-1).opts.goalBridge, firstBridge);
  const nextToken = harness.manager.active.get(first.sessionId).goalRunToken;
  const replacement = firstBridge.call('camellia_create_goal', { run_token: nextToken, objective: 'Replacement', user_request: 'Set a goal' });
  assert.equal(replacement.ok, false);
  assert.match(replacement.error, /unfinished goal/);
  assert.equal(harness.manager.goalFor(first.sessionId).view().objective, 'First');
  const other = await harness.manager.send('codex', { prompt: 'Set a goal: other' });
  const otherBridge = harness.sent.at(-1).opts.goalBridge;
  const otherToken = harness.manager.active.get(other.sessionId).goalRunToken;
  assert.equal(firstBridge.call('camellia_get_goal', { run_token: otherToken }).ok, false);
  assert.equal(otherBridge.call('camellia_get_goal', { run_token: nextToken }).ok, false);
  harness.manager.active.get(other.sessionId).steering = true;
  assert.equal(otherBridge.call('camellia_get_goal', { run_token: otherToken }).ok, false);
  harness.manager.active.get(other.sessionId).steering = false;
  harness.manager.closeGoalTools();
  assert.equal(otherBridge.call('camellia_get_goal', { run_token: otherToken }).ok, false);
  harness.finish('claude'); harness.finish('codex');
  await Promise.all([next.done, other.done]);
});

test('internal and disabled turns do not inherit an existing goal bridge', async t => {
  const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  const first = await harness.manager.send('claude', { prompt: 'Inspect' });
  const bridge = harness.sent.at(-1).opts.goalBridge;
  harness.finish('claude'); await first.done;
  for (const options of [{ internal: true }, { goalToolsDisabled: true }]) {
    const run = await harness.manager.send('claude', { sessionId: first.sessionId, prompt: 'Set a goal: forbidden' }, options);
    assert.equal(harness.sent.at(-1).opts.goalBridge, undefined);
    assert.doesNotMatch(harness.sent.at(-1).prompt, /Camellia goal run token/);
    assert.equal(bridge.call('camellia_create_goal', { run_token: 'stale', objective: 'Forbidden', user_request: 'Set a goal' }).ok, false);
    harness.finish('claude'); await run.done;
  }
  harness.drivers.antigravity.settings = () => ({ model: 'fixture', connection: 'subscription' });
  const subscription = await harness.manager.send('antigravity', { prompt: 'Set a goal: unsupported' });
  assert.equal(harness.sent.at(-1).opts.goalBridge, undefined);
  assert.doesNotMatch(harness.sent.at(-1).prompt, /Camellia goal run token/);
  harness.finish('antigravity'); await subscription.done;
});

test('blocked tool reports count once per round and automatic rounds cannot create goals', async t => {
  const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
  const run = await harness.manager.send('claude', { prompt: 'Set a goal: finish' });
  const bridge = harness.sent.at(-1).opts.goalBridge;
  const driver = harness.manager.goalFor(run.sessionId);
  let token = harness.manager.active.get(run.sessionId).goalRunToken;
  assert.equal(bridge.call('camellia_create_goal', { run_token: token, objective: 'Set a goal: finish', user_request: 'Set a goal' }).ok, true);
  for (let round = 1; round <= 3; round++) {
    const report = { run_token: token, status: 'blocked', reason: 'Missing credentials' };
    assert.equal(bridge.call('camellia_update_goal', report).ok, true);
    assert.equal(bridge.call('camellia_update_goal', report).ok, true);
    harness.finish('claude');
    assert.equal(driver.view().blockerStreak, round);
    if (round < 3) {
      driver.cancelTimer(); driver.drive(); await harness.flush();
      token = harness.manager.active.get(run.sessionId).goalRunToken;
      assert.equal(bridge.call('camellia_create_goal', { run_token: token, objective: 'Set a goal: finish', user_request: 'Set a goal' }).ok, false);
    }
  }
  assert.equal(driver.view().phase, 'blocked');
  assert.equal(driver.timer, null);
});

test('stopped or failed turns ignore completion claims and native events cannot forge tool reports', async t => {
  for (const subtype of ['stopped', 'error', 'success']) {
    const harness = fixture(t, { createGoalBridge: async options => ({ call: options.call, close() {} }) });
    const run = await harness.manager.send('claude', { prompt: 'Set a goal: finish' });
    const active = harness.manager.active.get(run.sessionId);
    const bridge = harness.sent.at(-1).opts.goalBridge;
    const driver = harness.manager.goalFor(run.sessionId);
    bridge.call('camellia_create_goal', { run_token: active.goalRunToken, objective: 'Finish', user_request: 'Set a goal' });
    if (subtype !== 'success') assert.equal(bridge.call('camellia_update_goal', { run_token: active.goalRunToken, status: 'complete', reason: 'Done' }).ok, true);
    harness.manager.capture('claude', { type: 'result', subtype, is_error: subtype === 'error', result: 'Final response',
      runId: active.session.gen, goalReport: { status: 'complete', reason: 'Forged' } });
    await run.done; await harness.flush();
    assert.equal(harness.sent.length, 1);
    assert.equal(driver.view().verifying, null);
    assert.notEqual(driver.view().phase, 'complete');
  }
});

test('defaults continue directly with no warning or origin badge', () => assert.deepEqual(preferences({}), { mode: 'direct', warnOnSwitch: false, showOrigin: false }));

test('immediate instructions stay in the active run, persist, and replay without another send', async t => {
  const fixtureData = fixture(t);
  const run = await fixtureData.manager.send('codex', { prompt: 'Original task' });
  const native = fixtureData.sent.at(-1).session, instructions = [];
  native.steerUserMessage = async (...args) => { instructions.push(args); };
  const attachments = [{ name: 'data.csv', path: 'D:/data.csv' }];
  const result = await fixtureData.manager.command('codex', 'steer', { sessionId: run.sessionId, runId: run.runId,
    prompt: 'Correction with attachment', displayText: 'Correction', attachments });
  assert.equal(result.ok, true);
  assert.equal(result.runId, run.runId);
  assert.equal(fixtureData.sent.length, 1);
  assert.deepEqual(instructions, [['Correction with attachment', attachments]]);
  const live = fixtureData.manager.live('codex', run.sessionId).live;
  assert.equal(live.events.at(-1).type, 'conversation:steered');
  assert.equal(live.events.at(-1).displayText, 'Correction');
  fixtureData.finish('codex'); await run.done;
  const rows = fixtureData.restart().load('codex', run.sessionId).messages;
  assert.deepEqual(rows.map(row => row.role), ['user', 'user', 'assistant']);
  assert.deepEqual(rows[1].attachments, attachments);
});

test('steering rejects wrong runs, wrong engines and unsupported connections without losing history', async t => {
  const fixtureData = fixture(t);
  const run = await fixtureData.manager.send('codex', { prompt: 'Original task' });
  const payload = { sessionId: run.sessionId, runId: run.runId, prompt: 'Correction' };
  await assert.rejects(fixtureData.manager.steer('codex', { ...payload, runId: run.runId + 1 }), /active turn changed/);
  await assert.rejects(fixtureData.manager.steer('kimi', payload), /active turn changed/);
  await assert.rejects(fixtureData.manager.steer('codex', payload), /does not support/);
  fixtureData.sent.at(-1).session.steerUserMessage = async () => { throw new Error('Native rejection'); };
  await assert.rejects(fixtureData.manager.steer('codex', payload), /Native rejection/);
  assert.equal(fixtureData.manager.load('codex', run.sessionId).messages.length, 1);
  assert.equal(fixtureData.manager.active.get(run.sessionId).steering, false);
});

test('result arriving before steering acknowledgment is committed after the accepted instruction', async t => {
  const fixtureData = fixture(t);
  const run = await fixtureData.manager.send('codex', { prompt: 'Original task' });
  const native = fixtureData.sent.at(-1).session;
  let acknowledge;
  native.steerUserMessage = () => new Promise(resolve => { acknowledge = resolve; });
  const payload = { sessionId: run.sessionId, runId: run.runId, prompt: 'Correction' };
  const pending = fixtureData.manager.steer('codex', payload);
  await assert.rejects(fixtureData.manager.steer('codex', payload), /previous instruction/);
  fixtureData.finish('codex');
  assert.equal(fixtureData.manager.active.has(run.sessionId), true);
  acknowledge(); await pending; await run.done;
  assert.equal(fixtureData.manager.active.has(run.sessionId), false);
  const events = fixtureData.events.filter(event => ['conversation:steered', 'result'].includes(event.type));
  assert.deepEqual(events.map(event => event.type), ['conversation:steered', 'result']);
  assert.deepEqual(fixtureData.manager.load('codex', run.sessionId).messages.map(row => row.role), ['user', 'user', 'assistant']);
});

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

test('editing a stopped turn ignores its oversized reply instead of waiting for compaction', async t => {
  for (const engine of ENGINES) {
    const harness = fixture(t);
    harness.drivers[engine].settings = () => ({ model: 'fixture', contextWindow: 8000 });
    const original = await harness.manager.send(engine, { prompt: 'ORIGINAL_REQUEST' });
    const conversation = harness.manager.get(original.sessionId);
    harness.finish(engine, 'stopped', 'DISCARDED_REPLY_' + 'x'.repeat(30000));
    const resending = harness.manager.send(engine, { sessionId: conversation.id, editSeq: original.userSeq, prompt: 'REVISED_REQUEST' });
    await harness.flush();
    assert.equal(harness.sent.length, 2);
    assert.match(harness.sent.at(-1).prompt, /REVISED_REQUEST/);
    assert.doesNotMatch(harness.sent.at(-1).prompt, /ORIGINAL_REQUEST|DISCARDED_REPLY|Earlier summary:/);
    const revised = await resending;
    harness.finish(engine);
    await revised.done;
  }
});

test('editing reuses only the compaction summary preceding the revised turn', async t => {
  const harness = fixture(t), conversation = harness.manager.create('codex');
  harness.manager.append(conversation, { role: 'user', text: 'EARLY_REQUEST' });
  harness.manager.append(conversation, { role: 'assistant', text: 'EARLY_REPLY_' + 'x'.repeat(230000) });
  const summaryFile = path.join(harness.root, 'prior-summary.md');
  fs.writeFileSync(summaryFile, 'SAFE_PRIOR_SUMMARY');
  harness.manager.append(conversation, { role: 'notice', text: 'Context compacted', file: summaryFile });
  harness.manager.append(conversation, { role: 'user', text: 'RECENT_REQUEST' });
  harness.manager.append(conversation, { role: 'assistant', text: 'RECENT_REPLY' });
  const original = harness.manager.append(conversation, { role: 'user', text: 'ORIGINAL_REQUEST' });
  const discardedFile = path.join(harness.root, 'discarded-summary.md');
  fs.writeFileSync(discardedFile, 'DISCARDED_SUMMARY');
  harness.manager.append(conversation, { role: 'notice', text: 'Context compacted', file: discardedFile });
  harness.manager.append(conversation, { role: 'assistant', text: 'DISCARDED_REPLY' });
  const resending = harness.manager.send('codex', { sessionId: conversation.id, editSeq: original.seq, prompt: 'REVISED_REQUEST' });
  await harness.flush();
  assert.equal(harness.sent.length, 1);
  const prompt = harness.sent.at(-1).prompt;
  assert.match(prompt, /SAFE_PRIOR_SUMMARY/);
  assert.match(prompt, /RECENT_REQUEST/);
  assert.match(prompt, /RECENT_REPLY/);
  assert.match(prompt, /REVISED_REQUEST/);
  assert.doesNotMatch(prompt, /EARLY_REQUEST|EARLY_REPLY|ORIGINAL_REQUEST|DISCARDED_/);
  const revised = await resending;
  harness.finish('codex');
  await revised.done;
});

test('an edit resend that replays an oversized history is auto-compacted instead of refused', async t => {
  const f = fixture(t), c = f.manager.create('claude', null, 'Edit a huge conversation');
  f.manager.modelContextWindow = () => 100000;
  f.manager.append(c, { role: 'user', text: 'First task' });
  f.manager.append(c, { role: 'tool', text: 'EARLY_WORK_' + 'a'.repeat(129000) });
  f.manager.append(c, { role: 'assistant', text: 'Early work done' });
  f.manager.append(c, { role: 'user', text: 'Second task' });
  f.manager.append(c, { role: 'tool', text: 'MORE_WORK_' + 'b'.repeat(129000) });
  f.manager.append(c, { role: 'assistant', text: 'More work done' });
  const old = f.manager.append(c, { role: 'user', text: 'ORIGINAL_REQUEST' });
  f.manager.append(c, { role: 'assistant', text: 'DISCARDED_REPLY' });
  f.manager.save(c);
  const revised = f.manager.send('claude', { sessionId: c.id, editSeq: old.seq, prompt: 'REVISED_REQUEST' });
  await f.flush();
  assert.doesNotMatch(f.sent.at(-1).prompt, /ORIGINAL_REQUEST|DISCARDED_REPLY/);
  while (/compact working context/.test(f.sent.at(-1).prompt)) {
    f.finish('claude', 'success', 'SUMMARY_TEXT of the earlier work');
    await f.flush();
  }
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

test('edit compaction respects the model window and cancellation preserves the original turn', async t => {
  for (const cancel of [false, true]) {
    const harness = fixture(t);
    harness.drivers.codex.settings = () => ({ model: 'fixture', contextWindow: 16000 });
    const conversation = harness.manager.create('codex');
    harness.manager.append(conversation, { role: 'user', text: 'PRIOR_REQUEST' });
    harness.manager.append(conversation, { role: 'assistant', text: 'p'.repeat(45000) });
    const original = harness.manager.append(conversation, { role: 'user', text: 'ORIGINAL_REQUEST' });
    harness.manager.append(conversation, { role: 'assistant', text: 'DISCARDED_REPLY' });
    const before = harness.manager.messages(conversation);
    const resending = harness.manager.send('codex', { sessionId: conversation.id, editSeq: original.seq, prompt: 'REVISED_REQUEST' });
    const rejected = cancel ? assert.rejects(resending, /canceled/) : null;
    await harness.flush();
    assert.equal(harness.manager.switching.has(conversation.id), true);
    assert.match(harness.sent.at(-1).prompt, /PRIOR_REQUEST/);
    assert.doesNotMatch(harness.sent.at(-1).prompt, /ORIGINAL_REQUEST|DISCARDED_REPLY/);
    if (cancel) {
      await harness.manager.cancel({ sessionId: conversation.id });
      await rejected;
      assert.deepEqual(harness.manager.messages(conversation), before);
      assert.equal(harness.sent.length, 1);
    } else {
      harness.finish('codex', 'success', 'PARTIAL_SUMMARY');
      await harness.flush();
      assert.doesNotMatch(harness.sent.at(-1).prompt, /ORIGINAL_REQUEST|DISCARDED_REPLY/);
      harness.finish('codex', 'success', 'SAFE_PRIOR_SUMMARY');
      const revised = await resending;
      assert.match(harness.sent.at(-1).prompt, /SAFE_PRIOR_SUMMARY/);
      assert.match(harness.sent.at(-1).prompt, /REVISED_REQUEST/);
      assert.doesNotMatch(harness.sent.at(-1).prompt, /ORIGINAL_REQUEST|DISCARDED_REPLY/);
      assert.equal(harness.manager.messages(conversation).some(row => row.file), false);
      harness.finish('codex');
      await revised.done;
    }
    assert.equal(harness.manager.busy(conversation.id), false);
  }
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

test('goal lifecycle actions cancel and purge only their own verifier for every engine', async t => {
  for (const engine of ENGINES) {
    for (const action of ['goal-pause', 'goal-clear', 'goal-complete', 'cancel', 'shutdown']) {
      const harness = fixture(t);
      const started = await harness.manager.command(engine, 'goal-start', { objective: 'Finish' });
      const goal = harness.manager.goalFor(started.sessionId);
      goal.drive(); await harness.flush();
      harness.finish(engine, 'success', '<goal:complete>');
      await harness.flush();
      const verifier = harness.sent.at(-1);
      const verifierId = verifier.opts.conversationId;
      assert.notEqual(verifierId, started.sessionId);
      assert.equal(verifier.session.running, true);
      const unrelated = await harness.manager.send(engine, { prompt: 'Unrelated work' });
      const unrelatedSession = harness.sent.at(-1).session;
      if (action === 'cancel') await harness.manager.cancel({ sessionId: started.sessionId });
      else if (action === 'shutdown') harness.manager.pauseGoals();
      else await harness.manager.command(engine, action, { sessionId: started.sessionId });
      await harness.flush();
      assert.equal(verifier.session.running, false, engine + ': ' + action);
      assert.equal(harness.manager.active.has(verifierId), false);
      assert.equal(harness.manager.items.has(verifierId), false);
      assert.equal(harness.manager.goals.has(verifierId), false);
      assert.equal(fs.existsSync(harness.manager.file(verifierId)), false);
      assert.equal(unrelatedSession.running, true);
      assert.equal(goal.view()?.verified ?? null, null);
      assert.equal(goal.view()?.phase ?? null, action === 'goal-clear' ? null : action === 'goal-complete' ? 'complete' : 'paused');
      harness.finish(engine, 'success', 'Done', unrelatedSession);
      await unrelated.done;
    }
  }
});

test('pausing during verifier setup prevents dispatch and cleans up after setup settles', async t => {
  const harness = fixture(t);
  const started = await harness.manager.command('codex', 'goal-start', { objective: 'Finish' });
  const goal = harness.manager.goalFor(started.sessionId);
  goal.drive(); await harness.flush();
  let release;
  harness.manager.prepare = () => new Promise(resolve => { release = resolve; });
  harness.finish('codex', 'success', '<goal:complete>');
  await harness.flush();
  const verifierId = [...harness.manager.active.keys()][0];
  assert.notEqual(verifierId, started.sessionId);
  await harness.manager.command('codex', 'goal-pause', { sessionId: started.sessionId });
  release(); await harness.flush();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.manager.active.has(verifierId), false);
  assert.equal(harness.manager.items.has(verifierId), false);
  assert.equal(goal.view().phase, 'paused');
  assert.equal(goal.view().verified, null);
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

test('portable compaction retains recent interactions exactly across restart and subsequent compaction', async context => {
  const logs = [], statuses = [];
  const harness = fixture(context, { log: value => logs.push(value), onStatus: value => statuses.push(value) });
  const manager = harness.manager, conversation = manager.create('kimi');
  manager.append(conversation, { role: 'user', text: 'OLD_TASK_MARKER' });
  manager.append(conversation, { role: 'assistant', text: 'Old result' });
  manager.append(conversation, { role: 'user', text: 'RECENT_TASK_MARKER', attachments: [{ path: 'recent.csv' }] });
  manager.append(conversation, { role: 'tool', text: 'EXACT_TOOL_RESULT_中文😀' });
  manager.append(conversation, { role: 'assistant', text: 'EXACT_RECENT_ANSWER' });
  const pending = manager.compact(conversation.id);
  await harness.flush();
  assert.match(harness.sent.at(-1).prompt, /OLD_TASK_MARKER/);
  assert.doesNotMatch(harness.sent.at(-1).prompt, /RECENT_TASK_MARKER|EXACT_TOOL_RESULT/);
  const session = harness.sent.at(-1).session;
  manager.capture('kimi', { type: 'stream_event', runId: session.gen, event: { delta: { type: 'thinking_delta', thinking: 'Working' } } });
  manager.capture('kimi', { type: 'gui:usage', runId: session.gen, usage: { input_tokens: 100, cache_read_input_tokens: 80, output_tokens: 10 } });
  harness.finish('kimi', 'success', 'SUMMARY_OF_OLD_TASK');
  const compacted = await pending;
  const markdown = fs.readFileSync(compacted.file, 'utf8');
  assert.match(markdown, /SUMMARY_OF_OLD_TASK/);
  assert.match(markdown, /RECENT_TASK_MARKER/);
  assert.match(markdown, /EXACT_TOOL_RESULT_中文😀/);
  assert.match(markdown, /recent.csv/);
  assert.equal(conversation.lastCompaction.reason, 'manual-native-unavailable');
  assert.equal(conversation.lastCompaction.requests, 1);
  assert.equal(conversation.lastCompaction.boundary, 5);
  assert.ok(conversation.lastCompaction.retainedChars > 0);
  assert.ok(conversation.lastCompaction.chunks[0].firstDeltaMs >= 0);
  assert.equal(conversation.lastCompaction.chunks[0].usage.cache_read_input_tokens, 80);
  assert.ok(statuses.some(value => value.compaction?.chunk === 1 && value.compaction.finalChunk));
  assert.ok(statuses.some(value => value.compaction?.stage === 'saving'));
  assert.ok(logs.some(value => value.includes('context compaction metrics:')));
  assert.ok(logs.every(value => !/EXACT_TOOL_RESULT|RECENT_TASK_MARKER|SUMMARY_OF_OLD_TASK/.test(value)));
  const restored = harness.restart(), restoredConversation = restored.get(conversation.id);
  assert.match(restored.context(restoredConversation, 'kimi'), /EXACT_RECENT_ANSWER/);
  assert.equal(restoredConversation.lastCompaction.requests, 1);
  const again = restored.compact(conversation.id);
  await harness.flush();
  assert.match(harness.sent.at(-1).prompt, /SUMMARY_OF_OLD_TASK/);
  assert.match(harness.sent.at(-1).prompt, /RECENT_TASK_MARKER/);
  harness.finish('kimi', 'success', 'Second summary');
  await again;
});

test('portable summary enforces a bounded output without replacing context on failure', async context => {
  const harness = fixture(context);
  const manager = harness.manager, conversation = manager.create('dsh');
  manager.append(conversation, { role: 'user', text: 'Task' });
  const pending = manager.compact(conversation.id);
  const rejected = assert.rejects(pending, /summary is too large/);
  await harness.flush();
  assert.match(harness.sent.at(-1).prompt, /under 12000 characters/);
  harness.finish('dsh', 'success', 'x'.repeat(12001));
  await rejected;
  assert.equal(manager.rows(conversation).some(row => row.file), false);
  assert.equal(conversation.lastCompaction.outcome, 'failed');
  assert.equal(conversation.lastCompaction.chunks[0].outputChars, 12001);
});

test('native compaction diagnostics distinguish supported and unsupported routes', async context => {
  const native = await nativeFixture(context, async () => {});
  await native.manager.compact(native.conversation.id);
  assert.equal(native.conversation.lastCompaction.route, 'native');
  assert.equal(native.conversation.lastCompaction.reason, 'native-eligible');
  assert.equal(native.conversation.lastCompaction.requests, 0);
  assert.ok(native.conversation.lastCompaction.nativeMs >= 0);
  const fallback = await nativeFixture(context, async () => { throw Object.assign(new Error('Unsupported'), { code: -32601 }); });
  const pending = fallback.manager.compact(fallback.conversation.id);
  await fallback.flush();
  fallback.finish('codex', 'success', 'Portable summary');
  await pending;
  assert.equal(fallback.conversation.lastCompaction.route, 'portable');
  assert.equal(fallback.conversation.lastCompaction.reason, 'native-unsupported');
});

test('overflow moves an over-budget recent tail into summarization instead of losing it', async context => {
  const harness = fixture(context, { modelContextWindow: () => 20000 });
  const manager = harness.manager, conversation = manager.create('kimi');
  manager.append(conversation, { role: 'user', text: 'OLD_HISTORY ' + 'x'.repeat(16000) });
  manager.append(conversation, { role: 'user', text: 'RETAINED_HISTORY ' + 'z'.repeat(5000) });
  const pending = manager.compact(conversation.id);
  await harness.flush();
  assert.doesNotMatch(harness.sent.at(-1).prompt, /RETAINED_HISTORY/);
  harness.finish('kimi', 'error', 'maximum context length is 4000 tokens');
  await harness.flush();
  for (let index = 0; manager.busy(conversation.id); index++) {
    assert.ok(index < 10);
    harness.finish('kimi', 'success', 'Small summary');
    await harness.flush();
  }
  await pending;
  assert.ok(harness.sent.some(request => request.prompt.includes('RETAINED_HISTORY')));
  assert.equal(conversation.lastCompaction.retainedChars, 0);
  assert.equal(conversation.lastCompaction.retries, 1);
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
  const statuses = [];
  const f = fixture(t, { modelContextWindow: () => 20000, onStatus: status => statuses.push(status) });
  const conversation = f.manager.create('codex', null, 'Pending setup');
  f.manager.append(conversation, { role: 'tool', text: 'x'.repeat(52000) });
  let release;
  f.manager.prepare = () => new Promise(resolve => { release = resolve; });
  const rejected = assert.rejects(f.manager.send('codex', { sessionId: conversation.id, prompt: 'Do not run' }), /canceled/);
  assert.deepEqual(statuses.at(-1), { sessionId: conversation.id, text: 'Compacting context before continuing the task…', compaction: { state: 'running' } });
  assert.equal(f.manager.load('codex', conversation.id).compaction.state, 'running');
  await f.manager.cancel({ sessionId: conversation.id });
  release();
  await rejected;
  assert.equal(f.sent.length, 0);
  assert.equal(f.manager.busy(conversation.id), false);
  assert.equal(statuses.at(-1).text, '');
  assert.equal(statuses.at(-1).compaction.state, 'cancelled');
  assert.equal(f.manager.load('codex', conversation.id).compaction, null);
});

test('resending after stop reports internal compaction before the visible turn starts', async context => {
  const statuses = [];
  const harness = fixture(context, { modelContextWindow: () => 20000, onStatus: status => statuses.push(status) });
  const first = await harness.manager.send('codex', { prompt: 'Inspect the project' });
  await harness.manager.cancel({ sessionId: first.sessionId, runId: first.runId });
  assert.equal((await first.done).subtype, 'stopped');
  const conversation = harness.manager.get(first.sessionId);
  harness.manager.append(conversation, { role: 'tool', text: 'x'.repeat(52000) });
  let accepted = false;
  const pending = harness.manager.command('codex', 'send', { sessionId: conversation.id, prompt: 'Continue' }).then(result => {
    accepted = true;
    return result;
  });
  await harness.flush();
  assert.equal(accepted, false);
  assert.equal(statuses.at(-1).text, 'Asking the engine to summarize the conversation…');
  assert.equal(harness.events.filter(event => event.type === 'conversation:started').length, 1);
  while (/compact working context/.test(harness.sent.at(-1).prompt)) {
    harness.finish('codex', 'success', 'Summary of earlier work');
    await harness.flush();
  }
  const next = await pending;
  assert.equal(next.ok, true);
  assert.equal(statuses.at(-1).text, '');
  const completed = statuses.find(status => status.compaction?.state === 'completed');
  assert.equal(completed.compaction.seq, harness.manager.messages(conversation).findLast(row => row.role === 'notice').seq);
  assert.equal(harness.manager.load('codex', conversation.id).compaction, null);
  assert.equal(harness.events.filter(event => event.type === 'conversation:started').length, 2);
  harness.finish('codex', 'success', 'Continued response');
  assert.equal(harness.events.filter(event => event.type === 'result').at(-1).runId, next.runId);
  assert.equal(harness.manager.busy(conversation.id), false);
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

test('native usage including cache overrides inflated history and survives reload', async t => {
  for (const engine of ENGINES) {
    const harness = fixture(t, { modelContextWindow: () => 20000 });
    const run = await harness.manager.send(engine, { prompt: 'Work' });
    const conversation = harness.manager.get(run.sessionId);
    const emit = event => harness.manager.capture(engine, { ...event, runId: harness.sent.at(-1).session.gen });
    emit({ type: 'gui:usage', usage: { input_tokens: 1000, cache_read_input_tokens: 3000, cache_creation_input_tokens: 1000, context_window: 40000 } });
    emit({ type: 'gui:tool', id: 'large', status: 'completed', output: 'x'.repeat(90000) });
    assert.equal(harness.manager.recovering.size, 0);
    const pressure = harness.manager.contextPressure(conversation, engine, harness.manager.settings(engine, conversation.id));
    assert.equal(pressure.source, 'usage');
    assert.equal(pressure.used, 5000);
    assert.equal(pressure.cap, 40000);
    assert.ok(pressure.estimate > 30000);
    harness.finish(engine);
    await run.done;
    const manager = harness.restart();
    const next = await manager.send(engine, { sessionId: conversation.id, prompt: 'Continue' });
    assert.equal(harness.sent.length, 2);
    assert.doesNotMatch(harness.sent.at(-1).prompt, /compact working context/);
    harness.finish(engine);
    await next.done;
  }
});

test('usage approaching the reported window triggers compaction with diagnostics', async t => {
  for (const engine of ENGINES) {
    const logs = [];
    const harness = fixture(t, { modelContextWindow: () => 200000, log: text => logs.push(text) });
    const run = await harness.manager.send(engine, { prompt: 'Work' });
    const emit = event => harness.manager.capture(engine, { ...event, runId: harness.sent.at(-1).session.gen });
    emit({ type: 'gui:usage', usage: { input_tokens: 1000, cache_read_input_tokens: 17000, context_window: 20000 } });
    emit({ type: 'gui:tool', id: 'done', status: 'completed', output: 'Done' });
    await harness.flush();
    assert.match(harness.sent.at(-1).prompt, /compact working context/);
    emit({ type: 'gui:usage', usage: { input_tokens: 999999, context_window: 1000000 } });
    harness.finish(engine, 'success', 'Working summary');
    await harness.flush();
    const conversation = harness.manager.get(run.sessionId);
    const notice = harness.manager.rows(conversation).findLast(row => row.compaction);
    assert.equal(notice.compaction.reason, 'tool-boundary');
    assert.equal(notice.compaction.source, 'usage');
    assert.equal(notice.compaction.used, 18000);
    assert.equal(notice.compaction.cap, 20000);
    assert.doesNotMatch(notice.text, /exceeded/);
    assert.ok(logs.some(text => text.includes('tool-boundary')));
    assert.equal(conversation.segments[engine].contextUsage, undefined);
    harness.finish(engine);
    await run.done;
  }
});

test('pre-send usage triggers compaction and changed settings discard stale usage', async t => {
  const harness = fixture(t, { modelContextWindow: () => 200000 });
  const run = await harness.manager.send('codex', { prompt: 'Work' });
  const manager = harness.manager, conversation = manager.get(run.sessionId);
  manager.capture('codex', { type: 'gui:usage', runId: harness.sent.at(-1).session.gen, usage: { input_tokens: 18000, context_window: 20000 } });
  harness.finish('codex');
  const settings = manager.settings('codex', conversation.id);
  for (const patch of [{ model: 'other' }, { connection: 'subscription' }, { contextWindow: 10000 }]) {
    const pressure = manager.contextPressure(conversation, 'codex', { ...settings, ...patch });
    assert.equal(pressure.source, 'estimate');
    assert.equal(pressure.cap, patch.contextWindow || 200000);
  }
  const pending = manager.send('codex', { sessionId: conversation.id, prompt: 'Next' });
  await harness.flush();
  assert.match(harness.sent.at(-1).prompt, /compact working context/);
  harness.finish('codex', 'success', 'Summary');
  const next = await pending;
  assert.equal(manager.rows(conversation).findLast(row => row.compaction).compaction.reason, 'before-send');
  harness.finish('codex');
  await next.done;
});

test('large replay below the token window is not compacted at the old character cutoff', async t => {
  const harness = fixture(t), manager = harness.manager;
  const conversation = manager.create('codex');
  manager.append(conversation, { role: 'user', text: 'Earlier task' });
  manager.append(conversation, { role: 'assistant', text: 'x'.repeat(250000) });
  const run = await manager.send('codex', { sessionId: conversation.id, prompt: 'Continue' });
  assert.ok(harness.sent.at(-1).prompt.length > 220000);
  assert.doesNotMatch(harness.sent.at(-1).prompt, /compact working context/);
  harness.finish('codex');
  await run.done;
});

test('native compaction lowers pressure and replacing the native session clears usage', async t => {
  const harness = fixture(t, { modelContextWindow: () => 20000 });
  const run = await harness.manager.send('codex', { prompt: 'Work' });
  const manager = harness.manager, conversation = manager.get(run.sessionId);
  const emit = event => manager.capture('codex', { ...event, runId: harness.sent.at(-1).session.gen });
  emit({ type: 'gui:usage', usage: { input_tokens: 19000, context_window: 20000 } });
  emit({ type: 'gui:usage', usage: { input_tokens: 2000, context_window: 20000 } });
  emit({ type: 'gui:tool', id: 'large', status: 'completed', output: 'x'.repeat(90000) });
  assert.equal(manager.recovering.size, 0);
  assert.equal(manager.contextPressure(conversation, 'codex', manager.settings('codex', conversation.id)).used, 2000);
  emit({ type: 'system', subtype: 'init', session_id: 'replacement-native' });
  assert.equal(conversation.segments.codex.contextUsage, undefined);
  assert.equal(manager.contextPressure(conversation, 'codex', manager.settings('codex', conversation.id)).source, 'estimate');
  harness.finish('codex');
  await run.done;
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

test('learned context budgets persist and stay isolated by model, connection and route', async context => {
  let route = 'provider-one';
  const harness = fixture(context, { modelContextWindow: () => 128000, contextRoute: () => route });
  const manager = harness.manager, conversation = manager.create('kimi');
  const settings = manager.settings('kimi', conversation.id);
  assert.equal(manager.reduceContextBudget(conversation, 'kimi', settings, 'maximum context length is 32,768 tokens'), 32768);
  assert.equal(manager.contextPressure(conversation, 'kimi', settings).cap, 32768);
  assert.equal(manager.reduceContextBudget(conversation, 'kimi', settings, 'context_length_exceeded'), 16384);
  for (const patch of [{ model: 'other' }, { connection: 'subscription' }])
    assert.equal(manager.contextPressure(conversation, 'kimi', { ...settings, ...patch }).cap, 128000);
  route = 'provider-two';
  assert.equal(manager.contextPressure(conversation, 'kimi', settings).cap, 128000);
  route = 'provider-one';
  const restarted = harness.restart();
  assert.equal(restarted.contextPressure(restarted.get(conversation.id), 'kimi', settings).cap, 16384);
});

test('summary overflow shrinks fresh requests and retries the same history fragment', async context => {
  const harness = fixture(context, { modelContextWindow: () => 20000 });
  const manager = harness.manager, conversation = manager.create('kimi');
  manager.append(conversation, { role: 'user', text: 'START-OF-HISTORY ' + 'x'.repeat(30000) + ' END-OF-HISTORY' });
  const pending = manager.compact(conversation.id);
  await harness.flush();
  const originalSize = harness.sent.at(-1).prompt.length;
  harness.finish('kimi', 'error', 'maximum context length is 8000 tokens');
  await harness.flush();
  assert.ok(harness.sent.at(-1).prompt.length < originalSize);
  assert.match(harness.sent.at(-1).prompt, /START-OF-HISTORY/);
  let fragments = 0;
  while (manager.busy(conversation.id)) {
    assert.ok(++fragments < 10);
    assert.equal(harness.sent.at(-1).opts.sessionId, null);
    harness.finish('kimi', 'success', 'Saved task and progress');
    await harness.flush();
  }
  assert.ok((await pending).file);
  assert.ok(harness.sent.some(request => request.prompt.includes('END-OF-HISTORY')));
  assert.equal(conversation.compactionRecovery, undefined);
  assert.equal(manager.contextPressure(conversation, 'kimi', manager.settings('kimi', conversation.id)).cap, 8000);
});

test('summary rescue rebuilds from full history if the accumulated summary no longer fits', async context => {
  const harness = fixture(context, { modelContextWindow: () => 20000 });
  const manager = harness.manager, conversation = manager.create('dsh');
  manager.append(conversation, { role: 'user', text: 'HISTORY-START ' + 'x'.repeat(60000) + ' HISTORY-END' });
  const pending = manager.compact(conversation.id);
  await harness.flush();
  harness.finish('dsh', 'success', 's'.repeat(11000));
  await harness.flush();
  harness.finish('dsh', 'error', 'maximum context length is 4000 tokens');
  await harness.flush();
  assert.match(harness.sent.at(-1).prompt, /HISTORY-START/);
  assert.ok(harness.sent.at(-1).prompt.length <= 7200);
  let fragments = 0;
  while (manager.busy(conversation.id)) {
    assert.ok(++fragments < 20);
    harness.finish('dsh', 'success', 'Small summary');
    await harness.flush();
  }
  assert.ok((await pending).file);
  assert.ok(harness.sent.at(-1).prompt.includes('HISTORY-END'));
});

test('summary rescue exhaustion retains native mapping, full history and a partial checkpoint', async context => {
  const harness = fixture(context, { modelContextWindow: () => 100000 });
  const run = await harness.manager.send('kimi', { prompt: 'Original task' });
  harness.finish('kimi'); await run.done;
  const manager = harness.manager, conversation = manager.get(run.sessionId);
  manager.append(conversation, { role: 'tool', text: 'x'.repeat(200000) });
  const snapshot = JSON.stringify(conversation.segments);
  const pending = manager.compact(conversation.id);
  const rejected = assert.rejects(pending, /rescue retry limit.*original history is retained/);
  await harness.flush();
  harness.finish('kimi', 'success', 'Checkpoint: file already written');
  await harness.flush();
  for (let attempt = 0; attempt < 5; attempt++) {
    harness.finish('kimi', 'error', 'context_length_exceeded');
    await harness.flush();
  }
  await rejected;
  assert.equal(manager.busy(conversation.id), false);
  assert.equal(JSON.stringify(conversation.segments), snapshot);
  assert.equal(conversation.compactionRecovery.summary, 'Checkpoint: file already written');
  assert.equal(conversation.compactionRecovery.partial, true);
  assert.equal(manager.rows(conversation).filter(row => row.role === 'notice' && row.file).length, 0);
  assert.ok(manager.rows(conversation).some(row => row.text.length === 200000));
  assert.equal(harness.restart().get(conversation.id).compactionRecovery.summary, 'Checkpoint: file already written');
});

test('native compaction overflow falls back to a fresh portable summary without disabling native support', async context => {
  const harness = await nativeFixture(context, async () => { throw new Error('maximum context length is 8192 tokens'); });
  const pending = harness.manager.compact(harness.conversation.id);
  await harness.flush();
  assert.equal(harness.sent.at(-1).opts.sessionId, null);
  assert.match(harness.sent.at(-1).prompt, /compact working context/);
  harness.finish('codex', 'success', 'Task checkpoint');
  assert.ok((await pending).file);
  assert.equal(harness.conversation.segments.codex.nativeCompactionUnsupported, undefined);
});

test('stopping a shrinking summary request never retries or continues the task', async context => {
  const harness = fixture(context);
  const run = await harness.manager.send('kimi', { prompt: 'Work' });
  harness.finish('kimi', 'error', 'context_length_exceeded');
  await harness.flush();
  harness.finish('kimi', 'error', 'context_length_exceeded');
  await harness.flush();
  const sent = harness.sent.length;
  await harness.manager.cancel({ sessionId: run.sessionId, runId: run.runId });
  assert.equal((await run.done).subtype, 'stopped');
  await harness.flush();
  assert.equal(harness.sent.length, sent);
  assert.equal(harness.manager.busy(run.sessionId), false);
});

test('an oversized continuation stops without sending the original task again', async context => {
  const harness = fixture(context, { modelContextWindow: () => 20000 });
  const run = await harness.manager.send('kimi', { prompt: 'x'.repeat(15000) });
  harness.finish('kimi', 'error', 'maximum context length is 4096 tokens');
  await harness.flush();
  let summaries = 0;
  while (harness.manager.busy(run.sessionId)) {
    assert.ok(++summaries < 10);
    assert.match(harness.sent.at(-1).prompt, /compact working context/);
    harness.finish('kimi', 'success', 'Compact task');
    await harness.flush();
  }
  const result = await run.done;
  assert.equal(result.is_error, true);
  assert.match(result.result, /continuation is still too large.*[\s\S]*Split oversized messages/);
  assert.equal(harness.sent.length, summaries + 1);
  assert.equal(harness.manager.busy(run.sessionId), false);
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
