'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApiRouter } = require('../api/api-router.js');
const routerConfig = require('../api/api-router-config.js');
const { ClaudeSession } = require('../engines/claude-session.js');
const { ClaudeHistory } = require('../engines/claude-history.js');
const { readJson, writeJson } = require('../shared/json-store.js');
const { BackendProcess } = require('./backend-process.js');
const dshConfig = require('../engines/dsh-config.js');
const { ClaudeGoal } = require('../engines/claude-goal.js');
const { createSessionWorkspaces } = require('../engines/session-workspaces.js');
const { KimiSession, kimiSpawnSpec } = require('../engines/kimi-session.js');
const { createProviderInsights } = require('../api/provider-insights.js');
const { createRuntimeManager } = require('./runtime-manager.js');
const { createEngineSettings, backup } = require('../engines/engine-settings.js');
const runtimePaths = require('./runtime-paths.js');

const APP_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(APP_ROOT, 'src/renderer');
const APP_NAME = 'Camellia';
const APP_NAME_CLAUDE = 'Claude Code';
const STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_PORT = 3000;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

// Keep existing conversations, settings and cookies when the product is renamed.
// An explicit user-data directory (including test profiles) stays authoritative.
const initialUserData = app.getPath('userData');
if (path.basename(initialUserData) === app.getName() && initialUserData === path.join(app.getPath('appData'), app.getName())) {
  const userData = path.join(app.getPath('appData'), 'dsh-desktop');
  fs.mkdirSync(userData, { recursive: true });
  if (app.getPath('sessionData') === initialUserData) app.setPath('sessionData', userData);
  app.setPath('userData', userData);
}
app.setName(APP_NAME);
app.commandLine.appendSwitch('lang', 'en-US');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}
function logPath() {
  return path.join(logDir(), 'dsh-desktop.log');
}
let logStream = null;
function log(message) {
  try {
    if (!logStream) {
      fs.mkdirSync(logDir(), { recursive: true });
      logStream = fs.createWriteStream(logPath(), { flags: 'a' });
      logStream.on?.('error', () => { logStream = null; });
      logStream.write(`\n=== ${APP_NAME} desktop start ${new Date().toISOString()} ===\n`);
    }
    logStream.write(`[${new Date().toISOString()}] ${message}\n`);
  } catch (_err) {
    // Never let logging break startup.
  }
}

// ---------------------------------------------------------------------------
// Config (stored in the app's own userData, NOT in ~/.dsh which dsh itself owns)
// ---------------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function defaultConfig() {
  return {
    dshBin: '',             // explicit path to @deepseek-ai/dsh/lib/bin.js (optional)
    nodeExe: '',            // explicit node.exe (optional)
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    dshHome: DSH_HOME,      // pass through as DSH_HOME env to the backend
    firstRunComplete: false, // set true after onboarding
    mode: 'dsh',            // Last selected agent; startup always opens the home panel.
    claude: {},             // Claude Code GUI settings
  };
}

function loadConfig(strict = false) {
  try {
    const parsed = readJson(configPath(), {});
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error("Desktop configuration must be a JSON object");
    return { ...defaultConfig(), ...parsed };
  } catch (err) {
    if (strict) throw err;
    log(err.message);
    return defaultConfig();
  }
}

function saveConfig(patch) {
  // Do not overwrite an unreadable existing configuration with defaults.
  const next = { ...loadConfig(true), ...patch };
  writeJson(configPath(), next);
  return next;
}

let runtimeManager;
function runtimes() {
  if (!runtimeManager) {
    const root = app.isPackaged ? process.resourcesPath : APP_ROOT;
    const node = detectNode();
    const npm = firstExisting(runtimePaths.npmCandidates(node, { resourcesPath: app.isPackaged ? root : undefined, env: process.env }));
    runtimeManager = createRuntimeManager({ root, installRoot: app.getPath('userData'), node, npm,
      onChange: state => {
        for (const window of [mainWindow, settingsWindow]) if (window && !window.isDestroyed()) window.webContents.send('dsh:runtime-state', state);
      } });
  }
  return runtimeManager;
}
function runtimeEnvironment(node, engine) {
  const root = app.isPackaged ? process.resourcesPath : APP_ROOT;
  const runtime = runtimes().locate(engine);
  const paths = [node && path.dirname(node), path.join(root, 'runtime/npm/bin'), runtime && path.join(runtime.dir, 'node_modules/.bin')].filter(Boolean);
  return { ...process.env, PATH: paths.concat(process.env.PATH || '').join(path.delimiter) };
}
let nativeSettings;
function engineSettings() {
  if (!nativeSettings) nativeSettings = createEngineSettings({ home: os.homedir(),
    claudeHome: process.env.CLAUDE_CONFIG_DIR,
    dshHome: () => loadConfig().dshHome || DSH_HOME,
    kimiHome: process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'),
    getDesktop: engine => engine === 'kimi' ? kimiSettings() : engine === 'claude' ? claudeSettings() : {},
    saveDesktop: (engine, value) => engine === 'kimi' ? saveKimiSettings(value) : engine === 'claude' ? saveClaudeSettings(value) : undefined,
    getRoute: () => routerConfig.hasRoutes(readOllamaProxyConfig()) ? resolveClaudeRoute() : null,
  });
  return nativeSettings;
}

