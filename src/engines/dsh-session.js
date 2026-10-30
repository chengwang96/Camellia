'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SessionPool } = require('./session-pool');
const { AcpSession } = require('./acp-session');
const { ClaudeHistory } = require('./claude-history');
const { dshLaunchArgs } = require('./dsh-config');
const { modelId } = require('../api/api-router-config');
const { valid, nativeMode } = require('./permission-levels');
const { levelsFor } = require('../shared/model-levels');
const YAML = require('yaml');
const { writeText } = require('../shared/json-store');
const { prepareDshHistory } = require('./dsh-native-history');
const { matchesPrompt, nativeEditOptions } = require('./native-edit-boundary');
const { validSessionId } = require('./claude-history');
const { copyDshFork } = require('./native-fork');

class DshSession extends AcpSession {
  async editBoundary(prompt) {
    if (!this.spec.nativeHistory) return null;
    await (this.ready ||= this.open());
    const boundary = await this.request('session/camellia_history_boundary', { sessionId: this.sessionId });
    return matchesPrompt(boundary.text, prompt) ? nativeEditOptions('dsh', boundary) : null;
  }
}
// Match the pinned DSH provider default. 8K can truncate a reasoning-only reply
// before the model emits code or a tool call, ending the native turn early.
const DSH_MAX_OUTPUT_TOKENS = 32768;
// The three universal levels as DSH permission presets (sandbox × approval).
const DSH_PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask', name: 'read-only',
    description: 'Reads run directly; every change asks for confirmation.' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'workspace-write',
    description: 'Write inside the workspace; wider access asks for confirmation.' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'danger-full-access',
    description: 'Full access without confirmation prompts.' },
};

