'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AcpSession } = require('./acp-session');
const TOML = require('smol-toml');
const { writeText } = require('../shared/json-store');
const { copyKimiFork } = require('./native-fork');
const { validSessionId } = require('./claude-history');
const { prepareKimiRuntime } = require('./kimi-steer');
const { matchesPrompt, nativeEditOptions } = require('./native-edit-boundary');
const { harnessThinkingRoute } = require('../api/harness-thinking');

class KimiSession extends AcpSession {
  async steerUserMessage(prompt, attachments = []) {
    if (!this.spec.nativeSteer) throw new Error('This engine connection does not support immediate instructions. Your message has been retained.');
    if (!this.running || this.dead || this.cancelled || !this.sessionId)
      throw new Error('The active turn is not ready or has already finished. Your message was not sent.');
    const parts = [{ type: 'text', text: prompt }];
    const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    for (const attachment of attachments) {
      const mimeType = imageTypes[path.extname(attachment.path).toLowerCase()];
      if (!attachment.isImage || !mimeType) continue;
      if (this.promptCapabilities.image !== true)
        throw new Error('Kimi did not advertise inline image prompts; send this message without the image or use an engine with image input.');
      parts.push({ type: 'image', mimeType, data: fs.readFileSync(attachment.path).toString('base64') });
    }
    const result = await this.request('session/camellia_steer', { sessionId: this.sessionId, prompt: parts }, 0);
    if (!Number.isSafeInteger(result?.turnId))
      throw new Error('Kimi did not confirm the expected turn. Check the conversation before retrying.');
    this.appendHistory('user', prompt);
    return result;
  }

  async editBoundary(prompt) {
    if (!this.spec.nativeHistory || this.running) return null;
    await (this.ready ||= this.open());
    const boundary = await this.request('session/camellia_history_boundary', { sessionId: this.sessionId });
    return matchesPrompt(boundary.text, prompt) ? nativeEditOptions('kimi', boundary) : null;
  }

  async generateTitle({ prompt = '', duringTurn = false, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (!this.spec.nativeHistory || this.dead || this.running && !duringTurn) return '';
    await (this.ready ||= this.open());
    if (this.dead || !this.sessionId || this.running && !duringTurn) return '';
    const request = async visiblePrompt => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (visiblePrompt && !this.running) return '';
        const result = await this.request('session/camellia_generate_title', {
          sessionId: this.sessionId, ...(visiblePrompt ? { prompt: visiblePrompt } : {}) }, 45000);
        if (typeof result?.title === 'string' && result.title.trim()) return result.title;
        if (visiblePrompt && !this.running) return '';
        if (attempt < 2) await delay(750 * (attempt + 1));
      }
      return '';
    };
    if (duringTurn && this.running && prompt.trim()) return request(prompt);
    if (this.running) return '';
    return request('');
  }
}

const MANAGED_PROVIDER = 'managed:kimi-code';
const DIRECT_HOSTS = ['api.kimi.com', 'auth.kimi.com', 'www.kimi.com', 'kimi.com', '.kimi.com',
  'api.kimi.ai', 'auth.kimi.ai', 'www.kimi.ai', 'kimi.ai', '.kimi.ai'];