// ---------------------------------------------------------------------------
// OpenCode multi-key proxy: REMOVED (provider subscription discontinued).
// ---------------------------------------------------------------------------
// One-time cleanup: strip the stale baseURL override this feature used to
// inject into settings.yaml's opencode-go block, so the route never points at
// a dead local port. Runs once per startup; the ~/.dsh/opencode-proxy.json key
// pool file is left on disk untouched in case it is needed elsewhere.
function cleanupOpencodeProxyRoute() {
  try {
    const settingsFile = path.join(loadConfig().dshHome || DSH_HOME, 'settings.yaml');
    if (dshConfig.cleanupLegacyRoute(settingsFile)) log('cleanup: removed stale opencode-go proxy baseURL');
  } catch (err) {
    log(`cleanup: opencode-go route failed: ${err && err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Shared API key pool. The old file name is retained for automatic migration.
// ---------------------------------------------------------------------------
function ollamaProxyConfigPath() {
  return path.join(loadConfig().dshHome || DSH_HOME, 'ollama-proxy.json');
}
function readOllamaProxyConfig() { return routerConfig.loadConfig(ollamaProxyConfigPath()); }
let ollamaProxyHandle = null;
function broadcastApiRouter(state) {
  for (const window of [mainWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('dsh:api-router-state', state);
  }
}
let providerInsights = null, balanceRefreshTimer = null;
function insights() {
  if (!providerInsights) providerInsights = createProviderInsights({
    file: path.join(app.getPath('userData'), 'provider-insights.json'), getConfig: readOllamaProxyConfig,
    onChange: state => {
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('dsh:provider-insights', state);
    },
  });
  return providerInsights;
}
function refreshAccountBalances() {
  clearTimeout(balanceRefreshTimer);
  if (loadConfig().autoRefreshBalances !== false) {
    try { void insights().refresh({ force: false }).catch(e => log(`account refresh: ${e.message}`)); } catch (e) { log(`account refresh: ${e.message}`); }
  }
  balanceRefreshTimer = setTimeout(refreshAccountBalances, 15 * 60000);
  balanceRefreshTimer.unref?.();
}
function apiRouterState() {
  try {
    const cfg = readOllamaProxyConfig();
    return { ok: true, ...(ollamaProxyHandle ? ollamaProxyHandle.getState() : { ...routerConfig.publicState(cfg), running: false, url: `http://127.0.0.1:${cfg.port}` }),
      presets: routerConfig.PRESETS, configPath: ollamaProxyConfigPath() };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function startOllamaProxyHandle() {
  await stopOllamaProxyHandle();
  try {
    const cfg = readOllamaProxyConfig();
    if (!routerConfig.hasRoutes(cfg)) { syncOllamaBaseUrl(false); return; }
    ollamaProxyHandle = startApiRouter({ configPath: ollamaProxyConfigPath(), log: msg => log(`[api-router] ${msg}`), onState: broadcastApiRouter });
    await ollamaProxyHandle.ready;
    syncOllamaBaseUrl(true);
    log(`api-router: listening on ${ollamaProxyHandle.url}`);
  } catch (e) { log(`api-router: start failed (${e.code || e.message})`); }
}
async function stopOllamaProxyHandle() {
  const handle = ollamaProxyHandle;
  ollamaProxyHandle = null;
  if (handle) await handle.stop();
}
async function saveApiRouter(payload) {
  const prev = readOllamaProxyConfig();
  const next = routerConfig.normalizeConfig(payload, prev);
  const restartClient = prev.port !== next.port || routerConfig.hasRoutes(prev) !== routerConfig.hasRoutes(next);
  if (restartClient && (claudeSession?.running || kimiSession?.running || ollamaProxyHandle?.getState().activeRequests)) {
    throw new Error("Wait for the response to finish or stop it before changing the router port or enabling/disabling the pool");
  }
  if (ollamaProxyHandle?.getState().running && prev.port === next.port && routerConfig.hasRoutes(next)) {
    ollamaProxyHandle.updateConfig(payload);
    syncOllamaBaseUrl(true);
  } else {
    await stopOllamaProxyHandle();
    routerConfig.writeConfig(ollamaProxyConfigPath(), routerConfig.normalizeConfig(payload, readOllamaProxyConfig()));
    await startOllamaProxyHandle();
  }
  const state = apiRouterState();
  if (restartClient && claudeSession) { claudeSession.kill(); claudeSession = null; }
  if (restartClient && kimiSession) { await kimiSession.shutdown(); kimiSession = null; }
  broadcastApiRouter(state);
  if (loadConfig().autoRefreshBalances !== false) void insights().refresh({ force: false }).catch(e => log(`account refresh: ${e.message}`));
  let warning;
  try { engineSettings().syncManagedRoutes(); } catch (e) { warning = "Routes saved, but global CLI connections could not be synchronized: " + e.message; }
  return { ok: true, state, warning };
}

// Add an explicit pool provider to DSH while preserving existing selections.
function syncOllamaBaseUrl(active) {
  try {
    const cfg = readOllamaProxyConfig();
    const settingsFile = path.join(loadConfig().dshHome || DSH_HOME, 'settings.yaml');
    backup(settingsFile);
    dshConfig.syncPoolProvider(settingsFile, { active, port: cfg.port,
      models: routerConfig.publicState(cfg).models, hasOllama: cfg.providers.some(p => p.type === 'ollama') });
  } catch (e) { log(`api-router: sync DSH models failed (${e.message})`); }
}

// ---------------------------------------------------------------------------
// Claude Code GUI (headless CLI driver)
// ---------------------------------------------------------------------------
function detectClaudeExe() {
  const managed = runtimes().locate('claude');
  if (managed) return managed.file;
  const candidates = [
    ...runtimePaths.globalPackageRoots({ node: detectNode(), env: process.env }).map(root =>
      path.join(root, '@anthropic-ai/claude-code/bin/claude.exe')),
    ...(process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA || '', 'Programs/claude-code/claude.exe')]
      : [path.join(os.homedir(), '.local/bin/claude')]),
  ];
  return firstExisting(candidates) || 'claude';
}