function dshAcpSpec({ runtime, home, model, route, permissionMode, env, nativeConfig = {}, thinking, webTools = false }) {
  const levels = levelsFor(model, { thinking });
  const supported = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const reasoningEfforts = Object.fromEntries(levels.map(level => [level === 'none' ? 'off' : level, level]).filter(([level]) => supported.includes(level)));
  const canThink = Object.keys(reasoningEfforts).some(level => level !== 'off');
  const args = dshLaunchArgs({ runtime, home, profile: 'acp', config: {
    ...nativeConfig,
    ...(webTools ? { 'tool-web': { ...nativeConfig['tool-web'], search: false, fetch: false } } : {}),
    'agent-default-model': { provider: 'api-pool', model },
    permission: { presets: DSH_PRESETS, defaultPreset: nativeMode('dsh', permissionMode, 'auto') },
    'llm-pi-ai': { providers: { 'api-pool': { displayName: 'Camellia API', apiKeyEnv: 'DSH_API_ROUTER_KEY',
      api: 'anthropic-messages', baseURL: route.baseUrl, defaultContextWindow: 65536, defaultMaxTokens: DSH_MAX_OUTPUT_TOKENS,
      models: [{ id: model, reasoningEfforts: canThink ? reasoningEfforts : false }] } } },
  } });
  const childEvents = /^(?:0\.[2-9]|[1-9]\.)/.test(String(runtime.version || ''));
  if (childEvents) {
    const file = path.join(home, 'camellia-subagents.patch.yml');
    writeText(file, YAML.stringify([{ insert: [{ id: 'camellia-subagents',
      name: path.join(__dirname, 'dsh-subagents.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
      inject: ['agents', 'subagents'],
    }] }]));
    args.push('--patch', file);
  }
  const nativeHistory = prepareDshHistory(runtime);
  if (nativeHistory) {
    const file = path.join(home, 'camellia-history.patch.yml');
    writeText(file, YAML.stringify([{ id: 'acp', disabled: true }, { insert: [{ id: 'camellia-acp', name: nativeHistory,
      inject: ['acpAppStartup'], config: { provider: 'api-pool', model } }] }]));
    args.push('--patch', file);
  }
  return { args, env: { ...env, DSH_HOME: home, DSH_API_ROUTER_KEY: 'proxy-managed' },
    modeEngine: 'dsh', nativeSubagentEvents: childEvents, nativeHistory: Boolean(nativeHistory),
    noModes: true, modelValue: JSON.stringify(['api-pool', model]), thinkingId: 'reasoning_effort', applyThinking: canThink };
}
function createDshChat({ dataDir, loadConfig, saveConfig, getRoute, getModels, getModelThinking = () => undefined, runtime, node, environment, onEvent, log, nativeConfig = () => ({}), nativeRevision = () => '' }) {
  const sessions = new SessionPool();
  let generation = 0;
  const history = new ClaudeHistory(path.join(dataDir, 'dsh-chat-history'));
  const settings = () => ({ permissionMode: 'default', model: '', ...loadConfig().dshChat });
  function saveSettings(patch) {
    const value = settings();
    for (const key of ['model', 'permissionMode', 'thinkingBudget']) if (patch[key] !== undefined) value[key] = String(patch[key]);
    if (!valid('dsh', value.permissionMode)) throw new Error('Invalid DSH permission mode');
    saveConfig({ dshChat: value }); return value;
  }
  function ensure(opts) {
    sessions.assertAccess(opts);
    const current = sessions.get(opts);
    const selected = { ...settings(), ...opts.settings, cwd: opts.cwd, nativeRevision: nativeRevision() };
    selected.model = modelId(selected.model);
    selected.modelThinking = getModelThinking(selected.model);
    if (!selected.model || !getModels().includes(selected.model)) throw new Error('Select a configured model first');
    if (current && !current.dead && !opts.fork && current.opts.goalBridge === opts.goalBridge && current.sessionId === opts.sessionId && JSON.stringify(current.settings) === JSON.stringify(selected)) return current;
    const spec = dshAcpSpec({ runtime: runtime(), home: path.join(dataDir, 'dsh-chat', ...(opts.conversationId ? ['conversations', opts.conversationId] : [])), model: selected.model,
      route: getRoute(), permissionMode: selected.permissionMode, env: environment(), nativeConfig: nativeConfig(), thinking: selected.modelThinking, webTools: opts.goalBridge?.webTools });
    if (selected.thinkingBudget === 'none') spec.thinkingValue = 'off';
    const previous = current?.shutdown();
    const session = new DshSession({ name: 'DSH', gen: ++generation, opts, settings: selected, spec, exe: node(), spawn, log, history,
      onEvent: event => { if (sessions.get(opts) === session) onEvent({ ...event, conversationId: opts.conversationId }); }, onSessionId: () => {}, onResult: () => {} });
    sessions.set(opts, session); session.start(previous); return session;
  }
  const forkNative = options => forkDshNative({ ...options, ensureSource: ensure,
    targetHome: path.join(dataDir, 'dsh-chat', 'conversations', options.conversationId) });
  return { history, settings, saveSettings, ensure, sessions, forkNative, nativeEditing: () => Boolean(prepareDshHistory(runtime())),
    nativeAutoCompaction: true, get session() { return sessions.legacy; }, shutdown: () => sessions.shutdown() };
}

async function forkDshNative({ ensureSource, sourceSession, targetHome, sessionId, sourceConversationId, cwd, settings, boundary, goalBridge, sourceGoalBridge, registerSession }) {
  // Next-turn settings may change while the source is generating. Its captured
  // connection owns the native run; applying the child's settings to it could
  // shut down that run. Configure only the child when it later resumes.
  if (sourceSession && (sourceSession.dead || sourceSession.sessionId !== sessionId))
    throw new Error('The captured DSH fork source is no longer available');
  const source = sourceSession || ensureSource({ sessionId, conversationId: sourceConversationId, cwd, settings, goalBridge: sourceGoalBridge });
  if (!source.spec.nativeHistory) return null;
  await (source.ready ||= source.open());
  let nativeId, cancelled = false, closed = false;
  const close = async () => {
    if (nativeId && !closed) { await source.request('session/close', { sessionId: nativeId }); closed = true; }
  };
  registerSession({ kill() { cancelled = true; return close().catch(() => {}); } });
  try {
    const bridge = goalBridge?.config;
    const mcpServers = bridge ? [{ name: 'camellia_goals', command: bridge.command, args: bridge.args,
      env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })) }] : [];
    const result = await source.request('session/camellia_fork', { sessionId, cwd, mcpServers, ...boundary });
    nativeId = result.sessionId;
    if (!validSessionId(nativeId) || nativeId === sessionId) throw new Error('DSH did not create an independent native fork');
    await close();
    if (cancelled) throw new Error('Fork canceled');
    await copyDshFork(source.spec.env.DSH_HOME, targetHome, nativeId);
    return { nativeId };
  } finally { await close().catch(() => {}); }
}
module.exports = { dshAcpSpec, createDshChat, DshSession, forkDshNative, DSH_MAX_OUTPUT_TOKENS };
