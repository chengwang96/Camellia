'use strict';

// Probe native CLI deny rules in an isolated profile. The model is a local
// Gemini fixture; this does not establish subscription or production policy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { AcpSession } = require('../src/engines/acp-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { locateAntigravityCli } = require('../src/main/antigravity-cli-runtime');
const { parseModels, groupModels, runCli } = require('../src/engines/antigravity/subscription');
const { prepareWindowsJob } = require('../src/engines/discussions/windows-job');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  assert.equal(process.platform, 'win32', 'This containment probe requires Windows');
  const runtime = locateAntigravityCli(path.resolve(__dirname, '../runtimes/antigravity')); assert.equal(runtime?.version, '1.2.3');
  const variant = process.argv[2] || 'typed-deny';
  assert.ok(['bare-wildcard', 'typed-deny'].includes(variant));
  const actions = ['read_file', 'write_file', 'command', 'unsandboxed', 'read_url', 'execute_url', 'mcp'];
  const rules = actions.map(action => action + '(*)'), typed = variant === 'typed-deny';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-cli-policy-'));
  const profile = path.join(root, 'profile'), cwd = path.join(root, 'work'), home = path.join(root, 'adapter');
  const nativeDir = path.join(profile, '.gemini/antigravity-cli'); fs.mkdirSync(nativeDir, { recursive: true }); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'existing.txt'), 'keep this content');
  fs.writeFileSync(path.join(nativeDir, 'settings.json'), JSON.stringify({ modelProvider: 'gemini', enableTelemetry: false,
    toolPermission: 'always-proceed', artifactReviewPolicy: 'always-proceed',
    permissions: { allow: rules, ...(typed ? { ask: rules } : {}), deny: typed ? rules : ['*'] } }));
  const env = isolatedEnvironment(profile, process.execPath); if (env.SystemRoot === env.SYSTEMROOT) delete env.SYSTEMROOT;
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  const journal = new WindowsJobJournal({ dir: path.join(root, 'jobs') }), jobs = [], sessions = [], logs = [], events = [], requests = [];
  const injected = new Set(), feedback = new Map();
  let urlReads = 0;
  const cases = {
    write: { name: 'write_to_file', args: { TargetFile: path.join(cwd, 'created.txt'), CodeContent: 'must not be written',
      Overwrite: false, Description: 'Local policy fixture' } },
    edit: { name: 'replace_file_content', args: { TargetFile: path.join(cwd, 'existing.txt'), TargetContent: 'keep this content',
      ReplacementContent: 'must not replace', AllowMultiple: false, StartLine: 1, EndLine: 1,
      Instruction: 'Replace the fixture content', Description: 'Local policy fixture' } },
    shell: { name: 'run_command', args: { CommandLine: 'echo must-not-run > shell.txt', Cwd: cwd,
      WaitMsBeforeAsync: 1000 } },
    read: { name: 'view_file', args: { AbsolutePath: path.join(cwd, 'existing.txt'), StartLine: 1, EndLine: 1 } },
    url: { name: 'read_url_content', args: {} },
  };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/url-canary') { urlReads++; res.writeHead(200); res.end('Local URL canary'); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body); assert.ok(requests.length < 30);
      const declarations = (body.tools || []).flatMap(tool => tool.functionDeclarations || []);
      const user = [...(body.contents || [])].reverse().find(message => message.role === 'user' && message.parts?.some(part => part.text?.includes('CLI POLICY')));
      const name = /CLI POLICY (\w+)/.exec(user?.parts.map(part => part.text || '').join(''))?.[1];
      for (const message of body.contents || []) for (const part of message.parts || []) if (part.functionResponse) {
        feedback.set(part.functionResponse.name, part.functionResponse.response);
      }
      let parts = [{ text: 'CLI policy fixture reply' }];
      if (name && declarations.length && !injected.has(name)) {
        const tool = declarations.find(tool => tool.name === cases[name]?.name);
        assert.ok(tool, 'The probe requires the native tool to be advertised'); injected.add(name);
        parts = [{ functionCall: { name: tool.name, args: { ...cases[name].args, toolAction: 'Local policy fixture', toolSummary: 'Verify denial' } },
          thoughtSignature: Buffer.from('fixture-signature').toString('base64') }];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 } }) + '\n\n');
    } catch (error) { logs.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  async function turn(active, prompt) {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void active.job.stop().catch(() => {}); reject(new Error('CLI policy fixture timed out')); }, 30000);
      active.session.onResult = value => { clearTimeout(timer); resolve(value); };
      assert.equal(active.session.sendUserMessage(prompt), true);
    });
    assert.equal(result.subtype, 'success', JSON.stringify(result) + logs.join('\n'));
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    cases.url.args.Url = `http://127.0.0.1:${server.address().port}/url-canary`;
    const fixtureEnv = { ...env, GEMINI_API_KEY: 'fixture-not-a-key', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}` };
    const selected = groupModels(parseModels(await runCli(runtime.file, ['models'], { env: fixtureEnv, cwd })))[0]; assert.ok(selected);
    async function open(sessionId) {
      const job = await prepareWindowsJob({ identity: { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 }, journal }); jobs.push(job);
      const spec = subscriptionSpawnSpec({ runtime, home, env, model: selected.id, effort: selected.defaultReasoningEffort || '', literalInput: true });
      Object.assign(spec.env, fixtureEnv);
      const session = new AcpSession({ gen: sessions.length + 1, name: 'Antigravity CLI policy fixture', opts: { sessionId }, exe: process.execPath, spec, spawn: job.spawn,
        settings: { cwd, model: selected.id, permissionMode: 'default' }, history: new ClaudeHistory(path.join(root, 'mirror')),
        log: line => logs.push(line), onEvent: event => events.push(event), onSessionId() {}, onResult() {} });
      sessions.push(session); session.start(); await (session.ready = session.open());
      return { session, job, nativeId: await session.prepareNativeStorage() };
    }
    async function stop(active) {
      await active.session.shutdown(); const proof = await active.job.stop(); assert.equal(proof.stopped, true); assert.equal(proof.activeProcesses, 0);
    }
    const active = await open();
    for (const name of Object.keys(cases)) await turn(active, 'CLI POLICY ' + name);
    await stop(active);
    if (typed) {
      const resumed = await open(active.session.sessionId); assert.equal(resumed.nativeId, active.nativeId);
      injected.delete('write'); feedback.delete('write_to_file');
      cases.write.args.TargetFile = path.join(cwd, 'resumed.txt');
      await turn(resumed, 'CLI POLICY write'); await stop(resumed);
      // A response from the first turn's retained history is not evidence that
      // the new process applied the rule to this new attempted write.
      assert.match(JSON.stringify(feedback.get('write_to_file')), /resumed\.txt/);
    }
    assert.deepEqual([...injected].sort(), Object.keys(cases).sort());
    const details = JSON.stringify([...feedback]) + logs.join('\n');
    if (typed) {
      assert.deepEqual(fs.readdirSync(cwd), ['existing.txt'], details);
      assert.equal(fs.readFileSync(path.join(cwd, 'existing.txt'), 'utf8'), 'keep this content');
      for (const { name } of Object.values(cases)) {
        assert.match(JSON.stringify(feedback.get(name)), /Matches user-configured deny rule/, name + ': ' + details);
        assert.doesNotMatch(JSON.stringify(feedback.get(name)), /invalid arguments|tool validation|additional properties/i);
      }
      assert.equal(urlReads, 0);
    } else {
      // Positive counterexample: bare "*" is not the action(target) wildcard.
      // Only temporary canaries are affected. A passing result here disproves
      // containment by that spelling; it never claims a usable policy.
      assert.deepEqual(fs.readdirSync(cwd).sort(), ['created.txt', 'existing.txt', 'shell.txt'], details);
      assert.equal(fs.readFileSync(path.join(cwd, 'existing.txt'), 'utf8'), 'must not replace');
      assert.match(fs.readFileSync(path.join(cwd, 'shell.txt'), 'utf8'), /must-not-run/);
      assert.ok(urlReads > 0, details);
    }
    assert.equal(events.filter(event => event.type === 'gui:permission').length, 0);
    console.log(JSON.stringify({ cliVersion: runtime.version, variant, explicitRulesMatched: typed ? injected.size : 0,
      denyOverridesAllowAskAndProceed: typed, resumedDenialVerified: typed, toolsStillAdvertised: true, workspaceUnchanged: typed, urlReads,
      loopbackReplies: requests.length, stoppedJobs: jobs.length, realModelCalls: 0 }));
  } finally {
    for (const session of sessions) await session.shutdown(); for (const job of jobs) await job.stop();
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('discussion-cli-policy-')); removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
