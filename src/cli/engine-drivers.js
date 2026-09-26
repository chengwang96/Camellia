'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRuntimeManager } = require('../main/runtime-manager');
const { npmCandidates } = require('../main/runtime-paths');
const { SessionPool } = require('../engines/session-pool');
const { ClaudeHistory } = require('../engines/claude-history');
const { ClaudeSession } = require('../engines/claude-session');
const { KimiSession, kimiSpawnSpec, kimiConnectionSettings, updateKimiConnectionSettings } = require('../engines/kimi-session');
const { createKimiAccount } = require('../engines/kimi-account');
const { createCodex } = require('../engines/codex');
const { createDshChat } = require('../engines/dsh-session');
const { createAntigravity } = require('../engines/antigravity');
const { valid, nativeMode } = require('../engines/permission-levels');
const { writeJson } = require('../shared/json-store');
const { conversationModels } = require('../engines/conversation-models');

function claudeSpec({ settings, opts, home, route, environment, history, mcpFile }) {
  const env = { ...environment, CLAUDE_CONFIG_DIR: home };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_BEDROCK$|CLAUDE_CODE_USE_VERTEX$)/i.test(key)) delete env[key];
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--replay-user-messages', '--include-partial-messages', '--verbose'];
  if (mcpFile && fs.existsSync(mcpFile)) args.push('--mcp-config', mcpFile);
  if (opts.sessionId) args.push('--resume', history.find(opts.sessionId) || opts.sessionId);
  if (opts.fork) args.push('--fork-session');
  const permission = nativeMode('claude', settings.permissionMode || 'ask');
  if (permission !== 'default') args.push('--permission-mode', permission);
  if (!settings.model) throw new Error('Choose a model on this server before sending');
  args.push('--model', settings.model);
  if (settings.thinkingBudget && settings.thinkingBudget !== 'off') args.push('--effort', settings.thinkingBudget);
  const overlay = {};
  if (settings.connection !== 'subscription') {
    Object.assign(overlay, { ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_AUTH_TOKEN: route.authToken, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: settings.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: settings.model, ANTHROPIC_DEFAULT_SONNET_MODEL: settings.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.model,
      ANTHROPIC_SMALL_FAST_MODEL: settings.model, CLAUDE_CODE_SUBAGENT_MODEL: settings.model });
  }
  if (settings.thinkingBudget === 'off') overlay.MAX_THINKING_TOKENS = '0';
  const file = path.join(home, 'overlays', `${opts.conversationId || 'legacy'}.json`);
  writeJson(file, { env: overlay }); args.push('--settings', file);
  return { args, env: { ...env, ...overlay }, cwd: settings.cwd };
}

