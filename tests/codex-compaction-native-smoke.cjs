'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CodexSession } = require('../src/engines/codex-session');
const { ClaudeSession } = require('../src/engines/claude-session');
const { KimiSession, kimiSpawnSpec } = require('../src/engines/kimi-session');
const { codexSpawnSpec } = require('../src/engines/codex-client');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const engine = process.argv[2] || 'codex';
  assert.ok(['codex', 'claude', 'kimi'].includes(engine));
  const runtime = createRuntimeManager({ root: appRoot, installRoot: appRoot }).locate(engine);
  assert.ok(runtime, 'Install the ' + engine + ' runtime first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-native-compact-'));
  const requests = [], notifications = [], events = [], logs = [];
  let router, session, complete;
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Task checkpoint: preserve NATIVE_MARKER_7391 and continue.' } }] }));
      response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      response.end(frame('[DONE]'));
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  function turn(prompt) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void session.kill(); reject(new Error('Native turn timed out\n' + logs.join('\n'))); }, 45000);
      complete = result => { clearTimeout(timer); resolve(result); };
      assert.equal(session.sendUserMessage(prompt), true);
    });
  }
  try {
    await listen(server);
    const probe = http.createServer(); await listen(probe);
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const configPath = path.join(root, 'router.json');
    writeConfig(configPath, normalizeConfig({ port, providers: [{ id: 'local', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'compact-fixture', upstream: 'fixture' }],
      keys: [{ id: 'local-key', key: 'local-only' }] }] }));
    router = startApiRouter({ configPath, timeoutMs: 5000 }); await router.ready;
    const env = isolatedEnvironment(path.join(root, 'home'), process.execPath);
    const spec = engine === 'codex' ? codexSpawnSpec({ runtime, home: path.join(root, 'codex'), cwd: root, connection: 'api', model: 'compact-fixture',
      env, route: { baseUrl: router.url } }) : engine === 'kimi' ? kimiSpawnSpec({ runtime: runtime.file, home: path.join(root, 'kimi'), model: 'compact-fixture',
      env, route: { baseUrl: router.url, authToken: 'proxy-managed' } }) : { cwd: root, env: { ...env, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), ANTHROPIC_BASE_URL: router.url,
        ANTHROPIC_AUTH_TOKEN: 'local-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
        args: ['--bare', '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose', '--model', 'compact-fixture', '--tools', ''] };
    const Session = { codex: CodexSession, claude: ClaudeSession, kimi: KimiSession }[engine];
    session = new Session({ gen: 1, settings: { cwd: root, model: 'compact-fixture', connection: 'api', permissionMode: 'bypassPermissions' },
      opts: {}, spec, exe: engine === 'kimi' ? process.execPath : runtime.file, spawn, history: new ClaudeHistory(path.join(root, 'history')), log: text => logs.push(text),
      onEvent: event => events.push(event), onResult: result => complete?.(result), onSessionId() {} });
    if (engine === 'codex') {
      const notify = session.notify.bind(session);
      session.notify = (method, params) => { notifications.push({ method, params }); notify(method, params); };
    }
    session.start();
    const initial = await turn('Remember NATIVE_MARKER_7391. No tools needed.');
    assert.equal(initial.subtype, 'success', JSON.stringify(initial) + '\n' + logs.slice(-15).join('\n'));
    for (let index = 0; index < 4; index++) assert.equal((await turn('Keep this checkpoint. ' + 'History to summarize. '.repeat(700))).subtype, 'success');
    const threadId = session.sessionId, proc = session.client?.proc || session.proc, before = requests.length, results = events.filter(event => event.type === 'result').length;
    try { await session.compact({ timeoutMs: 45000 }); }
    catch (error) { throw new Error(error.message + '\n' + logs.slice(-12).join('\n')); }
    assert.ok(requests.length > before, 'Native compression must contact the local model');
    assert.equal(session.sessionId, threadId);
    assert.equal(session.client?.proc || session.proc, proc);
    assert.equal(events.filter(event => event.type === 'result').length, results, 'Compaction must not count as a user result');
    if (engine === 'codex') assert.ok(notifications.some(event => event.method === 'item/completed' && event.params.item.type === 'contextCompaction'));
    assert.equal((await turn('Continue from the checkpoint without tools.')).subtype, 'success');
    assert.equal(session.sessionId, threadId);
    assert.match(JSON.stringify(requests.at(-1)), /NATIVE_MARKER_7391/);
    console.log('PASS installed ' + engine + ': native compaction, lifecycle completion, same process/thread, checkpoint continuation; loopback only');
  } finally {
    if (session?.shutdown) await session.shutdown();
    else if (session) {
      const closed = new Promise(resolve => session.proc.once('close', resolve));
      session.kill(); await closed;
    }
    await router?.stop();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-native-compact-'));
    removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
