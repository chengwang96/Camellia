'use strict';

// Installed SDK, isolated profile, direct loopback model fixture. The fixture
// deliberately emits unadvertised calls; no model/account or group is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { AcpSession } = require('../src/engines/acp-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { antigravitySpawnSpec } = require('../src/engines/antigravity');
const { locatePythonRuntime, SUPPORTED_SDK_VERSIONS } = require('../src/main/python-runtime');
const { prepareWindowsJob } = require('../src/engines/discussions/windows-job');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { frame } = require('../src/api/api-protocol');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  assert.equal(process.platform, 'win32', 'This containment probe requires Windows');
  const runtime = locatePythonRuntime(path.resolve(__dirname, '../runtimes/antigravity'));
  assert.ok(SUPPORTED_SDK_VERSIONS.includes(runtime?.version));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-sdk-tool-free-'));
  const cwd = path.join(root, 'work'), home = path.join(root, 'adapter'); fs.mkdirSync(cwd);
  const protectedFile = path.join(cwd, 'existing.txt'); fs.writeFileSync(protectedFile, 'keep this content');
  const env = isolatedEnvironment(path.join(root, 'profile'), process.execPath);
  if (env.SystemRoot === env.SYSTEMROOT) delete env.SYSTEMROOT;
  const journal = new WindowsJobJournal({ dir: path.join(root, 'jobs') }), jobs = [], sessions = [], events = [], logs = [];
  const requests = [], injected = new Set(), denied = new Map();
  let catalog = [];
  const cases = {
    create: { name: 'write_to_file', arguments: { TargetFile: path.join(cwd, 'created.txt'), CodeContent: 'must not be written',
      Overwrite: false, Description: 'Local policy fixture' } },
    edit: { name: 'replace_file_content', arguments: { TargetFile: protectedFile, TargetContent: 'keep this content',
      ReplacementContent: 'must not replace', AllowMultiple: false, StartLine: 1, EndLine: 1,
      Instruction: 'Replace the fixture content', Description: 'Local policy fixture' } },
    shell: { name: 'run_command', arguments: { CommandLine: 'echo must-not-run > shell.txt', Cwd: cwd, WaitMsBeforeAsync: 1000 } },
    child: { name: 'invoke_subagent', arguments: { Task: 'Create child.txt in the workspace' } },
    control: { name: 'call_mcp_tool', arguments: { ServerName: 'camellia_goals', ToolName: 'camellia_create_goal',
      Arguments: { objective: 'Never create this fixture goal' } } },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      assert.ok(requests.length < 30, 'The fixture must not loop indefinitely');
      assert.ok(['tool-free-fixture', 'catalog-fixture'].includes(body.model));
      if (body.model === 'catalog-fixture') catalog = (body.tools || []).map(tool => tool.function.name);
      else assert.equal(body.tools?.length || 0, 0, 'The actual SDK request must advertise no tools');
      const prompt = [...body.messages].reverse().find(message => message.role === 'user')?.content;
      const name = /POLICY (\w+)/.exec(typeof prompt === 'string' ? prompt : JSON.stringify(prompt))?.[1];
      for (const message of body.messages) if (message.role === 'tool') {
        const match = /^fixture-(\w+)$/.exec(message.tool_call_id);
        if (match) denied.set(match[1], message.content);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (cases[name] && !injected.has(name)) {
        injected.add(name);
        res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-' + name,
          type: 'function', function: { name: cases[name].name,
            arguments: JSON.stringify({ ...cases[name].arguments, toolAction: 'Local policy fixture', toolSummary: 'Verify rejection' }) } }] } }] }));
        res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      } else {
        res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Tool-free fixture reply' } }] }));
        res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
      }
      res.end(frame('[DONE]'));
    } catch (error) { logs.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  async function open(sessionId, restricted = true) {
    const job = await prepareWindowsJob({ identity: { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 }, journal }); jobs.push(job);
    const spec = antigravitySpawnSpec({ runtime, home, env, executionPolicy: restricted ? 'tool-free-v1' : undefined,
      route: { baseUrl: `http://127.0.0.1:${server.address().port}` } });
    const session = new AcpSession({ gen: sessions.length + 1, name: 'Antigravity tool-free fixture', opts: { sessionId },
      exe: runtime.file, spec, spawn: job.spawn, settings: { cwd, model: restricted ? 'tool-free-fixture' : 'catalog-fixture',
        permissionMode: restricted ? 'plan' : 'default' },
      history: new ClaudeHistory(path.join(root, 'mirror')), log: line => logs.push(line),
      onEvent: event => events.push(event), onSessionId() {}, onResult() {} });
    sessions.push(session); session.start(); await (session.ready = session.open());
    return { session, job };
  }
  async function turn(active, prompt) {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void active.job.stop().catch(() => {}); reject(new Error('Tool-free fixture timed out')); }, 30000);
      active.session.onResult = value => { clearTimeout(timer); resolve(value); };
      assert.equal(active.session.sendUserMessage(prompt), true);
    });
    assert.equal(result.subtype, 'success', JSON.stringify(result) + '\n' + logs.join('\n'));
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'keep this content');
    assert.deepEqual(fs.readdirSync(cwd), ['existing.txt']);
  }
  async function stop(active) {
    await active.session.shutdown(); const proof = await active.job.stop();
    assert.equal(proof.stopped, true); assert.equal(proof.activeProcesses, 0);
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // SDK enum values are not necessarily wire tool names (CREATE_FILE maps
    // to write_to_file). Validate the attack names against this native build.
    const baseline = await open(undefined, false); await turn(baseline, 'POLICY catalog'); await stop(baseline);
    for (const name of ['create', 'edit', 'shell', 'child']) {
      const actual = catalog.find(tool => tool === cases[name].name || tool.endsWith('__' + cases[name].name));
      assert.ok(actual, 'Missing native baseline tool: ' + cases[name].name); cases[name].name = actual;
    }
    const first = await open();
    await assert.rejects(first.session.request('session/new', { cwd, mcpServers: [{ name: 'camellia_goals', command: 'must-not-start' }] }), /cannot load MCP/);
    for (const modeId of ['acceptEdits', 'bypassPermissions', 'unknown']) {
      await assert.rejects(first.session.request('session/set_mode', { modeId }), /cannot elevate/);
    }
    const nativeId = await first.session.prepareNativeStorage(); assert.equal(requests.length, 1);
    await turn(first, 'POLICY hello');
    for (const name of Object.keys(cases)) await turn(first, 'POLICY ' + name);
    await turn(first, '/compact\nPOLICY literal');
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('/compact'));
    await stop(first);
    const resumed = await open(first.session.sessionId);
    assert.equal(await resumed.session.prepareNativeStorage(), nativeId);
    await turn(resumed, 'POLICY resumed');
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('POLICY hello'));
    await stop(resumed);
    assert.deepEqual([...injected].sort(), Object.keys(cases).sort());
    for (const name of Object.keys(cases)) assert.match(String(denied.get(name)), /unknown|not found|not enabled|denied|not available|unsupported|not registered/i,
      'Each forced tool call must produce an explicit rejection: ' + name);
    assert.equal(events.filter(event => event.type === 'gui:permission').length, 0);
    console.log(JSON.stringify({ sdkVersion: runtime.version, policy: 'tool-free-v1', advertisedTools: 0,
      nativeToolNamesValidated: 4, forcedCallsRejected: injected.size, workspaceUnchanged: true, resumed: true,
      literalCommandPreserved: true, mcpRegistrationRejected: true,
      escalationRejected: 3, loopbackReplies: requests.length, stoppedJobs: jobs.length, realModelCalls: 0 }));
  } finally {
    for (const session of sessions) await session.shutdown();
    for (const job of jobs) await job.stop();
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('discussion-sdk-tool-free-')); removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
