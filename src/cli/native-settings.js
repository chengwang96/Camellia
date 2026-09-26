'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parse, stringify } = require('../engines/engine-settings');
const { writeText } = require('../shared/json-store');
const { fail } = require('../main/remote/access');

const LIMIT = 256 * 1024;
const RESERVED = {
  claude: ['model', 'apiKeyHelper', 'forceLoginMethod', 'forceLoginOrgUUID'],
  codex: ['model', 'model_provider', 'model_providers', 'cli_auth_credentials_store', 'forced_login_method', 'forced_chatgpt_workspace_id', 'openai_base_url', 'chatgpt_base_url'],
  kimi: ['providers', 'models', 'default_model', 'default_provider', 'secondary_model', 'services'],
  dsh: ['agent-default-model', 'llm-pi-ai', 'permission'],
  google: ['modelProvider'],
};
function definitions(dataDir) {
  return {
    claude: [
      { id: 'settings', label: 'Claude settings', format: 'json', file: path.join(dataDir, 'claude-native/settings.json'), policy: 'claude' },
      { id: 'instructions', label: 'CLAUDE.md', format: 'text', file: path.join(dataDir, 'claude-native/CLAUDE.md') },
      { id: 'mcp', label: 'MCP servers', format: 'json', file: path.join(dataDir, 'claude-native/camellia-mcp.json') },
    ],
    codex: [
      { id: 'settings', label: 'Codex config.toml', format: 'toml', file: path.join(dataDir, 'codex/config.toml'), policy: 'codex' },
      { id: 'instructions', label: 'AGENTS.md', format: 'text', file: path.join(dataDir, 'codex/AGENTS.md') },
    ],
    kimi: [
      { id: 'settings', label: 'Kimi native preferences', format: 'toml', file: path.join(dataDir, 'kimi-native/config.toml'), policy: 'kimi' },
      { id: 'mcp', label: 'MCP servers', format: 'json', file: path.join(dataDir, 'kimi-native/mcp.json') },
    ],
    dsh: [{ id: 'settings', label: 'DSH native preferences', format: 'yaml', file: path.join(dataDir, 'dsh-native/settings.yaml'), policy: 'dsh' }],
    antigravity: [
      { id: 'settings', label: 'Antigravity SDK settings', format: 'json', file: path.join(dataDir, 'antigravity/settings.json') },
      { id: 'google', label: 'Google CLI settings', format: 'json', file: path.join(dataDir, 'google-native/.gemini/antigravity-cli/settings.json'), policy: 'google' },
      ...['mcp_config', 'skills', 'plugins'].map(id => ({ id, label: `Google ${id}`, format: 'json', file: path.join(dataDir, 'google-native/.gemini/config', id + '.json') })),
    ],
  };
}
const digest = value => createHash('sha256').update(value).digest('hex');
function protectedEnv(key) { return /^(ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|GOOGLE_APPLICATION_CREDENTIALS$|GEMINI_API_KEY$|GOOGLE_API_KEY$|DSH_API_ROUTER_KEY$|KIMI_API_KEY$|KIMI_BASE_URL$)/i.test(key); }
function editable(doc, value) {
  const result = structuredClone(value);
  for (const key of RESERVED[doc.policy] || []) delete result[key];
  if (doc.policy === 'claude' && result.env && typeof result.env === 'object') {
    for (const key of Object.keys(result.env)) if (protectedEnv(key)) delete result.env[key];
    if (!Object.keys(result.env).length) delete result.env;
  }
  return result;
}
function validate(doc, text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT || text.includes('\0')) fail(400, 'Native configuration exceeds limits');
  if (doc.format === 'text') return text;
  let value;
  try { value = parse(text, doc.format); } catch { fail(400, 'Invalid native configuration syntax'); }
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object') return;
    if (depth > 40 || seen.has(node)) fail(400, 'Configuration nesting or aliases are unsupported');
    seen.add(node);
    for (const key of Object.keys(node)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(400, 'Unsupported configuration key');
      visit(node[key], depth + 1);
    }
  };
  visit(value);
  if (Object.keys(value).some(key => (RESERVED[doc.policy] || []).includes(key))) fail(400, 'Routing and account credentials are managed separately');
  if (doc.policy === 'claude' && value.env) {
    if (typeof value.env !== 'object' || Array.isArray(value.env) || Object.keys(value.env).some(protectedEnv)) fail(400, 'Routing and account environment is protected');
  }
  if (doc.id === 'mcp' && value.mcpServers !== undefined && (!value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers))) fail(400, 'MCP servers must be an object');
  return value;
}
function createNativeSettings({ dataDir, isBusy = () => false, publish = () => {} }) {
  const documents = definitions(dataDir);
  function document(engine, id) {
    if (!Object.hasOwn(documents, engine)) fail(400, 'Unknown engine');
    const entry = documents[engine].find(entry => entry.id === id);
    if (!entry) fail(400, 'Unknown native configuration document');
    return entry;
  }
  function read(doc) {
    const relative = path.relative(dataDir, doc.file);
    let current = dataDir;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) fail(409, 'Native configuration cannot use symbolic links'); }
      catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    }
    const stat = fs.statSync(doc.file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT) fail(409, 'Native configuration file is unavailable or too large');
    return fs.readFileSync(doc.file, 'utf8');
  }
  function view(engine) {
    if (!Object.hasOwn(documents, engine)) fail(400, 'Unknown engine');
    const files = documents[engine].map(doc => {
      const raw = read(doc);
      let text;
      try { text = doc.format === 'text' ? raw : stringify(editable(doc, parse(raw, doc.format)), doc.format); }
      catch { fail(409, 'Native configuration is invalid; repair it on the server'); }
      return { id: doc.id, label: doc.label, format: doc.format, text, revision: digest(raw) };
    });
    return { engine, files, editable: !isBusy(engine) };
  }
  return {
    get: view,
    save(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['engine', 'id', 'text', 'revision', 'confirmed'].includes(key)) || payload.confirmed !== true) fail(400, 'Explicit native settings confirmation required');
      const doc = document(payload.engine, payload.id);
      if (isBusy(payload.engine)) fail(409, 'Stop engine activity, account operations and installation before editing native settings');
      const current = read(doc);
      if (digest(current) !== payload.revision) fail(409, 'Native settings changed; reload before saving');
      const value = validate(doc, payload.text);
      let content = value;
      if (doc.format !== 'text') {
        let previous;
        try { previous = parse(current, doc.format); } catch { fail(409, 'Repair invalid server configuration before editing'); }
        for (const key of RESERVED[doc.policy] || []) if (Object.hasOwn(previous, key)) value[key] = previous[key];
        if (doc.policy === 'claude' && previous.env) {
          const protectedValues = Object.fromEntries(Object.entries(previous.env).filter(([key]) => protectedEnv(key)));
          if (Object.keys(protectedValues).length) value.env = { ...value.env, ...protectedValues };
        }
        content = stringify(value, doc.format);
      }
      if (Buffer.byteLength(content) > LIMIT) fail(400, 'Native configuration exceeds limits');
      if (content !== current) writeText(doc.file, content);
      publish();
      return { ok: true, engine: payload.engine, id: doc.id, revision: digest(content), affects: 'next-engine-process' };
    },
    fingerprint(engine) {
      if (!Object.hasOwn(documents, engine)) fail(400, 'Unknown engine');
      return digest(documents[engine].map(doc => read(doc)).join('\0'));
    },
    config(engine, id = 'settings') {
      const doc = document(engine, id);
      const text = read(doc);
      try { return doc.format === 'text' ? text : editable(doc, parse(text, doc.format)); }
      catch { fail(409, 'Native configuration is invalid; repair it on the server'); }
    },
    path(engine, id) { return document(engine, id).file; },
  };
}

module.exports = { createNativeSettings, definitions, editable, validate, LIMIT };
