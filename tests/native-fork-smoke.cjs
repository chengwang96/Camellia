'use strict';

// Real native forks through SharedConversations and production driver factories.
// Model traffic and MCP bridges are local; no subscription or paid API is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { createCodex } = require('../src/engines/codex');
const { createAntigravity } = require('../src/engines/antigravity');
const { createGrokChat } = require('../src/engines/grok-session');
const { createDshChat } = require('../src/engines/dsh-session');
const { ClaudeSession } = require('../src/engines/claude-session');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { SessionPool } = require('../src/engines/session-pool');
const { snapshotTranscript } = require('../src/engines/native-fork');
const { KimiSession, kimiSpawnSpec, forkKimiNative } = require('../src/engines/kimi-session');
const { SharedConversations } = require('../src/engines/shared-conversations');
const { createGoalToolBridge } = require('../src/engines/goal-tool-bridge');
const { isolatedEnvironment } = require('../src/engines/isolated-environment');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  const headless = process.argv.includes('--headless'), withoutGoalTools = process.argv.includes('--without-goal-tools');
  const remote = process.argv.includes('--remote');
  const appRoot = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-native-forks-'));
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const readFixture = path.join(cwd, 'native-read.txt'); fs.writeFileSync(readFixture, 'Native retained file content');
  const requests = [], logs = [], ownershipChecks = [];
  let held, releaseHeld, compacting;
  const server = http.createServer(async (req, res) => {
    if (require('./model-metadata-fixture.cjs')(req, res)) return;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (compacting) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Native summary preserving FORK_SMOKE SOURCE_' + compacting } }] }));
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 8 } }));
      res.end(frame('[DONE]')); return;
    }
    const lastUser = body.messages?.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('FORK_SMOKE')) ?? -1;
    const current = lastUser < 0 ? '' : JSON.stringify(body.messages[lastUser].content);
    const currentMarker = current.match(/FORK_SMOKE \w+/g)?.at(-1);
    const marker = current.match(/FORK_SMOKE (?:CONTINUE_BRANCH|GRANDCHILD|REPLACED|REVISED|REEDITED)_[a-z]+/)?.[0];
    if (held && /^FORK_SMOKE (?:ACTIVE_DISCARD_[a-z]+|REEDITED_claude)$/.test(currentMarker || '')) {
      held?.();
      await new Promise(resolve => { releaseHeld = resolve; });
      if (res.destroyed) return;
    }
    const ownerTool = body.tools?.find(tool => /camellia_get_goal$/.test(tool.function?.name || tool.name || ''));
    const readTool = body.tools?.find(tool => ['read_file', 'read', 'Read'].includes(tool.function?.name || tool.name));
    const readSchema = readTool?.function?.parameters || readTool?.input_schema;
    const fileArgument = Object.keys(readSchema?.properties || {}).find(name => /^(?:file_path|path|target_file|filePath|file)$/.test(name)) || 'target_file';
    const results = lastUser < 0 ? [] : body.messages.slice(lastUser + 1).filter(message => message.role === 'tool');
    const token = current.match(/Camellia goal run token for this turn: ([\w-]+)/)?.[1];
    const call = marker && !results.length && (ownerTool && token || readTool);
    if (marker && ownerTool && results.length) ownershipChecks.push({ marker,
      ok: /"ok"\s*:\s*true/.test(JSON.stringify(results.map(result => result.content)).replace(/\\"/g, '"')) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = call ? { tool_calls: [{ index: 0, id: 'owner-' + requests.length, type: 'function',
      function: { name: ownerTool?.function?.name || ownerTool?.name || readTool?.function?.name || readTool?.name,
        arguments: JSON.stringify(ownerTool ? { run_token: token } : { [fileArgument]: readFixture }) } }] }
      : { role: 'assistant', content: 'Native fork fixture reply. ' + (marker || '') };
    res.write(frame({ choices: [{ index: 0, delta }] }));
    res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 8 } }));
    res.end(frame('[DONE]'));
  });
  const listen = instance => new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  await listen(server);
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const configFile = path.join(root, 'routes.json');
  const routes = normalizeConfig({ port, providers: [{ id: 'fixture', name: 'Local fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', protocol: 'openai',
    models: [{ id: 'fork-fixture', upstream: 'fork-fixture', contextWindow: 131072 }], keys: [{ id: 'local', key: 'local-only' }] }] });
  writeConfig(configFile, routes);
  const router = startApiRouter({ configPath: configFile }); await router.ready;
  let manager;
  const factories = [];
  try {
    let config = { codex: { connection: 'api', apiModel: 'fork-fixture', permissionMode: 'full' },
      claude: { connection: 'api', apiModel: 'fork-fixture', permissionMode: 'full' },
      kimi: { connection: 'api', apiModel: 'fork-fixture', permissionMode: 'full' },
      grok: { connection: 'api', apiModel: 'fork-fixture', permissionMode: 'full' },
      antigravity: { connection: 'api', model: 'fork-fixture', permissionMode: 'full' },
      dshChat: { model: 'fork-fixture', permissionMode: 'full' } };
    const runtimeManager = createRuntimeManager({ root: appRoot, installRoot: path.join(process.env.APPDATA || '', 'camellia'), node: process.execPath });
    const runtimes = () => runtimeManager;
    const env = isolatedEnvironment(path.join(root, 'isolated-home'), process.execPath);
    const common = { dataDir: root, loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; },
      runtimes, environment: () => env, getRoute: () => ({ baseUrl: router.url, authToken: 'proxy-managed' }),
      getModels: () => ['fork-fixture'], getContextWindow: () => 131072, log: text => logs.push(text), openExternal() {} };
    const codex = createCodex({ ...common, onEvent: event => manager.capture('codex', event), onGoal() {} });
    const grok = createGrokChat({ ...common, onEvent: event => manager.capture('grok', event) });
    const antigravity = createAntigravity({ ...common, cliSettingsFile: path.join(root, 'agy-settings.json'), node: () => process.execPath,
      onEvent: event => manager.capture('antigravity', event), onGoal() {}, openLogin() {} });
    const dsh = createDshChat({ ...common, runtime: () => runtimeManager.locate('dsh'), node: () => process.execPath,
      onEvent: event => manager.capture('dsh', event) });
    const claudeHome = path.join(root, 'claude-config'), claudeHistory = new ClaudeHistory(path.join(claudeHome, 'projects'));
    const claudePool = new SessionPool(); let generation = 0;
    const claude = { sessions: claudePool, history: claudeHistory, nativeCompaction: true, nativeAutoCompaction: true, nativeEditing: true,
      settings: () => ({ model: 'fork-fixture', connection: 'api', permissionMode: 'full', contextWindow: 131072 }),
      saveSettings: patch => patch,
      forkNative({ sessionId, snapshotFile, boundary }) {
        snapshotTranscript(claudeHistory.find(sessionId), snapshotFile);
        return { pendingNativeFork: { sessionId, ...(boundary?.resumeSessionAt ? { resumeSessionAt: boundary.resumeSessionAt } : {}) } };
      },
      ensure(opts) {
        const previous = claudePool.get(opts); if (previous) previous.kill();
        const args = ['--bare', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--model', 'fork-fixture', '--tools=Read', '--permission-mode', 'bypassPermissions'];
        if (opts.goalBridge?.config) {
          const file = path.join(root, 'claude-mcp-' + opts.conversationId + '.json');
          fs.writeFileSync(file, JSON.stringify({ mcpServers: { camellia_goals: opts.goalBridge.config } }));
          args.push('--strict-mcp-config', '--mcp-config', file);
        }
        if (opts.sessionId) {
          args.push('--resume', opts.resumeFile || claudeHistory.find(opts.sessionId) || opts.sessionId);
          if (opts.fork) args.push('--fork-session');
          if (opts.resumeSessionAt) args.push('--resume-session-at', opts.resumeSessionAt);
          if (opts.resumeDropsTurn) args.push('--resume-drops-turn', opts.resumeDropsTurn);
        }
        const spec = { args, cwd: opts.cwd, env: { ...env, CLAUDE_CONFIG_DIR: claudeHome,
          ANTHROPIC_BASE_URL: router.url, ANTHROPIC_API_KEY: 'local-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } };
        const session = new ClaudeSession({ gen: ++generation, settings: { ...opts.settings, cwd: opts.cwd }, opts,
          exe: runtimeManager.locate('claude').file, spec, spawn, nativeHistory: claudeHistory, log: common.log,
          onEvent: event => manager.capture('claude', { ...event, conversationId: opts.conversationId }) });
        claudePool.set(opts, session); session.start(); return session;
      } };
    const kimiPool = new SessionPool(), kimiHistory = new ClaudeHistory(path.join(root, 'kimi-history'));
    const kimi = { sessions: kimiPool, nativeCompaction: true, nativeAutoCompaction: true, nativeEditing: true,
      settings: () => ({ model: 'fork-fixture', connection: 'api', permissionMode: 'full', contextWindow: 131072 }), saveSettings: patch => patch,
      forkNative: args => forkKimiNative({ ...args, ensureSource: kimi.ensure, targetHome: path.join(root, 'kimi-code', 'conversations', args.conversationId) }),
      ensure(opts) {
        const previous = kimiPool.get(opts);
        if (previous && !previous.dead && !opts.fork && previous.sessionId === opts.sessionId && previous.opts.goalBridge === opts.goalBridge) return previous;
        const storage = opts.forkSourceConversationId || opts.conversationId;
        const spec = kimiSpawnSpec({ home: path.join(root, 'kimi-code', 'conversations', storage),
          runtime: runtimeManager.locate('kimi').file, route: common.getRoute(), model: 'fork-fixture', contextWindow: 131072, env });
        const session = new KimiSession({ gen: ++generation, settings: { ...opts.settings, cwd: opts.cwd }, opts,
          exe: process.execPath, spec, spawn, history: kimiHistory, log: common.log,
          onSessionId() {}, onResult() {}, onEvent: event => manager.capture('kimi', { ...event, conversationId: opts.conversationId }) });
        kimiPool.set(opts, session); session.start(previous?.shutdown()); return session;
      } };
    factories.push(codex, grok, claude, kimi, antigravity, dsh);
    let drivers = {
      codex: { ...codex, ensure: codex.ensureSession, nativeCompaction: true, nativeEditing: true },
      grok: { ...grok, nativeEditing: true },
      claude,
      kimi,
      antigravity: { ...antigravity, ensure: antigravity.ensureSession, nativeAutoCompaction: true },
      dsh,
    };
    if (headless) {
      const engines = require('../src/cli/engine-drivers').createEngineDrivers({ ...common, root: appRoot,
        runtimeManager, router: () => routes, isBusy: engine => manager?.isBusy(engine) || false,
        onEvent: (engine, event) => manager.capture(engine, event) });
      drivers = engines.drivers;
      factories.push(...Object.values(drivers));
    }
    const options = { dir: path.join(root, 'conversations'), loadConfig: common.loadConfig, saveConfig: common.saveConfig,
      drivers, modelContextWindow: () => 131072, log: common.log,
      ...(withoutGoalTools ? {} : { createGoalBridge: args => createGoalToolBridge({ node: process.execPath, ...args }) }) };
    manager = new SharedConversations(options);
    const forkSession = async (engine, id) => {
      if (!remote) return manager.command(engine, 'fork-session', { sessionId: id });
      const { RemoteCommands } = require('../src/main/remote/commands');
      const { RemoteReadModel } = require('../src/main/remote/read-model');
      const device = { id: 'local-fixture', permission: 'control', allWorkspaces: true };
      const commands = new RemoteCommands({ file: path.join(root, 'remote-commands.json'),
        reader: new RemoteReadModel(manager), access: { devices: [device] } });
      const result = await commands.perform(device.id, id, { action: 'fork', expectedSeq: manager.get(id).seq });
      assert.equal(result.ok, true);
      return { ok: true, sessionId: result.conversation.id };
    };
    const turn = async (engine, id, prompt, extra = {}) => {
      const run = await manager.send(engine, { ...(id ? { sessionId: id } : {}), prompt, ...extra });
      let timer;
      const result = await Promise.race([run.done, new Promise((_, reject) => {
        timer = setTimeout(() => { void manager.cancel({ sessionId: run.sessionId }); reject(new Error(engine + ' native fork turn timed out: ' + prompt + '\nRequests: '
          + requests.slice(-4).map(body => (JSON.stringify(body.messages).match(/FORK_SMOKE [A-Z]+_[a-z]+/g) || []).join(',')).join('\n')
          + '\n' + logs.slice(-6).join('\n'))); }, 30000);
      })]).finally(() => clearTimeout(timer));
      assert.equal(result.is_error, false, JSON.stringify(result) + '\n' + logs.slice(-12).join('\n'));
      return run.sessionId;
    };
    const selected = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
    for (const engine of selected.length ? selected : ['codex', 'grok', 'claude', 'kimi', 'antigravity', 'dsh']) {
      const first = manager.create(engine, null, 'Native source', cwd);
      await turn(engine, first.id, 'FORK_SMOKE SOURCE_' + engine);
      if (engine === 'claude') {
        const session = drivers.claude.sessions.get({ conversationId: first.id });
        const rows = fs.readFileSync(drivers.claude.history.find(session.sessionId), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(rows.some(row => row.type === 'user' && row.uuid === session.userMessageId), 'Claude must persist the supplied input identity');
      }
      if (['claude', 'grok', 'kimi', 'dsh'].includes(engine)) {
        const oldStart = requests.length;
        await turn(engine, first.id, 'FORK_SMOKE REPLACED_' + engine);
        const originalNative = first.segments[engine].nativeId;
        const editSeq = manager.rows(first).findLast(row => row.role === 'user').seq;
        const editStart = requests.length;
        await turn(engine, first.id, 'FORK_SMOKE REVISED_' + engine, { editSeq });
        const edited = requests.slice(editStart).find(body => JSON.stringify(body.messages).includes('FORK_SMOKE REVISED_' + engine));
        assert.ok(edited);
        assert.match(JSON.stringify(edited.messages), new RegExp('FORK_SMOKE SOURCE_' + engine));
        assert.doesNotMatch(JSON.stringify(edited.messages), new RegExp('FORK_SMOKE REPLACED_' + engine + '|Conversation context from earlier turns follows as JSON data'));
        const droppedCalls = requests.slice(oldStart, editStart).flatMap(body => body.messages || [])
          .flatMap(message => message.tool_calls || []).map(call => call.id);
        assert.ok(droppedCalls.length, engine + ' fixture must exercise tools before replacement');
        for (const call of droppedCalls) assert.ok(!JSON.stringify(edited.messages).includes(call), 'Discarded tool call leaked: ' + call);
        assert.notEqual(first.segments[engine].nativeId, originalNative, engine + ' edits must create an independent native identity');
        const repeatedSeq = manager.rows(first).findLast(row => row.role === 'user').seq;
        await Promise.all(factories.map(factory => factory.sessions.shutdown()));
        await manager.closeGoalTools(); manager = new SharedConversations(options);
        const repeatStart = requests.length;
        await turn(engine, first.id, 'FORK_SMOKE REEDITED_' + engine, { editSeq: repeatedSeq });
        const repeated = requests.slice(repeatStart).find(body => JSON.stringify(body.messages).includes('FORK_SMOKE REEDITED_' + engine));
        assert.ok(repeated);
        assert.doesNotMatch(JSON.stringify(repeated.messages), /FORK_SMOKE (?:REPLACED|REVISED)_|Conversation context from earlier turns follows as JSON data/);
        console.log('PASS: ' + engine + ' native repeated edit removes superseded turns/tools and survives restart.');
        if (engine === 'kimi') {
          const session = drivers.kimi.sessions.get({ conversationId: first.id });
          compacting = engine;
          try { await session.compact({ timeoutMs: 15000 }); }
          finally { compacting = null; }
          assert.equal(await session.editBoundary('FORK_SMOKE REEDITED_kimi'), null, 'Native undo must refuse to cross compaction');
          await turn(engine, first.id, 'FORK_SMOKE REPLACED_AFTER_COMPACT');
          const afterSeq = manager.rows(manager.get(first.id)).findLast(row => row.role === 'user').seq;
          const afterStart = requests.length;
          await turn(engine, first.id, 'FORK_SMOKE REVISED_AFTER_COMPACT', { editSeq: afterSeq });
          const after = requests.slice(afterStart).find(body => JSON.stringify(body.messages).includes('REVISED_AFTER_COMPACT'));
          assert.ok(after);
          assert.doesNotMatch(JSON.stringify(after.messages), /REPLACED_AFTER_COMPACT|Conversation context from earlier turns follows as JSON data/);
          assert.match(JSON.stringify(after.messages), /Native summary preserving FORK_SMOKE SOURCE_kimi/);
          console.log('PASS: Kimi native compaction boundary refuses old undo and preserves edits after compaction.');
        }
      }
      const source = manager.get(first.id), sourceNative = source.segments[engine].nativeId;
      let fork;
      // A CLI may not persist its active user prompt until the model replies.
      // Keep its frozen idle fork, and separately check that the live fork
      // falls back safely if an exact native cut is not yet observable.
      if (engine === 'claude') fork = await forkSession(engine, source.id);
      if (['codex', 'grok', 'claude', 'dsh'].includes(engine)) {
        const reached = new Promise(resolve => { held = resolve; });
        // Repeat the last completed Claude request: matching only its text can
        // mistake that older turn for an active prompt not yet persisted.
        const activePrompt = engine === 'claude' ? 'FORK_SMOKE REEDITED_claude' : 'FORK_SMOKE ACTIVE_DISCARD_' + engine;
        const active = await manager.send(engine, { sessionId: source.id, prompt: activePrompt });
        try {
          await Promise.race([reached, active.done.then(result => { throw new Error('Active fixture ended early: ' + JSON.stringify(result)); })]);
          const runningSource = manager.active.get(source.id).session;
          const runningSettings = JSON.stringify(runningSource.settings);
          if (engine === 'dsh') manager.saveSettings(engine, { sessionId: source.id, thinkingBudget: 'high' });
          const activeFork = await forkSession(engine, source.id);
          assert.equal(manager.active.get(source.id)?.session.running, true, 'Fork must leave its source generating');
          assert.equal(manager.active.get(source.id).session, runningSource, 'Fork must retain the exact running source');
          if (engine === 'dsh') {
            assert.equal(drivers.dsh.sessions.get({ conversationId: source.id }), runningSource);
            assert.equal(runningSource.dead, false);
            assert.equal(JSON.stringify(runningSource.settings), runningSettings, 'Next-turn settings must not reconfigure the active source');
            assert.equal(manager.settings(engine, activeFork.sessionId).thinkingBudget, 'high', 'Only the child inherits the new preference');
            console.log('PASS: DSH active fork preserves its source connection after a next-turn thinking change.');
          }
          if (engine === 'claude') {
            const branch = manager.get(activeFork.sessionId);
            assert.doesNotMatch(JSON.stringify(manager.messages(branch)), /ACTIVE_DISCARD/);
            const branchStart = requests.length;
            await turn(engine, branch.id, 'FORK_SMOKE ACTIVE_FALLBACK_BRANCH');
            const continued = requests.slice(branchStart).find(body => JSON.stringify(body.messages).includes('FORK_SMOKE ACTIVE_FALLBACK_BRANCH'));
            assert.match(JSON.stringify(continued.messages), /FORK_SMOKE REEDITED_claude/, 'An identical active request must not discard the earlier completed turn');
            await manager.deleteConversation(branch.id);
          } else fork = activeFork;
        } finally {
          await manager.cancel({ sessionId: source.id }); releaseHeld?.(); held = releaseHeld = undefined;
          await active.done;
        }
      } else fork = await forkSession(engine, source.id);
      const child = manager.get(fork.sessionId);
      assert.ok(child.segments[engine]?.nativeId || child.nativeFork, engine + ' native fork failed:\n' + logs.slice(-12).join('\n'));
      if (child.segments[engine]?.nativeId) assert.notEqual(child.segments[engine].nativeId, sourceNative);
      await turn(engine, first.id, 'FORK_SMOKE LATER_PARENT_' + engine);
      assert.equal(manager.get(first.id).segments[engine].nativeId, sourceNative);
      await Promise.all(factories.map(factory => factory.sessions.shutdown()));
      await manager.deleteConversation(first.id);
      const sourceHome = engine === 'codex' || engine === 'grok' ? path.join(root, engine, 'api', 'conversations', first.id)
        : engine === 'kimi' ? headless ? path.join(root, 'kimi-api', first.id) : path.join(root, 'kimi-code', 'conversations', first.id)
          : engine === 'dsh' ? path.join(root, 'dsh-chat', 'conversations', first.id)
          : engine === 'antigravity' ? path.join(root, 'antigravity', 'sessions', sourceNative) : null;
      if (sourceHome) {
        const relative = path.relative(root, sourceHome);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        removeTree(sourceHome);
      } else {
        const file = drivers.claude.history.find(sourceNative);
        assert.ok(file && !path.relative(root, file).startsWith('..'));
        fs.rmSync(file);
      }
      await manager.closeGoalTools();
      manager = new SharedConversations(options);
      const start = requests.length;
      await turn(engine, child.id, 'FORK_SMOKE CONTINUE_BRANCH_' + engine);
      assert.notEqual(manager.get(child.id).segments[engine].nativeId, sourceNative);
      const sent = requests.slice(start).find(body => JSON.stringify(body.messages).includes('FORK_SMOKE CONTINUE_BRANCH_' + engine));
      assert.ok(sent, engine + ' did not continue its fork');
      assert.match(JSON.stringify(sent.messages), new RegExp('FORK_SMOKE SOURCE_' + engine));
      assert.doesNotMatch(JSON.stringify(sent.messages), new RegExp('FORK_SMOKE LATER_PARENT_' + engine));
      assert.doesNotMatch(JSON.stringify(sent.messages), /FORK_SMOKE ACTIVE_DISCARD_/);
      assert.doesNotMatch(JSON.stringify(sent.messages), /Conversation context from earlier turns follows as JSON data/);
      if (engine === 'kimi' && !withoutGoalTools) assert.ok(ownershipChecks.some(check => check.marker === 'FORK_SMOKE CONTINUE_BRANCH_' + engine && check.ok), 'Kimi must call its own conversation bridge after source deletion');
      if (sent.tools?.some(tool => /camellia_get_goal$/.test(tool.function?.name || tool.name || '')))
        assert.ok(ownershipChecks.some(check => check.marker === 'FORK_SMOKE CONTINUE_BRANCH_' + engine && check.ok), engine + ' fork must call its own conversation bridge');
      assert.equal(manager.items.has(first.id), false);
      const grandchild = await forkSession(engine, child.id);
      const branch = manager.get(grandchild.sessionId);
      assert.ok(branch.segments[engine]?.nativeId || branch.nativeFork, engine + ' second-generation native fork failed:\n' + logs.slice(-6).join('\n'));
      const grandStart = requests.length;
      await turn(engine, branch.id, 'FORK_SMOKE GRANDCHILD_' + engine);
      const grand = requests.slice(grandStart).find(body => JSON.stringify(body.messages).includes('FORK_SMOKE GRANDCHILD_' + engine));
      assert.ok(grand);
      assert.match(JSON.stringify(grand.messages), new RegExp('FORK_SMOKE SOURCE_' + engine));
      assert.match(JSON.stringify(grand.messages), new RegExp('FORK_SMOKE CONTINUE_BRANCH_' + engine));
      assert.doesNotMatch(JSON.stringify(grand.messages), new RegExp('FORK_SMOKE LATER_PARENT_' + engine));
      assert.doesNotMatch(JSON.stringify(grand.messages), /Conversation context from earlier turns follows as JSON data/);
      if (engine === 'kimi' && !withoutGoalTools) assert.ok(ownershipChecks.some(check => check.marker === 'FORK_SMOKE GRANDCHILD_' + engine && check.ok), 'Kimi must rebind the second-generation conversation bridge');
      if (grand.tools?.some(tool => /camellia_get_goal$/.test(tool.function?.name || tool.name || '')))
        assert.ok(ownershipChecks.some(check => check.marker === 'FORK_SMOKE GRANDCHILD_' + engine && check.ok), engine + ' second-generation fork must call its own conversation bridge');
      console.log('PASS: ' + (remote ? 'remote ' : '') + (headless ? 'headless ' : '') + engine + ' unified native fork, independent homes, parent continuation/deletion, restart and second-generation native fork.');
    }
  } finally {
    releaseHeld?.();
    await Promise.allSettled(factories.map(factory => factory.sessions.shutdown()));
    await manager?.closeGoalTools();
    await router.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-native-forks-'));
    removeTree(root);
  }
}
const watchdog = setTimeout(() => { console.error('Native fork smoke exceeded 150 seconds'); process.exit(1); }, 150000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
