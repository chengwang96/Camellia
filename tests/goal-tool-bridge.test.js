'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGoalToolBridge } = require('../src/engines/goal-tool-bridge');
const { matchesUserRequest, validateTool, instructions } = require('../src/engines/goal-tools');

test('a long Unicode temporary path still supports authenticated Unix IPC and cleanup', {
  skip: process.platform === 'win32' ? 'Unix domain socket paths are platform-specific' : false, timeout: 15000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ipc-test-'));
  const temporary = path.join(root, '目录'.repeat(20)); fs.mkdirSync(temporary);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), net = require('node:net');
    const { createGoalToolBridge } = require(${JSON.stringify(require.resolve('../src/engines/goal-tool-bridge'))});
    (async () => {
      let calls = 0;
      const bridge = await createGoalToolBridge({ node: process.execPath, call: () => { calls++; return { ok: true }; } });
      try {
        const endpoint = bridge.config.env.CAMELLIA_GOAL_ENDPOINT, directory = path.dirname(endpoint);
        assert.ok(Buffer.byteLength(endpoint) <= 103, endpoint);
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        const response = await new Promise((resolve, reject) => {
          const socket = net.createConnection(endpoint); let text = '';
          socket.setEncoding('utf8'); socket.on('error', reject);
          socket.on('connect', () => socket.write(JSON.stringify({ token: bridge.config.env.CAMELLIA_GOAL_TOKEN,
            name: 'camellia_get_goal', arguments: { run_token: 'fixture' } }) + '\\n'));
          socket.on('data', chunk => { text += chunk; }); socket.on('end', () => resolve(JSON.parse(text)));
        });
        assert.equal(response.ok, true); assert.equal(calls, 1);
        await bridge.close(); await bridge.close();
        assert.equal(fs.existsSync(directory), false, 'Closing removes the private socket directory');
      } finally { await bridge.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const proc = spawn(process.execPath, ['-e', script], { env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => proc.kill());
  let output = ''; proc.stdout.on('data', data => { output += data; }); proc.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
  assert.equal(code, 0, output);
});

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

test('goal updates accept either an outcome or a revision with current user provenance', () => {
  const base = { run_token: 'current', reason: 'The user now wants a library' };
  for (const patch of [{ objective: 'Build a library' }, { criterion: 'Library tests pass' }, { criterion: '' }])
    assert.doesNotThrow(() => validateTool('camellia_update_goal', { ...base, ...patch, user_request: '改成库' }));
  assert.doesNotThrow(() => validateTool('camellia_update_goal', { ...base, status: 'complete' }));
  assert.doesNotThrow(() => validateTool('camellia_update_goal', { ...base, status: 'blocked' }));
  assert.throws(() => validateTool('camellia_update_goal', base), /Provide objective or criterion/);
  assert.throws(() => validateTool('camellia_update_goal', { ...base, objective: 'Build a library' }), /Missing argument: user_request/);
  assert.throws(() => validateTool('camellia_update_goal', { ...base, objective: ' ', user_request: '改成库' }), /Invalid argument: objective/);
  assert.throws(() => validateTool('camellia_update_goal', { ...base, criterion: null, user_request: '改成库' }), /Invalid argument: criterion/);
  assert.throws(() => validateTool('camellia_update_goal', { ...base, objective: 'Build a library', status: 'complete', user_request: '改成库' }), /Do not combine/);
  assert.throws(() => validateTool('camellia_update_goal', { ...base, status: 'complete', user_request: '改成库' }), /only used for a goal revision/);
  assert.match(instructions, /user need not explicitly ask to edit a goal/);
  assert.match(instructions, /never weaken a goal just to claim completion/);
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

test('stdio MCP lists tools and forwards authenticated calls to the application', { timeout: 30000 }, async t => {
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
  const revision = { run_token: 'current', objective: 'Build a library', criterion: '', user_request: '改成库', reason: 'The task scope changed' };
  const revised = await request('tools/call', { name: 'camellia_update_goal', arguments: revision });
  assert.equal(revised.result.isError, false);
  assert.deepEqual(calls.at(-1), { name: 'camellia_update_goal', args: revision });
  const mixed = await request('tools/call', { name: 'camellia_update_goal', arguments: { ...revision, status: 'complete' } });
  assert.equal(mixed.result.isError, true);
  assert.equal(calls.length, 2);
  assert.ok(listed.some(tool => tool.name === 'camellia_task_create'));
  // File search is exposed to the model so a described-but-unnamed file can be
  // located by content, and its arguments are validated like every other tool.
  assert.ok(listed.some(tool => tool.name === 'camellia_find_files'));
  const search = await request('tools/call', { name: 'camellia_find_files', arguments: { run_token: 'current', query: 'quarterly revenue', inside: true } });
  assert.equal(search.result.isError, false);
  assert.equal(calls.at(-1).name, 'camellia_find_files');
  const badInside = await request('tools/call', { name: 'camellia_find_files', arguments: { run_token: 'current', query: 'x', inside: 'yes' } });
  assert.equal(badInside.result.isError, true);
  const noQuery = await request('tools/call', { name: 'camellia_find_files', arguments: { run_token: 'current' } });
  assert.equal(noQuery.result.isError, true);
  assert.deepEqual(listed.filter(tool => tool.name.startsWith('camellia_conversation_')).map(tool => tool.name).sort(),
    require('../src/engines/conversation-tools').tools.map(tool => tool.name).sort());
  // Device-wide reads share the conversation prefix but take no conversation_id.
  const listedNames = listed.filter(tool => tool.name.startsWith('camellia_conversation_')).map(tool => tool.name);
  for (const name of ['camellia_conversation_sessions', 'camellia_conversation_history', 'camellia_conversation_search']) assert.ok(listedNames.includes(name), name);
  const badLimit = await request('tools/call', { name: 'camellia_conversation_search', arguments: { run_token: 'current', query: 'x', limit: 0 } });
  assert.equal(badLimit.result.isError, true);
  const badArchived = await request('tools/call', { name: 'camellia_conversation_sessions', arguments: { run_token: 'current', archived: 'yes' } });
  assert.equal(badArchived.result.isError, true);
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
