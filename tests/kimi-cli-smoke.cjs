'use strict';

// Real, pinned Kimi CLI -> workbench adapter -> same-model router failover.
// Every model request goes to a loopback fixture; no paid APIs or global config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { KimiSession, kimiSpawnSpec } = require('../src/engines/kimi-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');

async function run() {
  const runtime = path.resolve(process.argv[2] || path.join(__dirname, '../runtimes/kimi/node_modules/@moonshot-ai/kimi-code/dist/main.mjs'));
  assert.ok(fs.existsSync(runtime), 'Run npm run setup:kimi first');
  const runtimeVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime), '..', 'package.json'), 'utf8')).version;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-kimi-smoke-'));
  let inputRoot = root;
  if (process.platform === 'win32') {
    // GitHub's Windows runner supplies an 8.3 TEMP path. Exercise that path
    // spelling locally too, on volumes where short names are enabled.
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CAMELLIA_TEST_PATH).ShortPath'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, CAMELLIA_TEST_PATH: root } });
    assert.equal(probe.status, 0, probe.stderr);
    inputRoot = probe.stdout.trim();
    assert.equal(fs.realpathSync.native(inputRoot), fs.realpathSync.native(root));
  }
  const home = path.join(inputRoot, 'runtime-home');
  const cwd = path.join(inputRoot, 'Project With Spaces');
  fs.mkdirSync(cwd);
  const marker = path.join(cwd, 'marker.txt');
  const written = path.join(cwd, 'written.txt');
  const denied = path.join(cwd, 'denied.txt');
  fs.writeFileSync(marker, 'kimi-read-marker-7391');
  const requests = [], events = [], logs = [];
  let slowRequest;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({ body, key: req.headers.authorization });
    if (req.headers.authorization === 'Bearer exhausted') {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end('{"error":"quota exhausted"}'); return;
    }
    const lastUser = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('SMOKE '));
    const prompt = JSON.stringify(body.messages[lastUser].content);
    if (prompt.includes('SMOKE wait')) { slowRequest?.(); return; }
    const hasTool = body.messages.slice(lastUser).some(m => m.role === 'tool');
    let tool;
    if (!hasTool) {
      if (prompt.includes('SMOKE read')) tool = { name: 'Read', arguments: JSON.stringify({ path: marker }) };
      if (prompt.includes('SMOKE write')) tool = { name: 'Write', arguments: JSON.stringify({ path: written, content: 'kimi-wrote-7391' }) };
      if (prompt.includes('SMOKE deny')) tool = { name: 'Write', arguments: JSON.stringify({ path: denied, content: 'must not write' }) };
      if (prompt.includes('SMOKE shell')) tool = { name: 'Bash', arguments: JSON.stringify({ command: 'pwd', description: 'Report this test workspace' }) };
    }
    const delta = tool ? { tool_calls: [{ index: 0, id: 'tool-' + requests.length, type: 'function', function: tool }] } : { content: 'Kimi smoke reply ' + requests.length };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
      { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Check the local fixture.' } }] },
      { id: 'fixture', choices: [{ index: 0, delta }] },
      { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }, '[DONE]',
    ]) res.write(frame(chunk));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const configPath = path.join(root, 'routes.json');
  const url = 'http://127.0.0.1:' + server.address().port + '/v1';
  writeConfig(configPath, normalizeConfig({ port, providers: [
    { id: 'first', name: 'Exhausted fixture', baseUrl: url, protocol: 'openai', models: [{ id: 'kimi-k2.5', upstream: 'kimi-k2.5' }], keys: [{ id: 'bad', key: 'exhausted' }] },
    { id: 'next', name: 'Working fixture', baseUrl: url, protocol: 'openai', models: [{ id: 'kimi-k2.5', upstream: 'moonshotai/kimi-k2.5' }], keys: [{ id: 'good', key: 'local-working' }] },
    { id: 'unrelated', name: 'Other model', baseUrl: url, protocol: 'openai', models: [{ id: 'other-model', upstream: 'other-model' }], keys: [{ id: 'other', key: 'never-use' }] },
  ] }));
  const router = startApiRouter({ configPath });
  await router.ready;
  const history = new ClaudeHistory(path.join(root, 'display-history'));
  let session, gen = 0, done, permissionCount = 0, allow = true;
  async function create(opts = {}) {
    await session?.shutdown();
    const settings = { cwd, model: 'kimi-k2.5', permissionMode: 'default' };
    const spec = kimiSpawnSpec({ home, runtime, model: settings.model, contextWindow: 32768,
      route: { baseUrl: router.url, authToken: 'proxy-managed' },
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' } });
    session = new KimiSession({ gen: ++gen, settings, opts, exe: process.execPath, spec, spawn, history,
      log: msg => logs.push(msg), onSessionId() {}, onResult: event => done?.(event),
      onEvent: event => {
        events.push(event);
        if (event.type === 'gui:permission') {
          permissionCount++;
          assert.ok(event.options.length);
          session.answerPermission(event.requestId, allow);
        }
      },
    });
    session.start();
    if (process.platform === 'win32') {
      assert.equal(spec.env.KIMI_CODE_HOME, fs.realpathSync.native(home));
      assert.equal(session.cwd, fs.realpathSync.native(cwd));
    }
  }
  function turn(prompt, attachments) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.kill(); reject(new Error('Kimi smoke timed out\n' + logs.join('\n'))); }, 30000);
      done = result => { clearTimeout(timer); resolve(result); };
      assert.equal(session.sendUserMessage(prompt, attachments), true);
    });
  }
  try {
    await create();
    let result = await turn('SMOKE read marker.txt');
    assert.equal(result.subtype, 'success', JSON.stringify(result) + logs.join('\n'));
    assert.equal(requests[0].key, 'Bearer exhausted');
    assert.equal(requests[1].key, 'Bearer local-working');
    assert.ok(requests.slice(1).every(r => r.body.model === 'moonshotai/kimi-k2.5'));
    assert.ok(requests.some(r => r.body.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('kimi-read-marker-7391'))), JSON.stringify({ tools: events.filter(e => e.type === 'gui:tool'), requests: requests.map(r => r.body.messages.filter(m => m.role !== 'system').slice(-3)) }));
    assert.ok(events.some(e => e.type === 'gui:tool' && e.status === 'completed'));
    assert.ok(events.some(e => e.type === 'stream_event' && e.event.delta?.type === 'thinking_delta'));
    const sourceId = session.sessionId;
    assert.equal((await turn('SMOKE write written.txt')).subtype, 'success');
    assert.equal(fs.readFileSync(written, 'utf8'), 'kimi-wrote-7391');
    assert.ok(permissionCount > 0, 'A write in manual mode must ask the workbench');
    allow = false;
    assert.equal((await turn('SMOKE deny denied.txt')).subtype, 'success');
    assert.equal(fs.existsSync(denied), false);
    allow = true;
    assert.equal((await turn('SMOKE shell cwd')).subtype, 'success');
    assert.ok(events.some(e => e.type === 'gui:tool' && e.output?.includes('Project With Spaces')), 'Bash must work without optional node-pty');
    const reached = new Promise(resolve => { slowRequest = resolve; });
    const pending = turn('SMOKE wait');
    await reached;
    session.interrupt();
    assert.equal((await pending).subtype, 'stopped');
    await create({ sessionId: sourceId });
    assert.equal((await turn('SMOKE resume native history')).subtype, 'success');
    assert.equal(session.sessionId, sourceId);
    assert.match(JSON.stringify(requests.at(-1).body.messages), /SMOKE read/);
    await create({ sessionId: sourceId, fork: true });
    assert.equal((await turn('SMOKE fork native history')).subtype, 'success');
    assert.notEqual(session.sessionId, sourceId);
    assert.ok(JSON.stringify(requests.at(-1).body.messages).includes('SMOKE resume'), JSON.stringify(requests.at(-1).body.messages.filter(m => m.role === 'user' && m.content.includes('SMOKE'))));
    assert.ok((await history.transcript(session.sessionId)).messages.length >= 10);
    assert.equal((await history.list()).length, 2);
    const image = path.join(cwd, 'pixel.png');
    fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64'));
    assert.equal((await turn('SMOKE image attachment', [{ path: image, isImage: true }])).subtype, 'success');
    assert.match(JSON.stringify(requests.at(-1).body.messages), /data:image\/png;base64/);
    assert.equal(requests.some(r => r.key === 'Bearer never-use'), false);
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.ok(!config.includes('local-working') && !config.includes('exhausted'));
    assert.match(config, /proxy-managed/);
    console.log(`PASS: real Kimi Code ${runtimeVersion} ACP, same-model quota failover, streamed thought/text, Read/Write/Bash, approve/deny, cancel, native resume/fork, isolated history and config. Local endpoints only.`);
  } finally {
    await session?.shutdown();
    await router.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('workbench-kimi-smoke-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
