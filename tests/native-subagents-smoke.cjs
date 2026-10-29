'use strict';

// Exercise installed harnesses against a loopback model fixture. No real model,
// personal account, or user task is used. Keep native child scheduling intact.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { AcpSession } = require('../src/engines/acp-session');
const { GrokSession, grokSpawnSpec } = require('../src/engines/grok-session');
const { kimiSpawnSpec } = require('../src/engines/kimi-session');
const { dshAcpSpec } = require('../src/engines/dsh-session');
const { ClaudeSession } = require('../src/engines/claude-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { antigravitySpawnSpec } = require('../src/engines/antigravity');
const { removeTree } = require('./test-fs.cjs');

async function run() {
  const background = process.argv.includes('--background');
  const swarm = process.argv.includes('--swarm');
  const parallel = Math.min(16, Math.max(1, Number(process.argv.find(value => value.startsWith('--parallel='))?.split('=')[1] || (swarm ? 2 : 1))));
  const selected = process.argv.slice(2).filter(value => !value.startsWith('--'));
  const engines = selected.length ? selected : ['claude', 'dsh', 'kimi', 'grok', 'antigravity'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-subagents-smoke-'));
  const runtimeManager = createRuntimeManager({ root: path.resolve(__dirname, '..'), installRoot: path.resolve(__dirname, '..'), node: () => process.execPath });
  let current, childRequests = 0, launched = false;
  const server = http.createServer(async (req, res) => {
    if (require('./model-metadata-fixture.cjs')(req, res)) return;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const toolNames = body.tools?.map(tool => tool.function?.name) || [];
    let tool;
    const title = toolNames.length === 1 && toolNames.includes('session_title');
    if (title) tool = { name: 'session_title', arguments: JSON.stringify({ session_title: 'Subagent fixture' }) };
    else if (!launched && JSON.stringify(body.messages).includes('PARENT_SUBAGENT_FIXTURE')) {
      launched = true;
      const name = { claude: 'Agent', kimi: swarm ? 'AgentSwarm' : 'Agent', dsh: 'subagent', grok: 'spawn_subagent', antigravity: 'invoke_subagent' }[current];
      const declaration = body.tools?.find(row => row.function.name === name);
      if (!declaration) { res.writeHead(500); res.end('Missing ' + name + ': ' + toolNames.join(', ')); return; }
      const args = { description: 'Inspect fixture', prompt: 'CHILD_SUBAGENT_FIXTURE: Return child fixture complete.', run_in_background: background };
      if (current === 'kimi' && swarm) Object.assign(args, { items: ['one', 'two'], prompt_template: 'CHILD_SUBAGENT_FIXTURE: Return child fixture complete for {{item}}.' });
      if (current === 'claude') args.subagent_type = 'general-purpose';
      const properties = declaration.function.parameters.properties || {};
      for (const key of Object.keys(args)) if (!(key in properties)) delete args[key];
      for (const key of declaration.function.parameters.required || []) {
        if (!(key in args)) args[key] = key === 'task' || key === 'Task' ? 'CHILD_SUBAGENT_FIXTURE: Return child fixture complete.'
          : properties[key]?.enum?.[0] || 'Inspect fixture';
      }
      if (current === 'antigravity') args.Subagents = (swarm ? ['one', 'two'] : ['one']).map(item => ({
        TypeName: 'fixture-reader', Role: 'Fixture Inspector ' + item, Prompt: 'CHILD_SUBAGENT_FIXTURE: Return child fixture complete for ' + item,
      }));
      tool = { name, arguments: JSON.stringify(args) };
    } else if (!title) childRequests++;
    const lastUser = body.messages.findLast(message => message.role === 'user');
    if (background && JSON.stringify(lastUser).includes('CHILD_SUBAGENT_FIXTURE') && !JSON.stringify(lastUser).includes('PARENT_SUBAGENT_FIXTURE'))
      await new Promise(resolve => setTimeout(resolve, 250));
    const toolCalls = tool ? Array.from({ length: current === 'claude' && !title ? parallel : 1 }, (_, index) => ({
      index, id: parallel > 1 && current === 'claude' && !title ? 'fixture-spawn-' + index : 'fixture-spawn', type: 'function',
      function: current === 'claude' && !title && parallel > 1 ? { ...tool, arguments: JSON.stringify({ ...JSON.parse(tool.arguments),
        prompt: 'CHILD_SUBAGENT_FIXTURE: Return child fixture complete for item ' + index }) } : tool,
    })) : [];
    const delta = tool ? { tool_calls: toolCalls }
      : { content: 'Child fixture complete.' };
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', choices: [{ index: 0,
        message: { role: 'assistant', content: tool ? null : delta.content,
          ...(tool ? { tool_calls: toolCalls.map(({ index, ...call }) => call) } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
      { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'fixture', choices: [{ index: 0, delta }] },
      { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }, '[DONE]',
    ]) res.write(frame(chunk));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portProbe = http.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const configPath = path.join(root, 'routes.json');
  writeConfig(configPath, normalizeConfig({ port, providers: [{ id: 'fixture', name: 'Loopback fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', protocol: 'openai',
    models: [{ id: 'fixture-model', upstream: 'fixture-model' }], keys: [{ id: 'key', key: 'loopback-only' }] }] }));
  const router = startApiRouter({ configPath }); await router.ready;
  try {
    for (const engine of engines) {
      current = engine; launched = false; childRequests = 0;
      const runtime = runtimeManager.locate(engine, 'api'); assert.ok(runtime, engine + ' runtime missing');
      const home = path.join(root, engine, 'home'), cwd = path.join(root, engine, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
      const env = isolatedEnvironment(path.join(root, engine), process.execPath), events = [], logs = [];
      const settings = { cwd, model: 'fixture-model', permissionMode: 'full' };
      const common = { runtime: engine === 'dsh' ? runtime : runtime.file, home, model: settings.model,
        route: { baseUrl: router.url, authToken: 'proxy-managed' }, env, permissionMode: 'full' };
      const spec = engine === 'grok' ? grokSpawnSpec(common) : engine === 'kimi' ? kimiSpawnSpec(common)
        : engine === 'dsh' ? dshAcpSpec(common) : engine === 'antigravity' ? antigravitySpawnSpec({ ...common, runtime,
          config: { subagents: [{ name: 'fixture-reader', description: 'Read only loopback fixture agent' }] } })
        : { cwd, args: ['-p', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--output-format', 'stream-json', '--input-format', 'stream-json',
          '--include-partial-messages', '--verbose', '--model', 'fixture-model', '--permission-mode', 'bypassPermissions'],
          env: { ...env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'loopback-only', ANTHROPIC_BASE_URL: router.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } };
      const Class = engine === 'claude' ? ClaudeSession : engine === 'grok' ? GrokSession : AcpSession;
      let done;
      const session = new Class({ name: engine, gen: 1, settings, opts: {}, spec,
        exe: ['kimi', 'dsh'].includes(engine) ? process.execPath : runtime.file, spawn,
        history: new ClaudeHistory(path.join(root, engine, 'history')), log: value => logs.push(value), onSessionId() {},
        onEvent: event => events.push(event), onResult: value => done?.(value) });
      try {
        session.start();
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { session.kill(); reject(new Error(engine + ' timed out\n' + logs.slice(-8).join('\n'))); }, 60000);
          done = value => { clearTimeout(timer); resolve(value); };
          session.sendUserMessage('PARENT_SUBAGENT_FIXTURE: Spawn one native child to return the fixture marker.');
        });
        const expected = engine === 'claude' ? parallel : swarm && ['kimi', 'antigravity'].includes(engine) ? 2 : 1;
        const deadline = Date.now() + 10000;
        while ((session.children.size < expected || ![...session.children.values()].every(task => task.status === 'failed'
          || task.status === 'completed' && /Child fixture complete/i.test(task.result || ''))) && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 25));
        const tasks = events.filter(event => event.type === 'gui:subagent').map(event => event.task);
        const tools = events.filter(event => event.type === 'gui:tool');
        const diagnostic = JSON.stringify({ result, tasks, tools, logs: logs.slice(-8) });
        assert.equal(result.is_error, false, diagnostic);
        assert.ok(childRequests >= expected + 1, engine + ' did not execute its native children: ' + diagnostic);
        assert.ok(tasks.some(task => ['starting', 'running'].includes(task.status)), engine + ' did not report child startup: ' + diagnostic);
        assert.equal(session.children.size, expected, engine + ' duplicated or lost child cards: ' + diagnostic);
        assert.ok([...session.children.values()].every(task => task.status === 'completed' && /Child fixture complete/i.test(task.result || '')), engine + ' did not report child results: ' + diagnostic);
        console.log('PASS: ' + engine + ' native children=' + expected + ', lifecycle updates=' + tasks.length + ', background=' + background);
      } finally { await session.shutdown?.(); session.kill(); }
    }
  } finally {
    await router.stop(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-subagents-smoke-'));
    removeTree(root);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
