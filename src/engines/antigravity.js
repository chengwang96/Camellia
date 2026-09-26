'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SessionPool } = require('./session-pool');
const { AcpSession } = require('./acp-session');
const { ClaudeHistory } = require('./claude-history');
const { ClaudeGoal } = require('./claude-goal');
const { createSessionWorkspaces } = require('./session-workspaces');
const { readJson } = require('../shared/json-store');
const { modelId } = require('../api/api-router-config');
const { pythonEnvironment, globalPythonEnvironment } = require('../main/python-runtime');
const { downloadSettings } = require('../main/download-network');
const { createGoogleAccount, subscriptionEnvironment, requireGoogleProvider } = require('./antigravity/subscription');
const { valid } = require('./permission-levels');
const { accountSummary, DEFAULT_ACCOUNT_ID } = require('./subscription-accounts');

function antigravitySpawnSpec({ runtime, home, route, config = {}, env, python }) {
  return { args: ['-u', path.join(__dirname, 'antigravity/bridge.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')], modeEngine: 'antigravity', env: {
    ...(python ? globalPythonEnvironment(python, env)
      : runtime.custom ? { ...env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } : pythonEnvironment(runtime.dir, env)),
    CAMELLIA_ANTIGRAVITY_CONFIG: JSON.stringify({ home, baseUrl: route.baseUrl + '/compat/antigravity/v1', settings: config }),
  } };
}

function subscriptionSpawnSpec({ runtime, home, env, proxyUrl }) {
  return { args: [path.join(__dirname, 'antigravity/cli-bridge.cjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')], modeEngine: 'antigravity', env: {
    ...subscriptionEnvironment(env, proxyUrl), CAMELLIA_ANTIGRAVITY_CLI: JSON.stringify({ exe: runtime.file, home }),
  } };
}
const sessionConnection = id => id.startsWith('agy-') ? 'subscription' : 'api';

