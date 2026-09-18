'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AcpSession } = require('./acp-session');
const TOML = require('smol-toml');
const { writeText } = require('../shared/json-store');

const MANAGED_PROVIDER = 'managed:kimi-code';
function kimiEnvironment(home, inherited = process.env) {
  const env = { ...inherited, KIMI_CODE_HOME: home, KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_REGION_MARKER: 'off' };
  // A subscription must not inherit an API route or a different OAuth server.
  for (const key of Object.keys(env)) if (/^KIMI_MODEL_|^KIMI_(API_KEY|BASE_URL|OAUTH_HOST|REGISTRY_API_KEY)$|^KIMI_CODE_(API_KEY|BASE_URL|OAUTH_HOST)$|^KIMI_WEB_(SEARCH|FETCH)_(BASE_URL|API_KEY)$/i.test(key)) delete env[key];
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
  return { permissionMode: 'default', thinkingBudget: '', cwd: '', contextWindow: 131072, region: 'mainland-cn', ...saved,
    connection, apiModel: saved.apiModel ?? saved.model ?? '',
    model: connection === 'subscription' ? saved.subscriptionModel || '' : saved.apiModel ?? saved.model ?? '' };
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
  delete value.model; delete value.sessionId;
  return value;
}

// API credentials stay in the router. Subscription credentials are maintained
// by the official CLI in a separate app-owned home.
function kimiSpawnSpec({ home, runtime, model, contextWindow = 131072, route, connection = 'api', sharedSubscription = false, config = {}, mcp = '', env = process.env }) {
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
  } else merged = routeKimi({ telemetry: false, ...config, providers: {}, models: {} }, { route, model, contextWindow });
  writeText(path.join(home, 'config.toml'), TOML.stringify(merged));
  writeText(path.join(home, 'mcp.json'), mcp || '{"mcpServers":{}}');
  return { args: [runtime, 'acp'], env: { ...kimiEnvironment(home, env), KIMI_DISABLE_TELEMETRY: merged.telemetry ? '0' : '1' }, modeEngine: 'kimi' };
}

module.exports = { KimiSession: AcpSession, kimiSpawnSpec, kimiEnvironment, managedKimiConfig, kimiConnectionSettings, updateKimiConnectionSettings };
