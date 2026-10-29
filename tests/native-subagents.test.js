'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeSubagents } = require('../src/engines/native-subagents');
const { KimiSubagents } = require('../src/engines/kimi-subagents');
const { AcpSession } = require('../src/engines/acp-session');
const { GrokSession } = require('../src/engines/grok-session');
const { removeTree } = require('./test-fs.cjs');

function fixture(engine = 'dsh', Class = AcpSession) {
  const events = [], writes = [];
  const session = new Class({ name: engine, gen: 1, settings: {}, opts: {}, spec: { modeEngine: engine },
    log() {}, onEvent: event => events.push(event), onResult() {} });
  Object.assign(session, { sessionId: 'root', running: true, replayEvents: [], text: '', startedAt: Date.now(),
    proc: { stdin: { write: line => writes.push(JSON.parse(line)) } } });
  return { session, events, writes };
}
const tool = (name, input, output, status = 'in_progress') => ({ id: 'call', name, input, output, status });

test('native background launch receipts retain a single live child until its own completion', () => {
  const events = [], tracker = new NativeSubagents('claude', task => events.push(task));
  tracker.observe(tool('Agent', { description: 'Check files', prompt: 'Inspect the parser', run_in_background: true }));
  tracker.observe(tool('Agent', {}, 'Task launched', 'completed'), { rawOutput: { isAsync: true, status: 'async_launched', agentId: 'native-child' } });
  assert.equal(tracker.children.size, 1);
  assert.equal(tracker.children.get(tracker.resolve('native-child')).status, 'running');
  tracker.native('native-child', { toolCallId: 'call', status: 'completed', result: 'Actual child answer' });
  tracker.observe(tool('Agent', {}, 'Task launched', 'completed'), { rawOutput: { isAsync: true, agentId: 'native-child' } });
  assert.equal(tracker.children.size, 1);
  assert.equal(events.at(-1).status, 'completed'); assert.equal(events.at(-1).result, 'Actual child answer');
});

test('native Kimi swarm and SDK batch calls produce one task per child', () => {
  const tracker = new NativeSubagents('kimi', () => {});
  tracker.observe(tool('AgentSwarm', { description: 'Review sources', items: ['one', 'two'], prompt_template: 'Inspect {{item}}' }));
  assert.equal(tracker.children.size, 2);
  tracker.observe(tool('AgentSwarm', {}, '<agent_swarm_result><subagent agent_id="a" outcome="completed">First answer</subagent><subagent agent_id="b" outcome="failed">Second failed</subagent></agent_swarm_result>', 'completed'));
  assert.equal(tracker.children.get(tracker.resolve('a')).result, 'First answer');
  assert.equal(tracker.children.get(tracker.resolve('b')).status, 'failed');
  const sdk = new NativeSubagents('antigravity', () => {});
  sdk.observe(tool('start_subagent', { Subagents: [{ Role: 'Reader one', Prompt: 'Read one' }, { Role: 'Reader two', Prompt: 'Read two' }] }));
  sdk.observe(tool('start_subagent', {}, 'Launched both', 'completed'));
  assert.equal(sdk.children.size, 2); assert.ok([...sdk.children.values()].every(task => task.status === 'running'));
  sdk.native('trajectory-two', { toolCallId: 'call', slot: 1, status: 'completed', result: 'Read two result' });
  assert.equal(sdk.children.size, 2); assert.equal(sdk.children.get(sdk.resolve('trajectory-two')).title, 'Reader two');
});

test('ordinary shell jobs, task lists and prose containing agent are not subagents', () => {
  for (const engine of ['dsh', 'kimi', 'grok', 'antigravity']) {
    const tracker = new NativeSubagents(engine, () => {});
    for (const name of ['Bash', 'TaskList', 'job_output', 'Read agent documentation']) tracker.observe(tool(name, { run_in_background: true }));
    assert.equal(tracker.children.size, 0, engine);
  }
});

test('model-assigned tool IDs reused in a later turn cannot overwrite the earlier child', () => {
  const tracker = new NativeSubagents('claude', () => {});
  tracker.begin(); tracker.observe(tool('Agent', { prompt: 'First task' }));
  tracker.observe(tool('Agent', {}, 'First result', 'completed'));
  tracker.begin(); tracker.observe(tool('Agent', { prompt: 'Second task' }));
  assert.equal(tracker.children.size, 2);
  const tasks = [...tracker.children.values()];
  assert.equal(tasks[0].result, 'First result'); assert.equal(tasks[1].status, 'running');
});

