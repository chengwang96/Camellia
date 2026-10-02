'use strict';

// Explicit, isolated native handshake probe. No prompt is sent and the only
// configured model endpoint is a loopback server that rejects every request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { AcpSession } = require('../src/engines/acp-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { antigravitySpawnSpec, subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { locatePythonRuntime } = require('../src/main/python-runtime');
const { locateAntigravityCli } = require('../src/main/antigravity-cli-runtime');
const { parseModels, groupModels, runCli } = require('../src/engines/antigravity/subscription');
const { prepareWindowsJob } = require('../src/engines/discussions/windows-job');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { readAntigravityNativeInventory } = require('../src/engines/discussions/antigravity-history-inventory');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  assert.equal(process.platform, 'win32', 'This containment probe requires Windows');
  const runtimeDir = path.resolve(__dirname, '../runtimes/antigravity');
  const sdk = locatePythonRuntime(runtimeDir), cli = locateAntigravityCli(runtimeDir);
  assert.ok(sdk && cli, 'The pinned SDK and CLI must already be installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-antigravity-prepare-smoke-'));
  const profile = path.join(root, 'profile'), cwd = path.join(root, 'work'), home = path.join(root, 'adapter');
  const cliDataDir = path.join(profile, '.gemini/antigravity-cli');
  fs.mkdirSync(cwd); fs.mkdirSync(cliDataDir, { recursive: true });
  fs.writeFileSync(path.join(cliDataDir, 'settings.json'), JSON.stringify({ modelProvider: 'gemini', enableTelemetry: false }));
  const env = isolatedEnvironment(profile, process.execPath);
  if (env.SystemRoot === env.SYSTEMROOT) delete env.SYSTEMROOT;
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  const journal = new WindowsJobJournal({ dir: path.join(root, 'jobs') }), jobs = [], sessions = [], logs = [];
  let modelRequests = 0, selected, baseUrl;
  const server = http.createServer((req, res) => { modelRequests++; req.resume(); res.writeHead(500); res.end('No inference is allowed in this probe'); });
  const inventory = () => readAntigravityNativeInventory({ homes: [{ home, cliDataDir }], cliDataDirs: [], sdkSaveDirs: [] });
  async function open(connection, sessionId) {
    const job = await prepareWindowsJob({ identity: { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 }, journal }); jobs.push(job);
    const spec = connection === 'api' ? antigravitySpawnSpec({ runtime: sdk, home, env, route: { baseUrl } })
      : subscriptionSpawnSpec({ runtime: cli, home, env, model: selected.id, effort: selected.defaultReasoningEffort || '' });
    if (connection === 'subscription') Object.assign(spec.env, { GEMINI_API_KEY: 'fixture-not-a-key', GOOGLE_GEMINI_BASE_URL: baseUrl });
    const session = new AcpSession({ gen: sessions.length + 1, name: 'Antigravity prepare fixture', opts: { sessionId },
      exe: connection === 'api' ? sdk.file : process.execPath, spec, spawn: job.spawn,
      settings: { cwd, model: connection === 'api' ? 'prepare-fixture' : selected.id, permissionMode: 'plan' },
      history: new ClaudeHistory(path.join(root, 'mirror')), log: line => logs.push(line), onEvent() {}, onSessionId() {}, onResult() {} });
    sessions.push(session); session.start(); await (session.ready = session.open()); return { job, session };
  }
  async function stop({ session, job }) {
    await session.shutdown(); const proof = await job.stop(); assert.equal(proof.stopped, true); assert.equal(proof.activeProcesses, 0);
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`;
    const cliEnv = { ...env, GEMINI_API_KEY: 'fixture-not-a-key', GOOGLE_GEMINI_BASE_URL: baseUrl };
    selected = groupModels(parseModels(await runCli(cli.file, ['models'], { env: cliEnv, cwd })))[0]; assert.ok(selected);
    for (const connection of ['api', 'subscription']) {
      const first = await open(connection), sessionId = first.session.sessionId;
      const nativeId = await first.session.prepareNativeStorage();
      assert.equal(await first.session.prepareNativeStorage(), nativeId, 'Preparing twice must retain one native identity');
      const bridge = inventory().bridges.find(row => row.nativeId === sessionId);
      assert.equal(bridge.conversationId, nativeId, logs.join('\n'));
      assert.equal(bridge.databaseVerified, true);
      assert.ok(inventory().histories.some(row => row.connection === connection && row.storageDir === bridge.storageDir && row.conversationId === nativeId));
      assert.equal(modelRequests, 0);
      await assert.rejects(first.session.request('session/set_mode', { sessionId, modeId: 'default' }), /fixed/);
      await assert.rejects(first.session.request('session/new', { cwd }), /fixed/);
      await stop(first);
      const resumed = await open(connection, sessionId);
      assert.equal(await resumed.session.prepareNativeStorage(), nativeId, 'Native identity must survive restart without any input');
      const restored = inventory().bridges.find(row => row.nativeId === sessionId);
      assert.equal(restored.conversationId, nativeId); assert.equal(restored.databaseVerified, true);
      await stop(resumed);
    }
    assert.equal(modelRequests, 0); assert.equal(inventory().histories.length, 2);
    for (const connection of ['api', 'subscription']) {
      const active = await open(connection);
      const preparing = active.session.prepareNativeStorage().then(() => true, () => false);
      await stop(active); await preparing;
      assert.equal(active.session.dead, true); assert.equal(modelRequests, 0);
    }
    console.log(JSON.stringify({ sdkVersion: sdk.version, cliVersion: cli.version, sdkIdentityBeforeInput: true,
      cliIdentityBeforeInput: true, resumedWithoutInput: 2, persistedHistoriesBeforeInput: 2, closedDuringPreparation: 2,
      modelRequests, stoppedJobs: jobs.length, realModelCalls: 0 }));
  } finally {
    for (const session of sessions) await session.shutdown();
    for (const job of jobs) await job.stop();
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('discussion-antigravity-prepare-smoke-')); removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