function createAntigravity({ dataDir, cliSettingsFile, node, openLogin, loadConfig, saveConfig, getRoute, getModels, runtimes, environment = () => process.env, python = () => null, onEvent, onGoal, isBusy = () => false, log }) {
  const sessions = new SessionPool();
  let generation = 0;
  const home = path.join(dataDir, 'antigravity');
  const history = new ClaudeHistory(path.join(dataDir, 'antigravity-history'));
  function settings(sessionId) {
    const value = { connection: 'api', permissionMode: 'default', ...loadConfig().antigravity, thinkingBudget: '' };
    if (sessionId && sessionConnection(sessionId) !== value.connection) {
      value.connection = sessionConnection(sessionId);
      value.model = value[value.connection + 'Model'] || '';
    }
    return value;
  }
  const account = createGoogleAccount({ home, cliSettingsFile, runtime: runtimes, environment, settings, openLogin });
  const standaloneCwd = value => value.cwd || path.join(dataDir, 'antigravity-sessions');
  const workspaces = createSessionWorkspaces({ history, loadConfig, saveConfig, metaKey: 'antigravityMeta', settingsKey: 'antigravity',
    standaloneCwd, getSession: () => sessions.legacy, fixedCwd: true, onDetach: id => goal.detachWorkspace(id) });

  function saveSettings(patch) {
    const next = settings();
    if (patch.connection !== undefined && !['api', 'subscription'].includes(patch.connection)) throw new Error('Invalid Antigravity connection');
    if (patch.connection && patch.connection !== next.connection) {
      next[next.connection + 'Model'] = next.model || '';
      next.connection = patch.connection;
      next.model = next[next.connection + 'Model'] || '';
    }
    for (const key of ['cwd', 'permissionMode', 'proxyUrl']) if (patch[key] !== undefined) next[key] = String(patch[key]).trim();
    if (patch.model !== undefined) {
      const connection = patch.connection || (patch.sessionId ? sessionConnection(patch.sessionId) : next.connection);
      next[connection + 'Model'] = String(patch.model).trim();
      if (connection === next.connection) next.model = next[connection + 'Model'];
    }
    if (next.proxyUrl) next.proxyUrl = downloadSettings({ mode: 'proxy', url: next.proxyUrl }).url;
    if (!valid('antigravity', next.permissionMode)) throw new Error('Invalid Antigravity permission mode');
    saveConfig({ antigravity: next });
    return settings(patch.sessionId);
  }
  function ensureSession(opts) {
    const current = sessions.get(opts);
    const value = { ...settings(opts.sessionId), ...opts.settings };
    const context = opts.cwd ? { cwd: opts.cwd, workspaceId: null } : workspaces.resolveContext(value, opts);
    const selected = { ...value, cwd: context.cwd };
    opts = { ...opts, workspaceId: context.workspaceId };
    if (selected.cwd === standaloneCwd({})) fs.mkdirSync(selected.cwd, { recursive: true });
    if (!fs.statSync(selected.cwd).isDirectory()) throw new Error('Working directory does not exist: ' + selected.cwd);
    const subscription = selected.connection === 'subscription';
    if (!selected.model) throw new Error(subscription ? 'Sign in with Google and refresh available models in Settings → Engine settings → Antigravity.' : 'Select a configured model in the composer first');
    if (subscription) {
      requireGoogleProvider(cliSettingsFile);
      if (opts.fork) throw new Error('Google subscription sessions do not support forks. Start a new session instead.');
      if (!account.state().models.some(model => model.id === selected.model)) throw new Error('This model is not in the Google account model list. Refresh the account in Antigravity settings.');
    } else {
      selected.model = modelId(selected.model);
      if (!getModels().includes(selected.model)) throw new Error('No route is available for this model. Add one in Camellia settings.');
    }
    if (current && !current.dead && !opts.fork && current.opts.goalBridge === opts.goalBridge && current.sessionId === (opts.sessionId || null)
      && current.opts.workspaceId === opts.workspaceId && ['cwd', 'model', 'permissionMode', 'connection', 'proxyUrl'].every(key => current.settings[key] === selected[key])) return current;
    const runtime = runtimes().locate('antigravity', selected.connection);
    if (!runtime) throw new Error('Prepare Antigravity in Settings → Runtime, then retry');
    // A configured shared interpreter takes precedence; otherwise the managed
    // SDK environment (or an explicit script path) provides the runtime.
    const sharedPython = python() || null;
    const spec = subscription ? subscriptionSpawnSpec({ runtime, home, env: environment(), proxyUrl: selected.proxyUrl })
      : antigravitySpawnSpec({ runtime, home, route: getRoute(), env: environment(),
        python: sharedPython?.file ? sharedPython : null, config: readJson(path.join(home, 'settings.json'), {}) });
    const previousClosed = current?.shutdown();
    const next = new AcpSession({ name: 'Antigravity', gen: ++generation, settings: selected, opts, exe: subscription ? node() : runtime.file, spec, spawn, log, history,
      onEvent: event => { if (sessions.get(opts) === next) onEvent({ ...event, conversationId: opts.conversationId }); },
      onSessionId: id => { workspaces.recordContext(id, opts.workspaceId, selected.cwd); if (!opts.conversationId) goal.rememberSession(next); },
      onResult: event => { if (!opts.conversationId && sessions.legacy === next) goal.handleResult(event); },
    });
    sessions.set(opts, next);
    try { next.start(previousClosed); } catch (error) { next.kill(); throw error; }
    return next;
  }
  const goal = new ClaudeGoal({ file: () => path.join(dataDir, 'antigravity-goal.json'), getSession: () => sessions.legacy,
    ensureSession, resolveWorkspace: payload => workspaces.resolveContext(settings(), payload).workspaceId,
    onChange: onGoal, log, setTimer: setTimeout, clearTimer: clearTimeout });
  const handlers = {
    'get-live': async () => ({ ok: true, live: await sessions.legacy?.liveState() || null }),
    'get-settings': payload => settings(payload?.sessionId),
    'save-settings': patch => ({ ok: true, settings: saveSettings(patch || {}) }),
    'list-sessions': async payload => ({ ok: true, ...await workspaces.listSessions(payload || {}) }),
    'load-session': async id => ({ ok: true, ...await workspaces.transcript(id), settings: settings(id) }),
    // The official CLI keeps one global Google credential, so there is exactly
    // one account to report; the shape matches the multi-account engines.
    'account-state': () => {
      const value = account.state();
      return { ok: true, ...value, activeId: DEFAULT_ACCOUNT_ID,
        accounts: [{ ...accountSummary('antigravity', { id: DEFAULT_ACCOUNT_ID, label: '' }, value), active: true }] };
    },
    'account-refresh': async () => {
      const state = await account.refresh();
      if (!settings().subscriptionModel && settings().connection === 'subscription') saveSettings({ model: state.models[0].id });
      return { ok: true, ...state };
    },
    'sign-in': async () => {
      if (sessions.running || isBusy()) throw new Error('Stop Antigravity conversations before changing accounts');
      return { ok: true, ...await account.signIn() };
    },
    'rename-session': payload => workspaces.renameSession(payload.id, payload.title),
    'archive-session': payload => workspaces.archiveSession(payload.id, payload.archived !== false),
    'meta-op': payload => workspaces.metaOp(payload),
    'send': async payload => {
      if (sessions.legacy?.running) throw new Error('Wait for the response to finish or stop it before sending another message');
      const sessionId = payload.sessionId || null;
      const current = ensureSession({ sessionId, workspaceId: payload.workspaceId || null, fork: Boolean(payload.fork) });
      return { ok: current.sendUserMessage(String(payload.prompt || ''), payload.attachments || []), runId: current.gen };
    },
    'cancel': runId => {
      if (sessions.legacy?.gen === runId) { if (goal.armed) goal.setPhase('paused'); sessions.legacy.interrupt(); }
      return { ok: true };
    },
    'control-respond': payload => ({ ok: Boolean(sessions.legacy && !sessions.legacy.dead && sessions.legacy.answerPermission(payload.requestId, Boolean(payload.allow), payload.input, payload.message, payload.optionId)) }),
    'goal-get': () => ({ ok: true, goal: goal.view() }), 'goal-start': payload => goal.start(payload),
    'goal-pause': () => goal.setPhase('paused'), 'goal-resume': () => goal.resume(),
    'goal-complete': () => goal.setPhase('complete'), 'goal-clear': () => goal.clear(),
  };
  return { get session() { return sessions.legacy; }, home, goal, settings, saveSettings, handlers, ensureSession, history, sessions, workspaces,
    async shutdown() { await sessions.shutdown(); } };
}

module.exports = { createAntigravity, antigravitySpawnSpec, subscriptionSpawnSpec };