function createEngineDrivers({ root, dataDir, loadConfig, saveConfig, onEvent, getRoute, router, isBusy, runtimeManager, nativeSettings }) {
  const native = nativeSettings || require('./native-settings').createNativeSettings({ dataDir, isBusy });
  const environment = () => ({ ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') });
  const runtimes = runtimeManager || createRuntimeManager({ root, installRoot: dataDir, node: process.execPath,
    npm: npmCandidates(process.execPath, { resourcesPath: root }).find(file => fs.existsSync(file)), downloadOptions: () => loadConfig().downloadProxy });
  const locate = (engine, mode) => { const found = runtimes.locate(engine, mode); if (!found) throw new Error(`Install ${engine} on this server with runtime-install first`); return found; };
  const models = () => require('../api/api-router-config').publicState(router()).models;
  const context = model => require('../api/api-router-config').modelContextWindow(router(), model);
  const noLog = () => {};
  const links = {};
  const openExternal = engine => async value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid account authorization link');
    links[engine] = url.href;
  };
  for (const engine of ['claude', 'codex', 'kimi']) if (!loadConfig()[engine]) saveConfig({ [engine]: { connection: 'api', permissionMode: 'ask' } });
  if (!loadConfig().dshChat) saveConfig({ dshChat: { permissionMode: 'ask', model: '' } });
  const dsh = createDshChat({ dataDir, loadConfig, saveConfig, getRoute, getModels: models, runtime: () => locate('dsh'), node: () => process.execPath,
    environment, onEvent: event => onEvent('dsh', event), log: noLog, nativeConfig: () => native.config('dsh'), nativeRevision: () => native.fingerprint('dsh') });
  const codex = createCodex({ dataDir, loadConfig, saveConfig, getRoute, getModels: models, getContextWindow: context,
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
  const kimi = { history: kimiHistory, settings: kimiSettings, nativeCompaction: true, nativeAutoCompaction: true,
    saveSettings(patch) { saveConfig({ kimi: updateKimiConnectionSettings(loadConfig(), patch) }); return kimiSettings(patch.sessionId); },
    ensure(opts) {
      const settings = { ...kimiSettings(opts.sessionId), ...opts.settings, cwd: opts.cwd, nativeRevision: native.fingerprint('kimi') };
      const prior = cached(kimiPool, opts, settings); if (prior) return prior;
      const subscription = settings.connection === 'subscription';
      if (subscription && (!kimiAccount.state().account || !kimiAccount.state().models.some(model => model.id === settings.model))) throw new Error('Sign in and refresh the Kimi account on this server first');
      if (!subscription && !models().includes(settings.model)) throw new Error('Choose a configured API model');
      const spec = kimiSpawnSpec({ runtime: locate('kimi').file, home: subscription ? kimiHome : path.join(dataDir, 'kimi-api', opts.conversationId),
        config: native.config('kimi'), mcp: JSON.stringify(native.config('kimi', 'mcp')),
        connection: settings.connection, model: settings.model, contextWindow: context(settings.model) || settings.contextWindow,
        route: subscription ? undefined : getRoute(), env: environment(), sharedSubscription: subscription });
      const previous = kimiPool.get(opts)?.shutdown();
      const session = new KimiSession({ name: 'Kimi', gen: ++generation, settings, opts, spec, exe: process.execPath, spawn, history: kimiHistory, log: noLog,
        onEvent: event => { if (kimiPool.get(opts) === session) onEvent('kimi', { ...event, conversationId: opts.conversationId }); },
        onSessionId: id => saveConfig({ kimiSessionConnections: { ...loadConfig().kimiSessionConnections, [id]: settings.connection } }), onResult: noLog });
      kimiPool.set(opts, session); session.start(previous); return session;
    },
    async shutdown() { await kimiPool.shutdown(); await kimiAccount.shutdown(); },
  };
  const claude = { history: claudeHistory, nativeCompaction: true, nativeAutoCompaction: true,
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
      const settings = { ...claude.settings(), ...opts.settings, cwd: opts.cwd, nativeRevision: native.fingerprint('claude') };
      const current = cached(claudePool, opts, settings); if (current) return current;
      if (settings.connection !== 'subscription' && !models().includes(settings.model)) throw new Error('Choose a configured API model');
      const spec = claudeSpec({ settings, opts, home: claudeHome, route: settings.connection === 'subscription' ? null : getRoute(), environment: environment(), history: claudeHistory, mcpFile: native.path('claude', 'mcp') });
      claudePool.get(opts)?.kill();
      const session = new ClaudeSession({ gen: ++generation, settings, opts: { ...opts, lockPermissionMode: true }, exe: locate('claude').file, spec, spawn, log: noLog,
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
    cliSettingsFile: path.join(dataDir, 'google-native/.gemini/antigravity-cli/settings.json'), node: () => process.execPath,
    openLogin: async () => { throw new Error('Use native-login in the server terminal for Google sign-in'); },
    isBusy: () => isBusy('antigravity'), onEvent: event => onEvent('antigravity', event), onGoal: noLog, log: noLog });
  const drivers = { dsh, codex: { history: codex.history, settings: codex.settings, saveSettings: codex.saveSettings, ensure: codex.ensureSession,
    nativeCompaction: true, nativeEditing: true, shutdown: () => codex.shutdown() }, kimi, claude };
  drivers.antigravity = { history: antigravity.history, settings: antigravity.settings, saveSettings: antigravity.saveSettings,
    ensure: antigravity.ensureSession, nativeAutoCompaction: true, shutdown: () => antigravity.shutdown() };
  for (const [engine, service] of [['codex', codex], ['antigravity', antigravity]]) {
    const revisions = new Map(), ensure = drivers[engine].ensure;
    drivers[engine].ensure = opts => {
      const revision = native.fingerprint(engine);
      if (revisions.get(opts.conversationId) !== revision) {
        const current = service.sessions.get(opts);
        if (current) { current.dead = true; void current.shutdown(); }
      }
      revisions.set(opts.conversationId, revision);
      return ensure(opts);
    };
  }
  return { drivers, runtimes,
    accountBusy(engine) { return engine === 'kimi' ? kimiAccount.active : engine === 'codex' ? codex.accountState().loginPending : false; },
    prepare(engine, settings) {
      locate(engine, engine === 'antigravity' ? settings.connection : undefined); if (!drivers[engine]) throw new Error('Engine is unavailable on this server');
      if (engine === 'kimi' && (kimiAccount.state().loginPending || kimiAccount.state().refreshing)) throw new Error('Wait for Kimi account operation to finish');
      if (engine === 'codex' && codex.accountState().loginPending) throw new Error('Wait for Codex account operation to finish');
    },
    models(engine, settings) {
      if (engine === 'claude' && settings.connection === 'subscription') return settings.model ? [{ id: settings.model, name: settings.model, thinking: [] }] : [];
      return conversationModels(engine, settings, { router, codex: id => codex.accountState(id), kimi: () => kimiAccount.state(), antigravity: () => antigravity.handlers['account-state']() });
    },
    async account(engine, action) {
      if (!['codex', 'kimi', 'antigravity'].includes(engine)) throw new Error('Use the native server terminal login for this engine');
      if (!['state', 'refresh', 'login', 'cancel', 'logout'].includes(action)) throw new Error('Invalid account action');
      if (action !== 'state' && isBusy(engine)) throw new Error('Stop this engine before changing accounts');
      if (action === 'login') { locate(engine); delete links[engine]; }
      let result;
      if (engine === 'antigravity') {
        if (!['state', 'refresh'].includes(action)) throw new Error('Use the native server terminal to sign in or out of Google');
        result = await antigravity.handlers[action === 'state' ? 'account-state' : 'account-refresh']();
      } else if (engine === 'codex') result = await codex.handlers[{ state: 'account-state', refresh: 'account-refresh', login: 'sign-in', cancel: 'cancel-login', logout: 'sign-out' }[action]]();
      else result = await kimiAccount[{ state: 'state', refresh: 'refresh', login: 'signIn', cancel: 'cancelLogin', logout: 'signOut' }[action]]();
      if (action === 'logout' || action === 'cancel') delete links[engine];
      result ||= engine === 'kimi' ? kimiAccount.state() : {};
      return { engine, signedIn: Boolean(result.account || engine === 'antigravity' && result.models?.length), loginPending: Boolean(result.loginPending), login: result.login || null,
        loginUrl: result.loginPending ? links[engine] || null : null, models: (result.models || []).map(model => ({ id: model.id, name: model.displayName || model.name || model.id })) };
    },
    nativeLogin(engine, action = 'login') {
      if (!['claude', 'codex', 'antigravity'].includes(engine)) throw new Error('This engine uses the account command');
      if (!['login', 'logout', 'status'].includes(action) || engine === 'antigravity' && action !== 'login') throw new Error('Use the native Google CLI menu for logout and account status');
      if (isBusy(engine)) throw new Error('Stop engine conversations before signing in');
      const runtime = locate(engine, engine === 'antigravity' ? 'subscription' : undefined);
      const home = engine === 'claude' ? claudeHome : engine === 'antigravity' ? googleHome : codex.accountState().home;
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const args = engine === 'claude' ? ['auth', action] : engine === 'codex' ? action === 'login' ? ['login', '--device-auth'] : action === 'status' ? ['login', 'status'] : ['logout'] : [];
      return { executable: runtime.file, args, home, engine };
    },
  };
}

module.exports = { createEngineDrivers, claudeSpec };
