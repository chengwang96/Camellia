'use strict';
// Run the real Python SDK and native agent against a local model fixture.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { AcpSession } = require('../src/engines/acp-session');
const { antigravitySpawnSpec } = require('../src/engines/antigravity');
const { locatePythonRuntime } = require('../src/main/python-runtime');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');

async function run() {
  const runtime = locatePythonRuntime(path.resolve(process.argv[2] || 'runtimes/antigravity'));
  assert.ok(runtime, 'Run npm run setup:antigravity first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-antigravity-smoke-'));
  const cwd = path.join(root, 'Project With Spaces'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'marker.txt'), 'antigravity-fixture-7391');
  const mcpFile = path.join(root, 'mcp-fixture.cjs');
  fs.writeFileSync(mcpFile, `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result = {};
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Camellia fixture', version: '1.0.0' } };
      if (message.method === 'tools/list') result = { tools: [{ name: 'camellia_echo', description: 'Echo the fixture message', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] };
      if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.message }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    });
  `);
  const mcpSettings = { mcpServers: { fixture: { command: process.execPath, args: [mcpFile] } } };
  const requests = [], events = [], logs = [];
  let allow = true, session, complete, slowRequest;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ body, key: req.headers.authorization });
      if (req.headers.authorization === 'Bearer exhausted') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
        res.end('{"error":{"message":"Quota exhausted"}}'); return;
      }
      const lastUser = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('SMOKE '));
      const prompt = JSON.stringify(body.messages[lastUser]?.content);
      if (prompt?.includes('SMOKE wait')) { slowRequest?.(); return; }
      const hasTool = body.messages.slice(lastUser).some(m => m.role === 'tool');
      let tool;
      if (!hasTool && /SMOKE (read|write|deny|shell|mcp)/.test(prompt)) {
        const action = prompt.includes('SMOKE mcp') ? 'call_mcp_tool' : prompt.includes('SMOKE read') ? 'view_file' : prompt.includes('SMOKE shell') ? 'run_command' : 'write_to_file';
        const declared = body.tools?.find(t => t.function.name.toLowerCase().includes(action));
        assert.ok(declared, 'Missing SDK tool ' + action + ': ' + body.tools?.map(t => t.function.name).join(', '));
        const target = path.join(cwd, action === 'view_file' ? 'marker.txt' : prompt.includes('SMOKE deny') ? 'denied.txt' : 'written.txt');
        const args = action === 'call_mcp_tool' ? { ServerName: 'fixture', ToolName: 'camellia_echo', Arguments: { message: 'camellia-mcp-7391' } } : action === 'view_file' ? { AbsolutePath: target } : action === 'run_command'
          ? { CommandLine: process.platform === 'win32' ? 'echo camellia-shell' : 'printf camellia-shell', Cwd: cwd, WaitMsBeforeAsync: 10000 }
          : { TargetFile: target, CodeContent: 'antigravity-wrote-7391', Overwrite: false, Description: 'Create the smoke-test fixture' };
        Object.assign(args, { toolAction: 'Running fixture', toolSummary: 'Fixture operation' });
        tool = { id: 'fixture-reused-id', type: 'function', function: { name: declared.function.name, arguments: JSON.stringify(args) }, extra_content: { google: { thought_signature: 'fixture-signature-' + requests.length } } };
      }
      const message = { role: 'assistant', content: tool ? null : 'Antigravity smoke reply', ...(tool ? { tool_calls: [tool] } : {}) };
      const usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(frame({ id: 'fixture', choices: [{ index: 0, delta: { ...message, ...(tool ? { tool_calls: [{ ...tool, index: 0 }] } : {}) } }] }));
        res.write(frame({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }));
        res.end(frame('[DONE]'));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'fixture', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }));
      }
    } catch (error) { logs.push(error.stack); res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const configPath = path.join(root, 'routes.json');
  const provider = { type: 'gemini', name: 'Gemini fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', protocol: 'openai', models: [{ id: 'gemini-test', upstream: 'gemini-upstream' }] };
  writeConfig(configPath, normalizeConfig({ port, providers: [
    { ...provider, id: 'google', keys: [{ id: 'bad', key: 'exhausted' }, { id: 'good', key: 'working-fixture' }] },
    { ...provider, id: 'other', models: [{ id: 'other-model', upstream: 'other-model' }], keys: [{ id: 'unused', key: 'never-use' }] },
  ] }));
  const router = startApiRouter({ configPath }); await router.ready;
  const history = new ClaudeHistory(path.join(root, 'history'));
  let generation = 0;
  async function create(opts = {}, mode = 'default', config = {}) {
    await session?.shutdown();
    const spec = antigravitySpawnSpec({ runtime, home: path.join(root, 'data'), route: { baseUrl: router.url }, config,
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' } });
    session = new AcpSession({ name: 'Antigravity', gen: ++generation, settings: { cwd, model: 'gemini-test', permissionMode: mode }, opts,
      exe: runtime.file, spec, spawn, history, log: line => logs.push(line), onSessionId() {}, onResult: event => complete?.(event),
      onEvent: event => { events.push(event); if (event.type === 'gui:permission') session.answerPermission(event.requestId, allow); } });
    session.start();
  }
  function turn(prompt, attachments) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.kill(); reject(new Error('SDK smoke timed out: ' + logs.join('\n'))); }, 60000);
      complete = result => { clearTimeout(timer); resolve(result); };
      assert.equal(session.sendUserMessage(prompt, attachments), true);
    });
  }
  function success(result) { assert.equal(result.subtype, 'success', JSON.stringify(result) + '\n' + logs.join('\n')); }
  try {
    await create();
    success(await turn('SMOKE hello'));
    assert.equal(requests[0].key, 'Bearer exhausted');
    assert.equal(requests[1].key, 'Bearer working-fixture');
    assert.ok(requests.every(r => r.body.model === 'gemini-upstream'));
    const id = session.sessionId;
    success(await turn('SMOKE read marker.txt'));
    assert.ok(requests.some(r => r.body.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('antigravity-fixture-7391'))), JSON.stringify(requests.at(-1).body.messages));
    assert.ok(requests.some(r => r.body.messages.some(m => m.tool_calls?.some(t => t.extra_content?.google?.thought_signature))), 'Thought signatures survive the SDK round trip');
    success(await turn('SMOKE write written.txt'));
    assert.equal(fs.readFileSync(path.join(cwd, 'written.txt'), 'utf8').trimEnd(), 'antigravity-wrote-7391');
    assert.ok(events.some(e => e.type === 'gui:permission'));
    success(await turn('SMOKE shell'));
    assert.ok(requests.at(-1).body.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('camellia-shell')));
    allow = false;
    success(await turn('SMOKE deny denied.txt'));
    assert.equal(fs.existsSync(path.join(cwd, 'denied.txt')), false);
    allow = true;
    await create({ sessionId: id });
    success(await turn('SMOKE resume'));
    assert.equal(session.sessionId, id);
    assert.ok(JSON.stringify(requests.at(-1).body.messages).includes('SMOKE hello'));
    await create({ sessionId: id, fork: true });
    success(await turn('SMOKE fork'));
    assert.notEqual(session.sessionId, id);
    assert.ok(JSON.stringify(requests.at(-1).body.messages).includes('SMOKE resume'));
    await create({ sessionId: id });
    success(await turn('SMOKE return to original'));
    assert.ok(!JSON.stringify(requests.at(-1).body.messages).includes('SMOKE fork'), 'Forking must not append to the source native conversation');
    const imageFile = path.join(cwd, 'image.png');
    fs.writeFileSync(imageFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ5kAAAAASUVORK5CYII=', 'base64'));
    const beforeImage = requests.length;
    const imageResult = await turn('SMOKE image', [{ path: imageFile, isImage: true }]);
    assert.equal(imageResult.subtype, 'error');
    assert.match(imageResult.result, /Antigravity did not advertise inline image prompts/);
    assert.equal(requests.length, beforeImage, 'Unsupported images must not silently become text-only API requests');
    await create({}, 'default', mcpSettings);
    success(await turn('SMOKE mcp'));
    assert.ok(requests.at(-1).body.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('camellia-mcp-7391')));
    await create({}, 'plan', mcpSettings);
    success(await turn('SMOKE plan'));
    assert.ok(!requests.at(-1).body.tools.some(t => /write_to_file|replace_file_content|run_command|invoke_subagent|call_mcp_tool/.test(t.function.name)));
    const waiting = new Promise(resolve => { slowRequest = resolve; });
    const stopped = turn('SMOKE wait'); await waiting; session.interrupt();
    assert.equal((await stopped).subtype, 'stopped');
    const toolStates = new Map(events.filter(e => e.type === 'gui:tool').map(e => [e.id, e.status]));
    assert.ok([...toolStates.values()].every(status => ['completed', 'failed'].includes(status)), 'Tool cards must finish after approval or denial');
    console.log('PASS: Antigravity SDK streams, executes file/shell/MCP tools, reports unsupported images, honors approvals and plan mode, resumes/forks independently, cancels, and uses only same-model routes.');
  } finally {
    await session?.shutdown(); await router.stop();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(root, 'diagnostics.json'), JSON.stringify({ logs, requests, events }, null, 2));
    console.log('SDK fixture diagnostics: ' + root);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
