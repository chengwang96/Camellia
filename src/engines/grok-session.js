'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const TOML = require('smol-toml');
const { AcpSession } = require('./acp-session');
const { SessionPool } = require('./session-pool');
const { ClaudeHistory, validSessionId } = require('./claude-history');
const { modelId } = require('../api/api-router-config');
const { downloadSettings } = require('../main/download-network');
const { valid, nativeMode } = require('./permission-levels');
const { readJson, writeText } = require('../shared/json-store');
const { grokEditBoundary, grokUpdatesFile } = require('./native-edit-boundary');
const { copyGrokFork } = require('./native-fork');

// Allow the native CLI's cold Windows startup before its ACP server is ready.
const GROK_STARTUP_TIMEOUT_MS = 60000;

function grokEnvironment(home, inherited = process.env, proxyUrl, { subscription = false } = {}) {
  const env = { ...inherited, GROK_HOME: home };
  for (const key of Object.keys(env)) if (/^(XAI_API_KEY|GROK_CODE_XAI_API_KEY|GROK_OIDC_|GROK_AUTH_)/i.test(key)) delete env[key];
  if (env.CAMELLIA_NETWORK_MODE !== undefined) {
    if (subscription) Object.assign(env, require('../main/network-settings').subscriptionEnvironment(env));
  } else if (proxyUrl !== undefined) {
    const network = downloadSettings({ mode: proxyUrl ? 'proxy' : 'direct', url: proxyUrl });
    for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
    Object.assign(env, { HTTP_PROXY: network.url, HTTPS_PROXY: network.url,
      NO_PROXY: network.mode === 'proxy' ? 'localhost,127.0.0.1,::1' : '*' });
  }
  return env;
}

function nativeConfig(home) {
  const file = path.join(home, 'config.toml');
  return fs.existsSync(file) ? TOML.parse(fs.readFileSync(file, 'utf8')) : {};
}

function grokSpawnSpec({ runtime, home, model, connection = 'api', route, contextWindow, env = process.env, config = {}, proxyUrl = '', instructions = '', reasoningEffort = '' }) {
  fs.mkdirSync(home, { recursive: true });
  if (process.platform === 'win32') home = fs.realpathSync.native(home);
  const merged = { ...nativeConfig(home), ...config };
  if (connection !== 'subscription') {
    merged.models = { ...merged.models, default: 'camellia', session_summary: 'camellia' };
    merged.model = { ...merged.model, camellia: {
      model: modelId(model), base_url: route.baseUrl.replace(/\/$/, '') + '/v1', name: 'Camellia API',
      env_key: 'CAMELLIA_API_KEY', api_backend: 'messages', context_window: Number(contextWindow) || 131072, vision: true,
    } };
  }
  writeText(path.join(home, 'config.toml'), TOML.stringify(merged));
  const environment = { ...grokEnvironment(home, env, proxyUrl, { subscription: connection === 'subscription' }), CAMELLIA_API_KEY: route?.authToken || 'proxy-managed' };
  const args = ['--model', connection === 'subscription' ? model : 'camellia'];
  if (instructions) args.push('--rules', instructions);
  if (reasoningEffort) args.push('--reasoning-effort', reasoningEffort);
  args.push('--no-auto-update', 'agent', 'stdio');
  return { args, env: environment,
    modeEngine: 'grok', modelValue: connection === 'subscription' ? model : 'camellia', authMethod: connection === 'subscription' ? 'cached_token' : '' };
}

class GrokSession extends AcpSession {
  async editBoundary(prompt) {
    await (this.ready ||= this.open());
    return grokEditBoundary(grokUpdatesFile(this.spec.env.GROK_HOME, this.sessionId), prompt);
  }

  emit(event) {
    if (event.type === 'gui:subagent') for (const oldId of event.replacesIds || []) {
      const id = event.task.id;
      for (const [sessionId, childId] of this.childSessions || []) if (childId === oldId) this.childSessions.set(sessionId, id);
      if (this.childText?.has(oldId)) {
        if (!this.childText.has(id)) this.childText.set(id, this.childText.get(oldId));
        this.childText.delete(oldId);
      }
    }
    return super.emit(event);
  }

