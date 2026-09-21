'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu, Tray, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApiRouter } = require('../api/api-router.js');
const routerConfig = require('../api/api-router-config.js');
const { ClaudeSession } = require('../engines/claude-session.js');
const { ClaudeHistory } = require('../engines/claude-history.js');
const { readJson, writeJson } = require('../shared/json-store.js');
const { normalizeLanguage, translate } = require('../shared/i18n.js');
const { BackendProcess } = require('./backend-process.js');
const dshConfig = require('../engines/dsh-config.js');
const { ClaudeGoal } = require('../engines/claude-goal.js');
const { createSessionWorkspaces } = require('../engines/session-workspaces.js');
const { KimiSession, kimiSpawnSpec, kimiConnectionSettings, updateKimiConnectionSettings } = require('../engines/kimi-session.js');
const { createKimiAccount } = require('../engines/kimi-account.js');
const { createCodex } = require('../engines/codex');
const { createAntigravity } = require('../engines/antigravity');
const { createProviderInsights } = require('../api/provider-insights.js');
const { createRuntimeManager, ENGINES, run: runtimeRun } = require('./runtime-manager.js');
const { createRuntimeUpdates } = require('./runtime-updates.js');
const { downloadSettings } = require('./download-network.js');
const { createEngineSettings, backup } = require('../engines/engine-settings.js');
const runtimePaths = require('./runtime-paths.js');
const { BenchmarkRunner } = require('../benchmark/runner');
const { createLibraryManager } = require('../benchmark/libraries');
const { SharedConversations, preferences: conversationPreferences } = require('../engines/shared-conversations');
const { createDshChat } = require('../engines/dsh-session');
const { createZoomController, readLegacyZoom } = require('./zoom-controller');
const { saveClipboardImage } = require('./clipboard-attachments');
const { describePreview } = require('./file-preview');
let sharedConversations = null;
function publishChatEvent(engine, event) {
  // Persistence is best-effort here: a failed save must not escape into the
  // engine event pipeline, or one locked file would freeze the conversation.
  try { if (sharedConversations?.capture(engine, event)) return; }
  catch (err) { log(`shared conversation capture failed (${engine}): ${err?.message || err}`); }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:' + engine + '-event', event);
}

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
      logStream.on('error', () => { logStream = null; });
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
    closeToTray: false,     // close button hides to the tray; the model router keeps serving other apps
    mode: 'dsh',            // Last selected agent; startup always opens the home panel.
    claude: {},             // Claude Code GUI settings
    language: 'en',         // Workbench UI language, independent of the engines' prompts.
    downloadProxy: { mode: 'direct', url: '' },
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
function uiText(text) { return translate(text, normalizeLanguage(loadConfig().language)); }

app.commandLine.appendSwitch('lang', normalizeLanguage(loadConfig().language) === 'en' ? 'en-US' : 'zh-CN');

let zoomController;
function desktopZoom() {
  if (!zoomController) {
    const mode = loadConfig().mode;
    const chatUrl = pathToFileURL(path.join(RENDERER_ROOT, 'chat/claude.html'));
    chatUrl.searchParams.set('harness', mode);
    const urls = ['claude', 'codex', 'dsh', 'kimi', 'antigravity'].includes(mode) ? [chatUrl.href] : [];
    if (mode === 'dsh') urls.push('127.0.0.1');
    urls.push(pathToFileURL(path.join(RENDERER_ROOT, 'home/home.html')).href);
    zoomController = createZoomController({ loadConfig, saveConfig, log,
      legacyLevel: readLegacyZoom(path.join(app.getPath('userData'), 'Preferences'), urls) });
  }
  return zoomController;
}

let runtimeManager;
function runtimes() {
  if (!runtimeManager) {
    const root = app.isPackaged ? process.resourcesPath : APP_ROOT;
    const node = detectNode();
    const npm = firstExisting(runtimePaths.npmCandidates(node, { resourcesPath: app.isPackaged ? root : undefined, env: process.env }));
    runtimeManager = createRuntimeManager({ root, installRoot: app.getPath('userData'), node, npm,
      downloadOptions: chooseDownloadConnection,
      runtimeMode: engine => engine === 'antigravity' ? antigravity.settings().connection : 'api',
      onChange: state => {
        for (const window of [mainWindow, settingsWindow]) if (window && !window.isDestroyed()) window.webContents.send('dsh:runtime-state', state);
      } });
  }
  return runtimeManager;
}
async function chooseDownloadConnection(engine) {
  const saved = downloadSettings(loadConfig().downloadProxy);
  const hasProxy = Boolean(saved.url);
  const buttons = hasProxy ? ['Download with proxy', 'Download directly', 'Proxy settings', 'Cancel']
    : ['Download directly', 'Set up proxy', 'Cancel'];
  const { response } = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || mainWindow, {
    type: 'question', title: uiText(`Download ${ENGINES[engine].name}`), message: uiText(`How would you like to download ${ENGINES[engine].name}?`),
    detail: uiText(hasProxy ? `Saved proxy: ${new URL(saved.url).origin}\nManage the download connection in Settings → Runtime.`
      : 'No download proxy is configured. You can add your own proxy in Settings → Runtime.'),
    buttons: buttons.map(uiText), defaultId: hasProxy && saved.mode === 'direct' ? 1 : 0, cancelId: buttons.length - 1,
    noLink: true,
  });
  if (response === buttons.length - 2) openSettingsWindow({ page: 'runtimes', focus: 'downloadProxyUrl' });
  if (response >= buttons.length - 2) throw Object.assign(new Error('Download cancelled'), { code: 'DOWNLOAD_CANCELLED' });
  return { ...saved, mode: hasProxy && response === 0 ? 'proxy' : 'direct' };
}
let runtimeUpdatesService;
function runtimeUpdates() {
  if (!runtimeUpdatesService) {
    const root = app.isPackaged ? process.resourcesPath : APP_ROOT;
    const node = detectNode();
    const npm = firstExisting(runtimePaths.npmCandidates(node, { resourcesPath: app.isPackaged ? root : undefined, env: process.env }));
    runtimeUpdatesService = createRuntimeUpdates({ manager: runtimes(), engines: ENGINES, node, npm, run: runtimeRun,
      downloadSettings: () => loadConfig().downloadProxy,
      promptRestart: promptRuntimeRestart,
      log });
  }
  return runtimeUpdatesService;
}
async function promptRuntimeRestart(name, from, to) {
  const { response } = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || mainWindow, {
    type: 'info', title: uiText('Restart required'),
    message: uiText(`${name} was updated to v${to}. Restart Camellia to use the new version.`),
    buttons: [uiText('Later'), uiText('Restart now')], defaultId: 1, cancelId: 0, noLink: true,
  });
  if (response !== 1) return false;
  app.relaunch();
  app.exit(0);
  return true;
}
function runtimeEnvironment(node, engine) {
  const root = app.isPackaged ? process.resourcesPath : APP_ROOT;
  const runtime = runtimes().locate(engine);
  const paths = [node && path.dirname(node), path.join(root, 'runtime/npm/bin'), runtime && path.join(runtime.dir, 'node_modules/.bin')].filter(Boolean);
  return { ...process.env, PATH: paths.concat(process.env.PATH || '').join(path.delimiter) };
}

