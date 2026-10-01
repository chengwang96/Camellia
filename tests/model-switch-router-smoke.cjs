'use strict';

// Opt-in end-to-end check of the model-switch path against a real
// OpenAI-compatible route: it drives the real API router from the local router
// configuration and sends each turn through it, so it spends real provider
// quota. Not part of `npm test` or CI.
//
//   node tests/model-switch-router-smoke.cjs <model-a> <model-b> [router-config.json]
//
// It verifies that switching the selected model retires the recorded native
// session, replays the logical history to the new model, and can switch back —
// the behavior the unit tests cover with a fake engine, exercised here with
// real provider responses.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const routerConfig = require('../src/api/api-router-config.js');
const { startApiRouter } = require('../src/api/api-router.js');
const { createCompactionSummarizer } = require('../src/api/compaction-summarizer.js');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');

const modelA = String(process.argv[2] || '').trim();
const modelB = String(process.argv[3] || '').trim();
const configPath = process.argv[4] || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'ollama-proxy.json');
if (!modelA || !modelB) {
  console.error('Usage: node tests/model-switch-router-smoke.cjs <model-a> <model-b> [router-config.json]');
  console.error('This sends real provider requests through the configured router key.');
  process.exit(2);
}

const MARKER = 'MODEL_SWITCH_MARKER';
const BRIDGE = process.env.MODEL_SWITCH_SMOKE_BRIDGE === '1';
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-switch-'));
  const config = routerConfig.loadConfig(configPath);
  const available = routerConfig.publicState(config).models;
  for (const model of [modelA, modelB]) if (!available.includes(model)) throw new Error('The router configuration has no route for ' + model);
  const port = await freePort();
  const tempConfig = path.join(dir, 'router.json');
  routerConfig.writeConfig(tempConfig, { ...config, port });
  const router = startApiRouter({ configPath: tempConfig, log: message => console.log('[router] ' + message) });
  let manager;
  const spend = [];
  try {
    await router.ready;
    console.log('router listening on ' + router.url + ', models ' + modelA + ' → ' + modelB);
    const summarizer = createCompactionSummarizer({ getConfig: () => routerConfig.loadConfig(tempConfig),
      getRoute: () => ({ baseUrl: router.url, authToken: 'proxy-managed' }), isRunning: () => true,
      log: message => console.log('[engine] ' + message) });

    // The fake engine plays the role of a native CLI: it receives the replayed
    // logical history as its prompt and answers through the real router.
    let model = modelA, gen = 0;
    const sessions = [], replays = [];
    const engine = 'codex';
    const drivers = Object.fromEntries(ENGINES.map(name => [name, { settings: () => ({ model, connection: 'api' }),
      saveSettings: patch => { if (patch.model) model = patch.model; return { model, connection: 'api' }; },
      ensure(opts) {
        const session = { gen: ++gen, sessionId: opts.sessionId || engine + '-native-' + gen, settings: opts.settings,
          resume: Boolean(opts.sessionId),
          sendUserMessage(prompt) {
            replays.push({ model: opts.settings.model, resume: Boolean(opts.sessionId), prompt });
            manager.capture(engine, { type: 'system', subtype: 'init', session_id: session.sessionId, runId: session.gen });
            void (async () => {
              try {
                const { text, usage } = await summarizer.run({ model: opts.settings.model, system: 'You are a coding agent. Answer in one short sentence.',
                  user: prompt, maxTokens: 128 });
                if (usage) spend.push(usage);
                manager.capture(engine, { type: 'result', subtype: 'success', is_error: false, result: text || '(empty)', session_id: session.sessionId, runId: session.gen, usage });
              } catch (error) {
                manager.capture(engine, { type: 'result', subtype: 'error', is_error: true, result: error.message, session_id: session.sessionId, runId: session.gen });
              }
            })();
            return true;
          },
          interrupt() {}, kill() {} };
        sessions.push(session); return session;
      } }]));
    manager = new SharedConversations({ dir: path.join(dir, 'conversations'), loadConfig: () => ({}), saveConfig: () => {},
      drivers, onEvent: () => {}, log: () => {}, modelContextWindow: () => 200000, summarize: summarizer });

    let run = await manager.send(engine, { prompt: MARKER + ': the original task' });
    const answerA = await run.done;
    if (answerA.is_error) throw new Error('first turn failed: ' + answerA.result);
    const conversation = manager.get(run.sessionId);
    const nativeA = conversation.segments[engine].nativeId;
    console.log('turn 1 (' + modelA + '): ' + String(answerA.result).slice(0, 160));

    manager.saveSettings(engine, { sessionId: conversation.id, model: modelB });
    if (BRIDGE) manager.append(conversation, { role: 'user', text: 'ABSENT_DETAIL ' + 'Bridge note about the parser table and the router catalog. '.repeat(140) });
    run = await manager.send(engine, { sessionId: conversation.id, prompt: 'Continue on the second model' });
    const answerB = await run.done;
    if (answerB.is_error) throw new Error('second turn failed: ' + answerB.result);
    const switched = conversation.segments[engine];
    const parkedAfterSwitch = Object.values(conversation.modelSessions || {}).map(segment => segment.nativeId);
    console.log('turn 2 (' + modelB + '): ' + String(answerB.result).slice(0, 160));

    manager.saveSettings(engine, { sessionId: conversation.id, model: modelA });
    const runBack = await manager.send(engine, { sessionId: conversation.id, prompt: 'Back on the first model' });
    const answerBack = await runBack.done;
    if (answerBack.is_error) throw new Error('switch-back turn failed: ' + answerBack.result);
    console.log('turn 3 (' + modelA + '): ' + String(answerBack.result).slice(0, 160));

    const failures = [];
    if (replays[0].model !== modelA || replays[0].resume) failures.push('the first turn did not start a fresh native session on model A');
    if (replays[1].model !== modelB || replays[1].resume) failures.push('the model switch did not start a fresh native session on model B');
    if (replays[2].model !== modelA || !replays[2].resume) failures.push('the switch back did not resume the native session recorded on model A');
    if (!replays[1].prompt.includes(MARKER)) failures.push('the second model did not receive the replayed logical history');
    if (!replays[2].prompt.includes('Continue on the second model')) failures.push('the resumed model did not receive the turns it missed');
    if (BRIDGE) {
      if (!/while this model was not selected/.test(replays[2].prompt)) failures.push('the resumed model did not receive a summary bridge for the absence');
      if (/"cwd"\s*:/.test(replays[2].prompt) || replays[2].prompt.length > 4000)
        failures.push('the long absence was replayed verbatim instead of summarized');
    }
    if (!parkedAfterSwitch.includes(nativeA)) failures.push('the model-A session was not parked for its return');
    if (switched.nativeId === nativeA) failures.push('the second model resumed the model-A native session');
    if (conversation.segments[engine].nativeId !== nativeA) failures.push('the switch back did not restore the model-A session');

    const tokens = spend.reduce((total, usage) => total + (usage.total_tokens || 0), 0);
    console.log('\nreal requests: ' + replays.length + ', reported tokens: ' + tokens);
    if (failures.length) throw new Error('model-switch smoke failed:\n- ' + failures.join('\n- '));
    console.log('OK: each model parked its own native session and switch-back resumed it');
  } finally {
    if (manager) manager.pauseGoals();
    await router.stop();
    removeTree(dir);
  }
}

main().catch(error => { console.error('\nFAILED: ' + error.message); process.exitCode = 1; });
