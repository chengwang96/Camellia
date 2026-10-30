'use strict';

// Real pinned Grok Build -> ACP adapter -> shared model router. Only the model
// is a loopback fixture; no paid APIs or personal GROK_HOME are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { GrokSession, grokSpawnSpec, grokEnvironment } = require('../src/engines/grok-session');
const { normalizeGrokModels } = require('../src/engines/grok-quota');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { removeTree } = require('./test-fs.cjs');

async function run() {
  const appRoot = path.resolve(__dirname, '..');
  const runtime = createRuntimeManager({ root: appRoot, installRoot: appRoot, node: () => process.execPath }).locate('grok', 'api');
  assert.ok(runtime, 'Run npm run setup:grok first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-grok-smoke-'));
  const versionHome = path.join(root, 'version-home');
  const version = spawnSync(runtime.file, ['--version'], { encoding: 'utf8', windowsHide: true,
    env: grokEnvironment(versionHome, isolatedEnvironment(root, process.execPath)) });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout + version.stderr, /grok 1\.0\.70/);
  const home = path.join(root, 'runtime-home'), cwd = path.join(root, 'Project With Spaces');
  fs.mkdirSync(cwd, { recursive: true });
  const marker = path.join(cwd, 'marker.txt'), written = path.join(cwd, 'written.txt'), denied = path.join(cwd, 'denied.txt');
  fs.writeFileSync(marker, 'grok-read-marker-7391');
  const requests = [], events = [], logs = [];
  let slowRequest;
  const server = http.createServer(async (req, res) => {
    if (require('./model-metadata-fixture.cjs')(req, res)) return;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ body, key: req.headers.authorization });
    const titleOnly = body.tools?.length === 1 && body.tools[0].function?.name === 'session_title';
    const lastUser = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('GROK_SMOKE'));
    const prompt = lastUser < 0 ? '' : JSON.stringify(body.messages[lastUser].content);
    if (!titleOnly && prompt.includes('GROK_SMOKE wait')) { slowRequest?.(); return; }
    const hasTool = lastUser >= 0 && body.messages.slice(lastUser).some(m => m.role === 'tool');
    let tool;
    if (titleOnly) tool = { name: 'session_title', arguments: JSON.stringify({ session_title: 'Grok integration fixture' }) };
    else if (!hasTool) {
      if (prompt.includes('GROK_SMOKE read')) tool = { name: 'read_file', arguments: JSON.stringify({ target_file: marker }) };
      if (prompt.includes('GROK_SMOKE write')) tool = { name: 'search_replace', arguments: JSON.stringify({ file_path: written, old_string: '', new_string: 'grok-wrote-7391' }) };
      if (prompt.includes('GROK_SMOKE deny')) tool = { name: 'search_replace', arguments: JSON.stringify({ file_path: denied, old_string: '', new_string: 'must not write' }) };
    }
    const delta = tool ? { tool_calls: [{ index: 0, id: 'tool-' + requests.length, type: 'function', function: tool }] }
      : { content: 'Grok smoke reply ' + requests.length };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
      { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Check the local fixture.' } }] },
      { id: 'fixture', choices: [{ index: 0, delta }] },
      { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
      '[DONE]',
    ]) res.write(frame(chunk));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portProbe = http.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const configPath = path.join(root, 'routes.json');
  writeConfig(configPath, normalizeConfig({ port, providers: [{ id: 'fixture', name: 'Local fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', protocol: 'openai',
    models: [{ id: 'fixture-model', upstream: 'fixture-model' }], keys: [{ id: 'fixture-key', key: 'loopback-only' }] }] }));
  const router = startApiRouter({ configPath }); await router.ready;
  const history = new ClaudeHistory(path.join(root, 'display-history'));
  let session, gen = 0, done, permissionCount = 0, allow = true;
  async function create(opts = {}, permissionMode = 'full') {
    await session?.shutdown();
    const settings = { cwd, model: 'fixture-model', permissionMode };
    const spec = grokSpawnSpec({ home, runtime: runtime.file, model: settings.model, contextWindow: 32768,
      route: { baseUrl: router.url, authToken: 'proxy-managed' }, env: isolatedEnvironment(root, process.execPath) });
    session = new GrokSession({ name: 'Grok', gen: ++gen, settings, opts, exe: runtime.file, spec, spawn, history,
      log: msg => logs.push(msg), onSessionId() {}, onResult: event => done?.(event),
      onEvent: event => {
        events.push(event);
        if (event.type === 'gui:permission') { permissionCount++; session.answerPermission(event.requestId, allow); }
      },
    });
    session.start();
    await (session.ready = session.open());
  }
  function turn(prompt, attachments) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.kill(); reject(new Error('Grok smoke timed out\n' + logs.join('\n'))); }, 40000);
      done = result => { clearTimeout(timer); resolve(result); };
      assert.equal(session.sendUserMessage(prompt, attachments), true);
    });
  }
  try {
    await create();
    const models = normalizeGrokModels(await session.request('_x.ai/models/list', {}));
    assert.ok(models.some(model => model.id === 'camellia'), JSON.stringify(models));
    let result = await turn('GROK_SMOKE read marker.txt');
    assert.equal(result.subtype, 'success', JSON.stringify(result) + logs.join('\n'));
    assert.ok(requests.some(r => r.body.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('grok-read-marker-7391'))));
    assert.ok(events.some(e => e.type === 'gui:tool' && e.status === 'completed'));
    assert.ok(events.some(e => e.type === 'stream_event' && e.event.delta?.type === 'thinking_delta'));
    const sourceId = session.sessionId;
    assert.equal((await turn('GROK_SMOKE write written.txt')).subtype, 'success');
    assert.equal(fs.readFileSync(written, 'utf8'), 'grok-wrote-7391');
    assert.equal(permissionCount, 0, 'Full mode must not ask for native tool approval');
    const reached = new Promise(resolve => { slowRequest = resolve; });
    const pending = turn('GROK_SMOKE wait'); await reached; session.interrupt();
    assert.equal((await pending).subtype, 'stopped');
    await create({ sessionId: sourceId });
    assert.equal((await turn('GROK_SMOKE resume native history')).subtype, 'success');
    assert.equal(session.sessionId, sourceId);
    assert.ok(requests.some(r => JSON.stringify(r.body.messages).includes('GROK_SMOKE resume native history') && JSON.stringify(r.body.messages).includes('GROK_SMOKE read')));
    await create({ sessionId: sourceId }, 'ask'); allow = false;
    assert.equal((await turn('GROK_SMOKE deny denied.txt')).subtype, 'stopped');
    assert.ok(permissionCount > 0, 'Ask mode must route native approval to the workbench');
    assert.equal(fs.existsSync(denied), false);
    await create({ sessionId: sourceId, fork: true });
    assert.equal((await turn('GROK_SMOKE fork native history')).subtype, 'success');
    assert.notEqual(session.sessionId, sourceId);
    assert.ok(requests.some(r => JSON.stringify(r.body.messages).includes('GROK_SMOKE fork native history') && JSON.stringify(r.body.messages).includes('GROK_SMOKE resume')));
    for (const prompt of ['GROK_SMOKE revised native history', 'GROK_SMOKE revised again']) {
      const replaced = prompt.includes('again') ? 'GROK_SMOKE revised native history' : 'GROK_SMOKE fork native history';
      const boundary = await session.editBoundary(replaced);
      assert.ok(Number.isSafeInteger(boundary?.targetPromptIndex), 'Native prompt boundary is required');
      const previous = session.sessionId;
      await create({ sessionId: previous, fork: true, ...boundary });
      const start = requests.length;
      assert.equal((await turn(prompt)).subtype, 'success');
      assert.notEqual(session.sessionId, previous);
      const sent = requests.slice(start).find(r => JSON.stringify(r.body.messages).includes(prompt));
      assert.ok(sent);
      assert.match(JSON.stringify(sent.body.messages), /GROK_SMOKE read|GROK_SMOKE resume/);
      assert.doesNotMatch(JSON.stringify(sent.body.messages), new RegExp(replaced));
      assert.equal(fs.readFileSync(written, 'utf8'), 'grok-wrote-7391');
    }
    const image = path.join(cwd, 'pixel.png');
    fs.copyFileSync(path.join(appRoot, 'assets/icon-256.png'), image);
    assert.equal((await turn('GROK_SMOKE image attachment', [{ path: image, isImage: true }])).subtype, 'success');
    assert.ok(requests.some(r => JSON.stringify(r.body.messages).includes('GROK_SMOKE image attachment') && JSON.stringify(r.body.messages).includes('data:image/png;base64')),
      JSON.stringify(requests.filter(r => JSON.stringify(r.body.messages).includes('GROK_SMOKE image attachment')).map(r => r.body)));
    assert.ok(requests.every(request => request.key === 'Bearer loopback-only'));
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.ok(!config.includes('loopback-only') && !config.includes('proxy-managed'));
    assert.ok(!logs.join('\n').includes('loopback-only'));
    console.log(`PASS: real Grok Build ${runtime.version}, isolated --version, ACP models, API tools, full/ask permissions, stop, resume, fork, repeated native editing and image input. Local endpoints only.`);
  } catch (error) {
    const nativeLog = path.join(home, 'logs/unified.jsonl');
    const diagnostics = { error: error.message, logs, events, requests,
      nativeLog: fs.existsSync(nativeLog) ? fs.readFileSync(nativeLog, 'utf8').slice(-64000) : '' };
    const file = path.join(appRoot, 'dist/grok-smoke-diagnostics.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(diagnostics, null, 2));
    console.error('Grok diagnostics: ' + file);
    if (logs.length) console.error(logs.join('\n'));
    if (diagnostics.nativeLog) console.error(diagnostics.nativeLog);
    throw error;
  } finally {
    await session?.shutdown(); await router.stop(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-grok-smoke-'));
    removeTree(root);
  }
}
const watchdog = setTimeout(() => { console.error('Grok smoke exceeded 150 seconds'); process.exit(1); }, 150000);
run().catch(error => { console.error(error); if (error.data) console.error(JSON.stringify(error.data)); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
