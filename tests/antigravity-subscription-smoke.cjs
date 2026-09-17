'use strict';
// Exercise the actual CLI stream protocol with a local Gemini fixture. OAuth
// and subscriptions remain owned by Google; this test needs no Google account.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { AcpSession } = require('../src/engines/acp-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { locateAntigravityCli } = require('../src/main/antigravity-cli-runtime');
const { parseModels, runCli } = require('../src/engines/antigravity/subscription');

async function run() {
  const runtime = locateAntigravityCli(path.resolve(process.argv[2] || 'runtimes/antigravity'));
  assert.ok(runtime, 'Run npm run setup:antigravity:subscription first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-google-smoke-'));
  const profile = path.join(root, 'profile'), cwd = path.join(root, 'Project With Spaces');
  const settingsFile = path.join(profile, '.gemini/antigravity-cli/settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.mkdirSync(cwd);
  fs.writeFileSync(settingsFile, JSON.stringify({ modelProvider: 'gemini', enableTelemetry: false }));
  let session, complete, waiting;
  const events = [], errors = [], requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const declarations = (body.tools || []).flatMap(tool => tool.functionDeclarations || []);
      const userIndex = (body.contents || []).findLastIndex(message => message.parts?.some(part => /GOOGLE SMOKE/.test(part.text)));
      const prompt = body.contents?.[userIndex]?.parts.map(part => part.text || '').join('') || '';
      const mainRequest = Boolean(declarations.length && userIndex >= 0);
      if (mainRequest) requests.push(body);
      if (mainRequest && prompt.includes('GOOGLE SMOKE wait')) { waiting?.(); return; }
      const hasResponse = body.contents?.slice(userIndex + 1).some(message => message.parts?.some(part => part.functionResponse));
      let parts = [{ text: 'Google CLI fixture reply.' }];
      if (mainRequest && /GOOGLE SMOKE (write|deny)/.test(prompt) && !hasResponse) {
        const tool = declarations.find(tool => tool.name === 'write_to_file');
        assert.ok(tool, 'The official write tool must be present');
        parts = [{ functionCall: { name: tool.name, args: { TargetFile: path.join(cwd, prompt.includes('deny') ? 'denied.txt' : 'written.txt'),
          CodeContent: 'written-by-official-cli', Overwrite: false, Description: 'Local test file', toolAction: 'Testing file edits', toolSummary: 'Write a fixture' } }, thoughtSignature: Buffer.from('fixture-signature').toString('base64') }];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 } }) + '\n\n');
    } catch (error) { errors.push(error.stack); res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseEnv = { ...process.env, HOME: profile, USERPROFILE: profile, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  const fixtureEnv = { ...baseEnv, GEMINI_API_KEY: 'local-fixture', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const history = new ClaudeHistory(path.join(root, 'history'));
  let generation = 0;
  function start(opts = {}, permissionMode = 'default') {
    const spec = subscriptionSpawnSpec({ runtime, home: path.join(root, 'adapter'), env: baseEnv });
    if (process.argv[3]) spec.args[0] = path.resolve(process.argv[3]);
    // Only the test supplies API mode and a local transport, after asserting the
    // production subscription spec has removed inherited API credentials.
    assert.equal(spec.env.GEMINI_API_KEY, undefined);
    Object.assign(spec.env, fixtureEnv);
    session = new AcpSession({ name: 'Antigravity CLI', gen: ++generation, settings: { cwd, model: selected.id, permissionMode }, opts,
      exe: process.execPath, spec, spawn, history, log: message => errors.push(message), onEvent: event => events.push(event),
      onSessionId() {}, onResult: result => complete?.(result) });
    session.start();
    return session;
  }
  async function send(prompt) {
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI turn timed out: ' + errors.join('\n'))), 45000);
      complete = value => { clearTimeout(timer); resolve(value); };
    });
    assert.ok(session.sendUserMessage(prompt));
    return result;
  }
  async function closeSession() {
    const proc = session?.proc;
    const exited = proc && proc.exitCode === null ? new Promise(resolve => proc.once('close', resolve)) : Promise.resolve();
    await session?.shutdown();
    await exited;
  }
  let selected;
  try {
    const models = parseModels(await runCli(runtime.file, ['models'], { env: fixtureEnv, cwd }));
    selected = models[0]; assert.ok(selected);
    start();
    const first = await send('GOOGLE SMOKE hello');
    assert.equal(first.subtype, 'success', JSON.stringify(first) + errors.join('\n'));
    assert.match(first.session_id, /^agy-/); assert.match(first.result, /Google CLI fixture reply/);
    const second = await send('GOOGLE SMOKE again');
    assert.equal(second.subtype, 'success', JSON.stringify(second) + errors.join('\n'));
    assert.equal(second.session_id, first.session_id);
    assert.equal(second.usage.input_tokens, first.usage.input_tokens, 'Token counts describe the current turn, not the whole process');
    assert.ok(requests.at(-1).contents.some(message => message.role === 'model'), 'The CLI retains native context across turns');
    await closeSession();
    start({ sessionId: first.session_id }, 'acceptEdits');
    const resumed = await send('GOOGLE SMOKE write');
    assert.equal(resumed.subtype, 'success', JSON.stringify(resumed) + errors.join('\n'));
    assert.equal(resumed.session_id, first.session_id);
    assert.equal(fs.readFileSync(path.join(cwd, 'written.txt'), 'utf8').trim(), 'written-by-official-cli');
    assert.ok(events.some(event => event.type === 'gui:tool'));
    await closeSession();
    fs.writeFileSync(settingsFile, JSON.stringify({ modelProvider: 'gemini', enableTelemetry: false, permissions: { ask: ['write_file(*)'] } }));
    start({ sessionId: first.session_id });
    const denied = await send('GOOGLE SMOKE deny');
    assert.equal(denied.subtype, 'success', JSON.stringify(denied) + errors.join('\n'));
    assert.equal(fs.existsSync(path.join(cwd, 'denied.txt')), false, 'Headless mode must not silently approve an explicit CLI review rule');
    const requestStarted = new Promise(resolve => { waiting = resolve; });
    const stopped = send('GOOGLE SMOKE wait');
    await Promise.race([requestStarted, stopped.then(() => { throw new Error('The waiting request ended too early'); })]);
    session.interrupt();
    assert.equal((await stopped).subtype, 'stopped');
    await closeSession();
    start({ sessionId: first.session_id });
    assert.equal((await send('GOOGLE SMOKE after stop')).subtype, 'success');
    const transcript = await history.transcript(first.session_id);
    assert.ok(transcript.messages.length >= 10, 'The workbench history also survives process restarts');
    await closeSession();
    const available = selected, count = requests.length;
    selected = { id: 'missing-model-for-fixture' };
    start();
    const invalid = await send('GOOGLE SMOKE invalid model');
    assert.equal(invalid.is_error, true);
    assert.match(invalid.result, /invalid model selection/);
    assert.equal(requests.length, count, 'An invalid pinned model must not fall back to a different model');
    await closeSession();
    selected = available;
    start({ sessionId: invalid.session_id });
    assert.equal((await send('GOOGLE SMOKE retry after setup error')).subtype, 'success', 'A failed initialization can be retried from its saved workbench session');
    await closeSession();
    start({ sessionId: first.session_id, fork: true });
    assert.match((await send('GOOGLE SMOKE fork')).result, /does not support forks/);
    assert.equal(errors.filter(message => /AssertionError/.test(message)).length, 0, errors.join('\n'));
    console.log('PASS: Official CLI models, streaming, per-turn usage, native resume, edits, review denial, cancel and resume.');
  } finally {
    await closeSession();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
