'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse, stringify } = require('../engines/engine-settings');

// Only documents edited by Settings belong to this category. Installed skills,
// plugins, catalogs, binaries and native session profiles are not preferences.
const SETTINGS_FILES = new Map([
  ['app/desktop-config.json', { format: 'json' }],
  ['app/codex/config.toml', { engine: 'codex', format: 'toml' }],
  ['app/codex/AGENTS.md', { engine: 'codex', format: 'text' }],
  ['app/antigravity/settings.json', { engine: 'antigravity', mode: 'api', format: 'json' }],
  ['app/pi-native/AGENTS.md', { engine: 'pi', format: 'text' }],
  ['home/.dsh/settings.yaml', { engine: 'dsh', format: 'yaml' }],
  ['home/.claude/settings.json', { engine: 'claude', format: 'json' }],
  ['home/.claude/CLAUDE.md', { engine: 'claude', format: 'text' }],
  ['home/.claude.json', { engine: 'claude', format: 'json', key: 'mcpServers' }],
  ...['app/kimi-code', 'home/.kimi-code'].flatMap(root => [
    [root + '/config.toml', { engine: 'kimi', format: 'toml' }],
    [root + '/mcp.json', { engine: 'kimi', format: 'json' }],
    [root + '/tui.toml', { engine: 'kimi', format: 'toml' }],
  ]),
  ['home/.gemini/antigravity-cli/settings.json', { engine: 'antigravity', mode: 'subscription', format: 'json' }],
  ...['mcp_config', 'skills', 'plugins'].map(name =>
    ['home/.gemini/config/' + name + '.json', { engine: 'antigravity', mode: 'subscription', format: 'json' }]),
]);
const ENGINES = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'];
const PREFERENCE_KEYS = ['language', 'theme', 'closeToTray', 'autoRefreshBalances', 'accountRefreshMinutes',
  'chatContentWidth', 'network', 'downloadProxy', 'conversations', 'memoryDirectory', 'computerName'];
const ENGINE_MAP_KEYS = ['quickSwitchModels', 'quickSwitchLevels', 'hiddenSubscriptionModels',
  'subscriptionAutoRefresh', 'subscriptionAutoSwitch'];
const ENGINE_KEYS = ['permissionMode', 'thinkingBudget', 'contextWindow', 'cwd'];
const CONVERSATION_CONFIG = 'app/conversation-config.json';
const CONVERSATION_KEYS = ['claudeMeta', 'codexMeta', 'kimiMeta', 'antigravityMeta', 'piMeta', 'sharedMeta',
  'kimiSessionConnections', 'codexSessionConnections', 'codexSessionFastModes', 'sharedChat', 'dshChat', 'mode'];
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function engineInstalled(installed, engine, mode) {
  const status = installed?.[engine];
  return status === true || Boolean(object(status) && (mode ? status[mode] === true : status.api === true || status.subscription === true));
}
function portableDesktop(value, installed, skipped = new Set()) {
  const result = pick(value, PREFERENCE_KEYS);
  for (const engine of ENGINES) {
    if (!object(value[engine])) continue;
    const preferences = pick(value[engine], ENGINE_KEYS);
    if (!Object.keys(preferences).length) continue;
    if (installed && !engineInstalled(installed, engine)) { skipped.add(engine); continue; }
    result[engine] = preferences;
  }
  for (const key of ENGINE_MAP_KEYS) {
    if (!object(value[key])) continue;
    result[key] = {};
    for (const engine of ENGINES) if (Object.hasOwn(value[key], engine)) {
      if (installed && !engineInstalled(installed, engine)) { skipped.add(engine); continue; }
      result[key][engine] = value[key][engine];
    }
  }
  return result;
}

