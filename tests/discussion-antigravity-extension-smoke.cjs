'use strict';

// Native extension discovery is separate from model tool authorization. All
// extensions here are local canaries in a temporary profile and Windows Job.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { AcpSession } = require('../src/engines/acp-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { antigravitySpawnSpec, subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { locatePythonRuntime } = require('../src/main/python-runtime');
const { locateAntigravityCli } = require('../src/main/antigravity-cli-runtime');
const { parseModels, groupModels, runCli } = require('../src/engines/antigravity/subscription');
const { prepareWindowsJob } = require('../src/engines/discussions/windows-job');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { frame } = require('../src/api/api-protocol');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  assert.equal(process.platform, 'win32');
  const runtimeDir = path.resolve(__dirname, '../runtimes/antigravity');
  const sdk = locatePythonRuntime(runtimeDir), cli = locateAntigravityCli(runtimeDir);
  assert.equal(sdk?.version, '0.1.17'); assert.equal(cli?.version, '1.2.3');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-native-extensions-'));
  const journal = new WindowsJobJournal({ dir: path.join(root, 'jobs') });
  const jobs = [], sessions = [], logs = [], requests = [], observations = [];
  const canary = path.join(root, 'canary.cjs');
  fs.writeFileSync(canary, `const fs = require('node:fs');
const [file, kind] = process.argv.slice(2);
const record = method => fs.appendFileSync(file, JSON.stringify({kind,method}) + '\\n');
record('started');
if (kind.endsWith('mcp')) {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line); record(message.method);
    if (message.id === undefined) return;
    const result = message.method === 'initialize'
      ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:kind,version:'1'}}
      : message.method === 'tools/list' ? {tools:[{name:'canary',description:'Local fixture only',inputSchema:{type:'object',properties:{}}}]}
      : message.method === 'tools/call' ? {content:[{type:'text',text:'Local canary called'}]} : {};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result}) + '\\n');
  });
}
`);
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body); assert.ok(requests.length < 20);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (body.messages) {
        res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Extension fixture reply' } }] }));
        res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
        res.end(frame('[DONE]'));
      } else res.end('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Extension fixture reply' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 } }) + '\n\n');
    } catch (error) { logs.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  function json(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); }
  async function probe(kind) {
    const isCli = kind.startsWith('cli'), customAgent = kind === 'cli-agent', literalInput = kind === 'cli-literal' || customAgent;
    const folder = path.join(root, kind), profile = path.join(folder, 'profile'), cwd = path.join(folder, 'work');
    const nativeDir = path.join(profile, '.gemini/antigravity-cli'), eventsFile = path.join(folder, 'canary.jsonl');
    fs.mkdirSync(cwd, { recursive: true });
    json(path.join(nativeDir, 'settings.json'), { modelProvider: 'gemini', enableTelemetry: false,
      permissions: { deny: ['read_file(*)', 'write_file(*)', 'command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] } });
    const env = isolatedEnvironment(profile, process.execPath); if (env.SystemRoot === env.SYSTEMROOT) delete env.SYSTEMROOT;
    env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const fixtureEnv = { ...env, GEMINI_API_KEY: 'fixture-not-a-key', GOOGLE_GEMINI_BASE_URL: baseUrl };
    // Discover the local catalog before installing canaries: even `models`
    // may initialize native extensions. All extension launches below must be
    // contained by the same independently verified Job as the conversation.
    const selected = isCli ? groupModels(parseModels(await runCli(cli.file, ['models'], { env: fixtureEnv, cwd })))[0] : null;
    const extension = name => ({ command: process.execPath, args: [canary, eventsFile, name] });
    json(path.join(profile, '.gemini/config/mcp_config.json'), { mcpServers: { global: extension('global-mcp') } });
    json(path.join(cwd, '.agents/mcp_config.json'), { mcpServers: { workspace: extension('workspace-mcp') } });
    const hook = name => ({ [name]: { PreInvocation: [{ type: 'command', command: `"${process.execPath}" "${canary}" "${eventsFile}" ${name}`, timeout: 5 }] } });
    json(path.join(profile, '.gemini/config/hooks.json'), hook('global-hook'));
    json(path.join(cwd, '.agents/hooks.json'), hook('workspace-hook'));
    const skillDir = path.join(cwd, '.agents/skills/extension-canary'); fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: extension-canary\ndescription: Local extension fixture\n---\nINJECTED_SKILL_BODY_CANARY\n');
    if (customAgent) {
      const agentDir = path.join(cwd, '.agents/agents'); fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'discussion-text.md'), '---\nname: discussion-text\ndescription: Local text-only fixture\n' +
        'tools: []\nmainAgent: true\nsubagent: false\ninheritCustomizations: false\n---\nCUSTOM_AGENT_FIXTURE_MARKER\n');
    }
    const model = selected?.id || 'extension-fixture';
    const job = await prepareWindowsJob({ identity: { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 }, journal }); jobs.push(job);
    const home = path.join(folder, 'adapter');
    const spec = isCli ? subscriptionSpawnSpec({ runtime: cli, home, env, model, effort: selected.defaultReasoningEffort || '', literalInput })
      : antigravitySpawnSpec({ runtime: sdk, home, env, route: { baseUrl }, executionPolicy: 'tool-free-v1' });
    if (isCli) Object.assign(spec.env, fixtureEnv);
    const begin = requests.length;
    if (customAgent) {
      const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model,
        '--disable-slash-commands', '--agent', 'discussion-text'];
      if (selected.defaultReasoningEffort) args.push('--effort', selected.defaultReasoningEffort);
      const child = job.spawn(cli.file, args, { cwd, env: fixtureEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = createInterface({ input: child.stdout }); child.stderr.on('data', chunk => logs.push(String(chunk)));
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { void job.stop().catch(() => {}); reject(new Error('Custom agent fixture timed out')); }, 30000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', () => { clearTimeout(timer); reject(new Error('Custom agent exited before result: ' + logs.join('\n'))); });
          lines.on('line', line => {
            try {
              const event = JSON.parse(line);
              if (event.event === 'init') child.stdin.write(JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: '/extension-canary CLI literal' }] } }) + '\n');
              if (event.event === 'result') { clearTimeout(timer); resolve(event.result); }
            } catch (error) { clearTimeout(timer); reject(error); }
          });
        });
        assert.equal(result.status, 'SUCCESS', JSON.stringify(result) + logs.join('\n'));
      } finally { lines.close(); }
    } else {
      const session = new AcpSession({ gen: 1, name: 'Native extension fixture', opts: {}, exe: isCli ? process.execPath : sdk.file,
        spec, spawn: job.spawn, settings: { cwd, model, permissionMode: literalInput ? 'default' : 'plan' }, history: new ClaudeHistory(path.join(folder, 'mirror')),
        log: line => logs.push(line), onEvent() {}, onSessionId() {}, onResult() {} });
      sessions.push(session); session.start(); await (session.ready = session.open()); await session.prepareNativeStorage();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { void job.stop().catch(() => {}); reject(new Error('Extension probe timed out')); }, 30000);
        session.onResult = value => { clearTimeout(timer); resolve(value); };
        assert.equal(session.sendUserMessage('/extension-canary CLI literal'), true);
      });
      assert.equal(result.subtype, 'success', JSON.stringify(result) + logs.join('\n'));
      await session.shutdown();
    }
    const proof = await job.stop(); assert.equal(proof.stopped, true); assert.equal(proof.activeProcesses, 0);
    const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
    const own = requests.slice(begin);
    const mainRequests = customAgent ? own.filter(request => JSON.stringify(request.systemInstruction).includes('CUSTOM_AGENT_FIXTURE_MARKER'))
      : isCli ? own.filter(request => request.tools?.length) : own;
    assert.ok(mainRequests.length, 'Missing native model request');
    observations.push({ kind, events, skillExpanded: JSON.stringify(mainRequests).includes('INJECTED_SKILL_BODY_CANARY'),
      literalPresent: JSON.stringify(mainRequests).includes('/extension-canary CLI literal'), modelRequests: own.length,
      advertisedTools: mainRequests.map(request => request.messages ? (request.tools || []).map(tool => tool.function.name)
        : (request.tools || []).flatMap(tool => tool.functionDeclarations || []).map(tool => tool.name)) });
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await probe('cli-expanded'); await probe('cli-literal'); await probe('sdk'); await probe('cli-agent');
    const [expanded, literal, toolFree, custom] = observations;
    for (const value of [expanded, literal, custom]) for (const name of ['global-mcp', 'workspace-mcp']) {
      assert.ok(value.events.some(event => event.kind === name && event.method === 'tools/list'),
        'The canary must reach discovery: ' + value.kind + '/' + name);
    }
    assert.equal(expanded.skillExpanded, true, 'The positive control must really expand the skill');
    assert.equal(literal.skillExpanded, false); assert.equal(literal.literalPresent, true);
    assert.equal(toolFree.skillExpanded, false); assert.equal(toolFree.literalPresent, true);
    assert.equal(toolFree.events.filter(event => event.kind.endsWith('mcp')).length, 0);
    assert.ok(toolFree.advertisedTools.every(tools => tools.length === 0));
    assert.ok(observations.every(value => value.events.every(event => event.method !== 'tools/call')));
    const residual = ['call_mcp_tool', 'list_resources', 'manage_task', 'read_resource'];
    assert.ok(custom.advertisedTools.every(tools => JSON.stringify([...tools].sort()) === JSON.stringify(residual)),
      'The pinned custom agent must expose the observed residual tool surface');
    assert.equal(custom.skillExpanded, false); assert.equal(custom.literalPresent, true);
    console.log(JSON.stringify({ cliVersion: cli.version, sdkVersion: sdk.version, cliDenyStartsGlobalMcp: true,
      cliDenyStartsWorkspaceMcp: true, nativeSkillExpanded: true, literalInputPreserved: true, literalInputStillStartsMcp: true,
      customAgentEmptyToolsStillStartsMcp: true, customAgentResidualTools: residual,
      sdkFileConfiguredMcpStarted: 0, hookCanariesObserved: observations.flatMap(value => value.events).filter(event => event.kind.endsWith('hook')).length,
      // Without a working positive control, absence of a hook canary is not a
      // restriction proof. Hook/plugin coverage remains an admission blocker.
      hookCoverageVerified: false, loopbackReplies: requests.length, stoppedJobs: jobs.length, realModelCalls: 0 }));
  } finally {
    for (const session of sessions) await session.shutdown(); for (const job of jobs) await job.stop();
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('discussion-native-extensions-')); removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
