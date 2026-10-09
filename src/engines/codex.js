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
const { fastTier } = require('../shared/codex-speed');
const { downloadSettings } = require('../main/download-network');
const accountOptions = require('./subscription-accounts');
const { quotaPatch, createResetCredits } = require('./codex-reset-credits');
const { getDiscussionLaunch, buildDiscussionSpec, assertDiscussionPoolAccess } = require('./discussions/native-launch');

function createCodex({ dataDir, loadConfig, saveConfig, getRoute, getModels = () => [], getContextWindow = () => undefined, runtimes, environment = () => process.env,
  openExternal, onEvent, onGoal, onAccount = () => {}, createUsageMeter = () => null, isBusy = () => false, log = () => {}, createAccountClient = options => new CodexClient(options) }) {
  const home = path.join(dataDir, 'codex');
  const history = new ClaudeHistory(path.join(dataDir, 'codex-history'));
  const discussionHistory = new ClaudeHistory(path.join(dataDir, 'discussions', 'transcripts', 'codex'));
  const sessions = new SessionPool();
  let generation = 0;
  // One entry per signed-in ChatGPT account. Every account owns a CODEX_HOME so
  // several sign-ins can stay active at once; native threads live there too.
  const accountEntries = new Map();
  let pendingAccount = null;
  const wakingAccounts = new Set();
  const wakeClients = new Set();
  const connections = () => loadConfig().codexSessionConnections || {};
  const accountBindings = () => loadConfig().codexSessionAccounts || {};
  const accountList = () => accountOptions.accountsFor(loadConfig(), 'codex');
  const activeId = () => {
    const selected = accountOptions.activeAccountId(loadConfig(), 'codex');
    // Older Add clicks selected empty slots. Keep the usable login selected
    // when those legacy slots are hidden from the account cards.
    if (accountEntry(selected).state.account) return selected;
    return accountList().find(account => accountEntry(account.id).state.account)?.id || selected;
  };
  const accountHome = id => accountOptions.accountHome({ userData: dataDir, engine: 'codex', id, root: path.join(home, 'subscription') });
  function accountEntry(id = activeId()) {
    let value = accountEntries.get(id);
    if (!value) {
      const dir = accountHome(id);
      // The legacy single account kept its cached state one level above its home.
      const stateFile = path.join(id === accountOptions.DEFAULT_ACCOUNT_ID ? home : dir, 'account-state.json');
      value = { id, home: dir, stateFile, client: null, loginId: null, state: readJson(stateFile, { account: null, models: [], rateLimits: null }) };
      accountEntries.set(id, value);
    }
    return value;
  }
  function accountStates() {
    const installed = Boolean(runtimes().locate('codex'));
    return Object.fromEntries(accountList().map(account => {
      // One unreadable account file must not take the whole list down.
      try {
        const entry = accountEntry(account.id);
        return [account.id, { ...entry.state, installed, loginPending: Boolean(entry.loginId) }];
      } catch (error) {
        return [account.id, { account: null, models: [], error: String(error.message || error).slice(0, 200), installed }];
      }
    }));
  }
  function selectAccountId(sessionId) {
    return accountOptions.boundAccountId({ engine: 'codex', accounts: accountList(), states: accountStates(), activeId: activeId(),
      preferId: sessionId ? accountBindings()[sessionId] || null : null, autoSwitch: loadConfig().subscriptionAutoSwitch?.codex !== false });
  }
  function saveAccountConfig({ accounts, activeId: next }) {
    const config = loadConfig();
    saveConfig({ subscriptionAccounts: { ...config.subscriptionAccounts, codex: accounts || accountList() },
      subscriptionActive: { ...config.subscriptionActive, codex: next || activeId() } });
  }
  const connectionFor = id => connections()[id] || settings().connection;
  function settings(sessionId) {
    const value = { connection: getModels().length ? 'api' : 'subscription', permissionMode: 'default', thinkingBudget: '', ...loadConfig().codex };
    if (sessionId) {
      value.connection = connections()[sessionId] || value.connection;
      if (accountBindings()[sessionId]) value.subscriptionId = accountBindings()[sessionId];
    }
    value.model = value[value.connection + 'Model'] || '';
    value.fastMode = sessionId ? loadConfig().codexSessionFastModes?.[sessionId] === true : false;
    return value;
  }
  function saveSettings(patch) {
    if (patch.fastMode !== undefined) {
      if (typeof patch.fastMode !== 'boolean' || !patch.sessionId) throw new Error('Choose a conversation before changing Fast mode');
    }
    const value = settings();
    if (patch.connection !== undefined) {
      if (!['api', 'subscription'].includes(patch.connection)) throw new Error('Invalid Codex connection');
      value.connection = patch.connection;
    }
    for (const key of ['cwd', 'permissionMode', 'thinkingBudget', 'proxyUrl']) if (patch[key] !== undefined) value[key] = String(patch[key]).trim();
    if (!PERMISSIONS[value.permissionMode] && !valid('codex', value.permissionMode)) throw new Error('Invalid Codex permission mode');
    if (value.proxyUrl) value.proxyUrl = downloadSettings({ mode: 'proxy', url: value.proxyUrl }).url;
    if (patch.model !== undefined) value[(patch.connection || (patch.sessionId ? connectionFor(patch.sessionId) : value.connection)) + 'Model'] = String(patch.model).trim();
    delete value.model; delete value.subscriptionId; delete value.fastMode;
    saveConfig({ codex: value,
      ...(patch.fastMode !== undefined ? { codexSessionFastModes: { ...loadConfig().codexSessionFastModes, [patch.sessionId]: patch.fastMode } } : {}) });
    return settings(patch.sessionId);
  }
  function spec(connection, runtime, cwd, model, conversationId, accountId) {
    const target = connection === 'api' ? path.join(home, 'api', ...(conversationId ? ['conversations', conversationId] : []))
      : accountHome(accountId || activeId());
    return codexSpawnSpec({ runtime, home: target, configHome: home, cwd, allowUserQuestions: true,
      connection, model, route: connection === 'api' ? getRoute() : null, contextWindow: connection === 'api' ? getContextWindow(model) : undefined, env: environment(), proxyUrl: settings().proxyUrl,
      sharedPluginCache: connection === 'api' ? path.join(home, '.tmp') : '' });
  }
  function accountState(id = activeId()) {
    const value = accountEntry(id);
    return { ...value.state, installed: Boolean(runtimes().locate('codex')), loginPending: Boolean(pendingAccount || value.loginId), home: value.home,
      activeId: activeId(), accounts: accountOptions.accountSummaries({ engine: 'codex', accounts: accountList(), states: accountStates(), activeId: activeId() }) };
  }
  function publishAccount(id, patch) {
    const value = accountEntry(id);
    if (value.removing) return;
    value.state = { ...value.state, ...patch };
    if (patch.rateLimits) value.state.quotaHistory = require('./quota-history').recordQuota(value.state.quotaHistory, patch.rateLimits);

    if (pendingAccount?.id === id && value.state.account) {
      saveAccountConfig({ accounts: [...accountList(), pendingAccount], activeId: id });
      pendingAccount = null;
    }
    writeJson(value.stateFile, value.state); onAccount(accountState(id));
  }
  async function discardDraft(id) {
    if (accountList().some(account => account.id === id)) return;
    const value = accountEntry(id);
    value.removing = true;
    if (pendingAccount?.id === id) pendingAccount = null;
    await value.client?.shutdown();
    const dir = accountHome(id);
    if (path.resolve(dir).startsWith(path.resolve(path.join(dataDir, 'subscription-accounts')) + path.sep)) {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  async function getAccountClient(id = activeId()) {
    const value = accountEntry(id);
    if (value.removing) throw new Error('Account is being removed');
    if (!value.client || value.client.dead) {
      const runtime = runtimes().locate('codex');
      if (!runtime) throw new Error('Download Codex CLI in Settings → Engine Settings first');
      value.client = createAccountClient({ ...spec('subscription', runtime, home, undefined, undefined, id), log,
        onNotification: (method, params) => {
          if (value.removing) return;
          if (method === 'account/login/completed') {
            value.loginId = null;
            if (params.success) void refreshAccount(id).catch(error => { if (pendingAccount?.id === id) pendingAccount = null; publishAccount(id, { error: error.message }); });
            else {
              const error = params.error || 'ChatGPT sign-in was canceled';
              if (pendingAccount?.id === id) void discardDraft(id).catch(error => log(error.message)).finally(() => onAccount({ ...accountState(), error }));
              else publishAccount(id, { error });
            }
          } else if (method === 'account/rateLimits/updated') publishAccount(id, { rateLimits: params.rateLimits });
        },
      });
    }
    await value.client.ready; return value.client;
  }
  async function refreshAccount(id = activeId()) {
    const client = await getAccountClient(id);
    const value = await client.request('account/read', { refreshToken: true });
    if (value.account?.type !== 'chatgpt') {
      if (pendingAccount?.id === id) pendingAccount = null;
      publishAccount(id, { account: null, models: [], rateLimits: null, rateLimitResetCredits: null, error: null, verifiedAt: new Date().toISOString() });
      return accountState(id);
    }
    if (pendingAccount?.id === id) publishAccount(id, { account: value.account, error: null });
    const models = []; let cursor = null;
    do {
      const page = await client.request('model/list', { cursor, limit: 100 });
      models.push(...page.data.map(model => ({ id: model.model, name: model.displayName || model.model,
        isDefault: model.isDefault, defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
        serviceTiers: Array.isArray(model.serviceTiers) ? model.serviceTiers : [],
        defaultServiceTier: model.defaultServiceTier ?? null })));
      cursor = page.nextCursor;
    } while (cursor);
    // Quota errors do not invalidate a successful sign-in or hide usable models.
    let quota = { rateLimits: null, rateLimitResetCredits: null }, quotaError = null;
    try { quota = quotaPatch(await client.request('account/rateLimits/read', {})); }
    catch (error) { quotaError = error.message; }
    publishAccount(id, { account: value.account, models, ...quota, quotaError, error: null, verifiedAt: new Date().toISOString() });
    // Store the account default even when API is selected for new sessions.
    if (!settings().subscriptionModel && models.length) saveConfig({ codex: { ...loadConfig().codex, subscriptionModel: (models.find(m => m.isDefault) || models[0]).id } });
    return accountState(id);
  }
  function resetService(payload) {
    const id = String(payload?.id || '');
    if (!accountList().some(account => account.id === id)) throw new Error('Unknown Codex account');
    const entry = accountEntry(id);
    if (!entry.state.account || entry.loginId || entry.removing) throw new Error('Sign in to this ChatGPT account first');
    if (!entry.resetCredits) entry.resetCredits = createResetCredits({ file: path.join(entry.home, 'rate-limit-reset-request.json'),
      getClient: () => getAccountClient(id), publish: patch => publishAccount(id, patch) });
    return entry.resetCredits;
  }
  const standaloneCwd = value => value.cwd || path.join(dataDir, 'codex-sessions');
  const workspaces = createSessionWorkspaces({ history, loadConfig, saveConfig, metaKey: 'codexMeta', settingsKey: 'codex',
    standaloneCwd, getSession: () => sessions.legacy, fixedCwd: false, onDetach: id => goal.detachWorkspace(id) });
  function ensureSession(opts) {
    const discussion = getDiscussionLaunch(opts, 'codex');
    assertDiscussionPoolAccess(sessions, opts, discussion);
    const current = sessions.get(opts);
    const value = discussion ? { ...discussion.settings } : { ...settings(opts.sessionId), ...opts.settings };
    const context = opts.cwd ? { cwd: opts.cwd, workspaceId: null } : workspaces.resolveContext(value, opts);
    const selected = { ...value, cwd: context.cwd };
    opts = { ...opts, workspaceId: context.workspaceId };
    if (selected.cwd === standaloneCwd({})) fs.mkdirSync(selected.cwd, { recursive: true });
    if (!fs.statSync(selected.cwd).isDirectory()) throw new Error('Working directory does not exist: ' + selected.cwd);
    if (!selected.model) throw new Error(selected.connection === 'subscription' ? 'Sign in with ChatGPT in Settings → Engine Settings → Codex CLI.' : 'Select a configured model first');
    if (discussion && opts.sessionId && connections()[opts.sessionId] !== selected.connection) throw new Error('Discussion native connection is not verified');
    if (selected.connection === 'api') {
      selected.model = modelId(selected.model);
      if (!getModels().includes(selected.model)) throw new Error('No API route is configured for this model');
      if (!discussion) selected.contextWindow = getContextWindow(selected.model);
    } else {
      // A conversation keeps the account that owns its native thread; a new
      // conversation picks an account that still has quota.
      const accountId = discussion ? selected.subscriptionId : opts.conversationId && opts.settings?.subscriptionId || selectAccountId(opts.sessionId);
      if (discussion && (!accountList().some(account => account.id === accountId) || !accountEntry(accountId).state.account
        || opts.sessionId && accountBindings()[opts.sessionId] !== accountId)) throw new Error('Discussion subscription account is not verified');
      if (accountId) selected.subscriptionId = accountId;
      else delete selected.subscriptionId;
    }
    // Resolve against the account actually serving this turn, including quota
    // failover. A saved preference cannot enable Fast mode on an API route or
    // on an account/model that does not advertise it.
    selected.serviceTier = selected.connection === 'subscription' && selected.fastMode === true
      ? fastTier(accountEntry(selected.subscriptionId).state.models?.find(model => model.id === selected.model))?.id || null : null;
    if (current && !current.dead && !opts.fork && current.opts.goalBridge === opts.goalBridge && current.sessionId === (opts.sessionId || null)
      && current.opts.workspaceId === opts.workspaceId && ['cwd', 'model', 'permissionMode', 'thinkingBudget', 'connection', 'proxyUrl', 'contextWindow', 'subscriptionId', 'serviceTier'].every(key => current.settings[key] === selected[key])) return current;
    const runtime = runtimes().locate('codex');
    if (!runtime) throw new Error('Download Codex CLI in Settings → Engine Settings first');
    const launch = discussion ? buildDiscussionSpec(discussion, runtime, selected)
      : spec(selected.connection, runtime, selected.cwd, selected.model, opts.conversationId, selected.subscriptionId);
    const previousClosed = current?.shutdown();
    const next = new CodexSession({ gen: ++generation, settings: selected, opts, spec: launch, spawn: discussion?.spawn || spawn, log, history: discussion ? discussionHistory : history,
      usageMeter: createUsageMeter('codex', { settings: selected }),
      onEvent: event => { if (sessions.get(opts) === next) onEvent({ ...event, conversationId: opts.conversationId }); },
      onSessionId: id => {
        saveConfig({ codexSessionConnections: { ...connections(), [id]: selected.connection },
          ...(!opts.conversationId ? { codexSessionFastModes: { ...loadConfig().codexSessionFastModes, [id]: selected.fastMode === true } } : {}),
          // A new session starts from the connection the last one actually
          // used, so the settings page does not need a global selector.
          ...(!discussion ? { codex: { ...loadConfig().codex, connection: selected.connection } } : {}),
          ...(selected.connection === 'subscription' && selected.subscriptionId ? { codexSessionAccounts: { ...accountBindings(), [id]: selected.subscriptionId } } : {}) });
        if (!discussion) workspaces.recordContext(id, opts.workspaceId, selected.cwd); if (!opts.conversationId) goal.rememberSession(next);
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
    'account-state': async payload => {
      const id = payload?.id || activeId(), entry = accountEntry(id);
      // Older Camellia caches omitted tier capabilities. Refresh them once so
      // an existing sign-in can expose the toggle without signing in again.
      if (entry.state.account && entry.state.models?.some(model => !Array.isArray(model.serviceTiers))) {
        try { await refreshAccount(id); } catch (error) { log('Codex model capabilities: ' + error.message); }
      }
      return { ok: true, ...accountState(id) };
    },
    'account-refresh': async payload => {
      const id = payload?.id || activeId();
      if (!accountList().some(account => account.id === id)) throw new Error('Unknown Codex account');
      await refreshAccount(id); return { ok: true, ...accountState() };
    },
    'account-reset-preview': async payload => {
      const preview = await resetService(payload).preview();
      return { ok: true, ...accountState(), preview };
    },
    'account-reset-consume': async payload => {
      const result = await resetService(payload).consume(payload);
      return { ok: true, ...accountState(), ...result };
    },
    'account-wake': async payload => {
      const id = String(payload?.id || '');
      if (!accountList().some(account => account.id === id)) throw new Error('Unknown Codex account');
      if (wakingAccounts.has(id)) throw new Error('This account is already waking');
      const entry = accountEntry(id);
      if (!entry.state.account || entry.loginId) throw new Error('Sign in to this account first');
      const runtime = runtimes().locate('codex');
      if (!runtime) throw new Error('Download Codex CLI in Settings → Engine Settings first');
      const model = (entry.state.models || []).find(model => model.isDefault)?.id || entry.state.models?.[0]?.id;
      if (!model) throw new Error('Refresh the account to load its models first');
      wakingAccounts.add(id);
      let wakeClient;
      try {
        const cwd = path.join(home, 'wake'); fs.mkdirSync(cwd, { recursive: true });
        await require('./codex-wake').wakeAccount({ cwd, model,
          usageMeter: createUsageMeter('codex', { settings: { connection: 'subscription', subscriptionId: id, model } }),
          createClient: callbacks => {
            wakeClient = new CodexClient({ ...spec('subscription', runtime, cwd, model, undefined, id), ...callbacks, log });
            wakeClients.add(wakeClient); return wakeClient;
          } });
        let warning;
        try { await refreshAccount(id); } catch { warning = 'Greeting sent. Quota refresh failed; refresh it again later.'; }
        return { ok: true, ...accountState(), wakeSent: true, warning };
      } finally { wakingAccounts.delete(id); wakeClients.delete(wakeClient); }
    },
    'account-select': payload => {
      const id = String(payload?.id || '');
      if (!accountList().some(account => account.id === id)) throw new Error('Unknown Codex account');
      saveAccountConfig({ activeId: id }); onAccount(accountState());
      return { ok: true, ...accountState() };
    },
    'account-add': async payload => {
      if (pendingAccount) return { ok: true, ...accountState() };
      const accounts = accountList();
      if (accounts.length >= accountOptions.MAX_ACCOUNTS) throw new Error('Too many accounts for this provider');
      // New accounts have their own home and login client; existing replies
      // can keep running with the credentials their sessions are bound to.
      const id = 'account-' + require('node:crypto').randomUUID().slice(0, 20);
      pendingAccount = { id, label: accountOptions.normalizeLabel(payload?.label) };
      onAccount(accountState());
      try {
        await runtimes().ensure('codex');
        const value = accountEntry(id), client = await getAccountClient(id);
        const result = await client.request('account/login/start', { type: 'chatgpt' });
        value.loginId = result.loginId;
        await openExternal(result.authUrl);
        onAccount(accountState());
        return { ok: true, ...accountState() };
      } catch (error) {
        await discardDraft(id).catch(cleanup => log(cleanup.message));
        onAccount(accountState());
        throw error;
      }
    },
    'account-remove': async payload => {
      const id = String(payload?.id || '');
      if (accountEntries.get(id)?.resetCredits?.busy) throw new Error('Wait for the reset request to finish');
      if (wakingAccounts.has(id)) throw new Error('Wait for the account wake request to finish');
      const accounts = accountList();
      if (!accounts.some(account => account.id === id)) throw new Error('Unknown Codex account');
      if (sessions.running || goal.armed || isBusy()) throw new Error('Stop the Codex response or goal before removing an account');
      const value = accountEntry(id);
      value.removing = true;
      await sessions.shutdown();
      if (value.loginId) { try { await value.client?.request('account/login/cancel', { loginId: value.loginId }); } catch { /* already gone */ } }
      value.loginId = null;
      if (value.client) { try { await value.client.request('account/logout', {}); } catch { /* no live session */ } await value.client.shutdown(); value.client = null; }
      if (id === accountOptions.DEFAULT_ACCOUNT_ID) {
        // The default account keeps its home so the legacy sign-in slot survives.
        value.removing = false;
        value.resetCredits?.invalidate();
        publishAccount(id, { account: null, models: [], rateLimits: null, rateLimitResetCredits: null, error: null });
      } else {
        const dir = accountHome(id);
        try {
          if (path.resolve(dir).startsWith(path.resolve(path.join(dataDir, 'subscription-accounts')) + path.sep)) {
            await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
          }
        } catch (error) { value.removing = false; throw error; }
        accountEntries.delete(id);
        saveAccountConfig({ accounts: accounts.filter(account => account.id !== id), activeId: activeId() === id ? accountOptions.DEFAULT_ACCOUNT_ID : activeId() });
      }
      onAccount(accountState());
      return { ok: true, ...accountState() };
    },
    'account-label': payload => {
      const id = String(payload?.id || ''), label = String(payload?.label || '');
      const accounts = accountList();
      if (!accounts.some(account => account.id === id)) throw new Error('Unknown Codex account');
      saveAccountConfig({ accounts: accounts.map(account => account.id === id ? { ...account, label } : account) });
      onAccount(accountState());
      return { ok: true, ...accountState() };
    },
    'sign-in': async () => {
      if ([...accountEntries.values()].some(entry => entry.resetCredits?.busy)) throw new Error('Wait for the reset request to finish');
      if (wakingAccounts.size) throw new Error('Wait for the account wake request to finish');
      if (sessions.running || isBusy()) throw new Error('Stop the Codex response before changing accounts');
      await runtimes().ensure('codex');
      const value = accountEntry();
      value.resetCredits?.invalidate();
      const client = await getAccountClient(value.id);
      if (value.loginId) await client.request('account/login/cancel', { loginId: value.loginId });
      const result = await client.request('account/login/start', { type: 'chatgpt' });
      value.loginId = result.loginId;
      await openExternal(result.authUrl); onAccount(accountState());
      return { ok: true, ...accountState() };
    },
    'cancel-login': async () => {
      const value = accountEntry(pendingAccount?.id || activeId());
      if (value.loginId) await (await getAccountClient(value.id)).request('account/login/cancel', { loginId: value.loginId });
      value.loginId = null;
      if (pendingAccount?.id === value.id) await discardDraft(value.id);
      onAccount(accountState()); return { ok: true, ...accountState() };
    },
    'sign-out': async () => {
      if ([...accountEntries.values()].some(entry => entry.resetCredits?.busy)) throw new Error('Wait for the reset request to finish');
      if (wakingAccounts.size) throw new Error('Wait for the account wake request to finish');
      if (sessions.running || goal.armed || isBusy()) throw new Error('Stop the Codex response or goal before signing out');
      const value = accountEntry();
      await sessions.shutdown();
      await (await getAccountClient(value.id)).request('account/logout', {}); value.loginId = null;
      value.resetCredits?.invalidate();
      publishAccount(value.id, { account: null, models: [], rateLimits: null, rateLimitResetCredits: null, error: null }); return { ok: true, ...accountState() };
    },
    'send': async payload => {
      if (sessions.legacy?.running) throw new Error('Wait for the response to finish or stop it before sending another message');
      const sessionId = payload.sessionId || null;
      const current = ensureSession({ sessionId, workspaceId: payload.workspaceId || null, fork: Boolean(payload.fork),
        ...(!sessionId && typeof payload.fastMode === 'boolean' ? { settings: { fastMode: payload.fastMode } } : {}) });
      return { ok: current.sendUserMessage(String(payload.prompt || ''), payload.attachments || []), runId: current.gen };
    },
    'cancel': runId => { if (sessions.legacy?.gen === runId) { if (goal.armed) goal.setPhase('paused'); sessions.legacy.interrupt(); } return { ok: true }; },
    'control-respond': payload => ({ ok: Boolean(sessions.legacy && !sessions.legacy.dead && sessions.legacy.answerPermission(payload.requestId, Boolean(payload.allow), payload.input, payload.message, payload.optionId)) }),
    'goal-get': () => ({ ok: true, goal: goal.view() }), 'goal-start': payload => goal.start(payload),
    'goal-pause': () => goal.setPhase('paused'), 'goal-resume': () => goal.resume(),
    'goal-complete': () => goal.setPhase('complete'), 'goal-clear': () => goal.clear(),
  };
  return { get session() { return sessions.legacy; },
    get active() { return Boolean(sessions.active || [...accountEntries.values()].some(entry => entry.client && !entry.client.dead)); },
    home, goal, settings, saveSettings, handlers, ensureSession, history, sessions, workspaces, accountState,
    async shutdown() {
      await Promise.allSettled([...wakeClients].map(client => client.shutdown()));
      await sessions.shutdown();
      await Promise.allSettled([...accountEntries.values()].map(entry => entry.client?.shutdown()));
      for (const entry of accountEntries.values()) { entry.client = null; entry.loginId = null; }
    } };
}
module.exports = { createCodex };