  receive(message) {
    const params = message.params, update = params?.update;
    if (message.method === '_x.ai/session_notification' && update?.sessionUpdate === 'subagent_spawned'
        && (params.sessionId === this.sessionId || this.childSessions?.has(params.sessionId))) {
      this.childSessions ||= new Map(); this.childText ||= new Map();
      const task = this.subagents.attach(update.subagent_id, { title: update.description || update.subagent_type,
        parentId: this.childSessions.get(params.sessionId) || this.sessionId, turnId: update.attempt_id,
        status: 'running', canStop: false, canReply: false, progress: '', result: '', approvals: [] });
      if (task) this.childSessions.set(update.child_session_id || update.subagent_id, task.id);
      return;
    }
    const resolved = this.subagents.resolve(params?.sessionId);
    const id = this.childSessions?.get(params?.sessionId) || (params?.sessionId !== this.sessionId && this.children.has(resolved) ? resolved : undefined);
    if (id) {
      this.childText ||= new Map();
      if (message.method === 'session/request_permission') {
        return super.receive({ ...message, params: { ...params, sessionId: this.sessionId,
          _meta: { ...params._meta, camelliaSubagentId: id } } });
      }
      if (message.method === 'session/update') {
        const task = this.children.get(id);
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          const value = ((this.childText.get(id) || '') + update.content.text).slice(-16000);
          this.childText.set(id, value); this.subagents.update(id, { progress: value });
        } else if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
          const text = update.content?.map(part => part.content?.text || '').join('\n') || update.title || '';
          if (text) this.subagents.update(id, { progress: text, history: [
            ...(task.history || []), { type: update.sessionUpdate, text },
          ] });
        }
        return;
      }
      if (message.method === '_x.ai/session_notification') {
        if (update.sessionUpdate === 'response_started') {
          this.childText.set(id, ''); this.subagents.update(id, { status: 'running' });
        }
        if (update.sessionUpdate === 'turn_completed') this.subagents.update(id, {
          status: update.stop_reason === 'cancelled' ? 'stopped' : update.stop_reason === 'end_turn' ? 'completed' : 'failed',
          result: this.childText.get(id) || '', canStop: false,
        });
        return;
      }
    }
    return super.receive(message);
  }
  async open() {
    await this.starting;
    const initResult = await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Camellia', version: '1.0.1' } }, GROK_STARTUP_TIMEOUT_MS);
    this.promptCapabilities = initResult?.agentCapabilities?.promptCapabilities || {};
    if (this.spec.authMethod) await this.request('authenticate', { methodId: this.spec.authMethod, _meta: { headless: true } });
    const sourceId = this.opts.sessionId;
    const method = sourceId ? this.opts.fork ? '_x.ai/session/fork' : 'session/load' : 'session/new';
    const bridge = this.opts.goalBridge?.config;
    const mcpServers = bridge ? [{ name: 'camellia_goals', command: bridge.command, args: bridge.args, env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })) }] : [];
    const mode = nativeMode('grok', this.spec.modeValue || this.settings.permissionMode || 'default');
    const meta = mode === 'bypassPermissions' ? { yoloMode: true } : mode === 'auto' ? { autoMode: true } : {};
    const sourceBridge = this.opts.sourceGoalBridge?.config;
    const sourceServers = this.opts.sourceGoalBridge === undefined ? mcpServers : sourceBridge
      ? [{ name: 'camellia_goals', command: sourceBridge.command, args: sourceBridge.args, env: Object.entries(sourceBridge.env).map(([name, value]) => ({ name, value })) }] : [];
    if (this.opts.fork) await this.request('session/load', { sessionId: sourceId, cwd: this.cwd, mcpServers: sourceServers });
    const raw = await this.request(method, { ...(sourceId ? this.opts.fork ? { sourceSessionId: sourceId, sourceCwd: this.cwd, newCwd: this.cwd,
      ...(this.opts.targetPromptIndex === undefined ? {} : { targetPromptIndex: this.opts.targetPromptIndex }) } : { sessionId: sourceId } : {}),
      cwd: this.cwd, mcpServers, ...(Object.keys(meta).length ? { _meta: meta } : {}) });
    const result = raw?.result && typeof raw.result === 'object' ? raw.result : raw;
    this.sessionId = result.newSessionId || result.sessionId || sourceId;
    if (!validSessionId(this.sessionId)) throw new Error('Grok returned an invalid session ID');
    if (this.opts.fork) {
      await this.request('session/load', { sessionId: this.sessionId, cwd: this.cwd, mcpServers });
      const source = this.history.find(sourceId);
      if (source && this.opts.targetPromptIndex === undefined) fs.copyFileSync(source, this.historyFile());
    }
    let config = this.settings.model ? await this.request('session/set_model', { sessionId: this.sessionId,
      modelId: this.spec.modelValue || this.settings.model }) : result;
    if (this.settings.thinkingBudget) config = await this.request('session/set_config_option', {
      sessionId: this.sessionId, configId: 'reasoning_effort', value: this.settings.thinkingBudget });
    if (this.settings.permissionMode) await this.request('session/set_mode', { sessionId: this.sessionId, modeId: mode });
    this.onSessionId(this.sessionId);
    this.emit({ type: 'gui:config', options: config.configOptions || result.configOptions || [] });
  }
}

