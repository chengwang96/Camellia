'use strict';

const fs = require('node:fs');
const { writeText } = require('../shared/json-store');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const TOML = require('smol-toml');
const { configureApiModel } = require('./codex-models');

// Codex owns OAuth and native thread storage. Only its public app-server API
// crosses this boundary; auth files are never read into the renderer.
class CodexClient {
  constructor({ exe, args, env, cwd, log = () => {}, onNotification = () => {}, onRequest, onClose = () => {}, spawnProcess = spawn }) {
    Object.assign(this, { log, onNotification, onRequest, onClose });
    this.pending = new Map();
    this.sequence = 0;
    this.proc = spawnProcess(exe, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = readline.createInterface({ input: this.proc.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { log('Codex: ignored non-JSON stdout'); return; }
      // One bad message or handler must not kill the readline loop.
      try { this.receive(message); }
      catch (error) { log('Codex: event handling failed: ' + error.message); }
    });
    this.proc.stderr.on('data', data => log('Codex: ' + String(data).trim()));
    this.proc.once('error', error => this.close(error));
    this.proc.once('close', code => this.close(new Error(`Codex process exited (${code})`)));
    this.proc.stdin.on('error', error => this.close(error));
    this.ready = this.request('initialize', { clientInfo: { name: 'camellia', title: 'Camellia', version: '0.1.0' },
      capabilities: { experimentalApi: true } }).then(() => this.write({ method: 'initialized' }));
    this.ready.catch(() => {}); // The caller awaits initialization.
  }
  write(message) {
    if (this.dead) throw new Error('Codex process is unavailable');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (message.method) {
      if (message.id === undefined) this.onNotification(message.method, message.params || {});
      else if (this.onRequest) this.onRequest(message);
      else this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
  }
  close(error) {
    if (this.dead) return;
    this.dead = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.lines.close(); this.onClose(error);
  }
  shutdown() {
    if (this.stopping) return this.stopping;
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve();
    this.close(new Error('Codex process stopped'));
    this.stopping = new Promise(resolve => {
      const timer = setTimeout(() => this.proc.kill(), 5000);
      this.proc.once('close', () => { clearTimeout(timer); resolve(); });
      this.proc.stdin.end();
    });
    return this.stopping;
  }
}

function codexEnvironment(home, inherited = process.env, proxyUrl = '') {
  const env = { ...inherited, CODEX_HOME: home };
  if (process.platform === 'win32') { env.PATH = inherited.PATH || inherited.Path; delete env.Path; }
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'CODEX_API_KEY', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) delete env[name];
  if (proxyUrl) for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = proxyUrl;
  return env;
}

function codexSpawnSpec({ runtime, home, configHome = home, connection = 'subscription', model, route, contextWindow, env = process.env, proxyUrl = '', cwd = home }) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(configHome, 'config.toml');
  const config = fs.existsSync(file) ? TOML.parse(fs.readFileSync(file, 'utf8')) : {};
  // Connection and credential storage belong to Camellia, not native defaults.
  delete config.model; delete config.model_provider; delete config.model_providers;
  delete config.forced_login_method; delete config.forced_chatgpt_workspace_id;
  delete config.openai_base_url; delete config.chatgpt_base_url;
  config.cli_auth_credentials_store = 'file';
  config.model_provider = connection === 'api' ? 'camellia' : 'openai';
  const environment = codexEnvironment(home, env, proxyUrl);
  environment.PATH = path.join(path.dirname(path.dirname(runtime.file)), 'codex-path') + path.delimiter + (environment.PATH || '');
  configureApiModel(config, home, connection === 'api' ? model : undefined, contextWindow);
  if (connection === 'api') {
    config.web_search = 'disabled';
    config.model_providers = { camellia: { name: 'Camellia API routes', base_url: route.baseUrl + '/v1',
      wire_api: 'responses', env_key: 'CAMELLIA_CODEX_API_KEY', supports_websockets: false } };
    environment.CAMELLIA_CODEX_API_KEY = route.authToken || 'proxy-managed';
  } else delete environment.CAMELLIA_CODEX_API_KEY;
  // Both connection homes get the same user-editable settings and instructions.
  writeText(path.join(home, 'config.toml'), TOML.stringify(config));
  if (configHome !== home) {
    const instructions = path.join(configHome, 'AGENTS.md');
    const target = path.join(home, 'AGENTS.md');
    if (fs.existsSync(instructions)) fs.copyFileSync(instructions, target);
    else fs.rmSync(target, { force: true });
  }
  return { exe: runtime.file, args: ['app-server'], cwd, env: environment,
    permissions: { approvalPolicy: config.approval_policy || 'untrusted', sandbox: config.sandbox_mode || 'workspace-write' } };
}

module.exports = { CodexClient, codexEnvironment, codexSpawnSpec };
