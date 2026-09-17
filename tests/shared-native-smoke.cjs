'use strict';
// Real native transports; only the model is a local fixture. No paid APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { isolatedEnvironment, claudeSpec } = require('../src/benchmark/engines');
const { SessionPool } = require('../src/engines/session-pool');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');
const { ClaudeSession } = require('../src/engines/claude-session');
const { KimiSession, kimiSpawnSpec } = require('../src/engines/kimi-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { createCodex } = require('../src/engines/codex');
const { createAntigravity } = require('../src/engines/antigravity');
const { createDshChat } = require('../src/engines/dsh-session');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-shared-native-'));
  const appRoot = path.resolve(__dirname, '..');
  const runtimes = createRuntimeManager({ root: appRoot, installRoot: appRoot, node: () => process.execPath });
  let config = { codex: { connection: 'api', apiModel: 'fixture-model', permissionMode: 'default' }, antigravity: { model: 'fixture-model' }, dshChat: { model: 'fixture-model' } }, router, manager;
  const requests = [], logs = [], instances = [], route = {}, held = new Map();
  let holdConcurrent = true;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); requests.push(body);
      const marker = JSON.stringify(body.messages || []).match(/CONCURRENT_(?:A|B)_(?:claude|codex|dsh|kimi|antigravity)/)?.[0];
      if (marker && holdConcurrent) await new Promise(resolve => held.set(marker, { resolve, body }));
      const asksQuestion = JSON.stringify(body.messages || []).includes('ASK_QUESTION_FIXTURE') && body.tools?.some(tool => tool.function?.name === 'AskUserQuestion');
      const hasAnswer = body.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'question-fixture');
      const askInput = { questions: [{ question: 'Which outputs?', header: 'Outputs', options: [{ label: 'CSV', description: 'Tables' }, { label: 'JSON', description: 'Structured data' }], multiSelect: true }] };
      const message = asksQuestion && !hasAnswer ? { role: 'assistant', content: 'Please choose the outputs.', tool_calls: [{ index: 0, id: 'question-fixture', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify(askInput) } }] }
        : { role: 'assistant', content: asksQuestion ? 'QUESTION_ANSWER_RECEIVED' : marker ? 'Reply for ' + marker : '## Handoff\nRemember SHARED_SECRET_4821. Next step: verify the experiment.' };
      const finishReason = message.tool_calls ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 30, completion_tokens: 16, total_tokens: 46 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(frame({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: message }] }));
        res.write(frame({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })); res.end(frame('[DONE]'));
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, message, finish_reason: finishReason }], usage })); }
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const file = path.join(root, 'router.json');
  writeConfig(file, normalizeConfig({ port, providers: [{ id: 'fixture', name: 'Local fixture', type: 'custom',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai', models: [{ id: 'fixture-model', upstream: 'fixture-upstream' }, { id: 'fixture-picked', upstream: 'fixture-picked-upstream' }], keys: [{ id: 'fixture-key', key: 'loopback-only' }] }] }));
  try {
    router = startApiRouter({ configPath: file, timeoutMs: 30000 }); await router.ready;
    route.baseUrl = `http://127.0.0.1:${port}`;
    route.authToken = 'proxy-managed';
    const loadConfig = () => config, saveConfig = patch => { config = { ...config, ...patch }; }, log = message => logs.push(message);
    const common = { dataDir: root, loadConfig, saveConfig, getRoute: () => route, getModels: () => ['fixture-model', 'fixture-picked'], runtimes: () => runtimes,
      environment: () => isolatedEnvironment(root, process.execPath), log, onGoal: () => {}, onAccount: () => {} };
    const drivers = {};
    for (const engine of ['codex', 'antigravity', 'dsh']) {
      const options = { ...common, onEvent: event => manager.capture(engine, event), node: () => process.execPath, runtime: () => runtimes.locate('dsh') };
      const instance = engine === 'codex' ? createCodex(options) : engine === 'antigravity' ? createAntigravity(options) : createDshChat(options);
      drivers[engine] = { settings: instance.settings, saveSettings: instance.saveSettings, ensure: instance.ensure || instance.ensureSession };
      instances.push(instance);
    }
    for (const engine of ['claude', 'kimi']) {
      const sessions = new SessionPool(); let gen = 0;
      const home = path.join(root, engine), history = new ClaudeHistory(path.join(home, 'history'));
      drivers[engine] = { settings: () => ({ model: 'fixture-model' }), saveSettings: v => v,
        ensure(opts) {
          const current = sessions.get(opts);
          const profileHome = path.join(home, opts.conversationId);
          const runtime = runtimes.locate(engine), env = isolatedEnvironment(profileHome, process.execPath);
          const spec = engine === 'claude' ? claudeSpec({ home: profileHome, cwd: opts.cwd, model: opts.settings.model, route, env })
            : kimiSpawnSpec({ home: profileHome, runtime: runtime.file, model: opts.settings.model, route, env });
          if (engine === 'claude') {
            if (opts.sessionId) spec.args.push('--resume', opts.sessionId);
            current?.kill();
          }
          const closed = engine === 'kimi' ? current?.shutdown() : null;
          const Class = engine === 'claude' ? ClaudeSession : KimiSession;
          const session = new Class({ gen: ++gen, opts, settings: { ...opts.settings, cwd: opts.cwd, permissionMode: opts.settings.permissionMode || (engine === 'kimi' ? 'default' : 'acceptEdits') },
            exe: engine === 'claude' ? runtime.file : process.execPath, spec, spawn, log, history,
            onEvent: event => manager.capture(engine, event), onSessionId: () => {}, onResult: () => {} });
          sessions.set(opts, session); session.start(closed); return session;
        } };
      instances.push({ shutdown: () => sessions.shutdown() });
    }
    manager = new SharedConversations({ dir: path.join(root, 'conversations'), loadConfig, saveConfig, drivers, log });
    manager.saveSettings('claude', { model: 'fixture-picked' });
    const first = manager.create('claude', null, 'Shared native smoke');
    for (const engine of [...ENGINES, 'claude']) {
      await manager.switchEngine(first.id, engine, 'direct');
      const before = requests.length;
      const run = await manager.send(engine, { sessionId: first.id, prompt: engine === 'claude' ? 'Remember SHARED_SECRET_4821. Acknowledge only.' : 'Recall the secret and acknowledge only.' });
      const result = await run.done;
      assert.equal(result.is_error, false, engine + ': ' + result.result);
      assert.equal(result.subtype, 'success', engine + ': ' + JSON.stringify(result));
      assert.ok(requests.slice(before).some(r => JSON.stringify(r).includes('SHARED_SECRET_4821')), engine + ' receives context');
      assert.ok(requests.slice(before).every(r => r.model === 'fixture-picked-upstream'), engine + ' uses the shared model instead of its engine default');
      console.log('PASS native context and selected API model: ' + engine);
    }
    const oldDsh = first.segments.dsh.nativeId;
    await manager.switchEngine(first.id, 'dsh', 'markdown');
    assert.notEqual(first.segments.dsh.nativeId, oldDsh);
    assert.equal(first.handoffs.at(-1).status, 'complete');
    assert.equal(manager.load('kimi', first.id).messages.filter(m => m.role === 'user').length, 6);
    console.log('PASS automatic Markdown handoff and fresh native DSH session; 0 external API calls');
    const questionConversation = manager.create('claude', null, 'Question fixture', fs.mkdtempSync(path.join(root, 'question-work-')));
    manager.saveSettings('claude', { sessionId: questionConversation.id, permissionMode: 'bypassPermissions' });
    const questionStart = requests.length;
    const questionRun = await manager.send('claude', { sessionId: questionConversation.id, prompt: 'ASK_QUESTION_FIXTURE: ask which output formats I want, then acknowledge my answer.' });
    const questionDeadline = Date.now() + 15000;
    while (manager.activity(questionConversation.id) === 'running' && Date.now() < questionDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(manager.activity(questionConversation.id), 'question', 'native AskUserQuestion must wait for an answer under Allow all');
    const questionEvent = manager.live('claude', questionConversation.id).live.events.find(event => event.questions?.length);
    assert.equal(questionEvent.permissionMode, 'bypassPermissions');
    assert.equal(questionEvent.questions[0].multiSelect, true);
    assert.equal((await manager.command('claude', 'control-respond', { sessionId: questionConversation.id, runId: questionRun.runId,
      requestId: questionEvent.requestId, allow: true, input: { [questionEvent.questions[0].id]: 'CSV, JSON' } })).ok, true);
    assert.equal((await questionRun.done).subtype, 'success');
    assert.ok(requests.slice(questionStart).some(request => request.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'question-fixture' && JSON.stringify(message.content).includes('CSV, JSON'))), 'the real native tool returns the selected answers to the model');
    console.log('PASS: real Claude AskUserQuestion under Allow all waits for input, accepts multiple selections and returns the answer through the native tool; 0 external API calls');
    const runs = await Promise.all(ENGINES.flatMap(engine => ['A', 'B'].map(async letter => {
      const marker = `CONCURRENT_${letter}_${engine}`;
      const c = manager.create(engine, null, marker, fs.mkdtempSync(path.join(root, 'work-')));
      manager.saveSettings(engine, { sessionId: c.id, model: letter === 'A' ? 'fixture-model' : 'fixture-picked' });
      return { engine, letter, marker, c, ...await manager.send(engine, { sessionId: c.id, prompt: 'Acknowledge ' + marker + ' only.' }) };
    })));
    const until = Date.now() + 45000;
    while (held.size < 10 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(held.size, 10, 'all ten native sessions reach the model concurrently');
    for (const run of runs) {
      assert.equal(held.get(run.marker).body.model, run.letter === 'A' ? 'fixture-upstream' : 'fixture-picked-upstream', run.marker + ' model isolation');
      assert.equal(manager.live(run.engine, run.sessionId).live.prompt, 'Acknowledge ' + run.marker + ' only.');
      await assert.rejects(manager.switchEngine(run.sessionId, run.engine === 'kimi' ? 'codex' : 'kimi'), /Wait/);
    }
    assert.equal(manager.active.size, 10);
    // Stop just one real Codex process while its sibling keeps its pending request.
    const stopped = runs.find(r => r.engine === 'codex' && r.letter === 'A');
    await manager.cancel({ sessionId: stopped.sessionId, runId: stopped.runId });
    assert.equal((await stopped.done).subtype, 'stopped');
    for (const run of runs.filter(r => r !== stopped)) assert.equal(manager.active.has(run.sessionId), true);
    holdConcurrent = false;
    for (const entry of held.values()) entry.resolve();
    await Promise.all(runs.filter(r => r !== stopped).map(async run => {
      const result = await run.done;
      assert.equal(result.is_error, false, run.marker + ': ' + result.result);
      assert.ok(result.result.includes(run.marker), run.marker);
      const transcript = manager.messages(run.c).map(m => m.text).join('\n');
      assert.ok(!transcript.includes(`CONCURRENT_${run.letter === 'A' ? 'B' : 'A'}_${run.engine}`), 'no sibling content');
    }));
    assert.equal(manager.active.size, 0);
    console.log('PASS: 10 overlapping conversations across 5 real native harnesses, independent models, live snapshots, harness locks, isolated cancellation and transcripts; 0 external API calls');
    for (const engine of ENGINES) {
      const prior = runs.find(r => r.engine === engine && r.letter === 'B');
      const nativeId = prior.c.segments[engine].nativeId, before = requests.length;
      const edited = await manager.send(engine, { sessionId: prior.sessionId, editSeq: prior.userSeq, prompt: 'Acknowledge REVISED_' + engine + ' only.' });
      const result = await edited.done;
      assert.equal(result.subtype, 'success', engine + ': revised turn completes');
      assert.notEqual(prior.c.segments[engine].nativeId, nativeId, engine + ': must not resume superseded native context');
      assert.ok(requests.slice(before).some(r => JSON.stringify(r).includes('REVISED_' + engine)));
      const editedRequests = requests.slice(before).filter(r => JSON.stringify(r.messages).includes('REVISED_' + engine));
      assert.ok(editedRequests.every(r => !JSON.stringify(r.messages).includes(prior.marker)), engine + ': previous attempt must not leak into restarted model context');
      const history = manager.load(engine, prior.sessionId).messages;
      assert.equal(history.filter(m => m.role === 'user').length, 1);
      assert.equal(history[0].text, 'Acknowledge REVISED_' + engine + ' only.');
    }
    console.log('PASS: edit and resend starts fresh native context in every harness while retaining one logical conversation');
  } catch (error) { console.error(logs.slice(-25).join('\n')); throw error; }
  finally {
    await Promise.allSettled(instances.map(i => i.shutdown())); await router?.stop(); server.closeAllConnections(); server.close();
    console.log('Fixture artifacts: ' + root);
  }
}
const watchdog = setTimeout(() => { console.error('Native smoke exceeded 150 seconds'); process.exit(1); }, 150000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