function kimiEnvironment(home, inherited = process.env) {
  const env = { ...inherited, KIMI_CODE_HOME: home, KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_REGION_MARKER: 'off' };
  // A subscription must not inherit an API route or a different OAuth server.
  for (const key of Object.keys(env)) if (/^KIMI_MODEL_|^KIMI_(API_KEY|BASE_URL|OAUTH_HOST|REGISTRY_API_KEY)$|^KIMI_CODE_(API_KEY|BASE_URL|OAUTH_HOST)$|^KIMI_WEB_(SEARCH|FETCH)_(BASE_URL|API_KEY)$/i.test(key)) delete env[key];
  if (inherited.CAMELLIA_KIMI_DIRECT === '1') {
    const current = String(env.NO_PROXY || env.no_proxy || '');
    if (current !== '*') {
      const hosts = current.split(',').map(value => value.trim()).filter(Boolean);
      for (const host of DIRECT_HOSTS) if (!hosts.includes(host)) hosts.push(host);
      delete env.no_proxy;
      env.NO_PROXY = hosts.join(',');
    }
  }
  return env;
}
function managedKimiConfig(home) {
  const file = path.join(home, 'config.toml');
  const config = fs.existsSync(file) ? TOML.parse(fs.readFileSync(file, 'utf8')) : {};
  const provider = config.providers?.[MANAGED_PROVIDER];
  if (!provider?.oauth || provider.type !== 'kimi') throw new Error('Sign in with Kimi in Settings → Engine Settings → Kimi Code first');
  const apiUrl = new URL(provider.base_url), authUrl = new URL(provider.oauth.oauth_host || provider.oauth.oauthHost || 'https://auth.kimi.com');
  if (apiUrl.protocol !== 'https:' || !['api.kimi.com', 'api.kimi.ai'].includes(apiUrl.hostname) || !/^\/coding\/?(?:v1\/?)?$/.test(apiUrl.pathname)
      || apiUrl.username || apiUrl.password || apiUrl.port || apiUrl.search || apiUrl.hash
      || authUrl.protocol !== 'https:' || !['auth.kimi.com', 'auth.kimi.ai'].includes(authUrl.hostname) || authUrl.username || authUrl.password || authUrl.port) {
    throw new Error('The Kimi subscription profile must use the official Kimi service. Sign in again.');
  }
  const models = Object.fromEntries(Object.entries(config.models || {}).filter(([, value]) => value.provider === MANAGED_PROVIDER));
  return { ...config, providers: { [MANAGED_PROVIDER]: { ...provider, api_key: '' } }, models };
}

const { valid } = require('./permission-levels');

function kimiConnectionSettings(config, sessionId) {
  const saved = config.kimi || {};
  const connection = sessionId ? config.kimiSessionConnections?.[sessionId] || 'api' : saved.connection || 'api';
  const value = { permissionMode: 'default', thinkingBudget: '', cwd: '', contextWindow: 131072, region: 'mainland-cn', ...saved,
    connection, apiModel: saved.apiModel ?? saved.model ?? '',
    model: connection === 'subscription' ? saved.subscriptionModel || '' : saved.apiModel ?? saved.model ?? '' };
  // A running subscription conversation reports the account that owns its
  // native session, so the composer lists that account's models.
  const account = sessionId ? config.kimiSessionAccounts?.[sessionId] : null;
  if (account && connection === 'subscription') value.subscriptionId = account;
  return value;
}
function updateKimiConnectionSettings(config, patch) {
  const value = kimiConnectionSettings(config);
  if (patch.connection !== undefined) {
    if (!['api', 'subscription'].includes(patch.connection)) throw new Error('Invalid Kimi connection');
    value.connection = patch.connection;
  }
  for (const key of ['cwd', 'permissionMode', 'thinkingBudget', 'region']) if (patch[key] !== undefined) value[key] = String(patch[key]).trim();
  if (!['mainland-cn', 'global'].includes(value.region)) throw new Error('Invalid Kimi login region');
  if (!valid('kimi', value.permissionMode)) throw new Error('Invalid Kimi permission mode');
  if (patch.contextWindow !== undefined) value.contextWindow = Number(patch.contextWindow);
  if (!Number.isInteger(value.contextWindow) || value.contextWindow < 4096 || value.contextWindow > 2000000) throw new Error('Context window must be an integer between 4096 and 2000000');
  if (patch.model !== undefined) {
    const connection = patch.connection || (patch.sessionId ? kimiConnectionSettings(config, patch.sessionId).connection : value.connection);
    value[connection + 'Model'] = String(patch.model).trim();
  }
  delete value.model; delete value.sessionId; delete value.subscriptionId;
  return value;
}