let benchmarkRunner;
let benchmarkLibraryManager;
function benchmarkLibraries() {
  if (!benchmarkLibraryManager) benchmarkLibraryManager = createLibraryManager({
    directory: path.join(app.getPath('userData'), 'benchmark-libraries'),
    downloadOptions: () => downloadSettings(loadConfig().downloadProxy),
    onChange: () => benchmarkRunner?.emit(true),
  });
  return benchmarkLibraryManager;
}
function benchmarks() {
  if (!benchmarkRunner) benchmarkRunner = new BenchmarkRunner({ directory: path.join(app.getPath('userData'), 'benchmarks'),
    runtimes, node: detectNode, getRouter: () => ollamaProxyHandle, libraries: benchmarkLibraries(),
    onChange: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:benchmark-state', state); } });
  return benchmarkRunner;
}
let nativeSettings;
function engineSettings() {
  if (!nativeSettings) nativeSettings = createEngineSettings({ home: os.homedir(),
    claudeHome: process.env.CLAUDE_CONFIG_DIR,
    dshHome: () => loadConfig().dshHome || DSH_HOME,
    kimiHome: process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'),
    antigravityHome: antigravity.home, codexHome: codex.home,
    getDesktop: engine => engine === 'codex' ? codex.settings() : engine === 'antigravity' ? antigravity.settings() : engine === 'kimi' ? kimiSettings() : engine === 'claude' ? claudeSettings() : {},
    saveDesktop: (engine, value) => engine === 'codex' ? codex.saveSettings(value) : engine === 'antigravity' ? antigravity.saveSettings(value) : engine === 'kimi' ? saveKimiSettings(value) : engine === 'claude' ? saveClaudeSettings(value) : undefined,
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
    onChange: broadcastAccountInsights,
  });
  return providerInsights;
}
function accountInsights(state = insights().state()) {
  const kimi = kimiAccount.state();
  return { ...state, subscriptions: kimi.account ? [{ id: 'kimi-subscription', engine: 'kimi', name: 'Kimi Code',
    label: 'Kimi account', info: kimi.usage, capability: { supported: true, label: 'Kimi Code subscription quota', source: 'client' } }] : [] };
}
function broadcastAccountInsights(state) {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('dsh:provider-insights', accountInsights(state));
}
async function refreshInsights(payload = {}) {
  await Promise.all([
    payload.subscriptionId ? null : insights().refresh(payload),
    !payload.providerId && !payload.keyId && (!payload.subscriptionId || payload.subscriptionId === 'kimi-subscription')
      ? kimiAccount.refreshUsage({ force: payload.force !== false }) : null,
  ]);
  return accountInsights();
}
function refreshAccountBalances() {
  clearTimeout(balanceRefreshTimer);
  if (loadConfig().autoRefreshBalances !== false) {
    try { void refreshInsights({ force: false }).catch(e => log(`account refresh: ${e.message}`)); } catch (e) { log(`account refresh: ${e.message}`); }
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
  if (benchmarkRunner?.pending) throw new Error('Stop the benchmark before changing API routes so all engines use the same configuration');
  const prev = readOllamaProxyConfig();
  const next = routerConfig.normalizeConfig(payload, prev);
  const restartClient = prev.port !== next.port || routerConfig.hasRoutes(prev) !== routerConfig.hasRoutes(next);
  if (restartClient && (sharedConversations?.isBusy() || codex.session?.running || claudeSessions.legacy?.running || kimiSessions.legacy?.running || antigravity.session?.running || ollamaProxyHandle?.getState().activeRequests)) {
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
  if (restartClient) await claudeSessions.shutdown();
  if (restartClient) await kimiSessions.shutdown();
  if (restartClient) { await antigravity.shutdown(); await codex.shutdown(); await dshChat.shutdown(); }
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
const { SessionPool } = require('../engines/session-pool');
const { nativeMode } = require('../engines/permission-levels');
const claudeSessions = new SessionPool();

// Build spawn args/env for one persistent claude process.
// opts: { sessionId?: string, fork?: boolean }
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
  }
  if (settings.permissionMode) { const mode = nativeMode('claude', settings.permissionMode); if (mode !== 'default') args.push('--permission-mode', mode); }
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
  const settingsPath = writeClaudeSettingsOverlay(overlayEnv, opts.conversationId);
  args.push('--settings', settingsPath);
  return { args, env: { ...runtimeEnvironment(detectNode(), 'claude'), ...overlayEnv }, cwd: settings.cwd || undefined };
}

// Pin workbench routing without changing the user's Claude CLI configuration.
function writeClaudeSettingsOverlay(overlayEnv, conversationId) {
  const file = path.join(app.getPath('userData'), 'claude-profiles', (conversationId || 'legacy') + '.settings.json');
  writeJson(file, { env: overlayEnv });
  log(`claude: settings overlay → ${file} (baseURL=${overlayEnv.ANTHROPIC_BASE_URL})`);
  return file;
}

// All harness API credentials belong to the workbench router.
function managedClaudeModelEnv(model) {
  return { ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model };
}
function modelContextWindow(model) {
  for (const p of readOllamaProxyConfig().providers || []) for (const m of p.models || []) if (m.id === model && m.contextWindow) return m.contextWindow;
}
function resolveClaudeRoute() {
  const cfg = readOllamaProxyConfig();
  if (!routerConfig.hasRoutes(cfg)) throw new Error("Enable API routing and configure a model and key in Camellia settings");
  if (ollamaProxyHandle && !ollamaProxyHandle.getState().running) throw new Error(ollamaProxyHandle.getState().error || "The API router has not started");
  return { baseUrl: `http://127.0.0.1:${cfg.port}`, authToken: 'proxy-managed' };
}

// Fields that require a fresh process when changed (mid-session switching is
// not possible for model/effort/permission via the stream-json control API we use).
function sessionSettingsEqual(a, b) {
  return CLAUDE_SETTING_FIELDS.every((k) => String(a[k] || '') === String(b[k] || ''));
}

// Ensure a live session matching the requested settings; respawn when the
// conversation id changes or a locking setting changed mid-conversation.
function ensureClaudeSession(settings, opts) {
  const current = claudeSessions.get(opts);
  opts = { ...opts };
  const context = opts.cwd ? { cwd: opts.cwd, workspaceId: null } : resolveClaudeSessionContext(settings, opts);
  settings = { ...settings, cwd: context.cwd };
  opts.workspaceId = context.workspaceId;
  if (settings.cwd === claudeStandaloneCwd({})) fs.mkdirSync(settings.cwd, { recursive: true });
  if (!fs.existsSync(settings.cwd) || !fs.statSync(settings.cwd).isDirectory()) throw new Error("Working directory does not exist. Check the folder or move the session out of its workspace: " + settings.cwd);
  if (current && !current.dead) {
    // The live conversation id: whatever init reported, else the resume target.
    const liveConvId = current.sessionId || current.opts.sessionId || null;
    const wantConvId = opts.sessionId || null;
    const sameConversation = liveConvId === wantConvId;
    if (sameConversation && !opts.fork && current.opts.workspaceId === opts.workspaceId && sessionSettingsEqual(current.settings, settings)) {
      return current;
    }
  }
  // The selected ID is the resume target, including after a settings change.
  // An absent ID starts a new conversation.
  const sessionOpts = { sessionId: opts.sessionId || null, fork: Boolean(opts.fork), workspaceId: opts.workspaceId, conversationId: opts.conversationId, lockPermissionMode: true };
  // Validate the new route before retiring the current conversation process.
  const spec = claudeSpawnSpec(settings, sessionOpts);
  const exe = detectClaudeExe();
  if (current) current.kill();
  const session = new ClaudeSession({
    gen: ++claudeGen, settings, opts: sessionOpts, exe, spec, spawn, log,
    setTimer: setTimeout, clearTimer: clearTimeout,
    onEvent: event => {
      if (claudeSessions.get(opts) === session) publishChatEvent('claude', { ...event, conversationId: opts.conversationId });
    },
    onSessionId: id => {
      if (!opts.conversationId && claudeSessions.legacy === session) {
        recordClaudeSessionContext(id, sessionOpts.workspaceId, settings.cwd);
        goalDriver.rememberSession(session);
      }
    },
    onResult: event => { if (!opts.conversationId && claudeSessions.legacy === session) goalDriver.handleResult(event); },
  });
  claudeSessions.set(opts, session);
  try { session.start(); } catch (err) { session.kill(); throw err; }
  return session;
}

// ---------------------------------------------------------------------------
// Claude session history (~/.claude/projects/<cwd-key>/*.jsonl)
// ---------------------------------------------------------------------------
const claudeHistory = new ClaudeHistory(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'));
const findClaudeSessionFile = id => claudeHistory.find(id);

const claudeStandaloneCwd = settings => settings.cwd || path.join(app.getPath('userData'), 'claude-sessions');
const claudeWorkspaces = createSessionWorkspaces({
  history: claudeHistory, loadConfig, saveConfig, metaKey: 'claudeMeta', settingsKey: 'claude',
  standaloneCwd: claudeStandaloneCwd, getSession: () => claudeSessions.legacy,
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
  getSession: () => claudeSessions.legacy,
  ensureSession: opts => ensureClaudeSession(claudeSettings(), opts),
  resolveWorkspace: payload => resolveClaudeSessionContext(claudeSettings(), payload).workspaceId,
  onChange: goal => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:claude-goal', goal);
  },
  log, setTimer: setTimeout, clearTimer: clearTimeout,
});

// Kimi Code uses its own runtime and data directory, with shared UI metadata.
const kimiSessions = new SessionPool();
let kimiGen = 0;
const kimiHistory = new ClaudeHistory(path.join(app.getPath('userData'), 'kimi-history'));
const kimiStandaloneCwd = settings => settings.cwd || path.join(app.getPath('userData'), 'kimi-sessions');
const kimiWorkspaces = createSessionWorkspaces({
  history: kimiHistory, loadConfig, saveConfig, metaKey: 'kimiMeta', settingsKey: 'kimi',
  standaloneCwd: kimiStandaloneCwd, getSession: () => kimiSessions.legacy,
  onDetach: id => kimiGoalDriver.detachWorkspace(id), fixedCwd: true,
});
function kimiSettings(sessionId) {
  return kimiConnectionSettings(loadConfig(), sessionId);
}
function saveKimiSettings(patch) {
  saveConfig({ kimi: updateKimiConnectionSettings(loadConfig(), patch) });
  return kimiSettings(patch.sessionId);
}
function ensureKimiSession(settings, opts) {
  const current = kimiSessions.get(opts);
  const context = opts.cwd ? { cwd: opts.cwd, workspaceId: null } : kimiWorkspaces.resolveContext(settings, opts);
  settings = { ...settings, cwd: context.cwd };
  opts = { ...opts, workspaceId: context.workspaceId };
  if (settings.cwd === kimiStandaloneCwd({})) fs.mkdirSync(settings.cwd, { recursive: true });
  if (!fs.existsSync(settings.cwd) || !fs.statSync(settings.cwd).isDirectory()) throw new Error("Working directory does not exist: " + settings.cwd);
  if (!settings.model) throw new Error("Select a configured model in the composer first");
  const subscription = settings.connection === 'subscription';
  const account = kimiAccount.state();
  if (account.loginPending || account.refreshing || account.signingOut) throw new Error('Wait for the Kimi account operation to finish');
  let route;
  if (subscription) {
    if (!account.account) throw new Error('Sign in with Kimi in Settings → Engine Settings → Kimi Code first');
    if (!account.models.some(model => model.id === settings.model)) throw new Error('Refresh the Kimi account and select an available model');
  } else {
    settings.model = routerConfig.modelId(settings.model);
    route = resolveClaudeRoute();
    if (!routerConfig.publicState(readOllamaProxyConfig()).models.includes(settings.model)) throw new Error("No route is available for this model. Add one in Camellia settings.");
    const configuredContext = modelContextWindow(settings.model);
    if (configuredContext) settings.contextWindow = configuredContext;
  }
  if (current && !current.dead && !opts.fork && current.sessionId === (opts.sessionId || null)
      && current.opts.workspaceId === opts.workspaceId && sessionSettingsEqual(current.settings, settings)
      && current.settings.contextWindow === settings.contextWindow && current.settings.connection === settings.connection) return current;
  const runtime = runtimes().locate('kimi')?.file;
  if (!runtime) throw new Error("Kimi is being prepared. Check progress or retry in Settings → Runtime.");
  const exe = detectNode();
  if (!exe) throw new Error("Kimi Code requires Node.js 22.19 or later. Configure the runtime in settings.");
  const spec = kimiSpawnSpec({ home: path.join(app.getPath('userData'), subscription ? 'kimi-subscription' : 'kimi-code',
      ...(!subscription && opts.conversationId ? ['conversations', opts.conversationId] : [])),
    sharedSubscription: Boolean(opts.conversationId), runtime, route, connection: settings.connection,
    model: settings.model, contextWindow: settings.contextWindow, env: runtimeEnvironment(exe, 'kimi'), ...engineSettings().kimiConfig() });
  const previousClosed = current?.shutdown();
  const session = new KimiSession({ gen: ++kimiGen, settings, opts, exe, spec, spawn, log, history: kimiHistory,
    onEvent: event => {
      if (kimiSessions.get(opts) === session) publishChatEvent('kimi', { ...event, conversationId: opts.conversationId });
    },
    onSessionId: id => {
      saveConfig({ kimiSessionConnections: { ...loadConfig().kimiSessionConnections, [id]: settings.connection || 'api' } });
      kimiWorkspaces.recordContext(id, opts.workspaceId, settings.cwd);
      if (!opts.conversationId) kimiGoalDriver.rememberSession(session);
    },
    onResult: event => { if (!opts.conversationId && kimiSessions.legacy === session) kimiGoalDriver.handleResult(event); },
  });
  kimiSessions.set(opts, session);
  try { session.start(previousClosed); } catch (err) { session.kill(); throw err; }
  return session;
}
const kimiGoalDriver = new ClaudeGoal({
  file: () => path.join(app.getPath('userData'), 'kimi-goal.json'), getSession: () => kimiSessions.legacy,
  ensureSession: opts => ensureKimiSession(kimiSettings(opts.sessionId), opts),
  resolveWorkspace: payload => kimiWorkspaces.resolveContext(kimiSettings(), payload).workspaceId,
  onChange: goal => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:kimi-goal', goal);
  },
  log, setTimer: setTimeout, clearTimer: clearTimeout,
});

const kimiAccount = createKimiAccount({ home: path.join(app.getPath('userData'), 'kimi-subscription'),
  runtime: () => runtimes().locate('kimi'), ensureRuntime: () => runtimes().ensure('kimi'), node: detectNode,
  environment: () => runtimeEnvironment(detectNode(), 'kimi'), region: () => kimiSettings().region,
  isBusy: () => kimiSessions.legacy?.running || kimiGoalDriver.armed || sharedConversations?.isBusy('kimi'),
  openExternal: url => shell.openExternal(url),
  onModels: models => {
    if (!kimiSettings().subscriptionModel && models.length) saveConfig({ kimi: { ...loadConfig().kimi, subscriptionModel: (models.find(model => model.isDefault) || models[0]).id } });
  },
  onChange: account => {
    broadcastAccountInsights();
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) {
      window.webContents.send('dsh:kimi-account', account);
      window.webContents.send('dsh:engine-settings-changed', { engine: 'kimi' });
    }
  },
});

const codex = createCodex({ dataDir: app.getPath('userData'), loadConfig, saveConfig,
  getRoute: resolveClaudeRoute, getModels: () => routerConfig.publicState(readOllamaProxyConfig()).models,
  getContextWindow: modelContextWindow,
  runtimes, log, environment: () => runtimeEnvironment(detectNode(), 'codex'), openExternal: url => shell.openExternal(url),
  isBusy: () => sharedConversations?.isBusy('codex'),
  onEvent: event => publishChatEvent('codex', event),
  onGoal: goal => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:codex-goal', goal); },
  onAccount: account => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) {
      window.webContents.send('dsh:codex-account', account);
      window.webContents.send('dsh:engine-settings-changed', { engine: 'codex' });
    }
    if (nativeSettingsView && !nativeSettingsView.webContents.isDestroyed()) nativeSettingsView.webContents.send('dsh:codex-account', account);
  },
});

