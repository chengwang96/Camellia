'use strict';

const fs = require('node:fs');
const { writeText } = require('../shared/json-store');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const TOML = require('smol-toml');
const { configureApiModel, needsApiToolProfile } = require('./codex-models');
const { toolModelId } = require('../shared/codex-tool-model');

const QUESTION_INSTRUCTIONS = 'Camellia can show a choice dialog when you call request_user_input. For a choice dialog, use request_user_input rather than request_user_input_async, which does not open this dialog. If you need the user to choose among concrete options before continuing, use that tool instead of ending with a plain-text list of choices, and wait for the answer before making changes that depend on it. Do not ask when the existing request already authorizes a reasonable action; continue the work. If the tool is unavailable, ask in normal text.';

// The app-server spawns helpers (MCP tool servers, plugin-sync git) that inherit
// its stdio. Killing only the app-server leaves them running and holding the
// pipes, which defers `close` forever and strands the conversation that is
// switching away from this session. Stop the whole tree where supported.
function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      const killer = spawn(taskkill, ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { try { proc.kill(); } catch { /* already gone */ } });
    } catch { try { proc.kill(); } catch { /* already gone */ } }
    return;
  }
  try { proc.kill(); } catch { /* already gone */ }
}

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
    // The app-server spawns helpers (MCP tool servers, git during plugin sync)
    // that inherit its stdio. When it exits, a surviving helper keeps those
    // pipe handles open, so `close` can be deferred indefinitely. Treat the
    // exit itself as authoritative after a short grace period for `close`, so
    // a dead process is never mistaken for a live one.
    this.proc.once('exit', code => {
      clearTimeout(this.exitTimer);
      this.exitTimer = setTimeout(() => this.close(new Error(`Codex process exited (${code})`)), 1000);
      this.exitTimer.unref?.();
    });
    this.proc.once('close', code => {
      clearTimeout(this.exitTimer);
      this.close(new Error(`Codex process exited (${code})`));
    });
    this.proc.stdin.on('error', error => this.close(error));
    this.ready = this.request('initialize', { clientInfo: { name: 'camellia', title: 'Camellia', version: '0.3.0' },
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
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else pending.resolve(message.result);
  }
  close(error) {
    if (this.dead) return;
    this.dead = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.lines.close(); this.onClose(error);
  }
  shutdown() {
    if (this.stopping) return this.stopping;
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      this.close(new Error('Codex process stopped'));
      return Promise.resolve();
    }
    this.close(new Error('Codex process stopped'));
    this.stopping = new Promise((resolve, reject) => {
      // Helper processes inherit the app-server's stdout/stderr, so its `close`
      // event can be delayed indefinitely after the process itself is gone.
      // Settle on exit (and kill as a last resort) instead of waiting for the
      // pipes, which would strand the conversation that is switching away from
      // this session.
      let killTimer;
      const done = error => {
        clearTimeout(timer); clearTimeout(killTimer);
        this.proc.removeListener('exit', onExit);
        this.proc.removeListener('close', onExit);
        if (error) reject(error); else resolve();
      };
      const onExit = () => done();
      const timer = setTimeout(() => {
        killProcessTree(this.proc);
        killTimer = setTimeout(() => done(new Error('Codex process has not exited; retry after it stops')), 5000);
      }, 5000);
      this.proc.once('exit', onExit);
      this.proc.once('close', onExit);
      this.proc.stdin.end();
    });
    return this.stopping;
  }
}

function codexEnvironment(home, inherited = process.env, proxyUrl = '', { subscription = false } = {}) {
  const env = { ...inherited, CODEX_HOME: home };
  if (process.platform === 'win32') { env.PATH = inherited.PATH || inherited.Path; delete env.Path; }
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'CODEX_API_KEY', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) delete env[name];
  // A subscription CLI authenticates and streams through the provider's own
  // hosts, so it always takes the real proxy. "Auto" hands the other
  // engines a loopback bridge that would make ChatGPT sign-in and replies stall.
  if (env.CAMELLIA_NETWORK_MODE) {
    if (subscription) Object.assign(env, require('../main/network-settings').subscriptionEnvironment(env));
  } else if (proxyUrl) for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = proxyUrl;
  return env;
}

function sharePluginCache(home, shared) {
  const link = path.join(home, '.tmp');
  const target = path.resolve(shared);
  if (!shared || path.resolve(link) === target) return;
  const relative = path.relative(path.resolve(home), target);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Shared plugin cache must be outside the conversation home');
  try { fs.lstatSync(link); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EEXIST') { fs.lstatSync(link); return; }
    throw new Error('Cannot create shared Codex plugin cache: ' + (error.code || error.message), { cause: error });
  }
}

function codexSpawnSpec({ runtime, home, configHome = home, connection = 'subscription', model, route, contextWindow, env = process.env, proxyUrl = '', cwd = home, sharedPluginCache = '', allowUserQuestions = false }) {
  fs.mkdirSync(home, { recursive: true });
  if (sharedPluginCache) sharePluginCache(home, sharedPluginCache);
  const file = path.join(configHome, 'config.toml');
  const config = fs.existsSync(file) ? TOML.parse(fs.readFileSync(file, 'utf8')) : {};
  // Connection and credential storage belong to Camellia, not native defaults.
  delete config.model; delete config.model_provider; delete config.model_providers;
  delete config.forced_login_method; delete config.forced_chatgpt_workspace_id;
  delete config.openai_base_url; delete config.chatgpt_base_url;
  config.cli_auth_credentials_store = 'file';
  config.model_provider = connection === 'api' ? 'camellia' : 'openai';
  const managedCatalog = path.join(home, 'camellia-api-models.json');
  const userCatalog = config.model_catalog_json && path.resolve(config.model_catalog_json) !== path.resolve(managedCatalog);
  const runtimeModel = connection === 'api' && !userCatalog && needsApiToolProfile(model) ? toolModelId(model) : model;
  const environment = codexEnvironment(home, env, proxyUrl, { subscription: connection === 'subscription' });
  environment.PATH = path.join(path.dirname(path.dirname(runtime.file)), 'codex-path') + path.delimiter + (environment.PATH || '');
  configureApiModel(config, home, connection === 'api' ? runtimeModel : undefined, contextWindow);
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
  const args = ['app-server'];
  if (connection === 'api' && Number.isInteger(contextWindow) && contextWindow >= 4096) {
    args.push('-c', `model_context_window=${contextWindow}`);
  }
  // Upstream Codex advertises request_user_input in every chat session but its
  // router refuses the call outside Plan mode unless this feature is enabled.
  // Camellia renders task questions as its own dialog, so turn the tool on for
  // chat sessions. Discussions keep it off through their own feature policy.
  if (allowUserQuestions) args.push('-c', 'features.default_mode_request_user_input=true');
  return { exe: runtime.file, args, cwd, env: environment, model: runtimeModel,
    ...(allowUserQuestions ? { developerInstructions: [config.developer_instructions, QUESTION_INSTRUCTIONS].filter(Boolean).join('\n\n') } : {}),
    permissions: { approvalPolicy: config.approval_policy || 'untrusted', sandbox: config.sandbox_mode || 'workspace-write' } };
}

module.exports = { CodexClient, codexEnvironment, codexSpawnSpec, QUESTION_INSTRUCTIONS };