test('out-of-order snapshots and Agent receipts merge by exact native IDs even with identical titles', () => {
  const replaced = [], tracker = new NativeSubagents('claude', (task, ids) => { if (ids) replaced.push(...ids); });
  tracker.observe({ ...tool('Agent', { description: 'Worker', prompt: 'First goal', run_in_background: true }), id: 'call-one' });
  tracker.observe({ ...tool('Agent', { description: 'Worker', prompt: 'Second goal', run_in_background: true }), id: 'call-two' });
  tracker.native('native-two', { title: 'Worker', status: 'running' });
  tracker.native('native-one', { title: 'Worker', status: 'running' });
  tracker.native('native-two', { toolCallId: 'call-two', status: 'running' });
  tracker.native('native-one', { toolCallId: 'call-one', status: 'completed', result: 'First result' });
  assert.equal(tracker.children.size, 2);
  assert.equal(tracker.children.get(tracker.resolve('native-one')).goal, 'First goal');
  assert.equal(tracker.children.get(tracker.resolve('native-two')).goal, 'Second goal');
  assert.deepEqual(replaced.sort(), ['native-one', 'native-two']);
});

test('ACP child approvals survive parent completion and resolve the original wire request once', async () => {
  const { session, events, writes } = fixture();
  session.update({ sessionUpdate: 'camellia_subagent', task: { id: 'child', status: 'running', turnId: 'epoch', canStop: true } });
  assert.equal(session.children.get('child').canStop, false, 'unsupported native controls remain hidden');
  session.receive({ id: 'approval', method: 'session/request_permission', params: { sessionId: 'root',
    _meta: { camelliaSubagentId: 'child' }, toolCall: { title: 'Write', rawInput: { path: 'fixture.txt' } },
    options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });
  assert.equal(events.some(event => event.type === 'gui:permission'), false);
  assert.equal(session.children.get('child').status, 'waiting');
  session.finish({ subtype: 'success' });
  assert.ok(session.permissions.has('approval'));
  await session.controlChild('child', { operation: 'approve', approvalId: 'approval', response: { allow: true } });
  assert.equal(writes.at(-1).id, 'approval'); assert.equal(writes.at(-1).result.outcome.optionId, 'yes');
  await assert.rejects(session.controlChild('child', { operation: 'approve', approvalId: 'approval', response: { allow: true } }), /changed/);
  await assert.rejects(session.controlChild('child', { operation: 'stop', expectedTurnId: 'epoch' }), /does not support/);
});

test('ACP child results remain live after the parent turn and disconnect without invented success', () => {
  const { session } = fixture();
  session.update({ sessionUpdate: 'camellia_subagent', task: { id: 'a', status: 'running' } });
  session.update({ sessionUpdate: 'camellia_subagent', task: { id: 'b', status: 'running' } });
  session.finish({ subtype: 'success' });
  session.receive({ method: 'session/update', params: { sessionId: 'root', update: {
    sessionUpdate: 'camellia_subagent', task: { id: 'a', status: 'completed', result: 'Late answer' },
  } } });
  session.close(new Error('closed'));
  assert.equal(session.children.get('a').result, 'Late answer');
  assert.equal(session.children.get('b').status, 'unavailable');
});

test('Grok native child streams and terminal events stay attributed after the parent finishes', () => {
  const { session, events } = fixture('grok', GrokSession);
  session.update({ sessionUpdate: 'tool_call', toolCallId: 'spawn', title: 'spawn_subagent', status: 'in_progress',
    rawInput: { description: 'Inspect parser', prompt: 'Inspect the parser' } });
  session.receive({ method: '_x.ai/session_notification', params: { sessionId: 'root', update: {
    sessionUpdate: 'subagent_spawned', subagent_id: 'agent', child_session_id: 'child-session', description: 'Inspect parser', attempt_id: 'attempt',
  } } });
  session.finish({ subtype: 'success' });
  const count = events.filter(event => event.type === 'stream_event').length;
  session.receive({ method: 'session/update', params: { sessionId: 'unrelated', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Private outsider' } } } });
  session.receive({ method: 'session/update', params: { sessionId: 'child-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child result' } } } });
  session.receive({ method: '_x.ai/session_notification', params: { sessionId: 'child-session', update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' } } });
  assert.equal(session.children.size, 1);
  const task = session.children.get(session.subagents.resolve('agent'));
  assert.equal(task.status, 'completed'); assert.equal(task.result, 'Child result');
  assert.equal(events.filter(event => event.type === 'stream_event').length, count);
});

test('Grok child session routes and streamed text survive late native identity merges', () => {
  const { session } = fixture('grok', GrokSession);
  for (const id of ['one', 'two']) session.update({ sessionUpdate: 'tool_call', toolCallId: id,
    title: 'spawn_subagent', status: 'in_progress', rawInput: { description: 'Worker', prompt: 'Inspect ' + id } });
  const receive = (method, sessionId, update) => session.receive({ method, params: { sessionId, update } });
  receive('_x.ai/session_notification', 'root', { sessionUpdate: 'subagent_spawned',
    subagent_id: 'native-two', child_session_id: 'session-two', description: 'Worker', attempt_id: 'turn-two' });
  receive('session/update', 'session-two', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading' } });
  session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'two', status: 'completed',
    rawOutput: { subagent_id: 'native-two', status: 'running' } });
  assert.equal(session.children.size, 2);
  receive('session/update', 'session-two', { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read source' });
  const child = () => session.children.get(session.subagents.resolve('native-two'));
  assert.equal(child().goal, 'Inspect two');
  assert.equal(child().history.at(-1).text, 'Read source');
  receive('session/update', 'session-two', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' complete' } });
  receive('_x.ai/session_notification', 'session-two', { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' });
  assert.equal(child().result, 'Reading complete');
  assert.equal(child().status, 'completed');
  assert.equal(session.children.size, 2);
});

test('Kimi journal recovery ignores old history, reads split UTF-8, and settles background children without locks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-kimi-children-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('camellia-kimi-children-')); removeTree(root); });
  const dir = path.join(root, 'sessions', 'workspace', 'root', 'agents');
  fs.mkdirSync(path.join(dir, 'main'), { recursive: true }); fs.mkdirSync(path.join(dir, 'agent-0'));
  const main = path.join(dir, 'main', 'wire.jsonl'), child = path.join(dir, 'agent-0', 'wire.jsonl');
  fs.writeFileSync(main, JSON.stringify({ type: 'subagent.spawned', subagentId: 'old-agent', parentToolCallId: 'old' }) + '\n');
  const { session, events } = fixture('kimi');
  const observer = new KimiSubagents(session, root); t.after(() => observer.stop());
  await observer.begin(); observer.stop();
  const append = (file, rows) => fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  append(main, [{ type: 'turn.prompt', turnId: 1 }, { type: 'subagent.spawned', subagentId: 'agent-0', parentAgentId: 'main', parentToolCallId: 'spawn', description: 'Inspect source' }]);
  const line = Buffer.from(JSON.stringify({ type: 'agent.message.appended', message: { message: { role: 'assistant', content: [{ type: 'text', text: '中文🙂 progress' }] } } }) + '\n');
  const cut = line.indexOf(Buffer.from('🙂')) + 2;
  fs.writeFileSync(child, line.subarray(0, cut)); await observer.poll();
  assert.equal(session.children.has('old-agent'), false);
  fs.appendFileSync(child, line.subarray(cut)); await observer.poll();
  assert.equal(session.children.get('agent-0').progress, '中文🙂 progress');
  session.running = false;
  append(main, [{ type: 'subagent.completed', subagentId: 'agent-0', resultSummary: 'Final child answer' }]);
  append(child, [{ type: 'turn.prompt', turnId: 0 }, { type: 'turn.ended', reason: 'completed' }]);
  const before = events.length; await observer.poll();
  assert.equal(session.children.get('agent-0').result, 'Final child answer');
  assert.ok(events.slice(before).filter(event => event.type === 'gui:subagent').every(event => event.task.status === 'completed'));
  observer.row('main', { type: 'subagent.spawned', subagentId: '../unrelated' });
  assert.equal(session.children.has('../unrelated'), false);
});

test('Kimi one-based swarm indices and late journal starts preserve both completed tool results', () => {
  const { session, events } = fixture('kimi'), tracker = session.subagents;
  const observer = new KimiSubagents(session, 'unused');
  const call = { ...tool('AgentSwarm', { items: ['one', 'two'], prompt_template: 'Inspect {{item}}' }), id: '1:spawn' };
  tracker.observe(call);
  tracker.observe({ ...call, status: 'completed', output: '<agent_swarm_result><subagent agent_id="a" outcome="completed">First result</subagent><subagent agent_id="b" outcome="completed">Second result</subagent></agent_swarm_result>' });
  const before = events.length;
  observer.row('main', { type: 'turn.prompt', turnId: 1 });
  observer.row('main', { type: 'subagent.spawned', subagentId: 'b', parentToolCallId: 'spawn', swarmIndex: 2 });
  observer.row('main', { type: 'subagent.started', subagentId: 'b' });
  observer.row('main', { type: 'subagent.spawned', subagentId: 'a', parentToolCallId: 'spawn', swarmIndex: 1 });
  assert.equal(tracker.children.size, 2);
  assert.equal(tracker.children.get(tracker.resolve('a')).goal, 'Inspect one');
  assert.equal(tracker.children.get(tracker.resolve('b')).result, 'Second result');
  assert.ok(events.slice(before).every(event => event.task.status === 'completed'));
});
