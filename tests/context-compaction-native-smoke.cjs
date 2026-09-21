'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { removeTree } = require('./test-fs.cjs');
const { SharedConversations } = require('../src/engines/shared-conversations');
const { ClaudeSession } = require('../src/engines/claude-session');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');

async function main() {
  const runtime = createRuntimeManager({ root: path.resolve(__dirname, '..'), node: () => process.execPath }).locate('claude');
  assert.ok(runtime, 'Install the Claude runtime before running this smoke test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-compact-native-'));
  const sessions = [], requests = [], events = [], logs = [];
  let manager, router, generation = 0;
  const marker = path.join(root, 'marker.txt');
  fs.writeFileSync(marker, 'ALREADY_READ_MARKER');
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const lastUser = JSON.stringify(body.messages.findLast(message => message.role === 'user')?.content);
      const summary = lastUser.includes('compact working context');
      const continuation = !summary && lastUser.includes('Continue the unfinished user task');
      requests.push({ summary, continuation });
      const hasTool = body.messages.some(message => message.role === 'tool');
      const useTool = !summary && !continuation && !hasTool;
      const delta = useTool ? { tool_calls: [{ index: 0, id: 'read-marker', type: 'function', function: {
        name: 'Read', arguments: JSON.stringify({ file_path: marker }),
      } }] } : { content: summary ? 'Marker already read. Next: verify and report completion.' : 'NATIVE_COMPACTION_FINISHED' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { id: 'compact-fixture', choices: [{ index: 0, delta: { role: 'assistant' } }] },
        { id: 'compact-fixture', choices: [{ index: 0, delta }] },
        { id: 'compact-fixture', choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }] }, '[DONE]',
      ]) response.write(frame(event));
      response.end();
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const configPath = path.join(root, 'router.json');
    writeConfig(configPath, normalizeConfig({ port, providers: [{ id: 'local', name: 'Local fixture', protocol: 'openai',
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', models: [{ id: 'kimi-k3', upstream: 'kimi-k3' }],
      keys: [{ id: 'fixture', key: 'local-only' }] }] }));
    router = startApiRouter({ configPath });
    await router.ready;
    const env = { ...isolatedEnvironment(path.join(root, 'home'), process.execPath),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), ANTHROPIC_BASE_URL: router.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
    const settings = { model: 'kimi-k3', connection: 'api', contextWindow: 20000 };
    const driver = { settings: () => settings, ensure(opts) {
      const session = new ClaudeSession({ gen: ++generation, settings: { ...settings, cwd: root }, opts,
        exe: runtime.file, spec: { cwd: root, env, args: ['--bare', '-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
          '--include-partial-messages', '--verbose', '--model', 'kimi-k3', '--tools', 'Read', '--allowedTools', 'Read'] },
        spawn, log: text => logs.push(text), onEvent: event => manager.capture('claude', event) });
      session.start(); sessions.push(session); return session;
    } };
    manager = new SharedConversations({ dir: path.join(root, 'conversations'), loadConfig: () => ({}), saveConfig() {},
      drivers: { claude: driver }, onEvent: event => events.push(event) });
    const run = await manager.send('claude', { prompt: 'Read marker.txt once, then verify and report completion.' });
    manager.append(manager.get(run.sessionId), { role: 'tool', text: 'Earlier completed work: ' + 'x'.repeat(52000) });
    let timer;
    const result = await Promise.race([run.done, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native compaction timed out\n' + logs.slice(-15).join('\n'))), 90000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(result.is_error, false, JSON.stringify(result));
    assert.match(result.result, /NATIVE_COMPACTION_FINISHED/);
    assert.ok(requests.some(request => request.summary));
    assert.ok(requests.some(request => request.continuation));
    assert.equal(events.filter(event => event.type === 'conversation:continued').length, 1);
    assert.equal(events.filter(event => event.type === 'conversation:started').length, 1);
    assert.equal(events.filter(event => event.type === 'result').length, 1);
    assert.equal(manager.messages(manager.get(run.sessionId)).filter(row => row.role === 'user').length, 1);
    assert.equal(events.filter(event => event.type === 'assistant').flatMap(event => event.message?.content || [])
      .filter(block => block.type === 'tool_use' && block.name === 'Read').length, 1);
    assert.equal(manager.busy(run.sessionId), false);
    console.log('PASS: installed Claude CLI tool boundary -> interrupt -> chunked summary -> fresh native continuation; one user turn, one Read, one final result; loopback only');
  } finally {
    const closed = sessions.filter(session => session.proc?.exitCode == null).map(session => once(session.proc, 'close'));
    for (const session of sessions) session.kill();
    await Promise.all(closed);
    await router?.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-compact-native-'));
    removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
