'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SessionPool } = require('./session-pool');
const { CodexClient, codexSpawnSpec } = require('./codex-client');
const { CodexSession, PERMISSIONS } = require('./codex-session');
const { valid } = require('./permission-levels');
const { ClaudeHistory } = require('./claude-history');
const { ClaudeGoal } = require('./claude-goal');
const { createSessionWorkspaces } = require('./session-workspaces');
const { readJson, writeJson } = require('../shared/json-store');
const { modelId } = require('../api/api-router-config');
const { downloadSettings } = require('../main/download-network');

function createCodex({ dataDir, loadConfig, saveConfig, getRoute, getModels = () => [], getContextWindow = () => undefined, runtimes, environment = () => process.env,
  openExternal, onEvent, onGoal, onAccount = () => {}, isBusy = () => false, log = () => {} }) {
  const home = path.join(dataDir, 'codex');
  const history = new ClaudeHistory(path.join(dataDir, 'codex-history'));
  const accountFile = path.join(home, 'account-state.json');
  const sessions = new SessionPool();
  let generation = 0, accountClient = null, loginId = null;
  let account = readJson(accountFile, { account: null, models: [], rateLimits: null });
  const connections = () => loadConfig().codexSessionConnections || {};
  const connectionFor = id => connections()[id] || settings().connection;
  function settings(sessionId) {
    const value = { connection: getModels().length ? 'api' : 'subscription', permissionMode: 'default', thinkingBudget: '', ...loadConfig().codex };
    if (sessionId) value.connection = connections()[sessionId] || value.connection;
    value.model = value[value.connection + 'Model'] || '';
    return value;
  }
  function saveSettings(patch) {
    const value = settings();
    if (patch.connection !== undefined) {
      if (!['api', 'subscription'].includes(patch.connection)) throw new Error('Invalid Codex connection');
      value.connection = patch.connection;
    }
    for (const key of ['cwd', 'permissionMode', 'thinkingBudget', 'proxyUrl']) if (patch[key] !== undefined) value[key] = String(patch[key]).trim();
    if (!PERMISSIONS[value.permissionMode] && !valid('codex', value.permissionMode)) throw new Error('Invalid Codex permission mode');
    if (value.proxyUrl) value.proxyUrl = downloadSettings({ mode: 'proxy', url: value.proxyUrl }).url;
    if (patch.model !== undefined) value[(patch.connection || (patch.sessionId ? connectionFor(patch.sessionId) : value.connection)) + 'Model'] = String(patch.model).trim();
    delete value.model;
    saveConfig({ codex: value }); return settings(patch.sessionId);
  }
  function spec(connection, runtime, cwd, model, conversationId) {
    return codexSpawnSpec({ runtime, home: path.join(home, connection, ...(connection === 'api' && conversationId ? ['conversations', conversationId] : [])), configHome: home, cwd,
      connection, model, route: connection === 'api' ? getRoute() : null, contextWindow: connection === 'api' ? getContextWindow(model) : undefined, env: environment(), proxyUrl: settings().proxyUrl });
  }
  function accountState() {
    return { ...account, installed: Boolean(runtimes().locate('codex')), loginPending: Boolean(loginId), home };
  }
  function publishAccount(patch) {
    account = { ...account, ...patch }; writeJson(accountFile, account); onAccount(accountState());
  }
  async function getAccountClient() {
    if (!accountClient || accountClient.dead) {
      const runtime = runtimes().locate('codex');
      if (!runtime) throw new Error('Download Codex CLI in Settings → Runtime first');
      accountClient = new CodexClient({ ...spec('subscription', runtime, home), log,
        onNotification: (method, params) => {
          if (method === 'account/login/completed') {
            loginId = null;
            if (params.success) void refreshAccount().catch(error => publishAccount({ error: error.message }));
            else publishAccount({ error: params.error || 'ChatGPT sign-in was canceled' });
          } else if (method === 'account/rateLimits/updated') publishAccount({ rateLimits: params.rateLimits });
        },
      });
    }
    await accountClient.ready; return accountClient;
  }
  async function refreshAccount() {
    const client = await getAccountClient();
    const value = await client.request('account/read', { refreshToken: true });
    if (value.account?.type !== 'chatgpt') {
      publishAccount({ account: null, models: [], rateLimits: null, error: null, verifiedAt: new Date().toISOString() });
      return accountState();
    }
    const models = []; let cursor = null;
    do {
      const page = await client.request('model/list', { cursor, limit: 100 });
      models.push(...page.data.map(model => ({ id: model.model, name: model.displayName || model.model,
        isDefault: model.isDefault, defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts })));
      cursor = page.nextCursor;
    } while (cursor);
    // Quota errors do not invalidate a successful sign-in or hide usable models.
    let rateLimits = null, quotaError = null;
    try { const result = await client.request('account/rateLimits/read', {}); rateLimits = result.rateLimitsByLimitId || (result.rateLimits ? { codex: result.rateLimits } : null); }
    catch (error) { quotaError = error.message; }
    publishAccount({ account: value.account, models, rateLimits, quotaError, error: null, verifiedAt: new Date().toISOString() });
    // Store the account default even when API is selected for new sessions.
    if (!settings().subscriptionModel && models.length) saveConfig({ codex: { ...loadConfig().codex, subscriptionModel: (models.find(m => m.isDefault) || models[0]).id } });
    return accountState();
  }
  const standaloneCwd = value => value.cwd || path.join(dataDir, 'codex-sessions');
  const workspaces = createSessionWorkspaces({ history, loadConfig, saveConfig, metaKey: 'codexMeta', settingsKey: 'codex',
    standaloneCwd, getSession: () => sessions.legacy, fixedCwd: false, onDetach: id => goal.detachWorkspace(id) });
  function ensureSession(opts) {
    const current = sessions.get(opts);
    const value = { ...settings(opts.sessionId), ...opts.settings }, context = opts.cwd ? { cwd: opts.cwd, workspaceId: null } : workspaces.resolveContext(value, opts);
    const selected = { ...value, cwd: context.cwd };
    opts = { ...opts, workspaceId: context.workspaceId };
    if (selected.cwd === standaloneCwd({})) fs.mkdirSync(selected.cwd, { recursive: true });
    if (!fs.statSync(selected.cwd).isDirectory()) throw new Error('Working directory does not exist: ' + selected.cwd);
    if (!selected.model) throw new Error(selected.connection === 'subscription' ? 'Sign in with ChatGPT in Settings → Engine Settings → Codex CLI.' : 'Select a configured model first');
    if (selected.connection === 'api') {
      selected.model = modelId(selected.model);
      if (!getModels().includes(selected.model)) throw new Error('No API route is configured for this model');
    }
    if (current && !current.dead && !opts.fork && current.sessionId === (opts.sessionId || null)
      && current.opts.workspaceId === opts.workspaceId && ['cwd', 'model', 'permissionMode', 'thinkingBudget', 'connection', 'proxyUrl'].every(key => current.settings[key] === selected[key])) return current;
    const runtime = runtimes().locate('codex');
    if (!runtime) throw new Error('Download Codex CLI in Settings → Runtime first');
    const launch = spec(selected.connection, runtime, selected.cwd, selected.model, opts.conversationId);
    const previousClosed = current?.shutdown();
    const next = new CodexSession({ gen: ++generation, settings: selected, opts, spec: launch, spawn, log, history,
      onEvent: event => { if (sessions.get(opts) === next) onEvent({ ...event, conversationId: opts.conversationId }); },
      onSessionId: id => {
        saveConfig({ codexSessionConnections: { ...connections(), [id]: selected.connection } });
        workspaces.recordContext(id, opts.workspaceId, selected.cwd); if (!opts.conversationId) goal.rememberSession(next);
      },
      onResult: event => { if (!opts.conversationId && sessions.legacy === next) goal.handleResult(event); },
    });
    sessions.set(opts, next); next.start(previousClosed); return next;
  }
  const goal = new ClaudeGoal({ file: () => path.join(dataDir, 'codex-goal.json'), getSession: () => sessions.legacy, ensureSession,
    resolveWorkspace: payload => workspaces.resolveContext(settings(), payload).workspaceId,
    onChange: onGoal, log, setTimer: setTimeout, clearTimer: clearTimeout });
  const handlers = {
    'get-live': async () => ({ ok: true, live: await sessions.legacy?.liveState() || null }),
    'get-settings': payload => settings(payload?.sessionId),
    'save-settings': patch => ({ ok: true, settings: saveSettings(patch || {}) }),
    'list-sessions': async payload => ({ ok: true, ...await workspaces.listSessions(payload || {}) }),
    'load-session': async id => ({ ok: true, ...await workspaces.transcript(id), settings: settings(id) }),
    'rename-session': payload => workspaces.renameSession(payload.id, payload.title),
    'archive-session': payload => workspaces.archiveSession(payload.id, payload.archived !== false),
    'meta-op': payload => workspaces.metaOp(payload),
    'account-state': () => ({ ok: true, ...accountState() }),
    'account-refresh': async () => ({ ok: true, ...await refreshAccount() }),
    'sign-in': async () => {
      if (sessions.running || isBusy()) throw new Error('Stop the Codex response before changing accounts');
      await runtimes().ensure('codex');
      const client = await getAccountClient();
      if (loginId) await client.request('account/login/cancel', { loginId });
      const result = await client.request('account/login/start', { type: 'chatgpt' });
      loginId = result.loginId;
      await openExternal(result.authUrl); onAccount(accountState());
      return { ok: true, ...accountState() };
    },
    'cancel-login': async () => {
      if (loginId) await (await getAccountClient()).request('account/login/cancel', { loginId });
      loginId = null; onAccount(accountState()); return { ok: true, ...accountState() };
    },
    'sign-out': async () => {
      if (sessions.running || goal.armed || isBusy()) throw new Error('Stop the Codex response or goal before signing out');
      await sessions.shutdown();
      await (await getAccountClient()).request('account/logout', {}); loginId = null;
      publishAccount({ account: null, models: [], rateLimits: null, error: null }); return { ok: true, ...accountState() };
    },
    'send': async payload => {
      if (sessions.legacy?.running) throw new Error('Wait for the response to finish or stop it before sending another message');
      const sessionId = payload.sessionId || null;
      const current = ensureSession({ sessionId, workspaceId: payload.workspaceId || null, fork: Boolean(payload.fork) });
      return { ok: current.sendUserMessage(String(payload.prompt || ''), payload.attachments || []), runId: current.gen };
    },
    'cancel': runId => { if (sessions.legacy?.gen === runId) { if (goal.armed) goal.setPhase('paused'); sessions.legacy.interrupt(); } return { ok: true }; },
    'control-respond': payload => ({ ok: Boolean(sessions.legacy && !sessions.legacy.dead && sessions.legacy.answerPermission(payload.requestId, Boolean(payload.allow), payload.input, payload.message, payload.optionId)) }),
    'goal-get': () => ({ ok: true, goal: goal.view() }), 'goal-start': payload => goal.start(payload),
    'goal-pause': () => goal.setPhase('paused'), 'goal-resume': () => goal.resume(),
    'goal-complete': () => goal.setPhase('complete'), 'goal-clear': () => goal.clear(),
  };
  return { get session() { return sessions.legacy; }, get active() { return Boolean(sessions.active || (accountClient && !accountClient.dead)); },
    home, goal, settings, saveSettings, handlers, ensureSession, history, sessions, workspaces,
    async shutdown() { await sessions.shutdown(); await accountClient?.shutdown(); accountClient = null; loginId = null; } };
}
module.exports = { createCodex };