function grokConnectionSettings(config, sessionId) {
  const saved = config.grok || {};
  const connection = sessionId ? config.grokSessionConnections?.[sessionId] || 'api' : saved.connection || 'api';
  const value = { permissionMode: 'ask', thinkingBudget: '', cwd: '', contextWindow: 131072, proxyUrl: '', ...saved,
    connection, apiModel: saved.apiModel ?? saved.model ?? '',
    model: connection === 'subscription' ? saved.subscriptionModel || '' : saved.apiModel ?? saved.model ?? '' };
  const account = sessionId ? config.grokSessionAccounts?.[sessionId] : null;
  if (account && connection === 'subscription') value.subscriptionId = account;
  return value;
}

function updateGrokConnectionSettings(config, patch) {
  const value = grokConnectionSettings(config);
  if (patch.connection !== undefined) {
    if (!['api', 'subscription'].includes(patch.connection)) throw new Error('Invalid Grok connection');
    value.connection = patch.connection;
  }
  for (const key of ['cwd', 'permissionMode', 'thinkingBudget', 'proxyUrl']) if (patch[key] !== undefined) value[key] = String(patch[key]).trim();
  if (!valid('grok', value.permissionMode)) throw new Error('Invalid Grok permission mode');
  if (patch.contextWindow !== undefined) value.contextWindow = Number(patch.contextWindow);
  if (!Number.isInteger(value.contextWindow) || value.contextWindow < 4096 || value.contextWindow > 2000000) throw new Error('Context window must be an integer between 4096 and 2000000');
  if (patch.model !== undefined) {
    const connection = patch.connection || (patch.sessionId ? grokConnectionSettings(config, patch.sessionId).connection : value.connection);
    value[connection + 'Model'] = String(patch.model).trim();
  }
  delete value.model; delete value.sessionId; delete value.subscriptionId;
  return value;
}

