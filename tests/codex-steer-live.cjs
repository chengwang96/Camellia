'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CodexSession } = require('../src/engines/codex-session');
const { codexSpawnSpec } = require('../src/engines/codex-client');
const { SharedConversations } = require('../src/engines/shared-conversations');
const routerConfig = require('../src/api/api-router-config');

async function main() {
  if (process.env.CAMELLIA_LIVE_STEER !== '1') throw new Error('Set CAMELLIA_LIVE_STEER=1 to authorize one real paid API turn.');
  const dataDir = process.env.CAMELLIA_DATA_DIR || path.join(process.env.APPDATA, 'dsh-desktop');
  const desktop = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-config.json'), 'utf8'));
  const route = routerConfig.loadConfig(path.join(desktop.dshHome || path.join(os.homedir(), '.dsh'), 'ollama-proxy.json'));
  assert.equal(desktop.codex.connection, 'api');
  assert.ok(routerConfig.hasRoutes(route));
  const model = routerConfig.modelId(desktop.codex.apiModel);
  assert.ok(routerConfig.publicState(route).models.includes(model));
  const runtimeRoot = path.join(dataDir, 'runtimes', 'codex');
  const runtimeFile = fs.readdirSync(runtimeRoot, { recursive: true }).find(file => path.basename(file) === 'codex.exe');
  assert.ok(runtimeFile, 'Installed Windows Codex runtime is required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-live-steer-'));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  const marker = 'STEER_OK_' + randomUUID().replaceAll('-', '');
  const settings = { connection: 'api', model, cwd, permissionMode: 'bypassPermissions', thinkingBudget: 'low' };
  const spec = codexSpawnSpec({ runtime: { file: path.join(runtimeRoot, runtimeFile) }, home: path.join(root, 'codex'),
    cwd, connection: 'api', model, route: { baseUrl: `http://127.0.0.1:${route.port}`, authToken: 'proxy-managed' } });
  const events = [], requests = [], nativeTurns = [], agentMessages = [];
  let session, run, steering, timer, config = {};
  const report = { model, root, startedAt: new Date().toISOString() };
  const args = { dir: path.join(root, 'conversations'), loadConfig: () => config,
    saveConfig: patch => { config = { ...config, ...patch }; },
    drivers: { codex: { settings: () => settings, ensure(opts) {
      session = new CodexSession({ gen: 1, settings, opts, spec, history: { root: path.join(root, 'history') },
        log() {}, onSessionId() {}, onResult() {},
        onEvent: event => manager.capture('codex', { ...event, conversationId: opts.conversationId }) });
      session.start();
      const starting = session.starting;
      session.starting = starting.then(() => {
        const request = session.client.request.bind(session.client);
        session.client.request = (method, params, ...rest) => {
          requests.push({ method, expectedTurnId: params?.expectedTurnId });
          return request(method, params, ...rest);
        };
        const notify = session.client.onNotification;
        session.client.onNotification = (method, params) => {
          if (method === 'turn/started') nativeTurns.push(params.turn.id);
          if (method === 'item/completed' && params.item?.type === 'agentMessage') agentMessages.push(params.item.text);
          if (method === 'thread/tokenUsage/updated') report.nativeTokenUsage = params.tokenUsage;
          notify(method, params);
        };
      });
      return session;
    } } },
    onEvent(event) {
      events.push(event);
      if (!steering && event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
        steering = new Promise(resolve => setImmediate(resolve)).then(async () => {
          report.originalOutputObserved = true;
          report.nativeTurnId = session.turnId;
          await assert.rejects(session.client.request('turn/steer', { threadId: session.sessionId,
            expectedTurnId: 'deliberately-wrong-turn', input: [{ type: 'text', text: 'This must be rejected.' }] }));
          report.wrongNativeTurnRejected = true;
          const payload = { sessionId: run.sessionId, runId: run.runId,
            prompt: `Immediate correction: stop listing numbers now. Do not use tools. End your response with exactly this unique token on its own line: ${marker}` };
          await assert.rejects(manager.steer('codex', { ...payload, runId: run.runId + 1 }));
          report.wrongLogicalRunRejected = true;
          report.accepted = await manager.steer('codex', payload);
        });
        steering.catch(() => {});
      }
    } };
  const manager = new SharedConversations(args);
  try {
    const conversation = manager.create('codex', null, 'Isolated paid steering test', cwd);
    console.log(JSON.stringify({ model, root, phase: 'starting one paid turn' }));
    run = await manager.send('codex', { sessionId: conversation.id,
      prompt: 'This is a harmless streaming integration test. Do not use tools, read files, write files, or access the network. Print the integers 1 through 300, one integer per line, without skipping any. No introduction or explanation.' }, { goalToolsDisabled: true });
    await Promise.race([run.done, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Live steering test exceeded 120 seconds')), 120000);
    })]);
    assert.ok(steering, 'Expected real text output before sending the correction');
    await steering;
    const result = events.findLast(event => event.type === 'result');
    assert.equal(result.is_error, false);
    report.output = result.result;
    report.lastCallUsage = result.usage;
    report.agentMessages = agentMessages;
    report.originalSequenceCompleted = /(?:^|\n)300/.test(result.result);
    assert.ok(result.result.trim().endsWith(marker), 'Model must actually follow the unique correction');
    assert.equal(nativeTurns.length, 1, 'Steering must not start another native turn');
    assert.equal(nativeTurns[0], report.nativeTurnId);
    assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
    assert.equal(requests.filter(request => request.method === 'turn/interrupt').length, 0);
    assert.equal(events.filter(event => event.type === 'conversation:steered').length, 1);
    await assert.rejects(manager.steer('codex', { sessionId: run.sessionId, runId: run.runId, prompt: 'Too late' }));
    await assert.rejects(session.steerUserMessage('Too late'));
    report.finishedTurnRejected = true;
    const restored = new SharedConversations(args);
    const messages = restored.messages(restored.get(run.sessionId));
    assert.deepEqual(messages.map(message => message.role), ['user', 'user', 'assistant']);
    assert.ok(messages[1].text.includes(marker));
    report.persistedRoles = messages.map(message => message.role);
    report.nativeTurns = nativeTurns;
    report.requests = requests;
    report.scope = 'Shared conversation manager and native Codex through configured paid API router; no Electron UI automation.';
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.error = error.message;
    throw error;
  } finally {
    clearTimeout(timer);
    await session?.shutdown();
    manager.pauseGoals();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
