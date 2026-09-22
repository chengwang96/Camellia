'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const net = require('node:net');
const { createGoalToolBridge } = require('../src/engines/goal-tool-bridge');
const { matchesUserRequest, validateTool, instructions } = require('../src/engines/goal-tools');

test('packaged stdio helper includes every local tool schema dependency', () => {
  const unpacked = require('../package.json').build.asarUnpack;
  for (const file of ['goal-mcp-stdio.js', 'goal-tools.js', 'task-tools.js', 'conversation-tools.js'])
    assert.ok(unpacked.includes('src/engines/' + file), file);
});

test('request provenance accepts natural language anywhere in the current message without classifying intent', () => {
  for (const prompt of ['设定目标：完成测试', '请帮我设置目标：完成测试', 'Set a goal: finish the tests', 'Please enter Goal mode', '帮我做一个任务，设定一个 goal', '先修复登录问题。\n能帮我设个 goal，直到测试通过吗？', 'Could you set a goal to finish the tests?', '请设定目标，修好它，别修改无关文件']) assert.equal(matchesUserRequest(prompt, prompt), true, prompt);
  assert.equal(matchesUserRequest('先修复登录问题。\n能帮我设个 goal，直到测试通过吗？', '能帮我设个 goal'), true);
  for (const quote of ['', '   ', 'Set a goal', undefined, null, 1]) assert.equal(matchesUserRequest('检查实现', quote), false);
  assert.equal(matchesUserRequest(undefined, 'Set a goal'), false);
  assert.equal(matchesUserRequest('讨论如何设定目标', '设定目标'), true);
  assert.match(instructions, /Discussion, negation and hypothetical requests are not authorization/);
  assert.match(instructions, /never require a special phrase, prefix or punctuation/);
  assert.throws(() => validateTool('camellia_get_goal', { run_token: 'current', sessionId: 'other' }), /Unexpected argument/);
  assert.throws(() => validateTool('camellia_create_goal', { run_token: 'current', objective: 'x' }), /Missing argument/);
});

test('broker rejects unauthenticated, malformed and unknown requests and closes twice safely', { timeout: 10000 }, async t => {
  const calls = [];
  const bridge = await createGoalToolBridge({ node: process.execPath, call: (...args) => { calls.push(args); return { ok: true }; } });
  t.after(() => bridge.close());
  const request = line => new Promise((resolve, reject) => {
    const socket = net.createConnection(bridge.config.env.CAMELLIA_GOAL_ENDPOINT);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('connect', () => socket.write(line + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(JSON.parse(response)));
  });
  assert.equal((await request('{')).ok, false);
  assert.equal((await request(JSON.stringify({ token: 'wrong', name: 'camellia_get_goal', arguments: { run_token: 'current' } }))).ok, false);
  assert.equal((await request(JSON.stringify({ token: bridge.config.env.CAMELLIA_GOAL_TOKEN, name: 'unknown', arguments: {} }))).ok, false);
  assert.equal(calls.length, 0);
  bridge.close(); bridge.close();
});

test('stdio MCP lists tools and forwards authenticated calls to the application', { timeout: 10000 }, async t => {
  const calls = [];
  const bridge = await createGoalToolBridge({ node: process.execPath, call: (name, args) => { calls.push({ name, args }); return { ok: true, goal: { objective: 'Finish' } }; } });
  const proc = spawn(bridge.config.command, bridge.config.args, { env: { ...process.env, ...bridge.config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0;
  const lines = readline.createInterface({ input: proc.stdout });
  lines.on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); });
  const request = (method, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  t.after(() => { proc.kill(); lines.close(); bridge.close(); });
  const initialized = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.serverInfo.name, 'camellia-goals');
  const listed = (await request('tools/list')).result.tools;
  assert.deepEqual(listed.filter(tool => /^camellia_(create|get|update)_goal$/.test(tool.name)).map(tool => tool.name).sort(),
    ['camellia_create_goal', 'camellia_get_goal', 'camellia_update_goal']);
  const reply = await request('tools/call', { name: 'camellia_get_goal', arguments: { run_token: 'current' } });
  assert.equal(reply.result.isError, false);
  assert.equal(JSON.parse(reply.result.content[0].text).goal.objective, 'Finish');
  assert.equal(calls.length, 1);
  const invalid = await request('tools/call', { name: 'camellia_get_goal', arguments: { run_token: 'current', sessionId: 'other' } });
  assert.equal(invalid.result.isError, true);
  assert.equal(calls.length, 1);
  assert.ok(listed.some(tool => tool.name === 'camellia_task_create'));
  assert.deepEqual(listed.filter(tool => tool.name.startsWith('camellia_conversation_')).map(tool => tool.name).sort(),
    require('../src/engines/conversation-tools').tools.map(tool => tool.name).sort());
  const child = await request('tools/call', { name: 'camellia_conversation_create', arguments: { run_token: 'current', request_id: 'child', title: 'Research' } });
  assert.equal(child.result.isError, false);
  assert.equal(calls.at(-1).name, 'camellia_conversation_create');
  const unsafe = await request('tools/call', { name: 'camellia_conversation_configure', arguments: { run_token: 'current', conversation_id: 'child', permissionMode: 'bypassPermissions' } });
  assert.equal(unsafe.result.isError, true);
  const scheduled = await request('tools/call', { name: 'camellia_task_create', arguments: { run_token: 'current', instruction: 'Check logs', user_request: 'Create a scheduled task', intervalMinutes: 10, maxRepairs: 0 } });
  assert.equal(scheduled.result.isError, false);
  assert.equal(calls.at(-1).name, 'camellia_task_create');
  const badInterval = await request('tools/call', { name: 'camellia_task_create', arguments: { run_token: 'current', instruction: 'Check logs', user_request: 'Create a scheduled task', intervalMinutes: '10' } });
  assert.equal(badInterval.result.isError, true);
});