// Match the fields hidden by the engine settings editors. A transferred native
// document must not replace this installation's managed routes or login state.
const NATIVE_LOCAL_KEYS = {
  'app/codex/config.toml': ['model', 'model_provider', 'model_providers', 'cli_auth_credentials_store',
    'forced_login_method', 'forced_chatgpt_workspace_id', 'openai_base_url', 'chatgpt_base_url'],
  'home/.claude/settings.json': ['model'],
  'app/kimi-code/config.toml': ['providers', 'models', 'default_model'],
  'home/.kimi-code/config.toml': ['providers', 'models', 'default_model'],
  'home/.gemini/antigravity-cli/settings.json': ['modelProvider', 'useG1Credits'],
};
const ROUTE_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
function nativePreferences(relative, value, current = {}) {
  const definition = SETTINGS_FILES.get(relative);
  if (definition?.key) return { ...current, [definition.key]: value[definition.key] || {} };
  const next = structuredClone(value);
  for (const key of NATIVE_LOCAL_KEYS[relative] || []) {
    delete next[key];
    if (Object.hasOwn(current, key)) next[key] = current[key];
  }
  if (relative === 'home/.claude/settings.json') {
    for (const key of ROUTE_ENV) if (object(next.env)) delete next.env[key];
    if (object(current.env)) for (const key of ROUTE_ENV) if (Object.hasOwn(current.env, key)) {
      next.env ||= {}; next.env[key] = current.env[key];
    }
  }
  return next;
}
async function readSettings(file, relative, format = 'json', optional = false) {
  let text;
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_SETTINGS_BYTES) throw new Error('The package configuration is too large to validate: ' + relative);
    text = await fs.promises.readFile(file, 'utf8');
  } catch (error) { if (optional && error.code === 'ENOENT') return {}; throw error; }
  try { return parse(text.replace(/^\uFEFF/, ''), format); }
  catch { throw new Error('The package contains invalid ' + format.toUpperCase() + ': ' + relative); }
}
async function saveSettings(file, value, format = 'json') {
  const text = stringify(value, format);
  await fs.promises.writeFile(file, text);
  return Buffer.byteLength(text);
}
function usablePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && fs.existsSync(value);
}
function filterLocalReferences(value, current, relative, skippedPaths, target) {
  if (Array.isArray(value.skillsPaths)) {
    const available = value.skillsPaths.filter(usablePath);
    if (available.length !== value.skillsPaths.length) {
      skippedPaths.push(relative + ': skillsPaths');
      value.skillsPaths = available.length ? available : current.skillsPaths || [];
    }
  }
  for (const key of ['mcpServers', 'mcp_servers']) {
    if (!object(value[key])) continue;
    for (const [name, server] of Object.entries(value[key])) {
      if (!object(server)) continue;
      const paths = [server.command, ...(Array.isArray(server.args) ? server.args : []), server.cwd]
        .filter(arg => typeof arg === 'string' && (path.isAbsolute(arg) || path.win32.isAbsolute(arg)));
      if (paths.every(usablePath)) continue;
      skippedPaths.push(relative + ': ' + key + '.' + name);
      if (object(current[key]) && Object.hasOwn(current[key], name)) value[key][name] = current[key][name];
      else delete value[key][name];
    }
  }
  if (relative === 'home/.claude/settings.json' && object(value.enabledPlugins)) {
    let installed = {};
    try {
      const file = path.join(path.dirname(target), 'plugins/installed_plugins.json');
      if (fs.statSync(file).size <= MAX_SETTINGS_BYTES) installed = JSON.parse(fs.readFileSync(file, 'utf8')).plugins || {};
    } catch { /* A missing registry cannot establish an installed plugin. */ }
    for (const [name, enabled] of Object.entries(value.enabledPlugins)) {
      const records = installed[name];
      const ready = Array.isArray(records) && records.some(record => usablePath(record?.installPath));
      if (enabled !== true || ready) continue;
      skippedPaths.push(relative + ': enabledPlugins.' + name);
      if (object(current.enabledPlugins) && Object.hasOwn(current.enabledPlugins, name)) value.enabledPlugins[name] = current.enabledPlugins[name];
      else delete value.enabledPlugins[name];
    }
  }
  if (object(value.skills) && Array.isArray(value.skills.config)) {
    const available = value.skills.config.filter(skill => skill?.enabled === false || usablePath(skill?.path));
    if (available.length !== value.skills.config.length) {
      skippedPaths.push(relative + ': skills.config');
      value.skills.config = available.length ? available : current.skills?.config || [];
    }
  }
  return value;
}
async function prepareSettingsExport(files) {
  for (const file of files) {
    const definition = SETTINGS_FILES.get(file.rel);
    if (!definition || definition.format === 'text') continue;
    const value = await readSettings(file.abs, file.rel, definition.format);
    const next = file.rel === 'app/desktop-config.json' ? portableDesktop(value) : nativePreferences(file.rel, value);
    file.size = await saveSettings(file.abs, next, definition.format);
  }
}

