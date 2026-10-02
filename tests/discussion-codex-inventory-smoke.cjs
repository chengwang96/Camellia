'use strict';

// Explicit native-runtime probe: isolated homes, loopback protocol replies,
// no real account/model and no discussion group. Windows Job contains the CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const TOML = require('smol-toml');
const { CodexSession } = require('../src/engines/codex-session');
const { codexSpawnSpec } = require('../src/engines/codex-client');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { readCodexNativeHistories } = require('../src/engines/discussions/codex-history-inventory');
const { prepareWindowsJob } = require('../src/engines/discussions/windows-job');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  assert.equal(process.platform, 'win32', 'This native containment probe requires Windows');
  const appRoot = path.resolve(__dirname, '..');
  const runtime = createRuntimeManager({ root: appRoot, installRoot: appRoot }).locate('codex');
  assert.ok(runtime && fs.existsSync(runtime.file), 'The pinned Codex runtime must already be installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-codex-source-smoke-'));
  const cwd = path.join(root, 'work'), home = path.join(root, 'profile/.codex'); fs.mkdirSync(cwd);
  const env = isolatedEnvironment(path.join(root, 'profile'), process.execPath);
  // The benchmark helper copies both spellings from Windows' case-insensitive
  // process.env. The strict Job launcher accepts one unambiguous entry only.
  if (env.SystemRoot === env.SYSTEMROOT) delete env.SYSTEMROOT;
  const version = execFileSync(runtime.file, ['--version'], { env, cwd, windowsHide: true, timeout: 10000, encoding: 'utf8' }).trim();
  const journal = new WindowsJobJournal({ dir: path.join(root, 'windows-jobs') });
  const jobs = [], sessions = [], logs = [], requests = [];
  let router;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      assert.equal(body.model, 'fixture-native-inventory');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Inventory fixture reply' } }] }));
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
      res.end(frame('[DONE]'));
    } catch (error) {
      logs.push(error.message); if (!res.headersSent) res.writeHead(500); res.end('Fixture failed');
    }
  });
  const listen = value => new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  const close = value => new Promise((resolve, reject) => value.close(error => error ? reject(error) : resolve()));
  async function open({ nativeHome = home, sqliteEnv, sqliteConfig } = {}) {
    const identity = { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 };
    const job = await prepareWindowsJob({ identity, journal }); jobs.push(job);
    if (sqliteConfig) {
      fs.mkdirSync(nativeHome, { recursive: true });
      fs.writeFileSync(path.join(nativeHome, 'config.toml'), TOML.stringify({ sqlite_home: sqliteConfig }));
    }
    const spec = codexSpawnSpec({ runtime, home: nativeHome, cwd, env: sqliteEnv ? { ...env, CODEX_SQLITE_HOME: sqliteEnv } : env,
      connection: 'api', model: 'inventory-fixture', route: { baseUrl: router.url } });
    spec.permissions = { approvalPolicy: 'never', sandbox: 'read-only' };
    const session = new CodexSession({ gen: sessions.length + 1,
      settings: { cwd, model: 'inventory-fixture', connection: 'api', permissionMode: 'default' }, opts: {},
      spec, spawn: job.spawn, history: new ClaudeHistory(path.join(root, 'mirror')), log: line => logs.push(line),
      onSessionId() {}, onResult() {}, onEvent() {} });
    sessions.push(session); session.start(); await (session.ready = session.open());
    return { session, job };
  }
  async function stop({ session, job }) {
    await session.shutdown(); const proof = await job.stop();
    assert.equal(proof.stopped, true); assert.equal(proof.activeProcesses, 0);
  }
  async function replyAndArchive(active) {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void active.job.stop(); reject(new Error('Native inventory fixture timed out')); }, 30000);
      active.session.onResult = value => { clearTimeout(timer); resolve(value); };
      assert.equal(active.session.sendUserMessage('Inventory fixture: reply with the provided text', []), true);
    });
    assert.equal(result.subtype, 'success', JSON.stringify(result));
    await active.session.client.request('thread/archive', { threadId: active.session.sessionId });
    await stop(active);
  }
  try {
    await listen(server);
    const portProbe = http.createServer(); await listen(portProbe); const port = portProbe.address().port; await close(portProbe);
    const file = path.join(root, 'router.json');
    writeConfig(file, normalizeConfig({ port, providers: [{ id: 'fixture', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'inventory-fixture', upstream: 'fixture-native-inventory' }],
      keys: [{ id: 'local', key: 'fixture-not-a-key' }] }] }));
    router = startApiRouter({ configPath: file, timeoutMs: 5000 }); await router.ready;
    const fresh = await open(); await stop(fresh);
    assert.equal(requests.length, 0);
    assert.ok(!readCodexNativeHistories([home]).some(row => row.nativeId === fresh.session.sessionId),
      'Opening a thread alone does not establish persisted history ownership');

    const active = await open();
    await replyAndArchive(active);
    assert.equal(requests.length, 1);
    assert.deepEqual(readCodexNativeHistories([home]), [{ engine: 'codex', nativeId: active.session.sessionId }]);
    assert.ok(fs.readdirSync(path.join(home, 'archived_sessions')).some(name => name.includes(active.session.sessionId)));

    // These roots are all inside the temporary fixture. A relative environment
    // override resolves against the native cwd; a config value overrides it.
    const environmentHome = path.join(root, 'environment-home'), environmentDir = path.join(cwd, 'environment-state');
    const environment = await open({ nativeHome: environmentHome, sqliteEnv: 'environment-state' });
    await replyAndArchive(environment);
    assert.equal(fs.existsSync(path.join(environmentHome, 'state_5.sqlite')), false);
    assert.equal(fs.existsSync(path.join(environmentDir, 'state_5.sqlite')), true);
    const databaseIds = dir => readCodexNativeHistories([{ home: path.join(root, 'absent-log-home'), sqliteHomes: [dir] }])
      .map(row => row.nativeId).sort();
    assert.deepEqual(databaseIds(environmentDir), [environment.session.sessionId]);
    assert.deepEqual(readCodexNativeHistories([{ home: environmentHome, sqliteHomes: [environmentDir] }]),
      [{ engine: 'codex', nativeId: environment.session.sessionId }]);

    const configuredHome = path.join(root, 'configured-home'), configuredDir = path.join(root, 'configured-state');
    const configured = await open({ nativeHome: configuredHome, sqliteEnv: 'environment-state', sqliteConfig: configuredDir });
    await replyAndArchive(configured);
    assert.equal(fs.existsSync(path.join(configuredHome, 'state_5.sqlite')), false);
    assert.deepEqual(databaseIds(configuredDir), [configured.session.sessionId]);
    assert.deepEqual(databaseIds(environmentDir), [environment.session.sessionId]);
    assert.deepEqual(readCodexNativeHistories([{ home: configuredHome, sqliteHomes: [environmentDir] }])
      .map(row => row.nativeId).sort(), [configured.session.sessionId, environment.session.sessionId].sort());
    assert.equal(requests.length, 3);
    console.log(JSON.stringify({ version, freshThreadOnlyModelRequests: 0, loopbackReplies: requests.length,
      archivedNativeIdVerified: true, relativeEnvironmentRedirectVerified: true, configOverridesEnvironmentVerified: true,
      redirectedDatabasesVerified: 2, stoppedJobs: jobs.length, realModelCalls: 0 }));
  } finally {
    for (const session of sessions) await session.shutdown();
    for (const job of jobs) await job.stop();
    await router?.stop(); server.closeAllConnections(); if (server.listening) await close(server);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('discussion-codex-source-smoke-')); removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