function createGrokChat({ dataDir, loadConfig, saveConfig, getRoute, getModels, getContextWindow = () => undefined,
  runtimes, environment = () => process.env, accounts, onEvent, log = () => {}, nativeConfig = () => ({}), nativeRevision = () => '', nativeInstructions = () => '', createUsageMeter = () => null }) {
  const home = path.join(dataDir, 'grok');
  const sessions = new SessionPool();
  const history = new ClaudeHistory(path.join(dataDir, 'grok-history'));
  let generation = 0;
  const settings = id => grokConnectionSettings(loadConfig(), id);
  function saveSettings(patch) {
    saveConfig({ grok: updateGrokConnectionSettings(loadConfig(), patch) });
    return settings(patch.sessionId);
  }
  function ensure(opts) {
    sessions.assertAccess(opts);
    const selected = { ...settings(opts.sessionId), ...opts.settings, cwd: opts.cwd, nativeRevision: nativeRevision() };
    if (!['ask', 'auto', 'full', 'plan'].includes(selected.permissionMode)) throw new Error('Invalid Grok permission mode');
    const current = sessions.get(opts);
    if (current && !current.dead && !opts.fork && current.opts.goalBridge === opts.goalBridge && current.sessionId === (opts.sessionId || null)
      && JSON.stringify(current.settings) === JSON.stringify(selected)) return current;
    if (opts.sessionId && !validSessionId(opts.sessionId)) throw new Error('Invalid Grok session ID');
    const runtime = runtimes().locate('grok');
    if (!runtime) throw new Error('Download Grok Build in Settings → Engine Settings first');
    let sessionHome, route = null;
    if (selected.connection === 'subscription') {
      const accountId = opts.conversationId && selected.subscriptionId || accounts.bind(opts.sessionId);
      selected.subscriptionId = accountId;
      sessionHome = accounts.home(accountId);
      const account = accounts.state(accountId);
      if (account.loginPending || account.refreshing || account.signingOut) throw new Error('Wait for the Grok account operation to finish');
      if (!account.account) throw new Error('Sign in with Grok in Settings → Subscription accounts first');
      if (!account.models.some(model => model.id === selected.model)) throw new Error('Refresh the Grok account and select an available model');
    } else {
      selected.model = modelId(selected.model);
      if (!selected.model || !getModels().includes(selected.model)) throw new Error('Select a configured API model first');
      route = getRoute();
      selected.contextWindow = getContextWindow(selected.model) || selected.contextWindow;
      const storageId = opts.forkSourceConversationId || opts.conversationId;
      sessionHome = path.join(home, 'api', ...(storageId ? ['conversations', storageId] : ['standalone']));
    }
    const spec = grokSpawnSpec({ runtime: runtime.file, home: sessionHome, model: selected.model, connection: selected.connection,
      route, contextWindow: selected.contextWindow, env: environment(), config: nativeConfig(), proxyUrl: selected.proxyUrl,
      instructions: nativeInstructions(), reasoningEffort: selected.thinkingBudget });
    spec.modeValue = selected.permissionMode;
    const previous = current?.shutdown();
    const session = new GrokSession({ name: 'Grok', gen: ++generation, settings: selected, opts, spec, exe: runtime.file, spawn, history, log,
      usageMeter: createUsageMeter('grok', { settings: selected, home: sessionHome, version: runtime.version }),
      onEvent: event => { if (sessions.get(opts) === session) onEvent({ ...event, conversationId: opts.conversationId }); },
      onSessionId: id => saveConfig({ grokSessionConnections: { ...loadConfig().grokSessionConnections, [id]: selected.connection } }), onResult: () => {} });
    sessions.set(opts, session); session.start(previous); return session;
  }
  async function forkNative({ sessionId, sourceConversationId, conversationId, cwd, settings, goalBridge, sourceGoalBridge, boundary, registerSession }) {
    const session = ensure({ sessionId, conversationId, cwd, settings, goalBridge, sourceGoalBridge,
      fork: true, forkSourceConversationId: sourceConversationId, ...boundary });
    registerSession(session);
    try {
      await (session.ready ||= session.open());
      const nativeId = session.sessionId;
      if (nativeId === sessionId) throw new Error('Grok did not create an independent native fork');
      await session.shutdown();
      const sourceHome = session.spec.env.GROK_HOME;
      const targetHome = settings.connection === 'subscription' ? sourceHome : path.join(home, 'api', 'conversations', conversationId);
      await copyGrokFork(grokUpdatesFile(sourceHome, nativeId), sourceHome, targetHome);
      return { nativeId };
    } finally { if (!session.dead) await session.shutdown(); }
  }
  return { home, history, settings, saveSettings, ensure, forkNative, sessions, nativeAutoCompaction: true,
    get session() { return sessions.legacy; }, shutdown: () => sessions.shutdown() };
}

module.exports = { GrokSession, createGrokChat, grokSpawnSpec, grokEnvironment, grokConnectionSettings, updateGrokConnectionSettings, nativeConfig, GROK_STARTUP_TIMEOUT_MS };