const antigravity = createAntigravity({ dataDir: app.getPath('userData'), loadConfig, saveConfig,
  cliSettingsFile: path.join(os.homedir(), '.gemini/antigravity-cli/settings.json'), node: detectNode,
  openLogin: (file, env) => new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    // A detached child started with ignored stdio gets no console on Windows:
    // the script never runs and no terminal appears. Route through `start` so
    // PowerShell gets a real console window (and the CLI a TTY for OAuth).
    const systemRoot = process.env.SystemRoot || 'C:\Windows';
    const child = windows
      ? spawn(path.join(systemRoot, 'System32/cmd.exe'),
        ['/d', '/c', 'start', '""', path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        { env, detached: true, windowsHide: true, stdio: 'ignore' })
      : spawn('/usr/bin/open', ['-a', 'Terminal', file], { env, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  }),
  getRoute: resolveClaudeRoute, getModels: () => routerConfig.publicState(readOllamaProxyConfig()).models,
  runtimes, log, environment: () => runtimeEnvironment(detectNode(), 'antigravity'),
  isBusy: () => sharedConversations?.isBusy('antigravity'),
  onEvent: event => publishChatEvent('antigravity', event),
  onGoal: goal => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:antigravity-goal', goal); },
});

const dshChat = createDshChat({ dataDir: app.getPath('userData'), loadConfig, saveConfig, getRoute: resolveClaudeRoute,
  getModels: () => routerConfig.publicState(readOllamaProxyConfig()).models,
  runtime: () => ({ file: detectDshBin() }), node: detectNode, environment: () => runtimeEnvironment(detectNode(), 'dsh'),
  onEvent: event => publishChatEvent('dsh', event), log });
sharedConversations = new SharedConversations({ dir: path.join(app.getPath('userData'), 'conversations'), loadConfig, saveConfig, log, modelContextWindow,
  drivers: {
    claude: { history: claudeHistory, settings: claudeSettings, saveSettings: saveClaudeSettings, ensure: opts => ensureClaudeSession({ ...claudeSettings(), ...opts.settings }, opts) },
    kimi: { history: kimiHistory, settings: kimiSettings, saveSettings: saveKimiSettings, ensure: opts => ensureKimiSession({ ...kimiSettings(opts.sessionId), ...opts.settings }, opts) },
    codex: { history: codex.history, settings: codex.settings, saveSettings: codex.saveSettings, ensure: codex.ensureSession },
    antigravity: { history: antigravity.history, settings: antigravity.settings, saveSettings: antigravity.saveSettings, ensure: antigravity.ensureSession },
    dsh: dshChat,
  },
  prepare: async (engine, settings) => {
    if (engine !== 'dsh' || !loadConfig().dshBin) await runtimes().ensure(engine, settings?.connection);
  },
  onEvent: event => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:conversation-event', event); },
  onGoal: goal => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:conversation-goal', goal); },
  onStatus: status => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:conversation-status', status); },
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
// Engine status for About dialog
// ---------------------------------------------------------------------------
// Chat runs on per-engine ACP/CLI sessions, not on the lazy `dsh web` backend
// above, so the About dialog reports the live session state instead.
function engineStatusText() {
  const pools = [
    ['claude', 'Claude Code', claudeSessions],
    ['codex', 'Codex CLI', codex.sessions],
    ['dsh', 'DSH', dshChat.sessions],
    ['kimi', 'Kimi Code', kimiSessions],
    ['antigravity', 'Antigravity', antigravity.sessions],
  ];
  const state = pool => (pool.running ? 'responding' : pool.active ? 'session idle' : 'not started');
  const current = pools.find(([id]) => id === currentMode);
  if (current) return `${current[1]}: ${state(current[2])}`;
  const active = pools.filter(([, , pool]) => pool.active);
  return active.length ? active.map(([, label, pool]) => `${label}: ${state(pool)}`).join(', ') : 'no engine running';
}

// ---------------------------------------------------------------------------
// Window helpers / UI
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let appQuitting = false;
let currentMode = 'home';

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
      zoomFactor: desktopZoom().factor,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  desktopZoom().attach(settingsWindow.webContents);
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
      zoomFactor: desktopZoom().factor,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  desktopZoom().attach(mainWindow.webContents);

  mainWindow.on('close', event => {
    if (!appQuitting && loadConfig().closeToTray) { event.preventDefault(); mainWindow.hide(); }
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
  app.on('second-instance', () => showMainWindow());

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
      if (!loadConfig().dshBin && !runtimes().locate('dsh')) return { ok: false, needsRuntime: true,
        error: 'Download DeepSeek Harness from Settings → Runtime to use its native panel.' };
      if (!nativeSettingsView) {
        // The DSH settings UI is laid out for a full workbench window. Embed it one
        // zoom step finer so its density matches the surrounding settings panel.
        nativeSettingsView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
          zoomFactor: desktopZoom().factorAt(-1), nodeIntegration: false, additionalArguments: ['--workbench-settings'] } });
        desktopZoom().attach(nativeSettingsView.webContents, -1);
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

  const engineBusy = engine => sharedConversations.isBusy(engine)
    || (engine === 'codex' && (codex.session?.running || codex.goal.armed))
    || (engine === 'claude' && (claudeSessions.legacy?.running || goalDriver.armed))
    || (engine === 'kimi' && (kimiSessions.legacy?.running || kimiGoalDriver.armed))
    || (engine === 'antigravity' && (antigravity.session?.running || antigravity.goal.armed));
  for (const [name, handler] of Object.entries({
    'benchmark-state': () => ({ ok: true, ...benchmarks().state() }),
    'benchmark-start': async payload => ({ ok: true, ...await benchmarks().start(payload) }),
    'benchmark-cancel': () => benchmarks().cancel(),
    'benchmark-report': ({ id }) => ({ ok: true, report: benchmarks().report(id) }),
    'benchmark-delete': ({ id }) => benchmarks().deleteReport(id),
    'benchmark-install': async ({ engine }) => {
      if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity'].includes(engine)) throw new Error('Unknown benchmark engine');
      if (benchmarkRunner?.pending) throw new Error('Stop the benchmark before downloading an engine');
      await runtimes().ensure(engine, 'api');
      return { ok: true, ...benchmarks().state() };
    },
    'benchmark-prepare-library': async ({ library }) => {
      if (benchmarkRunner?.pending) throw new Error('Stop the benchmark before preparing a question library');
      await benchmarkLibraries().ensure(library);
      return { ok: true, ...benchmarks().state() };
    },
    'benchmark-export': async ({ id }) => {
      const report = benchmarks().report(id);
      const result = await dialog.showSaveDialog(mainWindow, { title: uiText('Export benchmark report'),
        defaultPath: `camellia-bench-${report.startedAt.slice(0, 10)}-${id.slice(0, 8)}.json`, filters: [{ name: 'JSON report', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      writeJson(result.filePath, report);
      return { ok: true };
    },
    'api-router-export': async () => {
      const cfg = readOllamaProxyConfig();
      // Full-fidelity export: providers, endpoints and raw keys. Subscriptions
      // are device-local by design and are never included.
      const bundle = { format: 'camellia-api-routes', version: 2, exportedAt: new Date().toISOString(),
        config: { enabled: cfg.enabled, port: cfg.port, providers: cfg.providers } };
      const result = await dialog.showSaveDialog(settingsWindow || mainWindow, { title: uiText('Export API route configuration'),
        defaultPath: `camellia-api-routes-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON configuration', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      writeJson(result.filePath, bundle);
      return { ok: true, keys: cfg.providers.reduce((n, p) => n + p.keys.length, 0) };
    },
    'api-router-import': async () => {
      const result = await dialog.showOpenDialog(settingsWindow || mainWindow, { title: uiText('Import API route configuration'),
        filters: [{ name: 'JSON configuration', extensions: ['json'] }], properties: ['openFile'] });
      if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };
      const bundle = readJson(result.filePaths[0], null);
      if (bundle?.format !== 'camellia-api-routes' || !bundle.config || !Array.isArray(bundle.config.providers)) {
        throw new Error('This file is not a Camellia API route export');
      }
      const prev = readOllamaProxyConfig();
      // Keep live usage counters and per-model active route state; replace the rest.
      const imported = routerConfig.normalizeConfig({ ...bundle.config, usage: prev.usage, active: prev.active }, prev);
      const saved = await saveApiRouter(imported);
      return { ...saved, providers: imported.providers.length };
    },
    'engine-settings-get': ({ engine }) => ({ ok: true, ...engineSettings().get(engine) }),
    'engine-settings-save': async ({ engine, ...payload }) => {
      if (engineBusy(engine)) throw new Error("Stop the current response or goal before changing global settings");
      const result = engineSettings().save(engine, payload);
      if (engine === 'claude') await claudeSessions.shutdown();
      if (engine === 'kimi') await kimiSessions.shutdown();
      if (engine === 'antigravity') await antigravity.shutdown();
      if (engine === 'codex') await codex.shutdown();
      if (engine === 'dsh') { await dshChat.shutdown(); syncOllamaBaseUrl(Boolean(ollamaProxyHandle?.getState().running)); }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:engine-settings-changed', { engine });
      return { ok: true, ...result };
    },
    'runtime-state': () => ({ ok: true, engines: runtimes().state() }),
    'runtime-ensure': async ({ engine }) => ({ ok: true, runtime: await runtimes().ensure(engine) }),
    'runtime-check-updates': async () => ({ ok: true, engines: await runtimeUpdates().check() }),
    'runtime-update': async ({ engine }) => {
      if (engineBusy(engine)) throw new Error('Stop conversations using this engine before updating it');
      return runtimeUpdates().update(engine);
    },
    'download-settings': () => ({ ok: true, ...downloadSettings(loadConfig().downloadProxy) }),
    'download-save-settings': payload => {
      const settings = downloadSettings(payload);
      saveConfig({ downloadProxy: settings });
      return { ok: true, ...settings };
    },
  })) ipcMain.handle('dsh:' + name, async (_event, payload) => {
    try { return await handler(payload || {}); } catch (error) {
      return error.code === 'DOWNLOAD_CANCELLED' ? { ok: true, canceled: true } : { ok: false, error: error.message };
    }
  });

  ipcMain.handle('dsh:zoom-by-wheel', (_event, direction) => {
    try { return desktopZoom().adjust(direction); }
    catch (error) { return { ok: false, error: error.message }; }
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
    'provider-insights': () => accountInsights(),
    'provider-refresh': payload => refreshInsights(payload),
    'provider-models': payload => insights().models(payload),
    'provider-verify': payload => insights().verify(payload),
  })) ipcMain.handle('dsh:' + channel, async (_event, payload) => {
    try { return await handler(payload); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dsh:workbench-settings', () => ({ ok: true, language: normalizeLanguage(loadConfig().language), theme: loadConfig().theme || 'system',
    conversations: conversationPreferences(loadConfig()), autoRefreshBalances: loadConfig().autoRefreshBalances !== false, closeToTray: loadConfig().closeToTray === true,
    dataPath: app.getPath('userData'), version: app.getVersion() }));
  ipcMain.handle('dsh:workbench-save-settings', (_event, payload) => {
    try {
      const theme = ['system', 'light', 'dark'].includes(payload?.theme) ? payload.theme : 'system';
      const language = normalizeLanguage(payload?.language ?? loadConfig().language);
      const patch = { theme, language, autoRefreshBalances: payload?.autoRefreshBalances !== false };
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'closeToTray')) patch.closeToTray = payload.closeToTray === true;
      saveConfig(patch);
      if (payload?.conversations) saveConfig({ conversations: conversationPreferences({ conversations: payload.conversations }) });
      nativeTheme.themeSource = theme;
      setMenu();
      refreshTrayMenu();
      for (const window of [mainWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send('dsh:language-changed', language);
      }
      if (nativeSettingsView) nativeSettingsView.webContents.send('dsh:language-changed', language);
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
      if (claudeSessions.legacy && claudeSessions.legacy.running) return { ok: false, error: "Wait for the response to finish or stop it before sending another message" };
      const settings = (payload && payload.settings) || claudeSettings();
      const session = ensureClaudeSession(settings, {
        sessionId: (payload && payload.sessionId) || null,
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
    if (claudeSessions.legacy && !claudeSessions.legacy.dead && claudeSessions.legacy.gen === _runId) claudeSessions.legacy.interrupt();
    return { ok: true };
  });

  ipcMain.handle('dsh:claude-control-respond', (_event, payload) => {
    if (!claudeSessions.legacy || claudeSessions.legacy.dead || !payload || !payload.requestId) return { ok: false };
    return { ok: claudeSessions.legacy.answerPermission(payload.requestId, Boolean(payload.allow), payload.input, payload.message) };
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

  const claudeCommands = {
    'get-settings': claudeSettings,
    'save-settings': patch => ({ ok: true, settings: saveClaudeSettings(patch) }),
    'rename-session': payload => renameClaudeSession(payload.id, payload.title),
    'archive-session': payload => archiveClaudeSession(payload.id, payload.archived !== false),
    'meta-op': claudeMetaOp,
    'goal-get': () => ({ ok: true, goal: goalDriver.view() }),
    'goal-start': payload => goalDriver.start(payload),
    'goal-pause': () => goalDriver.setPhase('paused'),
    'goal-resume': () => goalDriver.resume(),
    'goal-complete': () => goalDriver.setPhase('complete'),
    'goal-clear': () => goalDriver.clear(),
  };
  for (const [name, handler] of Object.entries(claudeCommands)) ipcMain.handle('dsh:claude-' + name, (_event, payload) => {
    try { return handler(payload || {}); }
    catch (error) { return { ok: false, error: error.message }; }
  });

  // A bounded IPC surface for the third harness; errors use the same UI shape.
  const kimiHandlers = {
    'get-live': async () => ({ ok: true, live: await kimiSessions.legacy?.liveState() || null }),
    'get-settings': payload => kimiSettings(payload?.sessionId),
    'save-settings': patch => ({ ok: true, settings: saveKimiSettings(patch || {}) }),
    'list-sessions': async payload => ({ ok: true, ...await kimiWorkspaces.listSessions(payload || {}) }),
    'load-session': async id => ({ ok: true, ...await kimiWorkspaces.transcript(id), settings: kimiSettings(id) }),
    'rename-session': payload => kimiWorkspaces.renameSession(payload.id, payload.title),
    'archive-session': payload => kimiWorkspaces.archiveSession(payload.id, payload.archived !== false),
    'meta-op': payload => kimiWorkspaces.metaOp(payload),
    'send': async payload => {
      if (kimiSessions.legacy?.running) return { ok: false, error: "Wait for the response to finish or stop it before sending another message" };
      const sessionId = payload.sessionId || null;
      const session = ensureKimiSession(kimiSettings(sessionId), { sessionId,
        workspaceId: payload.workspaceId || null, fork: Boolean(payload.fork) });
      return session.sendUserMessage(String(payload.prompt || ''), payload.attachments || []) ? { ok: true, runId: session.gen } : { ok: false, error: "Kimi process is unavailable" };
    },
    'cancel': runId => {
      if (kimiSessions.legacy?.gen === runId) {
        if (kimiGoalDriver.armed) kimiGoalDriver.setPhase('paused');
        kimiSessions.legacy.interrupt();
      }
      return { ok: true };
    },
    'control-respond': payload => ({ ok: Boolean(kimiSessions.legacy && !kimiSessions.legacy.dead && kimiSessions.legacy.answerPermission(
      payload.requestId, Boolean(payload.allow), payload.input, payload.message, payload.optionId)) }),
    'goal-get': () => ({ ok: true, goal: kimiGoalDriver.view() }),
    'goal-start': payload => kimiGoalDriver.start(payload),
    'goal-pause': () => kimiGoalDriver.setPhase('paused'), 'goal-resume': () => kimiGoalDriver.resume(),
    'goal-complete': () => kimiGoalDriver.setPhase('complete'), 'goal-clear': () => kimiGoalDriver.clear(),
    'account-state': () => ({ ok: true, ...kimiAccount.state() }),
    'account-refresh': async () => ({ ok: true, ...await kimiAccount.refresh() }),
    'sign-in': async () => {
      if (kimiSessions.legacy && !kimiSessions.legacy.running && !kimiGoalDriver.armed) { await kimiSessions.legacy.shutdown(); kimiSessions.legacy = null; }
      return { ok: true, ...await kimiAccount.signIn() };
    },
    'cancel-login': async () => ({ ok: true, ...await kimiAccount.cancelLogin() }),
    'open-login': async () => ({ ok: true, ...await kimiAccount.openLogin() }),
    'sign-out': async () => {
      if (kimiSessions.legacy?.running || kimiGoalDriver.armed || sharedConversations.isBusy('kimi')) throw new Error('Stop the Kimi response or goal before signing out');
      await kimiSessions.shutdown();
      return { ok: true, ...await kimiAccount.signOut() };
    },
  };
  for (const [name, handler] of Object.entries(kimiHandlers)) ipcMain.handle('dsh:kimi-' + name, async (_event, payload) => {
    try { return await handler(payload); }
    catch (error) { log('kimi-' + name + ': ' + error.message); return { ok: false, error: error.message }; }
  });

  for (const [engine, instance] of Object.entries({ codex, antigravity })) for (const [name, handler] of Object.entries(instance.handlers)) ipcMain.handle('dsh:' + engine + '-' + name, async (_event, payload) => {
    try {
      const result = await handler(payload);
      if (name === 'account-refresh' && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:engine-settings-changed', { engine });
      return result;
    } catch (error) { return error.code === 'DOWNLOAD_CANCELLED' ? { ok: true, canceled: true } : { ok: false, error: error.message }; }
  });

  ipcMain.handle('dsh:switch-mode', (_event, mode) => navigateMode(mode));
  ipcMain.handle('dsh:conversation-command', async (_event, { engine, action, payload }) => {
    try { return await sharedConversations.command(engine, action, payload); }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:conversation-switch', async (_event, payload) => {
    try {
      if (payload.sessionId) {
        if (payload.navigate) {
          if (sharedConversations.get(payload.sessionId).currentEngine !== payload.engine) throw new Error('The conversation engine changed. Open the conversation again.');
        } else await sharedConversations.switchEngine(payload.sessionId, payload.engine, payload.mode);
      }
      const result = await switchMode(payload.engine, payload.sessionId);
      return result;
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:conversation-open-handoff', (_event, { sessionId, file }) => {
    const c = sharedConversations.get(sessionId);
    if (!c.handoffs.some(h => h.file === file)) return { ok: false, error: 'Handoff not found' };
    void shell.openPath(file); return { ok: true };
  });

  // ---- Archived conversations (Settings → Archived) ------------------------
  const archivedSources = () => ({
    claude: claudeWorkspaces, kimi: kimiWorkspaces, codex: codex.workspaces,
    antigravity: antigravity.workspaces, shared: sharedConversations.workspaces,
  });
  ipcMain.handle('dsh:archived-sessions-list', async () => {
    try {
      const sessions = [];
      for (const [source, workspaces] of Object.entries(archivedSources())) {
        for (const session of await workspaces.listArchived()) {
          sessions.push({ ...session, source, origin: source === 'shared' ? sharedConversations.items.get(session.id)?.origin || null : null });
        }
      }
      sessions.sort((a, b) => b.archivedAt - a.archivedAt || a.id.localeCompare(b.id));
      return { ok: true, sessions };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // ---- Codex desktop session import ------------------------------------------
  const codexDesktop = () => require('./codex-desktop-import.js');
  ipcMain.handle('dsh:codex-desktop-sessions', async () => {
    try {
      const mod = codexDesktop();
      const imported = new Set([...sharedConversations.items.values()].map(c => c.importThreadId).filter(Boolean));
      return { ok: true, sessions: mod.listDesktopSessions(mod.desktopStatePath(), { excludeIds: imported }) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:codex-desktop-sync', async (_event, payload) => {
    try {
      const mod = codexDesktop();
      return { ok: true, ...mod.syncDesktopSession(sharedConversations, mod.desktopStatePath(), payload?.id) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:codex-desktop-import', async (_event, payload) => {
    try {
      const mod = codexDesktop();
      const result = mod.importDesktopSessions(sharedConversations, mod.desktopStatePath(), payload?.ids || [], log);
      return { ok: true, ...result };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:archived-session-action', async (_event, payload) => {
    const notify = (source, id, action) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:archived-changed', { source, id, action });
    };
    const removeArchived = async (source, id) => {
      const goal = { claude: goalDriver, kimi: kimiGoalDriver, codex: codex.goal, antigravity: antigravity.goal }[source];
      if (goal?.goal?.sessionId === id) {
        if (goal.armed) throw new Error('Pause the goal before deleting its conversation');
        goal.clear();
      }
      await archivedSources()[source].removeSession(id);
      const connectionKey = { kimi: 'kimiSessionConnections', codex: 'codexSessionConnections' }[source];
      if (connectionKey && loadConfig()[connectionKey]?.[id]) {
        const connections = { ...loadConfig()[connectionKey] };
        delete connections[id];
        saveConfig({ [connectionKey]: connections });
      }
    };
    try {
      const { source, id, action } = payload || {};
      if (!['restore', 'delete', 'delete-all'].includes(action)) throw new Error('Unknown action');
      if (action === 'delete-all') {
        // Notify per deleted conversation so open chats reset like a single delete.
        let deleted = 0;
        for (const [each, workspaces] of Object.entries(archivedSources())) {
          for (const session of await workspaces.listArchived()) {
            await removeArchived(each, session.id);
            deleted += 1;
            notify(each, session.id, 'delete');
          }
        }
        return { ok: true, deleted };
      }
      const workspaces = archivedSources()[source];
      if (!workspaces) throw new Error('Unknown conversation source');
      if (action === 'restore') workspaces.archiveSession(id, false);
      else await removeArchived(source, id);
      notify(source, id, action);
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });

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
      title: uiText(payload && payload.title ? payload.title : (kind === 'directory' ? "Choose folder" : "Choose file")),
      filters: filters.map(filter => ({ ...filter, name: uiText(filter.name) })),
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] || '' };
  });

  // Multi-select attachment picker for the Claude Code input area.
  ipcMain.handle('dsh:pick-attachments', async () => {
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const options = {
      properties: ['openFile', 'multiSelections'],
      title: uiText("Choose attachments"),
      filters: [
        { name: uiText("Images"), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
        { name: uiText("All files"), extensions: ['*'] },
      ],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? { canceled: true, paths: [] } : { canceled: false, paths: result.filePaths };
  });

  ipcMain.handle('dsh:preview-file', (_event, filePath) => {
    try { return { ok: true, file: describePreview(filePath) }; }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  });

  ipcMain.handle('dsh:open-file-externally', async (_event, filePath) => {
    try {
      const preview = describePreview(filePath);
      const error = await shell.openPath(preview.path);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) { return { ok: false, error: error?.message || String(error) }; }
  });

  ipcMain.handle('dsh:save-clipboard-image', (_event, payload) => {
    try { return { ok: true, attachment: saveClipboardImage(app.getPath('userData'), payload) }; }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
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
      await startOllamaProxyHandle();
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
      return { ok: true };
    } catch (err) {
      log(`apply-settings failed: ${err && err.stack || err}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // The tray keeps Camellia (and its model router) one click away. When the
  // close-to-tray preference is on, closing the window only hides it; Quit
  // here is the real exit.
  function showMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    createMainWindow();
    const mode = ['home', 'benchmark', 'claude', 'codex', 'dsh', 'kimi', 'antigravity'].includes(currentMode) ? currentMode : 'home';
    currentMode = mode;
    void loadMode(mode);
  }
  function refreshTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: uiText('Open Camellia'), click: () => showMainWindow() },
      { label: uiText('Settings…'), click: () => openSettingsWindow() },
      { type: 'separator' },
      { label: uiText('Quit'), click: () => app.quit() },
    ]));
  }
  function setupTray() {
    if (tray) return;
    try {
      tray = new Tray(path.join(APP_ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon-256.png'));
      tray.setToolTip(APP_NAME);
      tray.on('click', () => showMainWindow());
      refreshTrayMenu();
    } catch (error) { log('tray setup failed: ' + error.message); tray = null; }
  }
  app.on('activate', () => showMainWindow());

  app.whenReady().then(async () => {
    nativeTheme.themeSource = loadConfig().theme || 'system';
    setMenu();
    cleanupOpencodeProxyRoute(); // strip the removed OpenCode proxy's stale route
    await startOllamaProxyHandle();
    goalDriver.load();
    kimiGoalDriver.load();
    antigravity.goal.load();
    codex.goal.load();
    createMainWindow();
    setupTray();
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
            if (['claude', 'codex', 'kimi', 'antigravity'].includes(currentMode) && mainWindow && !mainWindow.isDestroyed()) {
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
    appQuitting = true;
    clearTimeout(balanceRefreshTimer);
    for (const goal of [goalDriver, kimiGoalDriver, antigravity.goal, codex.goal]) {
      if (goal.armed) goal.setPhase('paused');
      else goal.cancelTimer();
    }
    sharedConversations.pauseGoals();
    if ((claudeSessions.active || codex.active || kimiAccount.active || dshChat.sessions.active || kimiSessions.active || antigravity.sessions.active || benchmarkRunner?.pending) && !kimiClosing) {
      event.preventDefault();
      kimiClosing = true;
      void Promise.allSettled([claudeSessions.shutdown(), codex.shutdown(), kimiAccount.shutdown(), dshChat.shutdown(), kimiSessions.shutdown(), antigravity.shutdown(), benchmarkRunner?.shutdown()]).finally(() => app.quit());
      return;
    }
    stopBackend();
    stopOllamaProxyHandle();
  });

  app.on('will-quit', () => {
    stopBackend();
    stopOllamaProxyHandle();
  });

  let modeRequest = 0;
  function navigateMode(mode) {
    const chatModes = ['claude', 'codex', 'dsh', 'kimi', 'antigravity'];
    if (chatModes.includes(currentMode) && chatModes.includes(mode) && mainWindow && !mainWindow.isDestroyed()) {
      // The renderer owns the current logical session and unsent draft. All
      // engine menu switches must use the same handoff flow as its selector.
      mainWindow.webContents.send('dsh:harness-navigate', mode);
      return { ok: true };
    }
    return switchMode(mode);
  }
  async function switchMode(mode, conversationId) {
    if (!['home', 'benchmark', 'claude', 'codex', 'dsh', 'kimi', 'antigravity'].includes(mode)) {
      return { ok: false, error: 'Unknown engine or page' };
    }
    const request = ++modeRequest;
    const next = mode;
    try {
      if (!['home', 'benchmark'].includes(next) && !(next === 'dsh' && loadConfig().dshBin)) await runtimes().ensure(next, conversationId ? sharedConversations.settings(next, conversationId).connection : undefined);
    } catch (error) {
      if (error.code === 'DOWNLOAD_CANCELLED') return { ok: true, canceled: true };
      log(`runtime preparation failed: ${error.message}`);
      openSettingsWindow({ page: 'runtimes', engine: next });
      return { ok: false, error: error.message };
    }
    if (request !== modeRequest) return { ok: true, canceled: true };
    if (!['home', 'benchmark'].includes(next)) saveConfig({ mode: next });
    currentMode = next;
    log(`switch mode → ${next}`);
    // Update window title and menu according to mode
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(next === 'codex' ? `Codex CLI — ${APP_NAME}` : next === 'antigravity' ? `Antigravity — ${APP_NAME}` : next === 'kimi' ? `Kimi Code — ${APP_NAME}` : next === 'claude' ? `${APP_NAME_CLAUDE} — ${APP_NAME}` : APP_NAME);
    }
    setMenu();
    void loadMode(next, conversationId);
    return { ok: true };
  }

  async function loadMode(next, conversationId) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (currentMode !== next) return;
        await mainWindow.loadFile(path.join(RENDERER_ROOT, next === 'benchmark' ? 'benchmark/benchmark.html' : next === 'home' ? 'home/home.html' : 'chat/claude.html'),
          ['home', 'benchmark'].includes(next) ? undefined : { query: { harness: next, ...(conversationId ? { conversation: conversationId } : {}) } });
      }
    } catch (err) {
      log(`switch mode failed: ${err && err.stack || err}`);
      if (['claude', 'codex', 'kimi', 'antigravity'].includes(next)) openSettingsWindow({ page: 'runtimes', engine: next });
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
          { label: "About", click: () => dialog.showMessageBox({ type: 'info', title: `About ${APP_NAME}`, message: APP_NAME, detail: `Version ${app.getVersion()}\nEngine: ${engineStatusText()}` }) },
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
          { label: "Benchmark", click: () => switchMode('benchmark') },
          { type: 'separator' },
          { label: "Switch to Claude Code", click: () => navigateMode('claude') },
          { label: "Switch to Codex CLI", click: () => navigateMode('codex') },
          { label: "Switch to DSH", click: () => navigateMode('dsh') },
          { label: "Switch to Kimi Code", click: () => navigateMode('kimi') },
          { label: "Switch to Antigravity", click: () => navigateMode('antigravity') },
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
          { label: "Zoom in", accelerator: 'CmdOrCtrl+=', click: () => desktopZoom().adjust(1) },
          { label: "Zoom out", accelerator: 'CmdOrCtrl+-', click: () => desktopZoom().adjust(-1) },
          { label: "Actual size", accelerator: 'CmdOrCtrl+0', click: () => desktopZoom().set(0) },
          { type: 'separator' },
          { role: 'togglefullscreen', label: "Toggle full screen" },
        ],
      },
    ];
    const language = normalizeLanguage(loadConfig().language);
    function localize(items) {
      for (const item of items) {
        if (item.label) item.label = translate(item.label, language);
        if (item.submenu) localize(item.submenu);
      }
    }
    localize(template);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
}
