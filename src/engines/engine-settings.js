'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const TOML = require('smol-toml');
const { writeText } = require('../shared/json-store');

const ROUTE_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
const FIELDS = {
  claude: [
    { key: 'language', label: "Response language", type: 'text', placeholder: "Follow the conversation language" },
    { key: 'permissions.defaultMode', label: "Default permissions", type: 'select', options: [['default', "Default permissions"], ['acceptEdits', "Accept edits"], ['plan', "Plan only"], ['bypassPermissions', "Allow all"]] },
    { key: 'effortLevel', label: "Default reasoning level", type: 'select', options: [['', "Model default"], ['low', "Low"], ['medium', "Medium"], ['high', "High"], ['xhigh', "Extra high"]] },
    { key: 'outputStyle', label: "Output style", type: 'text', placeholder: "Default, or the name of an installed style" },
    { key: 'cleanupPeriodDays', label: "Session retention (days)", type: 'number', min: 1, max: 36500, placeholder: '30' },
  ],
  kimi: [
    { key: 'default_permission_mode', label: "Default permissions", type: 'select', options: [['manual', "Ask by default"], ['yolo', "Ask as needed"], ['auto', "Fully automatic"]] },
    { key: 'default_plan_mode', label: "Start new sessions in plan mode", type: 'checkbox' },
    { key: 'loop_control.max_attempts_per_step', label: "Maximum attempts per step", type: 'number', min: 1, max: 100 },
    { key: 'background.max_running_tasks', label: "Maximum background tasks", type: 'number', min: 1, max: 100 },
    { key: 'merge_all_available_skills', label: "Merge available skills", type: 'checkbox' },
    { key: 'telemetry', label: "Send anonymous usage statistics", type: 'checkbox' },
  ],
};
const getAt = (value, key) => key.split('.').reduce((v, part) => v?.[part], value);
function setAt(value, key, next) {
  const parts = key.split('.'); const last = parts.pop();
  for (const part of parts) value = value[part] ||= {};
  if (next === '' || next === null) delete value[last]; else value[last] = next;
}
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const revision = text => createHash('sha256').update(text).digest('hex');
function parse(text, format) {
  const value = text.trim() ? (format === 'json' ? JSON.parse(text) : format === 'yaml' ? YAML.parse(text) : TOML.parse(text)) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error("Configuration must be an object");
  return value;
}
const stringify = (value, format) => format === 'json' ? JSON.stringify(value, null, 2) + '\n' : format === 'yaml' ? YAML.stringify(value) : TOML.stringify(value);
function backup(file) {
  if (fs.existsSync(file) && !fs.existsSync(file + '.workbench.bak')) fs.copyFileSync(file, file + '.workbench.bak');
}
function routeKimi(config, { route, model, contextWindow = 131072 }) {
  if (!route || !model) return config;
  return { ...config, default_model: model,
    providers: { ...config.providers, workbench: { type: 'openai', base_url: route.baseUrl + '/v1', api_key: route.authToken } },
    models: { ...config.models, [model]: { provider: 'workbench', model, max_context_size: contextWindow } } };
}
function createEngineSettings({ home, claudeHome, dshHome, kimiHome, getDesktop, saveDesktop, getRoute }) {
  const claudeDir = claudeHome || path.join(home, '.claude');
  function definitions(engine) {
    if (engine === 'dsh') return [{ id: 'settings', label: "Full configuration", format: 'yaml', path: path.join(dshHome(), 'settings.yaml') }];
    if (engine === 'claude') return [
      { id: 'settings', label: "Full configuration", format: 'json', path: path.join(claudeDir, 'settings.json') },
      { id: 'mcp', label: "MCP servers", format: 'json', path: path.join(claudeHome || home, '.claude.json'), key: 'mcpServers' },
      { id: 'instructions', label: "Global instructions", format: 'text', path: path.join(claudeDir, 'CLAUDE.md') },
    ];
    if (engine === 'kimi') return [
      { id: 'settings', label: "Full configuration", format: 'toml', path: path.join(kimiHome, 'config.toml') },
      { id: 'mcp', label: "MCP servers", format: 'json', path: path.join(kimiHome, 'mcp.json') },
      { id: 'terminal', label: "Terminal", format: 'toml', path: path.join(kimiHome, 'tui.toml') },
    ];
    throw new Error("Unknown engine");
  }
  function editable(engine, doc, value) {
    if (doc.key) return value[doc.key] || {};
    if (engine === 'claude' && doc.id === 'settings') {
      value = structuredClone(value);
      for (const key of ROUTE_ENV) if (value.env) delete value.env[key];
      delete value.model;
    }
    if (engine === 'kimi' && doc.id === 'settings') {
      value = { ...value }; delete value.providers; delete value.models; delete value.default_model;
    }
    return value;
  }
  function get(engine) {
    const files = definitions(engine).map(doc => {
      const text = read(doc.path);
      const value = doc.format === 'text' ? text : editable(engine, doc, parse(text, doc.format));
      return { ...doc, revision: revision(text), text: doc.format === 'text' ? value : stringify(value, doc.format), backup: fs.existsSync(doc.path + '.workbench.bak') };
    });
    const native = parse(files[0].text, files[0].format);
    return { engine, files, desktop: getDesktop(engine), fields: (FIELDS[engine] || []).map(field => ({ ...field, value: getAt(native, field.key) ?? (field.type === 'checkbox' ? false : '') })) };
  }
  function save(engine, payload) {
    const definitionsById = new Map(definitions(engine).map(doc => [doc.id, doc]));
    const route = getRoute();
    const writes = payload.files.map(input => {
      const doc = definitionsById.get(input.id);
      if (!doc) throw new Error("Unknown configuration file");
      const original = read(doc.path);
      if (revision(original) !== input.revision) throw new Error(`${doc.label} was modified by another application. Reload before saving.`);
      if (doc.format === 'text') return { file: doc.path, text: String(input.text) };
      const old = parse(original, doc.format);
      let value = parse(input.text, doc.format);
      if (doc.id === 'settings') for (const [key, next] of Object.entries(payload.common || {})) {
        const field = (FIELDS[engine] || []).find(item => item.key === key);
        if (!field) throw new Error("Unknown setting");
        if (field.type === 'number' && next !== '' && (!Number.isInteger(next) || next < field.min || next > field.max)) throw new Error(`${field.label} must be an integer between ${field.min} and ${field.max}`);
        if (field.type === 'select' && next !== '' && !field.options.some(([id]) => id === next)) throw new Error(`Invalid ${field.label.toLowerCase()}`);
        setAt(value, key, next);
      }
      if (doc.key) value = { ...old, [doc.key]: value };
      if (engine === 'claude' && doc.id === 'settings') {
        const oldRoute = Object.fromEntries(ROUTE_ENV.filter(key => old.env?.[key] !== undefined).map(key => [key, old.env[key]]));
        value.env = { ...value.env, ...oldRoute };
        if (old.model) value.model = old.model;
        if (route) Object.assign(value.env, { ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_AUTH_TOKEN: route.authToken, ANTHROPIC_API_KEY: '' });
        const model = getDesktop('claude').model;
        if (route && model) {
          value.model = model;
          for (const key of ROUTE_ENV.slice(3)) value.env[key] = model;
        }
      }
      if (engine === 'kimi' && doc.id === 'settings') {
        value = routeKimi({ ...value, providers: old.providers, models: old.models, default_model: old.default_model }, {
          route, model: getDesktop('kimi').model, contextWindow: payload.desktop?.contextWindow || getDesktop('kimi').contextWindow,
        });
      }
      return { file: doc.path, text: stringify(value, doc.format) };
    });
    // Validate every document before replacing any file, and back up the originals once.
    for (const item of writes) backup(item.file);
    const desktop = { ...payload.desktop };
    if (engine === 'claude') {
      const native = parse(writes.find(item => item.file === definitionsById.get('settings').path).text, 'json');
      desktop.permissionMode = native.permissions?.defaultMode || 'default';
      desktop.thinkingBudget = native.effortLevel || '';
    }
    if (engine === 'kimi') {
      const native = parse(writes.find(item => item.file === definitionsById.get('settings').path).text, 'toml');
      desktop.permissionMode = native.default_plan_mode ? 'plan' : native.default_permission_mode === 'manual' ? 'default' : native.default_permission_mode || 'default';
    }
    saveDesktop(engine, desktop);
    for (const item of writes) writeText(item.file, item.text);
    return get(engine);
  }
  function kimiConfig() {
    return { config: parse(read(path.join(kimiHome, 'config.toml')), 'toml'), mcp: read(path.join(kimiHome, 'mcp.json')) };
  }
  function syncManagedRoutes() {
    const route = getRoute(); if (!route) return;
    for (const engine of ['claude', 'kimi']) {
      const doc = definitions(engine)[0]; if (!fs.existsSync(doc.path)) continue;
      const value = parse(read(doc.path), doc.format);
      if (engine === 'claude' && value.env?.ANTHROPIC_AUTH_TOKEN === 'proxy-managed' && value.env.ANTHROPIC_BASE_URL !== route.baseUrl) {
        value.env.ANTHROPIC_BASE_URL = route.baseUrl;
      } else if (engine === 'kimi' && value.providers?.workbench?.api_key === 'proxy-managed' && value.providers.workbench.base_url !== route.baseUrl + '/v1') {
        value.providers.workbench.base_url = route.baseUrl + '/v1';
      } else continue;
      backup(doc.path); writeText(doc.path, stringify(value, doc.format));
    }
  }
  return { get, save, kimiConfig, syncManagedRoutes, backupDsh: () => backup(path.join(dshHome(), 'settings.yaml')) };
}
module.exports = { createEngineSettings, parse, stringify, backup, routeKimi };
