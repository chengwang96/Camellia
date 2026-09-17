'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const YAML = require('yaml');
const { ClaudeSession } = require('../engines/claude-session');
const { AcpSession } = require('../engines/acp-session');
const { ClaudeHistory } = require('../engines/claude-history');
const { kimiSpawnSpec } = require('../engines/kimi-session');
const { antigravitySpawnSpec } = require('../engines/antigravity');
const { CodexSession } = require('../engines/codex-session');
const { codexSpawnSpec } = require('../engines/codex-client');
const { DSH_MAX_OUTPUT_TOKENS } = require('../engines/dsh-session');

const ENGINES = ['claude', 'codex', 'dsh', 'kimi', 'antigravity'];
const NAMES = { claude: 'Claude Code', codex: 'Codex CLI', dsh: 'DeepSeek Harness', kimi: 'Kimi Code', antigravity: 'Antigravity SDK' };
function isolatedEnvironment(home, node, inherited = process.env) {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'SHELL']) {
    if (inherited[key]) env[key] = inherited[key];
  }
  delete env.Path;
  env.PATH = path.dirname(node) + path.delimiter + (inherited.PATH || inherited.Path || '');
  for (const name of ['tmp', 'appdata', 'local', 'config', 'cache', 'data']) fs.mkdirSync(path.join(home, name), { recursive: true });
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'local'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
    TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', CI: '1',
    OPENAI_API_KEY: 'proxy-managed', ANTHROPIC_API_KEY: 'proxy-managed' });
  return env;
}
async function terminateProcessTree(proc) {
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* already exited */ } }
  }
}
async function stopProcess(proc, terminate = terminateProcessTree) {
  if (!proc?.pid) return;
  const running = proc.exitCode === null && proc.signalCode === null;
  const closed = running ? new Promise(resolve => proc.once('close', resolve)) : Promise.resolve();
  if (running) await terminate(proc);
  // A native runtime can exit while one of its descendants retains inherited
  // stdio. Waiting for `close` without releasing our pipe handles then hangs
  // benchmark cancellation even though the runtime has already been killed.
  proc.stdin?.destroy(); proc.stdout?.destroy(); proc.stderr?.destroy();
  await closed;
}
function dshSpec({ runtime, home, cwd, model, route, env }) {
  const dshHome = path.join(home, '.dsh'); fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), YAML.stringify({
    'agent-default-model': { provider: 'api-pool', model },
    permission: { defaultPreset: 'danger-full-access' },
    'llm-pi-ai': { providers: { 'api-pool': { displayName: 'Benchmark API', apiKeyEnv: 'DSH_API_ROUTER_KEY',
      api: 'anthropic-messages', baseURL: route.baseUrl, defaultContextWindow: 65536, defaultMaxTokens: DSH_MAX_OUTPUT_TOKENS, models: [{ id: model }] } } },
  }));
  return { args: [runtime.file, '--profile', 'headless'], cwd, env: { ...env, DSH_HOME: dshHome, DSH_API_ROUTER_KEY: 'proxy-managed' } };
}
function claudeSpec({ home, cwd, model, route, env }) {
  const config = path.join(home, '.claude'); fs.mkdirSync(config, { recursive: true });
  const modelEnv = Object.fromEntries(['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'].map(key => [key, model]));
  Object.assign(modelEnv, { ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_AUTH_TOKEN: 'proxy-managed', ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: config });
  const settings = path.join(home, 'claude-settings.json'); fs.writeFileSync(settings, JSON.stringify({ env: modelEnv }));
  const mcp = path.join(home, 'mcp.json'); fs.writeFileSync(mcp, '{"mcpServers":{}}');
  return { cwd, env: { ...env, ...modelEnv }, args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--model', model, '--permission-mode', 'bypassPermissions', '--settings', settings,
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp] };
}
async function runEngine({ engine, runtime, node, cwd, home, model, route, prompt, signal, python, onEvent = () => {} }) {
  if (!ENGINES.includes(engine)) throw new Error('Unknown benchmark engine');
  const env = isolatedEnvironment(home, node);
  if (python) Object.assign(env, { PATH: path.dirname(python) + path.delimiter + env.PATH,
    OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1',
    TF_NUM_INTEROP_THREADS: '1', TF_NUM_INTRAOP_THREADS: '1' });
  let session, proc, abort, log = '', headlessText = '', settled = false;
  const append = message => { log = (log + String(message) + '\n').slice(-16000); };
  const trackedSpawn = (exe, args, options) => {
    proc = spawn(exe, args, { ...options, detached: process.platform !== 'win32', windowsHide: true });
    return proc;
  };
  try {
    return await new Promise((resolve, reject) => {
      const finish = result => { if (!settled) { settled = true; resolve({ ...result, log }); } };
      abort = () => finish({ ok: false, text: String(session?.text || headlessText).slice(-4000), error: String(signal.reason?.message || signal.reason || 'Cancelled'), cancelled: true });
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      const event = ev => {
        if (ev.type === 'gui:permission') session?.answerPermission(ev.requestId, true, ev.input);
        onEvent(ev);
      };
      const result = ev => finish({ ok: !ev.is_error && ev.subtype === 'success', text: String(ev.result || '').slice(0, 4000),
        error: ev.is_error || ev.subtype !== 'success' ? String(ev.result || ev.subtype).slice(0, 1000) : null });
      try {
        if (engine === 'dsh') {
          const spec = dshSpec({ runtime, home, cwd, model, route, env });
          proc = trackedSpawn(node, [...spec.args, prompt], { cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
          proc.stdout.on('data', data => { headlessText = (headlessText + data).slice(-4000); });
          proc.stderr.on('data', data => append(data));
          proc.once('error', reject);
          proc.once('close', (code, signal) => {
            // Headless sends reasoning to stderr too. It is not an error message.
            const diagnostic = log.split('\n').filter(line => /^dsh: [A-Z][A-Z_]+: /.test(line)).at(-1);
            finish({ ok: code === 0, text: headlessText, exitCode: code, exitSignal: signal || null,
              error: code === 0 ? null : diagnostic || `DSH exited (${code ?? signal}) before completing the task. Inspect the request diagnostics and engine log.` });
          });
        } else {
          const opts = { workspaceId: null };
          const settings = { cwd, model, connection: 'api', permissionMode: engine === 'kimi' ? 'yolo' : 'bypassPermissions' };
          let spec, exe;
          if (engine === 'claude') { spec = claudeSpec({ home, cwd, model, route, env }); exe = runtime.file; }
          else if (engine === 'codex') { spec = codexSpawnSpec({ runtime, home: path.join(home, '.codex'), cwd, connection: 'api', model, route, env }); exe = runtime.file; }
          else if (engine === 'kimi') { spec = kimiSpawnSpec({ home: path.join(home, '.kimi'), runtime: runtime.file, model, route, env }); exe = node; }
          else { spec = antigravitySpawnSpec({ runtime, home: path.join(home, '.antigravity'), route, config: {}, env }); exe = runtime.file; }
          const Session = engine === 'claude' ? ClaudeSession : engine === 'codex' ? CodexSession : AcpSession;
          session = new Session({ name: NAMES[engine], gen: 1, settings, opts, exe, spec, spawn: trackedSpawn, log: append,
            history: new ClaudeHistory(path.join(home, 'history')), onEvent: event, onSessionId: () => {}, onResult: result });
          session.start();
          if (!session.sendUserMessage(prompt)) throw new Error('The engine did not accept the task');
        }
      } catch (error) { reject(error); }
    });
  } finally {
    signal.removeEventListener('abort', abort);
    await stopProcess(proc);
    await session?.kill();
  }
}

module.exports = { ENGINES, NAMES, isolatedEnvironment, runEngine, stopProcess, dshSpec, claudeSpec };
