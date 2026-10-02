'use strict';

// Explicit native probe. Both transports use isolated profiles and loopback
// model fixtures; no subscription account or real discussion is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { AcpSession } = require('../src/engines/acp-session');
const { antigravitySpawnSpec, subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { locatePythonRuntime } = require('../src/main/python-runtime');
const { locateAntigravityCli } = require('../src/main/antigravity-cli-runtime');
const { parseModels, groupModels, runCli } = require('../src/engines/antigravity/subscription');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { prepareWindowsJob } = require('../src/engines/discussions/windows-job');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { readAntigravityNativeInventory } = require('../src/engines/discussions/antigravity-history-inventory');
const { projectAntigravityStorage } = require('../src/engines/discussions/native-storage');
const { NativeSessionOwnership } = require('../src/engines/discussions/native-ownership');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  assert.equal(process.platform, 'win32', 'This containment probe requires Windows');
  const runtimeDir = path.resolve(__dirname, '../runtimes/antigravity');
  const sdk = locatePythonRuntime(runtimeDir), cli = locateAntigravityCli(runtimeDir);
  assert.ok(sdk && cli, 'The pinned SDK and CLI must already be installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-antigravity-source-smoke-'));
  const profile = path.join(root, 'profile'), home = path.join(root, 'adapter'), cwd = path.join(root, 'work');
  const env = isolatedEnvironment(profile, process.execPath);
  if (env.SystemRoot === env.SYSTEMROOT) delete env.SYSTEMROOT;
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  fs.mkdirSync(cwd); fs.mkdirSync(path.join(profile, '.gemini/antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(profile, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ modelProvider: 'gemini', enableTelemetry: false }));
  const journal = new WindowsJobJournal({ dir: path.join(root, 'windows-jobs') });
  const jobs = [], sessions = [], logs = [], sdkRequests = [], cliRequests = [];
  let router, selected;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (body.messages) {
        sdkRequests.push(body);
        assert.equal(body.model, 'inventory-fixture');
        res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'SDK inventory fixture reply' } }] }));
        res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
        res.end(frame('[DONE]'));
      } else {
        cliRequests.push(body);
        res.end('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'CLI inventory fixture reply' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 } }) + '\n\n');
      }
    } catch (error) { logs.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  const listen = value => new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  const close = value => new Promise((resolve, reject) => value.close(error => error ? reject(error) : resolve()));
  async function open(connection, opts = {}) {
    const job = await prepareWindowsJob({ identity: { runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 1 }, journal }); jobs.push(job);
    const spec = connection === 'api' ? antigravitySpawnSpec({ runtime: sdk, home, env, route: { baseUrl: router.url } })
      : subscriptionSpawnSpec({ runtime: cli, home, env, model: selected.id, effort: selected.defaultReasoningEffort || '' });
    if (connection === 'subscription') Object.assign(spec.env, {
      GEMINI_API_KEY: 'fixture-not-a-key', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}` });
    const session = new AcpSession({ gen: sessions.length + 1, name: 'Antigravity inventory fixture', opts,
      exe: connection === 'api' ? sdk.file : process.execPath, spec, spawn: job.spawn,
      settings: { cwd, model: connection === 'api' ? 'inventory-fixture' : selected.id, permissionMode: 'plan' },
      history: new ClaudeHistory(path.join(root, 'mirror')), log: line => logs.push(line), onEvent() {}, onSessionId() {}, onResult() {} });
    sessions.push(session); session.start(); await (session.ready = session.open());
    await session.prepareNativeStorage();
    return { session, job };
  }
  async function turn(active, prompt) {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void active.job.stop().catch(() => {}); reject(new Error('Native inventory fixture timed out')); }, 40000);
      active.session.onResult = value => { clearTimeout(timer); resolve(value); };
      assert.equal(active.session.sendUserMessage(prompt), true);
    });
    assert.equal(result.subtype, 'success', JSON.stringify(result) + '\n' + logs.join('\n'));
  }
  async function stop(active) {
    await active.session.shutdown(); const proof = await active.job.stop();
    assert.equal(proof.stopped, true); assert.equal(proof.activeProcesses, 0);
  }
  const sdkMetadata = id => JSON.parse(fs.readFileSync(path.join(home, 'sessions', id, 'session.json'), 'utf8'));
  const cliMetadata = id => JSON.parse(fs.readFileSync(path.join(home, 'cli-sessions', id + '.json'), 'utf8'));
  try {
    await listen(server);
    const portProbe = http.createServer(); await listen(portProbe); const port = portProbe.address().port; await close(portProbe);
    const file = path.join(root, 'routes.json');
    writeConfig(file, normalizeConfig({ port, providers: [{ id: 'fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      models: [{ id: 'inventory-fixture', upstream: 'inventory-fixture' }], keys: [{ id: 'local', key: 'fixture-not-a-key' }] }] }));
    router = startApiRouter({ configPath: file }); await router.ready;
    const fixtureEnv = { ...env, GEMINI_API_KEY: 'fixture-not-a-key', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}` };
    selected = groupModels(parseModels(await runCli(cli.file, ['models'], { env: fixtureEnv, cwd })))[0]; assert.ok(selected);

    const original = await open('api'); await turn(original, 'INVENTORY original SDK'); await stop(original);
    const originalId = original.session.sessionId, originalNative = sdkMetadata(originalId).conversationId;
    const fork = await open('api', { sessionId: originalId, fork: true });
    assert.equal(sdkMetadata(fork.session.sessionId).conversationId, originalNative, 'SDK copies the native ID into a separate save directory');
    await turn(fork, 'INVENTORY fork only'); await stop(fork);
    assert.ok(JSON.stringify(sdkRequests.at(-1).messages).includes('INVENTORY original SDK'));
    const resumed = await open('api', { sessionId: originalId }); await turn(resumed, 'INVENTORY resumed original'); await stop(resumed);
    assert.ok(!JSON.stringify(sdkRequests.at(-1).messages).includes('INVENTORY fork only'));
    assert.equal(sdkMetadata(fork.session.sessionId).conversationId, originalNative);

    const first = await open('subscription');
    assert.match(cliMetadata(first.session.sessionId).conversationId, /^[0-9a-f-]{36}$/, 'Native preparation completes before the first input');
    await turn(first, 'INVENTORY original CLI'); await stop(first);
    const saved = cliMetadata(first.session.sessionId), alias = 'agy-' + randomUUID();
    fs.writeFileSync(path.join(home, 'cli-sessions', alias + '.json'), JSON.stringify({ ...saved, id: alias }));
    const second = await open('subscription', { sessionId: alias }); await turn(second, 'INVENTORY alias CLI'); await stop(second);
    assert.equal(cliMetadata(alias).conversationId, saved.conversationId);
    assert.ok(JSON.stringify(cliRequests.at(-1).contents).includes('INVENTORY original CLI'), 'Different CLI bridge IDs can address the same native history');
    if (process.argv.includes('--inspect-layout')) {
      for (const dir of [home, profile]) for (const name of fs.readdirSync(dir, { recursive: true })) {
        const file = path.join(dir, name), info = fs.lstatSync(file);
        if (info.isFile() && /(?:conversation_summaries|[0-9a-f-]{32,36})\.db$/.test(name)) {
          const { DatabaseSync } = require('node:sqlite');
          const database = new DatabaseSync(file, { readOnly: true });
          try { console.log(JSON.stringify({ file: path.relative(root, file), identities: database.prepare(name.endsWith('conversation_summaries.db')
            ? 'SELECT conversation_id, parent_conversation_id, winning_conversation_id, app_data_dir FROM conversation_summaries'
            : 'SELECT trajectory_id, cascade_id FROM trajectory_meta').all() })); }
          finally { database.close(); }
        }
      }
    }
    const inventory = readAntigravityNativeInventory({ homes: [{ home, cliDataDir: path.join(profile, '.gemini/antigravity-cli') }], cliDataDirs: [], sdkSaveDirs: [] });
    assert.equal(inventory.bridges.length, 4);
    const sdkBridges = inventory.bridges.filter(row => row.connection === 'api');
    assert.equal(sdkBridges.length, 2); assert.equal(sdkBridges[0].conversationId, sdkBridges[1].conversationId);
    assert.notEqual(sdkBridges[0].storageDir, sdkBridges[1].storageDir);
    const cliBridges = inventory.bridges.filter(row => row.connection === 'subscription');
    assert.equal(cliBridges.length, 2); assert.equal(cliBridges[0].conversationId, cliBridges[1].conversationId);
    assert.equal(cliBridges[0].storageDir, cliBridges[1].storageDir);
    assert.equal(inventory.histories.length, 3);
    const members = inventory.bridges.map(row => ({ engine: 'antigravity', discussionId: randomUUID(), participantId: randomUUID(),
      runtimeId: randomUUID(), generation: 1, nativeId: row.nativeId }));
    const owners = members.map(member => ({ engine: member.engine, runtimeId: member.runtimeId, nativeId: member.nativeId,
      ownerId: `discussion/${member.discussionId}/${member.participantId}/1` }));
    const ownership = new NativeSessionOwnership({ readOwners: () => projectAntigravityStorage(owners, inventory) });
    for (const member of members) {
      if (member.nativeId.startsWith('agy-')) assert.throws(() => ownership.reserve(member), /storage belongs to another/);
      else { const lease = ownership.reserve(member); ownership.claimNative(lease, member.nativeId); ownership.release(lease); }
    }
    console.log(JSON.stringify({ sdkVersion: sdk.version, cliVersion: cli.version, sdkForkUsesIndependentStorage: true,
      cliAliasResumesSameHistory: true, mappedBridges: inventory.bridges.length, storageHistories: inventory.histories.length,
      cliAliasAdmissionBlocked: true, sdkIndependentClaims: 2,
      loopbackReplies: sdkRequests.length + cliRequests.length, stoppedJobs: jobs.length, realModelCalls: 0 }));
  } finally {
    for (const session of sessions) await session.shutdown();
    for (const job of jobs) await job.stop();
    await router?.stop(); server.closeAllConnections(); if (server.listening) await close(server);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('discussion-antigravity-source-smoke-')); removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
