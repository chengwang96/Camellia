'use strict';
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { spawn } = require('node:child_process');
const { SessionPool } = require('./session-pool');
const { AcpSession } = require('./acp-session');
const { ClaudeHistory } = require('./claude-history');
const { writeText } = require('../shared/json-store');
const { modelId } = require('../api/api-router-config');
// Match the pinned DSH provider default. 8K can truncate a reasoning-only reply
// before the model emits code or a tool call, ending the native turn early.
const DSH_MAX_OUTPUT_TOKENS = 32768;

function dshAcpSpec({ runtime, home, model, route, permissionMode, env }) {
  fs.mkdirSync(home, { recursive: true });
  writeText(path.join(home, 'settings.yaml'), YAML.stringify({
    'agent-default-model': { provider: 'api-pool', model },
    permission: { defaultPreset: permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write' },
    'llm-pi-ai': { providers: { 'api-pool': { displayName: 'Camellia API', apiKeyEnv: 'DSH_API_ROUTER_KEY',
      api: 'anthropic-messages', baseURL: route.baseUrl, defaultContextWindow: 65536, defaultMaxTokens: DSH_MAX_OUTPUT_TOKENS, models: [{ id: model }] } } },
  }));
  return { args: [runtime.file, '--profile', 'acp'], env: { ...env, DSH_HOME: home, DSH_API_ROUTER_KEY: 'proxy-managed' },
    noModes: true, modelValue: JSON.stringify(['api-pool', model]), thinkingId: 'reasoning_effort' };
}
function createDshChat({ dataDir, loadConfig, saveConfig, getRoute, getModels, runtime, node, environment, onEvent, log }) {
  const sessions = new SessionPool();
  let generation = 0;
  const history = new ClaudeHistory(path.join(dataDir, 'dsh-chat-history'));
  const settings = () => ({ permissionMode: 'default', model: '', ...loadConfig().dshChat });
  function saveSettings(patch) {
    const value = settings();
    for (const key of ['model', 'permissionMode', 'thinkingBudget']) if (patch[key] !== undefined) value[key] = String(patch[key]);
    if (!['default', 'bypassPermissions'].includes(value.permissionMode)) throw new Error('Invalid DSH permission mode');
    saveConfig({ dshChat: value }); return value;
  }
  function ensure(opts) {
    const current = sessions.get(opts);
    const selected = { ...settings(), ...opts.settings, cwd: opts.cwd };
    selected.model = modelId(selected.model);
    if (!selected.model || !getModels().includes(selected.model)) throw new Error('Select a configured model first');
    if (current && !current.dead && current.sessionId === opts.sessionId && JSON.stringify(current.settings) === JSON.stringify(selected)) return current;
    const spec = dshAcpSpec({ runtime: runtime(), home: path.join(dataDir, 'dsh-chat', ...(opts.conversationId ? ['conversations', opts.conversationId] : [])), model: selected.model,
      route: getRoute(), permissionMode: selected.permissionMode, env: environment() });
    const previous = current?.shutdown();
    const session = new AcpSession({ name: 'DSH', gen: ++generation, opts, settings: selected, spec, exe: node(), spawn, log, history,
      onEvent: event => { if (sessions.get(opts) === session) onEvent({ ...event, conversationId: opts.conversationId }); }, onSessionId: () => {}, onResult: () => {} });
    sessions.set(opts, session); session.start(previous); return session;
  }
  return { history, settings, saveSettings, ensure, sessions, get session() { return sessions.legacy; }, shutdown: () => sessions.shutdown() };
}
module.exports = { dshAcpSpec, createDshChat, DSH_MAX_OUTPUT_TOKENS };