// API credentials stay in the router. Subscription credentials are maintained
// by the official CLI in a separate app-owned home.
function kimiSpawnSpec({ home, runtime, model, contextWindow = 131072, route, connection = 'api', sharedSubscription = false, config = {}, mcp = '', env = process.env, thinkingBudget }) {
  fs.mkdirSync(home, { recursive: true });
  if (process.platform === 'win32') home = fs.realpathSync.native(home);
  const { routeKimi } = require('./engine-settings');
  // Native tools, hooks and permissions are retained; only this session's route is pinned.
  let merged;
  if (connection === 'subscription') {
    const managed = managedKimiConfig(home);
    if (!managed.models[model]) throw new Error('This model is not available to the Kimi account. Refresh the account in settings.');
    merged = { ...config, providers: managed.providers, models: managed.models, services: managed.services || {}, default_model: sharedSubscription ? managed.default_model || Object.keys(managed.models)[0] : model, telemetry: false };
    delete merged.default_provider;
    // A secondary API model from the global CLI must not cross into this account.
    delete merged.secondary_model;
  } else merged = routeKimi({ telemetry: false, ...config, providers: {}, models: {} }, {
    route: thinkingBudget === undefined ? route : harnessThinkingRoute(route, thinkingBudget), model, contextWindow });
  writeText(path.join(home, 'config.toml'), TOML.stringify(merged));
  writeText(path.join(home, 'mcp.json'), mcp || '{"mcpServers":{}}');
  const bridge = prepareKimiRuntime(runtime);
  return { args: [bridge.file, 'acp'], env: { ...kimiEnvironment(home, env), KIMI_DISABLE_TELEMETRY: merged.telemetry ? '0' : '1' }, modeEngine: 'kimi',
    nativeHistory: bridge.nativeHistory, nativeSteer: bridge.nativeSteer,
    ...(connection !== 'subscription' && thinkingBudget !== undefined ? { applyThinking: false } : {}) };
}

async function forkKimiNative({ ensureSource, targetHome, sessionId, sourceConversationId, cwd, settings, goalBridge, sourceGoalBridge, registerSession }) {
  // Kimi holds a writer lease on a loaded session. Fork through its owning
  // connection instead of trying to restore that session in a second process.
  const session = ensureSource({ sessionId, conversationId: sourceConversationId, cwd, settings, goalBridge: sourceGoalBridge });
  await (session.ready ||= session.open());
  if (!session.agentCapabilities?.sessionCapabilities?.close || !session.agentCapabilities?.sessionCapabilities?.resume)
    throw new Error('Kimi cannot safely rebind native fork tools; update its runtime');
  let nativeId, closed = false, cancelled = false;
  const closeFork = async () => {
    if (!nativeId || closed) return;
    await session.request('session/close', { sessionId: nativeId });
    closed = true;
  };
  registerSession({ kill() { cancelled = true; return closeFork().catch(() => {}); } });
  try {
    const result = await session.request('session/fork', { sessionId, cwd, mcpServers: [] });
    nativeId = result.sessionId;
    if (!validSessionId(nativeId) || nativeId === sessionId) throw new Error('Kimi did not create an independent native fork');
    if (cancelled) throw new Error('Fork canceled');
    // Fork preserves source MCP servers. Close the new, idle session and
    // restore it with its own bridge before any model request is possible.
    await closeFork();
    const bridge = goalBridge?.config;
    const mcpServers = bridge ? [{ name: 'camellia_goals', command: bridge.command, args: bridge.args,
      env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })) }] : [];
    await session.request('session/resume', { sessionId: nativeId, cwd, mcpServers });
    closed = false;
    await closeFork();
    if (cancelled) throw new Error('Fork canceled');
    await copyKimiFork(session.spec.env.KIMI_CODE_HOME, targetHome, nativeId);
    return { nativeId };
  } finally { await closeFork().catch(() => {}); }
}

module.exports = { KimiSession, kimiSpawnSpec, kimiEnvironment, managedKimiConfig, kimiConnectionSettings, updateKimiConnectionSettings, forkKimiNative };
