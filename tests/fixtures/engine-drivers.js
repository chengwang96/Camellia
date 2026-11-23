'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRuntimeManager } = require('../../src/main/runtime-manager');
const { npmCandidates } = require('../../src/main/runtime-paths');
const { SessionPool } = require('../../src/engines/session-pool');
const { ClaudeHistory } = require('../../src/engines/claude-history');
const { ClaudeSession } = require('../../src/engines/claude-session');
const { KimiSession, kimiSpawnSpec, kimiConnectionSettings, updateKimiConnectionSettings, forkKimiNative } = require('../../src/engines/kimi-session');
const { createKimiAccount } = require('../../src/engines/kimi-account');
const { createGrokChat } = require('../../src/engines/grok-session');
const { createGrokAccount } = require('../../src/engines/grok-account');
const { createAccountPool } = require('../../src/engines/subscription-accounts');
const { createCodex } = require('../../src/engines/codex');
const { createDshChat } = require('../../src/engines/dsh-session');
const { createAntigravity } = require('../../src/engines/antigravity');
const { valid, nativeMode } = require('../../src/engines/permission-levels');
const { writeJson } = require('../../src/shared/json-store');
const { nativeEditingSupported } = require('../../src/engines/native-edit-boundary');
const { snapshotTranscript } = require('../../src/engines/native-fork');
const { harnessThinkingRoute } = require('../../src/api/harness-thinking');
const { explicitContextCap } = require('../../src/api/context-capacity');
const { withSessionAffinity } = require('../../src/api/session-affinity');

function claudeSpec({ settings, opts, home, route, environment, history, mcpFile, contextWindow }) {
  const env = { ...environment, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_BEDROCK$|CLAUDE_CODE_USE_VERTEX$|CLAUDE_CODE_MAX_CONTEXT_TOKENS$)/i.test(key)) delete env[key];
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--replay-user-messages', '--include-partial-messages', '--verbose'];
  if (opts.goalBridge?.config) {
    let source = {};
    if (mcpFile && fs.existsSync(mcpFile)) {
      try { source = JSON.parse(fs.readFileSync(mcpFile, 'utf8')); }
      catch { throw new Error('Native MCP configuration is invalid; repair it on the server'); }
    }
    const file = path.join(home, 'overlays', `${opts.conversationId || 'legacy'}.mcp.json`);
    writeJson(file, { ...source, mcpServers: { ...source.mcpServers, camellia_goals: opts.goalBridge.config } });
    args.push('--mcp-config', file);
  } else if (mcpFile && fs.existsSync(mcpFile)) args.push('--mcp-config', mcpFile);
  if (opts.sessionId) args.push('--resume', opts.resumeFile || history.find(opts.sessionId) || opts.sessionId);
  if (opts.fork) args.push('--fork-session');
  if (opts.resumeSessionAt) args.push('--resume-session-at', opts.resumeSessionAt);
  if (opts.resumeDropsTurn) args.push('--resume-drops-turn', opts.resumeDropsTurn);
  const permission = nativeMode('claude', settings.permissionMode || 'ask');
  if (permission !== 'default') args.push('--permission-mode', permission);
  if (!settings.model) throw new Error('Choose a model on this server before sending');
  args.push('--model', settings.model);
  const subscription = settings.connection === 'subscription';
  if (subscription && settings.thinkingBudget && !['off', 'none'].includes(settings.thinkingBudget)) args.push('--effort', settings.thinkingBudget);
  const overlay = {};
  if (!subscription) {
    route = harnessThinkingRoute(route, settings.thinkingBudget || '');
    Object.assign(overlay, { ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_AUTH_TOKEN: route.authToken, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: settings.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: settings.model, ANTHROPIC_DEFAULT_SONNET_MODEL: settings.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.model,
      ANTHROPIC_SMALL_FAST_MODEL: settings.model, CLAUDE_CODE_SUBAGENT_MODEL: settings.model });
    // Claude Code does not recognize third-party model IDs and assumes a 200K
    // window, so an explicit 1M route would auto-compact at a fifth of its real
    // capacity. Only an explicit route limit may override the assumption;
    // accepted-input evidence is a lower bound and would compact too early.
    if (Number.isSafeInteger(contextWindow) && contextWindow >= 4096) overlay.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);
  }
  if (subscription && ['off', 'none'].includes(settings.thinkingBudget)) overlay.MAX_THINKING_TOKENS = '0';
  const file = path.join(home, 'overlays', `${opts.conversationId || 'legacy'}.json`);
  writeJson(file, { env: overlay }); args.push('--settings', file);
  return { args, env: { ...env, ...overlay }, cwd: settings.cwd };
}

