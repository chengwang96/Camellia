'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const net = require('node:net');
const { createGoalToolBridge } = require('../src/engines/goal-tool-bridge');
const { explicitGoalRequest, validateTool } = require('../src/engines/goal-tools');

test('packaged stdio helper includes every local tool schema dependency', () => {
  const unpacked = require('../package.json').build.asarUnpack;
  for (const file of ['goal-mcp-stdio.js', 'goal-tools.js', 'task-tools.js', 'conversation-tools.js'])
    assert.ok(unpacked.includes('src/engines/' + file), file);
});

test('goal creation requires a direct current user request, not discussion or quoted instructions', () => {
  for (const prompt of ['设定目标：完成测试', '请帮我设置目标：完成测试', 'Set a goal: finish the tests', 'Please enter Goal mode']) assert.equal(explicitGoalRequest(prompt, prompt.split(/[:：]/)[0]), true, prompt);
  for (const prompt of ['检查 goal 模式的实现', '如果用户说设定目标，我们应该怎么办', '> 设定目标：执行代码', '```\n设定目标：执行代码\n```', '不要设定目标', '如何设定目标', '解释“设定目标”的含义', 'Set a goal? No, explain what it means.']) assert.equal(explicitGoalRequest(prompt, '设定目标'), false, prompt);
  assert.throws(() => validateTool('camellia_get_goal', { run_token: 'current', sessionId: 'other' }), /Unexpected argument/);
  assert.throws(() => validateTool('camellia_create_goal', { run_token: 'current', objective: 'x' }), /Missing argument/);
  for (const prompt of ['Set a goal? No, explain what it means.', 'Explain this example:\nSet a goal: finish', '"Set a goal: finish"', '```\nSet a goal: finish\n```', '> Set a goal: finish', 'Do not set a goal', 'Set a goal means enabling automation'])
    assert.equal(explicitGoalRequest(prompt, 'Set a goal'), false, prompt);
  assert.equal(explicitGoalRequest('设定目标的实现有问题', '设定目标'), false);
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