async function prepareSettingsImport({ targets, staging, dataDir, home, installedEngines, includeConversations }) {
  const skipped = new Set(), skippedPaths = [], rewritten = [];
  const desktopRel = 'app/desktop-config.json';
  let currentDesktop, nextDesktop;
  const loadDesktop = async () => {
    if (!currentDesktop) {
      try { currentDesktop = await readSettings(path.join(dataDir, 'desktop-config.json'), desktopRel, 'json', true); }
      catch { throw new Error('The current subscription account settings could not be preserved: ' + desktopRel); }
      nextDesktop = structuredClone(currentDesktop);
    }
  };
  for (const relative of [...targets]) {
    const definition = SETTINGS_FILES.get(relative);
    const file = path.join(staging, ...relative.split('/'));
    if (relative === CONVERSATION_CONFIG || relative === desktopRel) {
      await loadDesktop();
      const value = await readSettings(file, relative);
      if (relative === desktopRel) {
        const preferences = portableDesktop(value, installedEngines, skipped);
        if (preferences.memoryDirectory) {
          let usable = false;
          try { usable = fs.statSync(preferences.memoryDirectory).isDirectory(); } catch {}
          if (!usable) { delete preferences.memoryDirectory; skippedPaths.push('memoryDirectory'); }
        }
        for (const engine of ENGINES) if (preferences[engine]?.cwd) {
          let usable = false;
          try { usable = path.isAbsolute(preferences[engine].cwd) && fs.statSync(preferences[engine].cwd).isDirectory(); } catch {}
          if (!usable) { delete preferences[engine].cwd; skippedPaths.push(engine + '.cwd'); }
        }
        for (const [key, preference] of Object.entries(preferences)) {
          nextDesktop[key] = ENGINES.includes(key) || ENGINE_MAP_KEYS.includes(key)
            ? { ...currentDesktop[key], ...preference } : preference;
        }
      }
      // Legacy full-profile desktop files also held history metadata. Restore
      // that part only when the conversation category was explicitly selected.
      if (includeConversations) Object.assign(nextDesktop, pick(value, CONVERSATION_KEYS));
      if (relative === CONVERSATION_CONFIG) targets.splice(targets.indexOf(relative), 1);
      continue;
    }
    if (!definition || definition.format === 'text') continue;
    const root = relative.startsWith('app/') ? dataDir : home;
    const target = path.join(root, ...relative.split('/').slice(1));
    const current = await readSettings(target, relative, definition.format, true);
    const value = await readSettings(file, relative, definition.format);
    const next = filterLocalReferences(nativePreferences(relative, value, current), current, relative, skippedPaths, target);
    await saveSettings(file, next, definition.format);
    rewritten.push(relative);
  }
  if (nextDesktop) {
    const file = path.join(staging, ...desktopRel.split('/'));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await saveSettings(file, nextDesktop);
    if (!targets.includes(desktopRel)) targets.push(desktopRel);
    rewritten.push(desktopRel);
  }
  return { skippedEngines: [...skipped], skippedPaths, rewritten };
}

module.exports = { SETTINGS_FILES, ENGINES, CONVERSATION_CONFIG, CONVERSATION_KEYS, MAX_SETTINGS_BYTES,
  engineInstalled, portableDesktop, readSettings, prepareSettingsExport, prepareSettingsImport };