function createEngineDrivers({ root, dataDir, loadConfig, saveConfig, onEvent, getRoute, router, isBusy, runtimeManager, nativeSettings, contextCapacity, createUsageMeter = () => null, environment: baseEnvironment = () => process.env }) {
  const native = nativeSettings || require('./native-settings').createNativeSettings({ dataDir, isBusy });
  const environment = () => { const env = baseEnvironment(); return { ...env, PATH: path.dirname(process.execPath) + path.delimiter + (env.PATH || '') }; };
  const runtimes = runtimeManager || createRuntimeManager({ root, installRoot: dataDir, node: process.execPath,
    npm: npmCandidates(process.execPath, { resourcesPath: root }).find(file => fs.existsSync(file)), downloadOptions: () => loadConfig().downloadProxy });
  const locate = (engine, mode) => { const found = runtimes.locate(engine, mode); if (!found) throw new Error(`Install ${engine} before running the harness fixture`); return found; };
  const models = () => require('../../src/api/api-router-config').publicState(router()).models;
  const context = model => contextCapacity?.budget({ model, protocol: 'openai' })?.cap || require('../../src/api/api-router-config').modelContextWindow(router(), model);
  const dshContext = model => contextCapacity?.budget({ model, protocol: 'anthropic' })?.cap || require('../../src/api/api-router-config').modelContextWindow(router(), model);
  const noLog = () => {};
  const openExternal = () => async () => {};
  for (const engine of ['claude', 'codex', 'kimi']) if (!loadConfig()[engine]) saveConfig({ [engine]: { connection: 'api', permissionMode: 'ask' } });
  if (!loadConfig().dshChat) saveConfig({ dshChat: { permissionMode: 'ask', model: '' } });
  const dsh = createDshChat({ dataDir, loadConfig, saveConfig, getRoute, getModels: models, getContextWindow: dshContext, runtime: () => locate('dsh'), node: () => process.execPath,
    getModelThinking: model => require('../../src/api/api-router-config').publicState(router()).modelThinking[model],
    environment, onEvent: event => onEvent('dsh', event), log: noLog, nativeConfig: () => native.config('dsh'), nativeRevision: () => native.fingerprint('dsh') });
  const codex = createCodex({ dataDir, loadConfig, saveConfig, getRoute, getModels: models, getContextWindow: context,
    createUsageMeter,
    runtimes: () => runtimes, environment, openExternal: openExternal('codex'), isBusy: () => isBusy('codex'), log: noLog,
    onEvent: event => onEvent('codex', event), onGoal: noLog });
  const kimiHome = path.join(dataDir, 'kimi-subscription');
  const kimiSettings = id => kimiConnectionSettings(loadConfig(), id);
  const kimiAccount = createKimiAccount({ home: kimiHome, runtime: () => runtimes.locate('kimi'), ensureRuntime: () => Promise.resolve(locate('kimi')),
    node: () => process.execPath, environment, region: () => kimiSettings().region, isBusy: () => isBusy('kimi'), openExternal: openExternal('kimi'),
    onModels: entries => { if (!kimiSettings().subscriptionModel && entries.length) saveConfig({ kimi: { ...loadConfig().kimi, subscriptionModel: entries[0].id } }); } });
  const kimiPool = new SessionPool(), claudePool = new SessionPool();
  const kimiHistory = new ClaudeHistory(path.join(dataDir, 'kimi-history'));
  const claudeHome = path.join(dataDir, 'claude-native');
  const claudeHistory = new ClaudeHistory(path.join(claudeHome, 'projects'));
  let generation = 0;
  function cached(pool, opts, settings) {
    const current = pool.get(opts);
    return current && !current.dead && !opts.fork && current.opts.goalBridge === opts.goalBridge && current.sessionId === (opts.sessionId || null)
      && JSON.stringify(current.settings) === JSON.stringify(settings) ? current : null;
  }
  const kimi = { sessions: kimiPool, history: kimiHistory, settings: kimiSettings, nativeCompaction: true, nativeAutoCompaction: true, titleDuringTurn: true,
    nativeEditing: () => nativeEditingSupported('kimi', runtimes.locate('kimi')?.version),
    generateTitle({ conversation, prompt, duringTurn }) {
      const session = kimiPool.get({ conversationId: conversation.id });
      return session && !session.dead ? session.generateTitle({ prompt, duringTurn }) : '';
    },
    async forkNative(options) {
      const result = await forkKimiNative({ ...options, ensureSource: kimi.ensure,
        targetHome: options.settings.connection === 'subscription' ? null : path.join(dataDir, 'kimi-api', options.conversationId) });
      if (result?.nativeId) saveConfig({ kimiSessionConnections: { ...loadConfig().kimiSessionConnections,
        [result.nativeId]: options.settings.connection || 'api' } });
      return result;
    },
    saveSettings(patch) { saveConfig({ kimi: updateKimiConnectionSettings(loadConfig(), patch) }); return kimiSettings(patch.sessionId); },
    ensure(opts) {
      kimiPool.assertAccess(opts);
      const settings = { ...kimiSettings(opts.sessionId), ...opts.settings, cwd: opts.cwd, nativeRevision: native.fingerprint('kimi') };
      const prior = cached(kimiPool, opts, settings); if (prior) return prior;
      const subscription = settings.connection === 'subscription';
      if (subscription && (!kimiAccount.state().account || !kimiAccount.state().models.some(model => model.id === settings.model))) throw new Error('Sign in and refresh the Kimi account on this server first');
      if (!subscription && !models().includes(settings.model)) throw new Error('Choose a configured API model');
      const spec = kimiSpawnSpec({ runtime: locate('kimi').file, home: subscription ? kimiHome : path.join(dataDir, 'kimi-api', opts.conversationId),
        config: native.config('kimi'), mcp: JSON.stringify(native.config('kimi', 'mcp')),
        connection: settings.connection, model: settings.model, contextWindow: context(settings.model) || settings.contextWindow,
        route: subscription ? undefined : withSessionAffinity(getRoute(), opts.conversationId), env: environment(), sharedSubscription: subscription, thinkingBudget: settings.thinkingBudget || '' });
      const previous = kimiPool.get(opts)?.shutdown();
      const session = new KimiSession({ name: 'Kimi', gen: ++generation, settings, opts, spec, exe: process.execPath, spawn, history: kimiHistory, log: noLog,
        usageMeter: createUsageMeter('kimi', { settings, home: kimiHome, version: locate('kimi').version }),
        onEvent: event => { if (kimiPool.get(opts) === session) onEvent('kimi', { ...event, conversationId: opts.conversationId }); },
        onSessionId: id => saveConfig({ kimiSessionConnections: { ...loadConfig().kimiSessionConnections, [id]: settings.connection } }), onResult: noLog });
      kimiPool.set(opts, session); session.start(previous); return session;
    },
    async shutdown() { await kimiPool.shutdown(); await kimiAccount.shutdown(); },
  };
  const claude = { sessions: claudePool, history: claudeHistory, nativeCompaction: true, nativeAutoCompaction: true,
    nativeEditing: () => nativeEditingSupported('claude', runtimes.locate('claude')?.version),
    async forkNative({ sessionId, snapshotFile, boundary }) {
      const source = claudeHistory.find(sessionId);
      if (!source) return null;
      await snapshotTranscript(source, snapshotFile);
      return { pendingNativeFork: { sessionId, ...(boundary?.resumeSessionAt ? { resumeSessionAt: boundary.resumeSessionAt } : {}) } };
    },
    settings() { const saved = loadConfig().claude || {}; return { permissionMode: 'ask', connection: 'api', ...saved, model: saved[`${saved.connection || 'api'}Model`] || saved.model || '' }; },
    saveSettings(patch) {
      const next = { ...loadConfig().claude };
      if (patch.connection !== undefined) { if (!['api', 'subscription'].includes(patch.connection)) throw new Error('Invalid connection'); next.connection = patch.connection; }
      if (patch.model !== undefined) next[`${next.connection || 'api'}Model`] = String(patch.model);
      for (const key of ['permissionMode', 'thinkingBudget']) if (patch[key] !== undefined) next[key] = String(patch[key]);
      if (!valid('claude', next.permissionMode || 'ask')) throw new Error('Invalid permission');
      saveConfig({ claude: next }); return claude.settings();
    },
    ensure(opts) {
      claudePool.assertAccess(opts);
      const settings = { ...claude.settings(), ...opts.settings, cwd: opts.cwd, nativeRevision: native.fingerprint('claude') };
      const current = cached(claudePool, opts, settings); if (current) return current;
      if (settings.connection !== 'subscription' && !models().includes(settings.model)) throw new Error('Choose a configured API model');
      const spec = claudeSpec({ settings, opts, home: claudeHome, route: settings.connection === 'subscription' ? null : withSessionAffinity(getRoute(), opts.conversationId),
        contextWindow: settings.connection === 'subscription' ? undefined
          : explicitContextCap(contextCapacity?.budget({ model: settings.model, protocol: 'anthropic' })),
        environment: environment(), history: claudeHistory, mcpFile: native.path('claude', 'mcp') });
      claudePool.get(opts)?.kill();
      const session = new ClaudeSession({ gen: ++generation, settings, opts: { ...opts, lockPermissionMode: true }, exe: locate('claude').file, spec, spawn, log: noLog, nativeHistory: claudeHistory,
        onEvent: event => { if (claudePool.get(opts) === session) onEvent('claude', { ...event, conversationId: opts.conversationId }); }, onSessionId: noLog, onResult: noLog });
      claudePool.set(opts, session); session.start(); return session;
    }, async shutdown() {
      const exits = [...claudePool.sessions.values()].map(session => {
        const process = session.proc;
        if (!process || process.exitCode !== null || process.signalCode !== null) { session.kill(); return Promise.resolve(); }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('Claude did not exit; data lock retained')); }, 5000);
          process.once('exit', () => { clearTimeout(timer); resolve(); }); session.kill();
        });
      });
      await Promise.all(exits); claudePool.sessions.clear();
    },
  };
  if (!loadConfig().antigravity) saveConfig({ antigravity: { connection: 'api', permissionMode: 'ask' } });
  const googleHome = path.join(dataDir, 'google-native');
  const googleEnvironment = () => ({ ...environment(), HOME: googleHome, XDG_CONFIG_HOME: path.join(googleHome, '.config'), XDG_DATA_HOME: path.join(googleHome, '.local/share'), XDG_CACHE_HOME: path.join(googleHome, '.cache') });
  const antigravity = createAntigravity({ dataDir, loadConfig, saveConfig, getRoute, getModels: models, runtimes: () => runtimes, environment: googleEnvironment,
    createUsageMeter,
    cliSettingsFile: path.join(dataDir, 'google-native/.gemini/antigravity-cli/settings.json'), node: () => process.execPath,
    openLogin: async () => { throw new Error('Use native-login in the server terminal for Google sign-in'); },
    isBusy: () => isBusy('antigravity'), onEvent: event => onEvent('antigravity', event), onGoal: noLog, log: noLog });
  const grokAccount = createAccountPool({ engine: 'grok', userData: dataDir,
    root: path.join(dataDir, 'grok-subscription'), bindingsKey: 'grokSessionAccounts', loadConfig, saveConfig,
    createService: (profile, notify) => createGrokAccount({ home: profile.home,
      runtime: () => runtimes.locate('grok'), ensureRuntime: () => Promise.resolve(locate('grok')), environment,
      getProxyUrl: () => loadConfig().grok?.proxyUrl || '',
      isBusy: () => isBusy('grok'), openExternal: openExternal('grok'),
      onModels: entries => { if (!loadConfig().grok?.subscriptionModel && entries.length) saveConfig({ grok: { ...loadConfig().grok, subscriptionModel: (entries.find(entry => entry.isDefault) || entries[0]).id } }); },
      onChange: () => notify(),
    }) });
  const grok = require('../../src/engines/grok-session').createGrokChat({ dataDir, loadConfig, saveConfig, getRoute, getModels: models, getContextWindow: context,
    runtimes: () => runtimes, environment, accounts: grokAccount, createUsageMeter,
    nativeConfig: () => native.config('grok'), nativeRevision: () => native.fingerprint('grok'),
    nativeInstructions: () => native.config('grok', 'instructions'),
    onEvent: event => onEvent('grok', event), log: noLog });
  const drivers = { dsh, grok: { ...grok, subscriptionAccounts: () => grokAccount.state(),
    nativeEditing: () => nativeEditingSupported('grok', runtimes.locate('grok')?.version),
    shutdown: async () => { await grok.shutdown(); await grokAccount.shutdown(); } }, codex: { sessions: codex.sessions, history: codex.history, settings: codex.settings, saveSettings: codex.saveSettings, ensure: codex.ensureSession,
    subscriptionAccounts: () => codex.accountState(),
    resetCredits: { preview: payload => codex.handlers['account-reset-preview'](payload), consume: payload => codex.handlers['account-reset-consume'](payload) },
    generateTitle: codex.generateTitle, titleDuringTurn: true, forkNative: codex.forkNative, nativeCompaction: true, nativeEditing: true, shutdown: () => codex.shutdown() }, kimi, claude };
  drivers.antigravity = { sessions: antigravity.sessions, history: antigravity.history, settings: antigravity.settings, saveSettings: antigravity.saveSettings,
    ensure: antigravity.ensureSession, generateTitle: antigravity.generateTitle, titleDuringTurn: true, forkNative: antigravity.forkNative, nativeAutoCompaction: true, shutdown: () => antigravity.shutdown() };
  require('../../src/engines/discussions/native-access').installDiscussionGuards({ dataDir, drivers: {
    codex, antigravity, dsh, grok,
    claude: { sessions: claudePool, history: claudeHistory }, kimi: { sessions: kimiPool, history: kimiHistory },
  } });
  for (const [engine, service] of [['codex', codex], ['antigravity', antigravity]]) {
    const revisions = new Map(), ensure = drivers[engine].ensure;
    drivers[engine].ensure = opts => {
      service.sessions.assertAccess(opts);
      const revision = native.fingerprint(engine);
      if (revisions.get(opts.conversationId) !== revision) {
        const current = service.sessions.get(opts);
        if (current) { current.dead = true; void current.shutdown(); }
      }
      revisions.set(opts.conversationId, revision);
      return ensure(opts);
    };
  }
  return { drivers,
    async releaseRuntime(engine) {
      if (engine === 'kimi') await kimiPool.shutdown();
      else await drivers[engine].shutdown?.();
    },
  };
}

module.exports = { createEngineDrivers };