const CLAUDE_SETTING_FIELDS = ['cwd', 'model', 'thinkingBudget', 'permissionMode'];
function claudeSessionSettings(settings = {}) {
  return Object.fromEntries(CLAUDE_SETTING_FIELDS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
}
function claudeSettings() { return claudeSessionSettings(loadConfig().claude || {}); }

function saveClaudeSettings(patch) {
  const config = loadConfig();
  const next = { ...config, claude: { ...(config.claude || {}), ...claudeSessionSettings(patch) } };
  saveConfig(next);
  return claudeSessionSettings(next.claude);
}

let claudeGen = 0;        // session generation; also reported as runId to the renderer
let claudeSession = null; // current ClaudeSession | null

// Build spawn args/env for one persistent claude process.
// opts: { sessionId?: string, resumeLast?: boolean }
function claudeSpawnSpec(settings, opts) {
  const args = [
    '-p', // stream-json input REQUIRES print mode; without it the CLI starts
          // its interactive shell, hits the login screen, and never reads stdin
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--replay-user-messages',
    '--include-partial-messages',
    '--prompt-suggestions', 'true',
    '--verbose',
  ];
  if (opts.sessionId) {
    // An absolute transcript also resumes across directories on older CLIs
    // whose ID lookup is limited to the current project. Keep the original ID.
    args.push('--resume', findClaudeSessionFile(opts.sessionId) || opts.sessionId);
    if (opts.fork) args.push('--fork-session'); // fork: same history, new session id
  } else if (opts.resumeLast) {
    args.push('-c');
  }
  if (settings.permissionMode && settings.permissionMode !== 'default') args.push('--permission-mode', settings.permissionMode);
  if (settings.model) args.push('--model', settings.model);
  // Thinking intensity → --effort (matches DSH 推理等级: low|medium|high|xhigh|max).
  // '' = Default (flag omitted); 'off' goes through MAX_THINKING_TOKENS=0.
  const thinking = settings.thinkingBudget;
  if (thinking && thinking !== 'off') args.push('--effort', thinking);

  // Unified routing: the proxy owns upstream credentials for every harness.
  const route = resolveClaudeRoute();
  if (!settings.model) throw new Error("Select a configured model in the composer first");
  const overlayEnv = { ...managedClaudeModelEnv(settings.model),
    ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_AUTH_TOKEN: route.authToken, ANTHROPIC_API_KEY: '' };
  if (thinking === 'off') overlayEnv.MAX_THINKING_TOKENS = '0';
  // ~/.claude/settings.json 的 env 块优先级高于进程环境变量（会覆盖上面
  // 的设置）——用 --settings overlay 反压回去（命令行设置 > 用户设置）。
  // 写到 userData 文件而不是内联 JSON，避免密钥出现在命令行里。
  const settingsPath = writeClaudeSettingsOverlay(overlayEnv);
  args.push('--settings', settingsPath);
  return { args, env: { ...runtimeEnvironment(detectNode(), 'claude'), ...overlayEnv }, cwd: settings.cwd || undefined };
}

// Pin workbench routing without changing the user's Claude CLI configuration.
function writeClaudeSettingsOverlay(overlayEnv) {
  const file = path.join(app.getPath('userData'), 'claude-overlay.settings.json');
  writeJson(file, { env: overlayEnv });
  log(`claude: settings overlay → ${file} (baseURL=${overlayEnv.ANTHROPIC_BASE_URL})`);
  return file;
}

// All harness API credentials belong to the workbench router.
function managedClaudeModelEnv(model) {
  return { ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model };
}
function resolveClaudeRoute() {
  const cfg = readOllamaProxyConfig();
  if (!routerConfig.hasRoutes(cfg)) throw new Error("Enable API routing and configure a model and key in Camellia settings");
  if (ollamaProxyHandle && !ollamaProxyHandle.getState().running) throw new Error(ollamaProxyHandle.getState().error || "The API router has not started");
  return { baseUrl: `http://127.0.0.1:${cfg.port}`, authToken: 'proxy-managed' };
}

// Fields that require a fresh process when changed (mid-session switching is
// not possible for model/effort/permission via the stream-json control API we use).
const SESSION_LOCKING_FIELDS = CLAUDE_SETTING_FIELDS;

function sessionSettingsEqual(a, b) {
  return SESSION_LOCKING_FIELDS.every((k) => String((a || {})[k] || '') === String((b || {})[k] || ''));
}

// Ensure a live session matching the requested settings; respawn when the
// conversation id changes or a locking setting changed mid-conversation.
function ensureClaudeSession(settings, opts) {
  opts = { ...opts };
  const context = resolveClaudeSessionContext(settings, opts);
  settings = { ...settings, cwd: context.cwd };
  opts.workspaceId = context.workspaceId;
  if (settings.cwd === claudeStandaloneCwd({})) fs.mkdirSync(settings.cwd, { recursive: true });
  if (!fs.existsSync(settings.cwd) || !fs.statSync(settings.cwd).isDirectory()) throw new Error("Working directory does not exist. Check the folder or move the session out of its workspace: " + settings.cwd);
  if (claudeSession && !claudeSession.dead) {
    // The live conversation id: whatever init reported, else the resume target.
    const liveConvId = claudeSession.sessionId || claudeSession.opts.sessionId || null;
    const wantConvId = (opts && opts.sessionId) || null;
    const sameConversation = liveConvId === wantConvId;
    if (sameConversation && !opts.fork && claudeSession.opts.workspaceId === opts.workspaceId && sessionSettingsEqual(claudeSession.settings, settings)) {
      return claudeSession;
    }
  }
  const priorSessionId = claudeSession && claudeSession.sessionId;
  const settingsOnlyRespawn = Boolean(claudeSession && !claudeSession.dead && !(opts && opts.fork))
    && !sessionSettingsEqual(claudeSession.settings, settings)
    && ((opts && opts.sessionId) || null) === priorSessionId;
  // Carry the conversation forward ONLY when this respawn was forced by a
  // settings change mid-conversation (a null opts.sessionId means "new conversation").
  const resumeId = (opts && opts.sessionId)
    || (settingsOnlyRespawn ? priorSessionId : null);
  const sessionOpts = { sessionId: resumeId, resumeLast: opts.resumeLast, fork: Boolean(opts.fork), workspaceId: opts.workspaceId };
  // Validate the new route before retiring the current conversation process.
  const spec = claudeSpawnSpec(settings, sessionOpts);
  const exe = detectClaudeExe();
  if (claudeSession) claudeSession.kill();
  const session = new ClaudeSession({
    gen: ++claudeGen, settings, opts: sessionOpts, exe, spec, spawn, log,
    setTimer: setTimeout, clearTimer: clearTimeout,
    onEvent: event => {
      if (claudeSession === session && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:claude-event', event);
    },
    onSessionId: id => {
      if (claudeSession === session) {
        recordClaudeSessionContext(id, sessionOpts.workspaceId, settings.cwd);
        goalDriver.rememberSession(session);
      }
    },
    onResult: event => { if (claudeSession === session) goalDriver.handleResult(event); },
  });
  claudeSession = session;
  try { session.start(); } catch (err) { session.kill(); throw err; }
  return claudeSession;
}

// ---------------------------------------------------------------------------
// Claude session history (~/.claude/projects/<cwd-key>/*.jsonl)
// ---------------------------------------------------------------------------
const claudeHistory = new ClaudeHistory(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'));
const parseSessionHead = file => claudeHistory.head(file);
const findClaudeSessionFile = id => claudeHistory.find(id);

const claudeStandaloneCwd = settings => settings.cwd || path.join(app.getPath('userData'), 'claude-sessions');
const claudeWorkspaces = createSessionWorkspaces({
  history: claudeHistory, loadConfig, saveConfig, metaKey: 'claudeMeta', settingsKey: 'claude',
  standaloneCwd: claudeStandaloneCwd, getSession: () => claudeSession,
  onDetach: id => goalDriver.detachWorkspace(id),
});
const { listSessions: listClaudeSessions,
  sessionMeta: claudeSessionMeta,
  resolveContext: resolveClaudeSessionContext,
  recordContext: recordClaudeSessionContext,
  renameSession: renameClaudeSession,
  archiveSession: archiveClaudeSession,
  metaOp: claudeMetaOp,
  transcript: loadClaudeSessionTranscript } = claudeWorkspaces;

// ---------------------------------------------------------------------------
// Claude goal mode (GUI-layer replica of DSH's goal loop)
// ---------------------------------------------------------------------------
const goalDriver = new ClaudeGoal({
  file: () => path.join(app.getPath('userData'), 'claude-goal.json'),
  getSession: () => claudeSession,
  ensureSession: opts => ensureClaudeSession(claudeSettings(), opts),
  resolveWorkspace: payload => resolveClaudeSessionContext(claudeSettings(), payload).workspaceId,
  onChange: goal => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:claude-goal', goal);
  },
  log, setTimer: setTimeout, clearTimer: clearTimeout,
});

// Kimi Code uses its own runtime and data directory, with shared UI metadata.
let kimiSession = null;
let kimiGen = 0;
const kimiHistory = new ClaudeHistory(path.join(app.getPath('userData'), 'kimi-history'));
const kimiStandaloneCwd = settings => settings.cwd || path.join(app.getPath('userData'), 'kimi-sessions');
const kimiWorkspaces = createSessionWorkspaces({
  history: kimiHistory, loadConfig, saveConfig, metaKey: 'kimiMeta', settingsKey: 'kimi',
  standaloneCwd: kimiStandaloneCwd, getSession: () => kimiSession,
  onDetach: id => kimiGoalDriver.detachWorkspace(id), fixedCwd: true,
});
function kimiSettings() {
  const saved = loadConfig().kimi || {};
  return { ...claudeSessionSettings(saved), contextWindow: saved.contextWindow || 131072 };
}
function saveKimiSettings(patch) {
  const next = { ...kimiSettings(), ...claudeSessionSettings(patch) };
  if (patch.contextWindow !== undefined) {
    const size = Number(patch.contextWindow);
    if (!Number.isInteger(size) || size < 4096 || size > 2000000) throw new Error("Context window must be an integer between 4096 and 2000000");
    next.contextWindow = size;
  }
  if (next.permissionMode && !['default', 'plan', 'yolo', 'auto'].includes(next.permissionMode)) throw new Error("Invalid Kimi permission mode");
  saveConfig({ kimi: next });
  return next;
}
function ensureKimiSession(settings, opts) {
  const context = kimiWorkspaces.resolveContext(settings, opts);
  settings = { ...settings, cwd: context.cwd };
  opts = { ...opts, workspaceId: context.workspaceId };
  if (settings.cwd === kimiStandaloneCwd({})) fs.mkdirSync(settings.cwd, { recursive: true });
  if (!fs.existsSync(settings.cwd) || !fs.statSync(settings.cwd).isDirectory()) throw new Error("Working directory does not exist: " + settings.cwd);
  if (!settings.model) throw new Error("Select a configured model in the composer first");
  settings.model = routerConfig.modelId(settings.model);
  const route = resolveClaudeRoute();
  if (!routerConfig.publicState(readOllamaProxyConfig()).models.includes(settings.model)) throw new Error("No route is available for this model. Add one in Camellia settings.");
  if (kimiSession && !kimiSession.dead && !opts.fork && kimiSession.sessionId === (opts.sessionId || null)
      && kimiSession.opts.workspaceId === opts.workspaceId && sessionSettingsEqual(kimiSession.settings, settings)
      && kimiSession.settings.contextWindow === settings.contextWindow) return kimiSession;
  const runtime = runtimes().locate('kimi')?.file;
  if (!runtime) throw new Error("Kimi is being prepared. Check progress or retry in Settings → Runtime.");
  const exe = detectNode();
  if (!exe) throw new Error("Kimi Code requires Node.js 22.19 or later. Configure the runtime in settings.");
  const spec = kimiSpawnSpec({ home: path.join(app.getPath('userData'), 'kimi-code'), runtime, route,
    model: settings.model, contextWindow: settings.contextWindow, env: runtimeEnvironment(exe, 'kimi'), ...engineSettings().kimiConfig() });
  const previousClosed = kimiSession?.shutdown();
  const session = new KimiSession({ gen: ++kimiGen, settings, opts, exe, spec, spawn, log, history: kimiHistory,
    onEvent: event => {
      if (kimiSession === session && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:kimi-event', event);
    },
    onSessionId: id => {
      kimiWorkspaces.recordContext(id, opts.workspaceId, settings.cwd);
      kimiGoalDriver.rememberSession(session);
    },
    onResult: event => { if (kimiSession === session) kimiGoalDriver.handleResult(event); },
  });
  kimiSession = session;
  try { session.start(previousClosed); } catch (err) { session.kill(); throw err; }
  return session;
}
const kimiGoalDriver = new ClaudeGoal({
  file: () => path.join(app.getPath('userData'), 'kimi-goal.json'), getSession: () => kimiSession,
  ensureSession: opts => ensureKimiSession(kimiSettings(), opts),
  resolveWorkspace: payload => kimiWorkspaces.resolveContext(kimiSettings(), payload).workspaceId,
  onChange: goal => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:kimi-goal', goal);
  },
  log, setTimer: setTimeout, clearTimer: clearTimeout,
});

// Write the credentials key -> env var mapping and the model/provider settings.
// The harness resolves `llm-pi-ai.providers.<id>.apiKeyEnv` to the env var in
// .credentials.yaml. DeepSeek is the only first-class provider now.
function applyCredentials(provider, apiKey) {
  const home = loadConfig().dshHome || DSH_HOME;

  let envKey;
  let settingsProviderId;
  if (String(provider || '').toLowerCase() === 'deepseek' || !provider) {
    envKey = 'DEEPSEEK_API_KEY';
    settingsProviderId = 'deepseek';
  } else {
    // Unknown provider: generic pi-ai compatible endpoint keyed by env var.
    envKey = String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY';
    settingsProviderId = String(provider).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  const trimmed = apiKey ? apiKey.trim() : '';
  const mask = trimmed ? (trimmed.startsWith('sk-') ? `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}` : '****') : '(empty)';
  log(`Writing credential env ${envKey} (${mask}) and provider settings to DSH_HOME=${loadConfig().dshHome || DSH_HOME}`);

  const model = settingsProviderId === 'deepseek' ? (process.env.DSH_DEFAULT_MODEL || 'deepseek-chat') : 'deepseek-v4-pro';
  dshConfig.configureProvider(home, { providerId: settingsProviderId, apiKeyEnv: envKey, apiKey: trimmed, model });

  return { envKey, settingsProviderId };
}

function isFirstRun() {
  const config = loadConfig();
  if (config.firstRunComplete) return false;
  if (routerConfig.hasRoutes(readOllamaProxyConfig())) return false;
  // Also treat "credentials already present" as non-first-run so the app is
  // usable without re-entering keys on a fresh userData.
  return !fs.existsSync(path.join(loadConfig().dshHome || DSH_HOME, '.credentials.yaml'));
}

// ---------------------------------------------------------------------------
// dsh detection
// ---------------------------------------------------------------------------
function nodeCandidates() {
  return runtimePaths.nodeCandidates({ explicit: loadConfig().nodeExe,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined, env: process.env });
}

function firstExisting(paths) {
  return paths.find((p) => p && fs.existsSync(p)) || null;
}

function dshBinCandidates() {
  const explicit = loadConfig().dshBin;
  const out = [];
  if (explicit) out.push(explicit);
  const managed = runtimes().locate('dsh');
  if (managed) out.push(managed.file);

  const scopes = [
    // Global npm install
    ...runtimePaths.globalPackageRoots({ node: detectNode(), env: process.env }).map(root => path.join(root, '@deepseek-ai/dsh/lib/bin.js')),
    // npx caches (most recent first) — this is where the current harness lives
    ...npxDshLocations(),
    // Local project installs that might exist
  ];
  out.push(...scopes);
  return out.filter(Boolean);
}

function npxDshLocations() {
  const cacheRoot = runtimePaths.npmCacheRoot({ env: process.env, home: os.homedir() });
  const npxRoot = path.join(cacheRoot, '_npx');
  const results = [];
  try {
    if (!fs.existsSync(npxRoot)) return results;
    const dirs = fs.readdirSync(npxRoot).map((d) => path.join(npxRoot, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    // Sort by mtime descending so newest harness wins.
    dirs.sort((a, b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
    for (const d of dirs) {
      if (fs.existsSync(d)) results.push(d);
    }
  } catch (_err) {
    // ignore
  }
  return results;
}

function detectNode() {
  return firstExisting(nodeCandidates());
}

function detectDshBin() {
  const found = firstExisting(dshBinCandidates());
  return found;
}

function detectRuntime() {
  const nodeExe = detectNode();
  const dshBin = detectDshBin();
  log(`detected node=${nodeExe || '(none)'} dshBin=${dshBin || '(none)'}`);
  return { nodeExe, dshBin };
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
const backend = new BackendProcess({ spawn, log });
let backendUrl = '';
function stopBackend() { backend.stop(); }

async function startBackend() {
  const config = loadConfig();
  if (!config.dshBin) await runtimes().ensure('dsh');
  const runtime = detectRuntime();
  if (!runtime.nodeExe) throw new Error('Node.js was not found. Install Node.js or set nodeExe in desktop-config.json.');
  if (!runtime.dshBin) throw new Error('The dsh harness was not found. Install @deepseek-ai/dsh or set dshBin in desktop-config.json.');

  const args = [runtime.dshBin, 'web', '--no-open'];
  syncOllamaBaseUrl(Boolean(ollamaProxyHandle?.getState().running));
  const env = { ...runtimeEnvironment(runtime.nodeExe, 'dsh'), DSH_HOME: config.dshHome || DSH_HOME, DSH_API_ROUTER_KEY: 'proxy-managed' };
  const result = await backend.start({
    key: JSON.stringify([runtime.nodeExe, args, config.host, config.port, env.DSH_HOME]),
    exe: runtime.nodeExe, cwd: path.dirname(runtime.dshBin), env,
    host: config.host, port: config.port, timeoutMs: STARTUP_TIMEOUT_MS,
    args: port => [...args, '--host', config.host, '--port', String(port)],
  });
  backendUrl = result.origin || new URL(result.url).origin;
  return result;
}

// ---------------------------------------------------------------------------
// Window helpers / UI
// ---------------------------------------------------------------------------
let mainWindow = null;
let currentMode = 'home'; // Current page: home, dsh, claude, kimi, or setup.

let settingsWindow = null;
let nativeSettingsView = null;
let nativeSettingsLoad = null;
const { welcomeHtml, errorHtml } = require('./desktop-views.js').createDesktopViews({
  appName: APP_NAME, dshHome: DSH_HOME, defaultPort: DEFAULT_PORT, loadConfig, detectRuntime,
  isDark: () => nativeTheme.shouldUseDarkColors,
});

function openApiSettingsWindow() {
  openSettingsWindow();
}

function openSettingsWindow(target = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.webContents.send('dsh:settings-navigate', target);
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 1160,
    height: 860,
    minWidth: 760,
    minHeight: 620,
    icon: path.join(APP_ROOT, 'assets/icon-256.png'),
    title: `Settings — ${APP_NAME}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.on('closed', () => {
    nativeSettingsView?.webContents.close(); nativeSettingsView = null; nativeSettingsLoad = null;
    settingsWindow = null;
  });
  settingsWindow.loadFile(path.join(RENDERER_ROOT, 'settings/api-settings.html'), { query: { page: target.page || 'providers', engine: target.engine || 'dsh' } });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    icon: path.join(APP_ROOT, 'assets/icon-256.png'),
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => { mainWindow.show(); });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') { void shell.openExternal(u.href); }
    } catch (_e) {}
    return { action: 'deny' };
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.handle('dsh:save-credentials', (_event, payload) => {
    try {
      const { provider, apiKey } = payload || {};
      const result = applyCredentials(provider || 'deepseek', apiKey || '');
      return { ok: true, ...result };
    } catch (err) {
      log(`save-credentials failed: ${err && err.message}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('dsh:finish-onboarding', () => {
    saveConfig({ firstRunComplete: true });
    return switchMode('dsh');
  });

  ipcMain.handle('dsh:get-state', () => {
    return {
      config: loadConfig(),
      dshHome: loadConfig().dshHome || DSH_HOME,
      backendUrl,
      isPackaged: app.isPackaged,
      version: app.getVersion(),
    };
  });

  ipcMain.handle('dsh:open-logs', () => {
    return shell.openPath(logDir());
  });

  ipcMain.handle('dsh:open-settings-window', (_event, target) => {
    openSettingsWindow(target);
    return { ok: true };
  });

  ipcMain.handle('dsh:native-settings-ready', event => {
    if (event.sender === nativeSettingsView?.webContents) settingsWindow?.webContents.send('dsh:native-settings-ready');
  });
  ipcMain.handle('dsh:show-native-settings', async (event, payload) => {
    if (event.sender !== settingsWindow?.webContents) return { ok: false, error: "The native panel can only be opened from the settings window" };
    try {
      if (!payload.visible) { nativeSettingsView?.setVisible(false); return { ok: true }; }
      if (!nativeSettingsView) {
        nativeSettingsView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
          nodeIntegration: false, additionalArguments: ['--workbench-settings'] } });
        settingsWindow.contentView.addChildView(nativeSettingsView);
        nativeSettingsView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      }
      const zoom = event.sender.getZoomFactor();
      const bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.max(0, Math.round(Number(payload.bounds[key]) * zoom))]));
      nativeSettingsView.setBounds(bounds); nativeSettingsView.setVisible(true);
      if (!nativeSettingsLoad || payload.reload) {
        const view = nativeSettingsView;
        nativeSettingsLoad = (async () => {
          engineSettings().backupDsh();
          const { url } = await startBackend();
          if (!view.webContents.isDestroyed()) await view.webContents.loadURL(url);
        })().catch(error => { nativeSettingsLoad = null; throw error; });
      }
      await nativeSettingsLoad;
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  for (const [name, handler] of Object.entries({
    'engine-settings-get': ({ engine }) => ({ ok: true, ...engineSettings().get(engine) }),
    'engine-settings-save': async ({ engine, ...payload }) => {
      if ((engine === 'claude' && (claudeSession?.running || goalDriver.armed)) || (engine === 'kimi' && (kimiSession?.running || kimiGoalDriver.armed))) throw new Error("Stop the current response or goal before changing global settings");
      const result = engineSettings().save(engine, payload);
      if (engine === 'claude') { claudeSession?.kill(); claudeSession = null; }
      if (engine === 'kimi') { await kimiSession?.shutdown(); kimiSession = null; }
      if (engine === 'dsh') syncOllamaBaseUrl(Boolean(ollamaProxyHandle?.getState().running));
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:engine-settings-changed', { engine });
      return { ok: true, ...result };
    },
    'runtime-state': () => ({ ok: true, engines: runtimes().state() }),
    'runtime-ensure': async ({ engine }) => ({ ok: true, runtime: await runtimes().ensure(engine) }),
  })) ipcMain.handle('dsh:' + name, async (_event, payload) => {
    try { return await handler(payload || {}); } catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle('dsh:zoom-by-wheel', (_event, direction) => {
    const wc = _event?.sender;
    if (wc) {
      const level = wc.getZoomLevel() + (direction > 0 ? 0.5 : -0.5);
      wc.setZoomLevel(level);
    }
    return { ok: true };
  });

  ipcMain.handle('dsh:get-settings', () => {
    const config = loadConfig();
    const detected = detectRuntime();
    return {
      config,
      detected,
      dshHome: loadConfig().dshHome || DSH_HOME,
    };
  });

  ipcMain.handle('dsh:save-settings', (_event, payload) => {
    try {
      const patch = {};
      if (payload && typeof payload === 'object') {
        if (typeof payload.dshBin === 'string') patch.dshBin = payload.dshBin.trim();
        if (typeof payload.nodeExe === 'string') patch.nodeExe = payload.nodeExe.trim();
        if (payload.port !== undefined && payload.port !== null && payload.port !== '') {
          const port = Number(payload.port);
          if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Backend port must be between 0 and 65535");
          patch.port = port;
        }
        if (typeof payload.dshHome === 'string' && payload.dshHome.trim()) patch.dshHome = payload.dshHome.trim();
      }
      const saved = saveConfig(patch);
      log(`settings saved: ${JSON.stringify(patch)}`);
      return { ok: true, config: saved };
    } catch (err) {
      log(`save-settings failed: ${err && err.message}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // ---- Shared API router -------------------------------------------------
  ipcMain.handle('dsh:open-api-settings-window', () => { openApiSettingsWindow(); return { ok: true }; });
  ipcMain.handle('dsh:api-router-get-state', apiRouterState);
  for (const [channel, handler] of Object.entries({
    'provider-insights': () => insights().state(),
    'provider-refresh': payload => insights().refresh(payload),
    'provider-models': payload => insights().models(payload),
    'provider-verify': payload => insights().verify(payload),
  })) ipcMain.handle('dsh:' + channel, async (_event, payload) => {
    try { return await handler(payload); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dsh:workbench-settings', () => ({ ok: true, theme: loadConfig().theme || 'system',
    autoRefreshBalances: loadConfig().autoRefreshBalances !== false, dataPath: app.getPath('userData'), version: app.getVersion() }));
  ipcMain.handle('dsh:workbench-save-settings', (_event, payload) => {
    try {
      const theme = ['system', 'light', 'dark'].includes(payload?.theme) ? payload.theme : 'system';
      saveConfig({ theme, autoRefreshBalances: payload?.autoRefreshBalances !== false });
      nativeTheme.themeSource = theme;
      void refreshAccountBalances();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dsh:api-router-save-config', async (_event, payload) => {
    try { return await saveApiRouter(payload); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dsh:api-router-rotate', (_event, model) => {
    try { if (!ollamaProxyHandle) throw new Error("The router is not running"); return { ok: true, state: ollamaProxyHandle.rotate(model) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dsh:api-router-reset', (_event, payload) => {
    try { if (!ollamaProxyHandle) throw new Error("The router is not running"); return { ok: true, state: ollamaProxyHandle.reset(payload?.model, payload?.keyId) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dsh:ollama-proxy-get-state', apiRouterState);

  // ---- Claude Code GUI ---------------------------------------------------
  ipcMain.handle('dsh:claude-send', (_event, payload) => {
    try {
      if (claudeSession && claudeSession.running) return { ok: false, error: "Wait for the response to finish or stop it before sending another message" };
      const settings = (payload && payload.settings) || claudeSettings();
      const session = ensureClaudeSession(settings, {
        sessionId: (payload && payload.sessionId) || null,
        resumeLast: Boolean(payload && payload.resumeLast),
        fork: Boolean(payload && payload.fork),
        workspaceId: (payload && payload.workspaceId) || null,
      });
      if (!session.sendUserMessage(String((payload && payload.prompt) || ''))) {
        return { ok: false, error: "Claude process is unavailable" };
      }
      return { ok: true, runId: session.gen };
    } catch (err) {
      log(`claude-send failed: ${err && err.message}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // Stop = graceful interrupt over the control channel (keeps the process and
  // conversation alive); the renderer exposes it as the stop button.
  ipcMain.handle('dsh:claude-cancel', (_event, _runId) => {
    if (claudeSession && !claudeSession.dead && claudeSession.gen === _runId) claudeSession.interrupt();
    return { ok: true };
  });

  ipcMain.handle('dsh:claude-control-respond', (_event, payload) => {
    if (!claudeSession || claudeSession.dead || !payload || !payload.requestId) return { ok: false };
    return { ok: claudeSession.answerPermission(payload.requestId, Boolean(payload.allow), payload.input, payload.message) };
  });

  ipcMain.handle('dsh:claude-get-settings', () => claudeSettings());

  ipcMain.handle('dsh:claude-save-settings', (_event, patch) => {
    try {
      return { ok: true, settings: saveClaudeSettings(patch || {}) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // ---- Claude session history (~/.claude/projects/**/*.jsonl) -------------
  ipcMain.handle('dsh:claude-list-sessions', async (_event, payload) => {
    try {
      return { ok: true, ...await listClaudeSessions(payload || {}) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('dsh:claude-load-session', async (_event, id) => {
    try {
      return { ok: true, ...await loadClaudeSessionTranscript(String(id || '')) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('dsh:claude-rename-session', (_event, payload) => {
    try {
      return renameClaudeSession(String(payload && payload.id || ''), payload && payload.title);
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('dsh:claude-archive-session', (_event, payload) => {
    try {
      return archiveClaudeSession(String(payload && payload.id || ''), payload && payload.archived !== false);
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 工作区 / 置顶 / 归组等元数据操作的单一入口
  ipcMain.handle('dsh:claude-meta-op', (_event, payload) => {
    try {
      return claudeMetaOp(payload || {});
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // ---- Claude goal mode ----------------------------------------------------
  ipcMain.handle('dsh:claude-goal-get', () => ({ ok: true, goal: goalDriver.view() }));

  ipcMain.handle('dsh:claude-goal-start', (_event, payload) => {
    try {
      return goalDriver.start(payload || {});
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('dsh:claude-goal-pause', () => goalDriver.setPhase('paused'));
  ipcMain.handle('dsh:claude-goal-resume', () => goalDriver.resume());
  ipcMain.handle('dsh:claude-goal-complete', () => goalDriver.setPhase('complete'));
  ipcMain.handle('dsh:claude-goal-clear', () => goalDriver.clear());

  // A bounded IPC surface for the third harness; errors use the same UI shape.
  const kimiHandlers = {
    'get-live': async () => ({ ok: true, live: await kimiSession?.liveState() || null }),
    'get-settings': () => kimiSettings(),
    'save-settings': patch => ({ ok: true, settings: saveKimiSettings(patch || {}) }),
    'list-sessions': async payload => ({ ok: true, ...await kimiWorkspaces.listSessions(payload || {}) }),
    'load-session': async id => ({ ok: true, ...await kimiWorkspaces.transcript(id) }),
    'rename-session': payload => kimiWorkspaces.renameSession(payload.id, payload.title),
    'archive-session': payload => kimiWorkspaces.archiveSession(payload.id, payload.archived !== false),
    'meta-op': payload => kimiWorkspaces.metaOp(payload),
    'send': payload => {
      if (kimiSession?.running) return { ok: false, error: "Wait for the response to finish or stop it before sending another message" };
      const session = ensureKimiSession(kimiSettings(), { sessionId: payload.sessionId || null,
        workspaceId: payload.workspaceId || null, resumeLast: Boolean(payload.resumeLast), fork: Boolean(payload.fork) });
      return session.sendUserMessage(String(payload.prompt || ''), payload.attachments || []) ? { ok: true, runId: session.gen } : { ok: false, error: "Kimi process is unavailable" };
    },
    'cancel': runId => {
      if (kimiSession?.gen === runId) {
        if (kimiGoalDriver.armed) kimiGoalDriver.setPhase('paused');
        kimiSession.interrupt();
      }
      return { ok: true };
    },
    'control-respond': payload => ({ ok: Boolean(kimiSession && !kimiSession.dead && kimiSession.answerPermission(
      payload.requestId, Boolean(payload.allow), payload.input, payload.message, payload.optionId)) }),
    'goal-get': () => ({ ok: true, goal: kimiGoalDriver.view() }),
    'goal-start': payload => kimiGoalDriver.start(payload),
    'goal-pause': () => kimiGoalDriver.setPhase('paused'), 'goal-resume': () => kimiGoalDriver.resume(),
    'goal-complete': () => kimiGoalDriver.setPhase('complete'), 'goal-clear': () => kimiGoalDriver.clear(),
  };
  for (const [name, handler] of Object.entries(kimiHandlers)) ipcMain.handle('dsh:kimi-' + name, async (_event, payload) => {
    try { return await handler(payload); }
    catch (error) { log('kimi-' + name + ': ' + error.message); return { ok: false, error: error.message }; }
  });

  ipcMain.handle('dsh:switch-mode', (_event, mode) => switchMode(mode));

  // Native file picker. `kind` filters the visible file extensions;
  // kind 'directory' switches to a folder picker (workspace paths).
  ipcMain.handle('dsh:pick-file', async (_event, payload) => {
    const kind = payload && payload.kind;
    const filters = (() => {
      if (kind === 'dsh') return [{ name: 'dsh bin.js', extensions: ['js'] }, { name: "All files", extensions: ['*'] }];
      if (kind === 'node' && process.platform === 'win32') return [{ name: 'node.exe', extensions: ['exe'] }, { name: "All files", extensions: ['*'] }];
      return [{ name: "All files", extensions: ['*'] }];
    })();
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);
    const options = {
      properties: kind === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'],
      title: payload && payload.title ? payload.title : (kind === 'directory' ? "Choose folder" : "Choose file"),
      filters,
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] || '' };
  });

  // Multi-select attachment picker for the Claude Code input area.
  ipcMain.handle('dsh:pick-attachments', async () => {
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const options = {
      properties: ['openFile', 'multiSelections'],
      title: "Choose attachments",
      filters: [
        { name: "Images", extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
        { name: "All files", extensions: ['*'] },
      ],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? { canceled: true, paths: [] } : { canceled: false, paths: result.filePaths };
  });

  // Test that the given (or detected) node + dsh actually run.
  ipcMain.handle('dsh:test-runtime', async (_event, payload) => {
    try {
      const config = loadConfig();
      const nodeExe = (payload && payload.nodeExe) ? payload.nodeExe : (config.nodeExe || detectNode());
      const dshBin = (payload && payload.dshBin) ? payload.dshBin : (config.dshBin || detectDshBin());
      if (!nodeExe || !fs.existsSync(nodeExe)) {
        return { ok: false, error: `Node.js not found: ${nodeExe || "(Empty)"}` };
      }
      if (!dshBin || !fs.existsSync(dshBin)) {
        return { ok: false, error: `DSH bin.js not found: ${dshBin || "(Empty)"}` };
      }
      const result = spawnSync(nodeExe, [dshBin, '--version'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
      });
      if (result.error) {
        return { ok: false, error: `Cannot run Node.js: ${result.error.message}` };
      }
      if (result.status !== 0) {
        return { ok: false, error: `dsh --version exited with code ${result.status}: ${(result.stderr || result.stdout || '').trim()}` };
      }
      const version = (result.stdout || '').trim();
      return {
        ok: true,
        detail: `node=${nodeExe}\ndsh=${dshBin}\nVersion=${version || '(unknown)'}`,
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // After saving settings, restart the backend with the new paths/port.
  ipcMain.handle('dsh:apply-settings', async () => {
    try {
      stopBackend();
      if (bootInFlight) { try { await bootInFlight; } catch { /* cancelled startup */ } }
      await startOllamaProxyHandle();
      // Restart DSH only when that is the page the user has chosen.
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
      if (currentMode === 'dsh') await bootToGui();
      return { ok: true };
    } catch (err) {
      log(`apply-settings failed: ${err && err.stack || err}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = loadConfig().theme || 'system';
    setMenu();
    cleanupOpencodeProxyRoute(); // strip the removed OpenCode proxy's stale route
    await startOllamaProxyHandle();
    goalDriver.load();
    kimiGoalDriver.load();
    createMainWindow();
    void refreshAccountBalances();
    switchMode('home');

    // Dev-time hot reload: editing claude.html reloads the Claude view right
    // away (ignored when packaged). Debounced because editors double-fire.
    if (!app.isPackaged) {
      try {
        let reloadTimer = null;
        fs.watch(path.join(RENDERER_ROOT, 'chat'), (_event, filename) => {
          if (!['claude.html', 'claude.css', 'claude.js', 'chat-runtime.js'].includes(String(filename))) return;
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            if (['claude', 'kimi'].includes(currentMode) && mainWindow && !mainWindow.isDestroyed()) {
              log('Claude view changed → hot reload');
              mainWindow.webContents.reloadIgnoringCache();
            }
          }, 400);
        });
      } catch (err) {
        log(`hot reload watcher failed: ${err && err.message}`);
      }
    }

  });

  app.on('window-all-closed', () => {
    // Always quit on all platforms for this single-window app.
    app.quit();
  });

  let kimiClosing = false;
  app.on('before-quit', event => {
    clearTimeout(balanceRefreshTimer);
    claudeSession?.kill();
    goalDriver.cancelTimer();
    kimiGoalDriver.cancelTimer();
    if (kimiSession && !kimiSession.dead && !kimiClosing) {
      event.preventDefault();
      kimiClosing = true;
      void kimiSession.shutdown().finally(() => app.quit());
      return;
    }
    stopBackend();
    stopOllamaProxyHandle();
  });

  app.on('will-quit', () => {
    stopBackend();
    stopOllamaProxyHandle();
  });

  let bootInFlight = null;
  function bootToGui() {
    if (bootInFlight) return bootInFlight;
    const pending = (async () => {
      const started = Date.now();
      const { url } = await startBackend();
      log(`backend ready at ${new URL(url).origin} in ${Date.now() - started}ms`);
      // A background startup must not replace the home panel or another page.
      if (currentMode === 'dsh' && mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(url);
        log(`DSH page loaded in ${Date.now() - started}ms`);
      }
    })();
    bootInFlight = pending;
    return pending.finally(() => { if (bootInFlight === pending) bootInFlight = null; });
  }

  function switchMode(mode) {
    const next = ['home', 'claude', 'kimi'].includes(mode) ? mode : 'dsh';
    if (next !== 'home') saveConfig({ mode: next });
    currentMode = next;
    log(`switch mode → ${next}`);
    // Update window title and menu according to mode
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(next === 'kimi' ? `Kimi Code — ${APP_NAME}` : next === 'claude' ? `${APP_NAME_CLAUDE} — ${APP_NAME}` : APP_NAME);
    }
    setMenu();
    void loadMode(next);
    return { ok: true };
  }

  async function loadMode(next) {
    try {
      if (next === 'dsh') {
        await bootToGui();
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        if (next === 'claude' || next === 'kimi') await runtimes().ensure(next);
        if (currentMode !== next) return;
        await mainWindow.loadFile(path.join(RENDERER_ROOT, next === 'home' ? 'home/home.html' : 'chat/claude.html'),
          next === 'kimi' ? { query: { harness: 'kimi' } } : undefined);
      }
    } catch (err) {
      log(`switch mode failed: ${err && err.stack || err}`);
      if (next === 'claude' || next === 'kimi') openSettingsWindow({ page: 'runtimes', engine: next });
      if (next === 'dsh' && currentMode === 'dsh' && mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml(err, backendUrl)));
      }
    }
  }

  function showCredentials() {
    currentMode = 'setup';
    mainWindow.setTitle(APP_NAME);
    setMenu();
    return mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(welcomeHtml(loadConfig())));
  }

  function setMenu() {
    const template = [
      {
        label: APP_NAME,
        submenu: [
          { label: "About", click: () => dialog.showMessageBox({ type: 'info', title: `About ${APP_NAME}`, message: APP_NAME, detail: `Version ${app.getVersion()}\nBackend: ${backendUrl || "Not started"}` }) },
          { type: 'separator' },
          { label: "Settings…", accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
          { type: 'separator' },
          { label: "Open logs folder", click: () => shell.openPath(logDir()) },
          { type: 'separator' },
          { label: "Quit", role: 'quit' },
        ],
      },
      {
        label: "Engine",
        submenu: [
          { label: "Home", accelerator: 'CmdOrCtrl+Shift+H', click: () => switchMode('home') },
          { type: 'separator' },
          { label: "Switch to DSH", click: () => switchMode('dsh') },
          { label: "Switch to Claude Code", click: () => switchMode('claude') },
          { label: "Switch to Kimi Code", click: () => switchMode('kimi') },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: 'undo', label: "Undo" },
          { role: 'redo', label: "Redo" },
          { type: 'separator' },
          { role: 'cut', label: "Cut" },
          { role: 'copy', label: "Copy" },
          { role: 'paste', label: "Paste" },
          { role: 'selectAll', label: "Select all" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: 'reload', label: "Reload" },
          { type: 'separator' },
          { role: 'zoomIn', label: "Zoom in", accelerator: 'CmdOrCtrl+=' },
          { role: 'zoomOut', label: "Zoom out", accelerator: 'CmdOrCtrl+-' },
          { role: 'resetZoom', label: "Actual size", accelerator: 'CmdOrCtrl+0' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: "Toggle full screen" },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
}
