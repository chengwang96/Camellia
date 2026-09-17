'use strict';
// Exercise the pinned CLI with only loopback model responses and an isolated home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CodexSession } = require('../src/engines/codex-session');
const { CodexClient, codexSpawnSpec } = require('../src/engines/codex-client');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { isolatedEnvironment } = require('../src/benchmark/engines');

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const runtime = process.argv[2] ? { file: path.resolve(process.argv[2]) } : createRuntimeManager({ root: appRoot, installRoot: appRoot }).locate('codex');
  assert.ok(runtime && fs.existsSync(runtime.file), 'Run npm run setup:codex first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-codex-smoke-'));
  const cwd = path.join(root, 'Project With Spaces'), home = path.join(root, 'profile'); fs.mkdirSync(cwd);
  const marker = path.join(cwd, 'written.txt');
  const patchText = '*** Begin Patch\n*** Add File: first file.txt\n+quotes: "double", \'single\', $literal, `tick`\n+中文 café\n*** Add File: second.txt\n+second file\n*** End Patch';
  const requests = [], events = [], logs = [];
  let router, session, generation = 0, done, waiting;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push({ body, key: req.headers.authorization });
      if (req.headers.authorization === 'Bearer exhausted') { res.writeHead(402); res.end('{"error":"quota exhausted"}'); return; }
      assert.equal(body.model, 'fixture-codex');
      const last = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('SMOKE'));
      const prompt = JSON.stringify(body.messages[last]?.content);
      if (prompt.includes('SMOKE wait')) { waiting?.(); return; }
      const hasTool = body.messages.slice(last).some(m => m.role === 'tool');
      if (hasTool) assert.equal(body.messages.slice(last).find(m => m.tool_calls?.length)?.reasoning_content, 'Execute the requested native tool.');
      let tool;
      if ((prompt.includes('SMOKE patch') || prompt.includes('SMOKE denied')) && !hasTool) {
        const patch = body.tools.map(t => t.function).find(t => /(?:^|__)apply_patch$/.test(t.name));
        assert.ok(patch, 'Third-party API models must have the native patch tool');
        assert.ok(!patch.description.includes('do not wrap the patch in JSON'));
        tool = { index: 0, id: 'call_' + requests.length, type: 'function', function: { name: patch.name,
          arguments: JSON.stringify({ input: prompt.includes('SMOKE denied') ? '*** Begin Patch\n*** Add File: denied.txt\n+must not be written\n*** End Patch' : patchText }) } };
      } else if ((prompt.includes('SMOKE write') || prompt.includes('SMOKE broken')) && !hasTool) {
        const shell = body.tools.map(t => t.function).find(t => /shell_command$|exec_command$/.test(t.name));
        assert.ok(shell, 'Codex must expose a native shell tool');
        let command = process.platform === 'win32' ? "Set-Content -LiteralPath '" + marker.replace(/'/g, "''") + "' -Value 'codex-wrote-7391'"
          : "printf '%s\\n' 'codex-wrote-7391' > '" + marker.replace(/'/g, "'\\''") + "'";
        if (prompt.includes('SMOKE broken')) {
          assert.ok(!body.tools.some(t => /(?:^|__)apply_patch$/.test(t.function.name)), 'Baseline uses native unknown-model defaults');
          command = "$patch = @'\n*** Begin Patch\n*** Add File: broken.txt\n+valid multiline patch\n*** End Patch\n'@\napply_patch $patch";
        }
        tool = { index: 0, id: 'call_' + requests.length, type: 'function', function: { name: shell.name,
          arguments: JSON.stringify({ [shell.parameters.properties.cmd ? 'cmd' : 'command']: command, login: false }) } };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (tool) {
        const args = tool.function.arguments;
        res.write(frame({ choices: [{ index: 0, delta: { reasoning_content: 'Execute the requested native tool.', tool_calls: [{ ...tool, function: { ...tool.function, arguments: args.slice(0, 17) } }] } }] }));
        res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(17) } }] } }] }));
      } else res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Codex smoke reply' } }] }));
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
      res.end(frame('[DONE]'));
    } catch (error) { logs.push(error.stack); if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await listen(server); const probe = http.createServer(); await listen(probe); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const file = path.join(root, 'router.json');
  writeConfig(file, normalizeConfig({ port, providers: [{ id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai',
    models: [{ id: 'codex-fixture', upstream: 'fixture-codex' }], keys: [{ id: 'empty', key: 'exhausted' }, { id: 'local', key: 'working' }] }] }));
  const env = isolatedEnvironment(home, process.execPath);
  const history = new ClaudeHistory(path.join(root, 'history'));
  async function create(opts = {}, { nativePatch = true, readOnly = false } = {}) {
    await session?.shutdown();
    const spec = codexSpawnSpec({ runtime, home: path.join(home, '.codex'), cwd, connection: 'api',
      model: nativePatch ? 'codex-fixture' : undefined, env, route: { baseUrl: router.url } });
    if (readOnly) spec.permissions = { approvalPolicy: 'on-request', sandbox: 'read-only' };
    session = new CodexSession({ gen: ++generation, settings: { cwd, model: 'codex-fixture', permissionMode: readOnly ? 'default' : 'bypassPermissions', connection: 'api' }, opts, spec, spawn, history,
      log: msg => logs.push(msg), onSessionId() {}, onResult: result => done?.(result), onEvent: event => {
        events.push(event);
        if (event.type === 'gui:permission') session.answerPermission(event.requestId, false);
      } });
    session.start();
  }
  function turn(prompt, attachments = []) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.kill(); reject(new Error('Codex smoke timed out\n' + logs.join('\n'))); }, 45000);
      done = result => { clearTimeout(timer); resolve(result); }; assert.equal(session.sendUserMessage(prompt, attachments), true);
    });
  }
  try {
    router = startApiRouter({ configPath: file, timeoutMs: 5000 }); await router.ready;
    await create();
    let result = await turn('SMOKE write written.txt');
    assert.equal(result.subtype, 'success', JSON.stringify(result) + '\n' + logs.join('\n'));
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'codex-wrote-7391');
    assert.deepEqual(requests.slice(0, 2).map(r => r.key), ['Bearer exhausted', 'Bearer working']);
    assert.ok(events.some(e => e.type === 'gui:tool' && e.status === 'completed'));
    assert.ok(events.some(e => e.event?.delta?.text === 'Codex smoke reply'));
    assert.ok(events.some(e => e.event?.delta?.thinking === 'Execute the requested native tool.'));
    result = await turn('SMOKE patch two files');
    assert.equal(result.subtype, 'success', logs.join('\n'));
    assert.equal(fs.readFileSync(path.join(cwd, 'first file.txt'), 'utf8'), 'quotes: "double", \'single\', $literal, `tick`\n中文 café\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'second.txt'), 'utf8'), 'second file\n');
    assert.ok(events.some(e => e.type === 'gui:tool' && e.name === 'fileChange' && e.status === 'completed'));
    const sourceId = session.sessionId;
    await create({ sessionId: sourceId }); result = await turn('SMOKE resume');
    assert.equal(result.subtype, 'success', logs.join('\n')); assert.equal(session.sessionId, sourceId);
    await create({ sessionId: sourceId, fork: true }); result = await turn('SMOKE fork');
    assert.equal(result.subtype, 'success', logs.join('\n')); assert.notEqual(session.sessionId, sourceId);
    assert.ok((await history.transcript(session.sessionId)).messages.length >= 4);
    const reached = new Promise(resolve => { waiting = resolve; }); const pending = turn('SMOKE wait'); await reached;
    session.interrupt(); assert.equal((await pending).subtype, 'stopped');
    await create({}, { readOnly: true });
    result = await turn('SMOKE denied patch');
    assert.equal(result.subtype, 'success', logs.join('\n'));
    assert.equal(fs.existsSync(path.join(cwd, 'denied.txt')), false, 'Native patch approval denial must prevent edits');
    assert.ok(events.some(e => e.type === 'gui:permission' && e.toolName === 'fileChange'), 'Codex still owns native patch permissions');
    if (process.platform === 'win32') {
      const before = events.length;
      await create({}, { nativePatch: false });
      result = await turn('SMOKE broken patch baseline');
      assert.equal(result.subtype, 'success', logs.join('\n'));
      assert.equal(fs.existsSync(path.join(cwd, 'broken.txt')), false);
      assert.ok(events.slice(before).some(e => e.type === 'gui:tool' && e.is_error && /Invalid patch/.test(e.output)), 'Reproduce the Windows multiline batch failure');
      const baseline = requests.find(r => r.body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('SMOKE broken')));
      // 0.154.0 renders instructions tool-aware: the native unknown-model
      // fallback omits the update_plan sections while a catalog entry keeps
      // them (fallback-ness cannot be expressed in catalog JSON). Normalize
      // those sections so only genuine upstream drift fails here.
      const dropPlanSections = text => {
        const out = []; let skipping = false;
        for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
          if (/^#{1,2} /.test(line)) skipping = ['## Planning', '## `update_plan`'].some(heading => line.startsWith(heading));
          if (!skipping) out.push(line);
        }
        return out.join('\n').trimEnd();
      };
      assert.ok(dropPlanSections(baseline.body.messages[0].content) === dropPlanSections(requests[1].body.messages[0].content),
        'The native fallback instructions are unchanged apart from plan-tool sections and platform line endings');
      assert.deepEqual(baseline.body.tools.map(t => t.function.name), requests[1].body.tools.filter(t => t.function.name !== 'apply_patch').map(t => t.function.name), 'Only the missing patch tool is added');
    }
    const state = router.getState(); assert.ok(state.usage.local.inputTokens >= 100);
    // Read the official account API in a new empty profile, without logging in.
    const accountClient = new CodexClient({ ...codexSpawnSpec({ runtime, home: path.join(root, 'account'), env }), log: msg => logs.push(msg) });
    try { await accountClient.ready; assert.equal((await accountClient.request('account/read', { refreshToken: false })).account, null); }
    finally { await accountClient.shutdown(); }
    console.log('PASS: Codex native patch (Unicode, quotes, spaces, multiple files, streamed arguments), permissions, Windows batch regression, shell, resume, fork, cancellation, failover, usage, and isolated account');
  } finally {
    await session?.shutdown(); await router?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.mkdirSync(path.join(appRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'dist/codex-smoke.json'), JSON.stringify({ requests, events, logs }, null, 2));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('camellia-codex-smoke-'));
    // Native SQLite handles close asynchronously after the process is stopped.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
