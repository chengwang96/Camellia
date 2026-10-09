'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu, Tray, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextEventLoopTurn } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { liveWebContents } = require('./live-web-contents');
const { startApiRouter } = require('../api/api-router.js');
const routerConfig = require('../api/api-router-config.js');
const { createCompactionSummarizer } = require('../api/compaction-summarizer.js');
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
const { createAccountPool } = require('../engines/subscription-accounts.js');
const { createCodex } = require('../engines/codex');
const { apiContextWindow } = require('../engines/codex-models');
const { createAntigravity } = require('../engines/antigravity');
const { createProviderInsights } = require('../api/provider-insights.js');
const { createContextCapacity } = require('../api/context-capacity.js');
const { createRuntimeManager, ENGINES, run: runtimeRun } = require('./runtime-manager.js');
const { createRuntimeUpdates } = require('./runtime-updates.js');
const { createAppUpdates } = require('./app-updates.js');
const { downloadSettings } = require('./download-network.js');
const { subscriptionEnvironment } = require('./network-settings.js');
const { createEngineSettings, backup } = require('../engines/engine-settings.js');
const runtimePaths = require('./runtime-paths.js');
const { BenchmarkRunner } = require('../benchmark/runner');
const { createLibraryManager } = require('../benchmark/libraries');
const { SharedConversations, preferences: conversationPreferences, shortTitle } = require('../engines/shared-conversations');
const { validateMemoryDirectory } = require('../engines/global-memory');
const { createDshChat } = require('../engines/dsh-session');
const { createPiChat } = require('../engines/pi-session');
const { createZoomController, readLegacyZoom } = require('./zoom-controller');
const { saveClipboardImage, savePastedText } = require('./clipboard-attachments');
const { StorageCleanup } = require('./storage-cleanup');
const { createDataPackage, importDataPackage, inspectDataPackage, recoverDataImports, resolveKinds: normalizeMigrationScope } = require('./data-migration');
const { configureDataDirectory, migrationStatus: dataDirectoryStatus, requestDirectoryMigration, cancelDirectoryMigration, readDirectoryMigrationResult } = require('./data-directory');
const { migrateDataDirectory } = require('./data-directory-progress');
const { pluginCacheMaintenanceStatus, requestPluginCacheMaintenance, cancelPluginCacheMaintenance, completePluginCacheMaintenance } = require('./plugin-cache-startup');
const { IdleSessionReaper } = require('../engines/idle-session-reaper');
const { attachInputContextMenu } = require('./input-context-menu');
const { attachImageContextMenu } = require('./image-context-menu');
const { describePreview } = require('./file-preview');
const { ENGINES: SUBSCRIPTION_MODEL_ENGINES } = require('../shared/subscription-models');
const { revealInFileManager } = require('./reveal-file');
const { resolveArtifacts } = require('./turn-artifacts');
const { readOfficePreview } = require('./office-preview');
const { isOleWorkbook, readXlsPreview } = require('./xls-preview');
const { isWordDocument, readDocPreview } = require('./doc-preview');
const { isLegacyPresentation, readPptPreview } = require('./ppt-preview');
const { createConversationTitles, titleCandidates, titleErrorKind, TitleRequestError,
  TITLE_INSTRUCTION, MINIMAL_INSTRUCTION, AUXILIARY_HEADER, MAX_MESSAGE_CHARS, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } = require('./conversation-title.js');
let sharedConversations = null;
let discussionBoundary = null;
let discussionService = null;
let discussionProduction = null;
function productionDiscussions() {
  if (!discussionProduction) {
    const { discussionCatalog } = require('../engines/discussions/catalog');
    const getCatalog = () => discussionCatalog({ router: readOllamaProxyConfig, codex, kimi: kimiAccount, antigravity, contextWindow: modelContextWindow });
    discussionProduction = new (require('../engines/discussions/production').DiscussionProduction)({
      dataDir: app.getPath('userData'), registry: discussionBoundary.registry, codex, antigravity,
      runtimes, node: detectNode, refreshKimi: id => kimiAccount.refreshUsage({ force: true }, id), log,
      getNativeConfig: (engine, connection) => engineSettings().discussionConfig(engine, connection),
      getRouter: () => ollamaProxyHandle, getCatalog, environment: () => runtimeEnvironment(detectNode(), 'codex') });
  }
  return discussionProduction;
}
function discussions() {
  if (!discussionService) {
    const { DiscussionService } = require('../engines/discussions/service');
    const production = productionDiscussions();
    discussionService = new DiscussionService({ dataDir: app.getPath('userData'), registry: discussionBoundary.registry, production: discussionProduction,
      getCatalog: production.getCatalog,
      hiddenSubscriptionModels: () => loadConfig().hiddenSubscriptionModels || {},
      assertAvailable: assertRuntimeAvailable,
      onEvent: event => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:discussion-event', event);
        remoteDesktop?.publish();
      },
      onError: error => log('Discussion: ' + error.message) });
  }
  return discussionService;
}
let remoteDesktop = null;
// Mobile access and CLI devices share one embedded Tailscale node so the user
// signs in once; each consumer registers its own failure handler.
const sharedDesktopNetwork = require('./remote/shared-network').createSharedNetwork({ options: {
  app, safeStorage: require('electron').safeStorage, openExternal: url => shell.openExternal(url) } });
function publishChatEvent(engine, event) {
  try { if (discussionBoundary?.registry.capture(engine, event)) return; }
  catch (error) { log(`discussion event capture failed (${engine}): ${error?.message || error}`); return; }
  // Persistence is best-effort here: a failed save must not escape into the
  // engine event pipeline, or one locked file would freeze the conversation.
  try { if (sharedConversations?.capture(engine, event)) return; }
  catch (err) { log(`shared conversation capture failed (${engine}): ${err?.message || err}`); }
  // Native-only sessions do not emit conversation:turn-end, so a deferred
  // network restart is released here for them.
  if (event.type === 'result') retirePendingEngines();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:' + engine + '-event', event);
}

const APP_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(APP_ROOT, 'src/renderer');
const APP_NAME = 'Camellia';
const APP_NAME_CLAUDE = 'Claude Code';
const STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_PORT = 3000;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

const managedDataDirectory = configureDataDirectory(app);
const appDataDirectory = (() => { try { return app.getPath('appData'); } catch { return null; } })();
app.setName(APP_NAME);
let gotSingleInstanceLock = app.requestSingleInstanceLock();
const managedBrowserDirectory = app.getPath('sessionData') === app.getPath('userData');
if (gotSingleInstanceLock) recoverDataImports({ dataDir: app.getPath('userData'), home: os.homedir() });
function lockDataDirectory(directory) {
  app.releaseSingleInstanceLock();
  if (managedBrowserDirectory) app.setPath('sessionData', directory);
  app.setPath('userData', directory);
  gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) throw new Error('Could not lock the data directory: ' + directory);
}
const directoryMigration = managedDataDirectory && gotSingleInstanceLock
  ? migrateDataDirectory({ app, appData: appDataDirectory, dataDir: app.getPath('userData'),
    suspend: () => { app.releaseSingleInstanceLock(); gotSingleInstanceLock = false; },
    lockDestination: state => lockDataDirectory(state.destination),
    activate: state => { if (!gotSingleInstanceLock || app.getPath('userData') !== state.destination) lockDataDirectory(state.destination); },
    resume: state => lockDataDirectory(state.source) }) : null;
if (directoryMigration?.recoveryRequired) throw new Error('Data directory recovery is required: ' + directoryMigration.rollbackError);
const lastDirectoryMigration = directoryMigration || (managedDataDirectory ? readDirectoryMigrationResult(appDataDirectory) : null);
const pluginCacheMaintenance = gotSingleInstanceLock ? completePluginCacheMaintenance({ app, dataDir: app.getPath('userData') }) : null;
if (pluginCacheMaintenance?.recoveryRequired) throw new Error('Plugin cache recovery is required: ' + pluginCacheMaintenance.error);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}
let logWriter = null;
function getLogWriter() {
  if (!logWriter) {
    logWriter = new (require('./rotating-log').RotatingLog)({ directory: logDir(), io: fs });
    logWriter.write(`=== ${APP_NAME} desktop start ===`);
  }
  return logWriter;
}
function log(message) {
  try {
    getLogWriter().write(message);
  } catch (_err) {
    // Never let logging break startup.
  }
}

// A crash currently ends the log mid-sentence with nothing to explain it, which
// makes a real failure indistinguishable from a deliberate quit. Record the
// reason and end the process explicitly so the next start sees what happened.
// These handlers must never throw and never touch the window or app state.
function describe(value) {
  try {
    if (value instanceof Error) return String(value.stack || value.message || value).trimEnd();
    return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    try { return String(value); } catch { return '[Unprintable error]'; }
  }
}
function logFatal(message) {
  // A separate synchronous file survives app.exit without racing the stream.
  try {
    if (getLogWriter().fatal(message)) return;
  } catch {
    // Continue to stderr when creating the writer or writing its file fails.
  }
  try { process.stderr?.write(`[${new Date().toISOString()}] ${message}\n`); } catch { /* Reporting cannot replace the original failure. */ }
}
function installCrashHandlers() {
  process.on('uncaughtException', error => {
    logFatal('FATAL uncaughtException: ' + describe(error));
    process.exitCode = 1;
    // Never throw from the crash path: the test harness loads this file with a
    // mocked Electron that has no app.exit, and throwing here would replace the
    // original failure with a confusing one.
    if (typeof app.exit === 'function') app.exit(1);
  });
  process.on('unhandledRejection', reason => {
    logFatal('FATAL unhandledRejection: ' + describe(reason));
  });
  // A renderer or utility process dying leaves a blank window or a stuck action
  // with no trace in the main log, so record which process went and why.
  app.on('render-process-gone', (_event, contents, details) => {
    const url = (() => { try { return contents?.getURL?.() || ''; } catch { return ''; } })();
    log(`render process gone: reason=${details?.reason} exitCode=${details?.exitCode} url=${url}`);
  });
  app.on('child-process-gone', (_event, details) => {
    log(`child process gone: type=${details?.type} reason=${details?.reason} exitCode=${details?.exitCode}`);
  });
}
installCrashHandlers();
if (lastDirectoryMigration) log('Data directory migration result: ' + JSON.stringify(lastDirectoryMigration));

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
    closeToTray: false,     // close button hides to the tray; the model router keeps serving other apps
    mode: 'dsh',            // Last selected agent; startup always opens the home panel.
    claude: {},             // Claude Code GUI settings
    language: 'en',         // Workbench UI language, independent of the engines' prompts.
    chatContentWidth: 'standard', // Conversation column width: standard | wide | full
    computerName: '',       // Display name of this computer, shared with paired phones.
    downloadProxy: { mode: 'direct', url: '' },
    subscriptionAutoRefresh: {}, // Per-engine opt-out from the background quota cadence.
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
// The name shown to paired phones. An empty or unusable value falls back to the
// operating system host name so a fresh install still has something to display.
function normalizeComputerName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 80);
}
function computerName() {
  return normalizeComputerName(loadConfig().computerName) || normalizeComputerName(os.hostname()) || 'Camellia desktop';
}
function uiText(text) { return translate(text, normalizeLanguage(loadConfig().language)); }

app.commandLine.appendSwitch('lang', normalizeLanguage(loadConfig().language) === 'en' ? 'en-US' : 'zh-CN');

let zoomController;
function desktopZoom() {
  if (!zoomController) {
    const mode = loadConfig().mode;
    const chatUrl = pathToFileURL(path.join(RENDERER_ROOT, 'chat/claude.html'));
    chatUrl.searchParams.set('harness', mode);
    const urls = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(mode) ? [chatUrl.href] : [];
    if (mode === 'dsh') urls.push('127.0.0.1');
    urls.push(pathToFileURL(path.join(RENDERER_ROOT, 'home/home.html')).href);
    zoomController = createZoomController({ loadConfig, saveConfig, log,
      legacyLevel: readLegacyZoom(path.join(app.getPath('userData'), 'Preferences'), urls) });
  }
  return zoomController;
}

let runtimeManager;
let migrationBusy = false;
function engineBusy(engine) {
  return sharedConversations.isBusy(engine)
    || (engine === 'pi' && piChat.sessions.running)
    || (engine === 'codex' && (codex.session?.running || codex.goal.armed))
    || (engine === 'claude' && (claudeSessions.legacy?.running || goalDriver.armed))
    || (engine === 'kimi' && (kimiSessions.legacy?.running || kimiGoalDriver.armed))
    || (engine === 'antigravity' && (antigravity.session?.running || antigravity.goal.armed));
}
// An engine process reads the proxy environment once, when it is spawned, so a
// network change only reaches engines started afterwards. These helpers stop
// the current processes; the next turn builds fresh ones from the new
// environment, resuming each conversation's native session.
async function stopEngine(engine) {
  if (engine === 'claude') return claudeSessions.shutdown();
  if (engine === 'kimi') return kimiSessions.shutdown();
  if (engine === 'antigravity') return antigravity.shutdown();
  if (engine === 'codex') return codex.shutdown();
  if (engine === 'dsh') return dshChat.shutdown();
  if (engine === 'pi') return piChat.shutdown();
}
const NETWORK_ENGINES = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'];
// Engines that still have to be retired because a network change could not
// reach them yet. A turn in flight is never interrupted; the engine joins this
// set and is stopped the moment it goes idle.
const networkRestartPending = new Set();
function retirePendingEngines() {
  for (const engine of [...networkRestartPending]) {
    if (engineBusy(engine)) continue;
    networkRestartPending.delete(engine);
    void stopEngine(engine).catch(error => log(`${engine}: deferred network restart failed: ${error.message}`));
  }
}
// Called after the network settings are applied. Idle engines are retired at
// once; busy ones are retired when their current turn ends.
function applyNetworkChange() {
  // Every engine has to be replaced: an idle process still holds the old
  // environment. Busy ones wait for their turn to finish.
  for (const engine of NETWORK_ENGINES) {
    if (engineBusy(engine)) networkRestartPending.add(engine);
    else void stopEngine(engine).catch(error => log(`${engine}: network change restart failed: ${error.message}`));
  }
  retirePendingEngines();
  const deferred = [...networkRestartPending];
  if (deferred.length) log('network change deferred until these engines are idle: ' + deferred.join(', '));
  return deferred;
}
function runtimes() {
  if (!runtimeManager) {
    const root = app.isPackaged ? process.resourcesPath : APP_ROOT;
    const node = detectNode();
    const npm = firstExisting(runtimePaths.npmCandidates(node, { resourcesPath: app.isPackaged ? root : undefined, env: process.env }));
    runtimeManager = createRuntimeManager({ root, installRoot: app.getPath('userData'), node, npm,
      customPaths: () => loadConfig().runtimePaths || {},
      saveCustomPaths: runtimePaths => saveConfig({ runtimePaths }),
      beforePathSave: engine => {
        if (engineBusy(engine)) throw new Error('Stop conversations using this engine before changing its path');
      },
      downloadOptions: chooseDownloadConnection,
      runtimeMode: engine => engine === 'antigravity' ? antigravity.settings().connection : 'api',
      onChange: state => {
        for (const window of [mainWindow, settingsWindow]) if (window && !window.isDestroyed()) {
          window.webContents.send('dsh:runtime-state', runtimeUpdatesService?.state(state) || state);
          window.webContents.send('dsh:runtime-python-state', runtimeManager.pythonState());
        }
      } });
  }
  return runtimeManager;
}
async function chooseDownloadConnection(engine) {
  return downloadSettings(loadConfig().downloadProxy);
}

let runtimeUpdatesService;
let appUpdatesService;
const runtimeReinstallPreviews = new Map();
function assertRuntimeReinstallAllowed(engine) {
  assertRuntimeAvailable(engine);
  if (appUpdatesService?.state().installing) throw new Error('Wait for the Camellia update to finish before updating a runtime');
  if (benchmarkRunner?.pending || discussionService?.active) throw new Error('Stop the benchmark or discussion before updating a runtime');
  if (engineBusy(engine)) throw new Error('Stop conversations using this engine before updating it');
  if (engine === 'kimi' && kimiAccount.active) throw new Error('Wait for Kimi account activity to finish before updating it');
}
function anyRuntimeUpdating() { return Object.keys(ENGINES).some(engine => runtimeUpdatesService?.isUpdating(engine)); }
function assertRuntimeAvailable(engine) {
  if (migrationBusy) throw new Error('Wait for the data transfer to finish before starting an engine');
  if (runtimeUpdatesService?.isUpdating(engine)) throw new Error(`${ENGINES[engine]?.name || engine} is updating. Try again when the update finishes.`);
}
function appUpdates() {
  if (!appUpdatesService) {
    appUpdatesService = createAppUpdates({ currentVersion: app.getVersion(),
      appPath: app.isPackaged ? path.dirname(process.execPath).replace(/[\\/]MacOS$/, '') : null,
      platformSupported: app.isPackaged,
      relaunch: () => { app.relaunch(); app.exit(0); },
      quit: () => app.quit(),
      reveal: file => shell.showItemInFolder(file),
      log,
      // The installer needs a visible window; macOS archive updates apply
      // silently, so downloads still follow the user's saved connection.
    });
  }
  return appUpdatesService;
}
function runtimeUpdates() {
  if (!runtimeUpdatesService) {
    const root = app.isPackaged ? process.resourcesPath : APP_ROOT;
    const node = detectNode();
    const npm = firstExisting(runtimePaths.npmCandidates(node, { resourcesPath: app.isPackaged ? root : undefined, env: process.env }));
    runtimeUpdatesService = createRuntimeUpdates({ manager: runtimes(), engines: ENGINES, node, npm, run: runtimeRun,
      downloadSettings: () => loadConfig().downloadProxy,
      beforeInstall: async engine => {
        if (appUpdatesService?.state().installing) throw new Error('Wait for the Camellia update to finish before updating a runtime');
        if (benchmarkRunner?.pending || discussionService?.active) throw new Error('Stop the benchmark or discussion before updating a runtime');
        if (engineBusy(engine)) throw new Error('Stop conversations using this engine before updating it');
        if (engine === 'kimi' && kimiAccount.active) throw new Error('Wait for Kimi account activity to finish before updating it');
        const reopenDshPanel = engine === 'dsh' && Boolean(nativeSettingsLoad || backend.current);
        // Idle sessions and the DSH settings server still hold files on Windows.
        await stopEngineForUpdate(engine);
        if (engine === 'dsh') {
          const oldLoad = nativeSettingsLoad;
          if (oldLoad) await oldLoad.catch(() => {});
          await backend.stopAndWait();
        }
        return async () => {
          if (!reopenDshPanel || !settingsWindow || settingsWindow.isDestroyed()
            || !nativeSettingsView || nativeSettingsView.webContents.isDestroyed()) return;
          nativeSettingsLoad = (async () => {
            const { url } = await startBackend();
            await nativeSettingsView.webContents.loadURL(url);
          })().catch(error => { nativeSettingsLoad = null; throw error; });
          await nativeSettingsLoad;
        };
      },
      onChange: state => {
        for (const window of [mainWindow, settingsWindow]) if (window && !window.isDestroyed()) {
          window.webContents.send('dsh:runtime-state', state);
        }
      },
      log });
  }
  return runtimeUpdatesService;
}
function runtimeEnvironment(node, engine) {
  const root = app.isPackaged ? process.resourcesPath : APP_ROOT;
  const runtime = runtimes().locate(engine);
  const paths = [node && path.dirname(node), path.join(root, 'runtime/npm/bin'), runtime && path.join(runtime.dir, 'node_modules/.bin')].filter(Boolean);
  // One user-selected Python serves every harness, so its directory leads PATH
  // for engines that call python or pip from a shell tool.
  const python = runtimes().pythonState?.();
  if (python?.file) paths.unshift(path.dirname(python.file));
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
    antigravityHome: antigravity.home, codexHome: codex.home, piHome: path.join(app.getPath('userData'), 'pi-native'),
    getDesktop: engine => engine === 'codex' ? codex.settings() : engine === 'antigravity' ? antigravity.settings() : engine === 'kimi' ? kimiSettings() : engine === 'claude' ? claudeSettings() : engine === 'pi' ? piChat.settings() : {},
    saveDesktop: (engine, value) => engine === 'codex' ? codex.saveSettings(value) : engine === 'antigravity' ? antigravity.saveSettings(value) : engine === 'kimi' ? saveKimiSettings(value) : engine === 'claude' ? saveClaudeSettings(value) : engine === 'pi' ? piChat.saveSettings(value) : undefined,
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
let subscriptionUsageStore = null;
let subscriptionPriceRefresh = null;
function subscriptionPrices() {
  return subscriptionPriceRefresh ||= require('../api/subscription-price-catalog').createPriceRefresh({
    file: path.join(app.getPath('userData'), 'subscription-prices-cache.json'),
    onChange: () => {
      try { subscriptionUsage().reprice(); } catch (error) { log('Subscription repricing:', error.message); }
      broadcastApiRouter(apiRouterState());
    },
  });
}
function subscriptionUsage() {
  return subscriptionUsageStore ||= require('../api/subscription-usage').createSubscriptionUsage({
    file: path.join(app.getPath('userData'), 'subscription-usage.json'),
    onChange: () => broadcastApiRouter(apiRouterState()),
  });
}
let networkSettingsService, networkDispatcher;
// Only the subscription CLIs that are actually signed in can use the proxy
// environment, so the connectivity test lists them instead of probing hosts a
// user has not connected yet.
function activeSubscriptionEngines() {
  const engines = [];
  try {
    const states = kimiAccount.states();
    if (Object.values(states).some(state => state?.account)) engines.push('kimi');
  } catch { }
  try { if (codex.accountState().accounts.some(account => account.signedIn)) engines.push('codex'); } catch { }
  try { if (antigravity.handlers['account-state']().account) engines.push('antigravity'); } catch { }
  return engines;
}
function networkSettings() {
  if (!networkSettingsService) networkSettingsService = require('./network-settings').createNetworkSettings({ loadConfig, saveConfig,
    // A stale system proxy is downgraded to "prefer direct" in the background;
    // every open window is told so the user can fix the cause.
    onHealthChange: payload => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('dsh:network-health', payload);
      }
    },
    subscriptionEngines: activeSubscriptionEngines,
    loadRoutes: readOllamaProxyConfig,
    sessions: () => require('electron').session,
    applyEnvironment: env => {
      const { PROXY_KEYS } = require('./network-settings');
      for (const key of Object.keys(process.env)) if (PROXY_KEYS.test(key)) delete process.env[key];
      Object.assign(process.env, env);
      const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
      const previous = networkDispatcher;
      networkDispatcher = new EnvHttpProxyAgent({ httpProxy: env.HTTP_PROXY, httpsProxy: env.HTTPS_PROXY, noProxy: env.NO_PROXY });
      setGlobalDispatcher(networkDispatcher);
      previous?.close().catch(() => {});
    } });
  return networkSettingsService;
}
function subscriptionUsageState() {
  return subscriptionUsage().state(require('../api/subscription-usage').subscriptionProfiles(loadConfig()));
}
function createUsageMeter(engine, { settings, home, version }) {
  if (settings.connection !== 'subscription') return null;
  return require('../engines/subscription-meter').createSubscriptionMeter({ engine, home, version,
    accountId: settings.subscriptionId || 'default', model: settings.model, log,
    record: value => subscriptionUsage().record(value) });
}
function broadcastApiRouter(state) {
  state = { ...state, subscriptionUsage: subscriptionUsageState() };
  for (const window of [mainWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('dsh:api-router-state', state);
  }
}
let providerInsights = null, balanceRefreshTimer = null;
// One global cadence for every provider's account API, not just Ollama: the
// route pool reads reported balances and quota windows on this interval, and
// the Insights panel refreshes its balances on the same schedule.
const ACCOUNT_REFRESH_MINUTES = [5, 15, 30, 60];
function accountRefreshMinutes() {
  const value = Number(loadConfig().accountRefreshMinutes);
  return ACCOUNT_REFRESH_MINUTES.includes(value) ? value : 15;
}
function accountRefreshEnabled() { return loadConfig().autoRefreshBalances !== false; }
// A per-engine exception to the global cadence. Antigravity's background quota
// probe makes the official CLI perform its own Google sign-in when the stored
// credential read is slow, so a user may keep balance refreshes for every other
// provider while leaving Antigravity alone. The manual refresh button and an
// explicit engine check never consult this.
function subscriptionAutoRefreshEnabled(engine) {
  return loadConfig().subscriptionAutoRefresh?.[engine] !== false;
}

// The middle conversation column is readable at its standard width; a wider or
// full-width column helps comparisons, tables and diffs on large screens.
const CHAT_CONTENT_WIDTHS = ['standard', 'wide', 'full'];
function normalizeChatContentWidth(value) {
  return CHAT_CONTENT_WIDTHS.includes(value) ? value : 'standard';
}
function quotaCheckOptions() {
  return { enabled: accountRefreshEnabled(), intervalMs: accountRefreshMinutes() * 60000 };
}
function syncQuotaCheck() {
  try { ollamaProxyHandle?.setQuotaCheck(quotaCheckOptions()); } catch (e) { log(`api-router: quota check update failed (${e.message})`); }
}
let contextCapacity = null;
function capacity() {
  if (!contextCapacity) contextCapacity = createContextCapacity({
    file: path.join(app.getPath('userData'), 'context-capacity.json'), getConfig: readOllamaProxyConfig,
  });
  return contextCapacity;
}
function insights() {
  if (!providerInsights) providerInsights = createProviderInsights({
    file: path.join(app.getPath('userData'), 'provider-insights.json'), getConfig: readOllamaProxyConfig,
    getRefreshIntervalMs: () => accountRefreshMinutes() * 60000,
    onChange: broadcastAccountInsights,
  });
  return providerInsights;
}
function accountInsights(state = insights().state()) {
  const subscriptions = [];
  const states = kimiAccount.states();
  for (const profile of kimiAccount.list()) {
    const kimi = states[profile.id];
    if (!kimi?.account) continue;
    subscriptions.push({ id: 'kimi:' + profile.id, engine: 'kimi', name: 'Kimi Code',
      label: profile.label || (profile.id === 'default' ? 'Kimi account' : 'Kimi account ' + profile.id),
      info: { ...kimi.usage, refreshing: Boolean(kimi.usage?.refreshing || kimi.refreshing) },
      capability: { supported: true, label: 'Kimi Code subscription quota', source: 'client' } });
  }
  for (const profile of codex.accountState().accounts.filter(account => account.signedIn)) {
    const account = codex.accountState(profile.id);
    const history = account.quotaHistory || [];
    subscriptions.push({ id: 'codex:' + profile.id, engine: 'codex', name: 'ChatGPT / Codex', label: profile.label || profile.email,
      info: { latest: history.at(-1), history }, capability: { supported: true, label: 'ChatGPT quota', source: 'client' } });
  }
  const google = antigravity.handlers['account-state']();
  if (google.models?.length && google.verifiedAt && !google.awaitingVerification) {
    subscriptions.push({ id: 'antigravity:default', engine: 'antigravity', name: 'Google / Antigravity', label: 'Google account',
      info: google.usage, capability: { supported: true, label: 'Google subscription quota', source: 'client' } });
  }
  return { ...state, subscriptions };
}
function broadcastAccountInsights(state) {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('dsh:provider-insights', accountInsights(state));
}
async function refreshInsights(payload = {}) {
  if (migrationBusy) throw new Error('Wait for the data transfer to finish before refreshing accounts');
  const wanted = String(payload.subscriptionId || '');
  const kimiIds = !payload.apiOnly && !payload.providerId && !payload.keyId
    ? kimiAccount.list().map(profile => profile.id).filter(id => !runtimeUpdatesService?.isUpdating('kimi') && (!wanted || wanted === 'kimi:' + id)) : [];
  const codexIds = !payload.apiOnly && !payload.providerId && !payload.keyId
    ? codex.accountState().accounts.filter(account => account.signedIn && !runtimeUpdatesService?.isUpdating('codex') && (!wanted || wanted === 'codex:' + account.id)).map(account => account.id) : [];
  const google = antigravity.handlers['account-state']();
  // The timer's background pass sends force:false; a manual refresh and an
  // explicit engine check send force:true. Only the background pass honors the
  // per-engine opt-out, so turning it off never strands the quota.
  const background = payload.force === false;
  const refreshGoogle = (!background || subscriptionAutoRefreshEnabled('antigravity')) && !payload.apiOnly && !payload.providerId && !payload.keyId
    && !runtimeUpdatesService?.isUpdating('antigravity') && (!wanted || wanted === 'antigravity:default') && google.models?.length && google.verifiedAt && !google.awaitingVerification;
  await Promise.all([
    payload.subscriptionId ? null : insights().refresh(payload),
    ...kimiIds.map(id => kimiAccount.refreshUsage({ force: payload.force !== false }, id)),
    ...codexIds.map(id => codex.handlers['account-refresh']({ id })),
    refreshGoogle ? antigravity.handlers['account-refresh-usage']({ force: payload.force !== false }) : null,
  ]);
  return accountInsights();
}
function refreshAccountBalances() {
  clearTimeout(balanceRefreshTimer);
  const minutes = accountRefreshMinutes();
  if (!migrationBusy && accountRefreshEnabled()) {
    try { void refreshInsights({ force: false }).catch(e => log(`account refresh: ${e.message}`)); } catch (e) { log(`account refresh: ${e.message}`); }
  }
  balanceRefreshTimer = setTimeout(refreshAccountBalances, minutes * 60000);
  balanceRefreshTimer.unref?.();
}
function apiRouterState() {
  try {
    const cfg = readOllamaProxyConfig();
    return { ok: true, ...(ollamaProxyHandle ? ollamaProxyHandle.getState() : { ...routerConfig.publicState(cfg), running: false, url: `http://127.0.0.1:${cfg.port}` }),
      presets: routerConfig.PRESETS, configPath: ollamaProxyConfigPath(), subscriptionUsage: subscriptionUsageState() };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Full-fidelity API route bundle shared by file export and the paired mobile
// client. Providers, endpoints and raw keys are included; subscription
// accounts stay device-local and are never part of the payload.
function apiRoutesBundle(config = readOllamaProxyConfig()) {
  return { format: 'camellia-api-routes', version: 2, exportedAt: new Date().toISOString(),
    config: { enabled: config.enabled, port: config.port, providers: config.providers } };
}
async function startOllamaProxyHandle() {
  await stopOllamaProxyHandle();
  try {
    const cfg = readOllamaProxyConfig();
    if (!routerConfig.hasRoutes(cfg)) { syncOllamaBaseUrl(false); return; }
    ollamaProxyHandle = startApiRouter({ configPath: ollamaProxyConfigPath(), log: msg => log(`[api-router] ${msg}`), onState: broadcastApiRouter,
      onContextEvidence: evidence => capacity().observe(evidence), quotaCheck: quotaCheckOptions() });
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
  if (restartClient) { await antigravity.shutdown(); await codex.shutdown(); await dshChat.shutdown(); await piChat.shutdown(); }
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
  if (thinking && !['off', 'none'].includes(thinking)) args.push('--effort', thinking);

  // Unified routing: the proxy owns upstream credentials for every harness.
  const route = resolveClaudeRoute();
  if (!settings.model) throw new Error("Select a configured model in the composer first");
  const overlayEnv = { ...managedClaudeModelEnv(settings.model),
    ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_AUTH_TOKEN: route.authToken, ANTHROPIC_API_KEY: '' };
  if (['off', 'none'].includes(thinking)) overlayEnv.MAX_THINKING_TOKENS = '0';
  // ~/.claude/settings.json 的 env 块优先级高于进程环境变量（会覆盖上面
  // 的设置）——用 --settings overlay 反压回去（命令行设置 > 用户设置）。
  // 写到 userData 文件而不是内联 JSON，避免密钥出现在命令行里。
  const settingsPath = writeClaudeSettingsOverlay(overlayEnv, opts.conversationId);
  args.push('--settings', settingsPath);
  // Claude Code is the same class of provider CLI: on a network where direct
  // traffic cannot reach its hosts, a "prefer direct" bridge would stall it on
  // the direct attempt. Give the process the real detected proxy; the local
  // router stays exempt through NO_PROXY.
  const environment = subscriptionEnvironment(runtimeEnvironment(detectNode(), 'claude'));
  return { args, env: { ...environment, ...overlayEnv }, cwd: settings.cwd || undefined };
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
  return capacity().budget({ model, protocol: 'openai' })?.cap || routerConfig.modelContextWindow(readOllamaProxyConfig(), model);
}
function codexContextWindow(model) {
  return apiContextWindow(model, capacity().budget({ model, protocol: 'openai' }));
}
function resolveClaudeRoute() {
  const cfg = readOllamaProxyConfig();
  if (!routerConfig.hasRoutes(cfg)) throw new Error("Enable API routing and configure a model and key in Camellia settings");
  if (ollamaProxyHandle && !ollamaProxyHandle.getState().running) throw new Error(ollamaProxyHandle.getState().error || "The API router has not started");
  return { baseUrl: `http://127.0.0.1:${cfg.port}`, authToken: 'proxy-managed' };
}
// Marked as auxiliary so the router counts it apart from agent requests, and
// so a title request never shares the per-model cooldown of real work.
async function requestConversationTitle({ model, message, minimal }) {
  const route = resolveClaudeRoute();
  const instruction = minimal ? MINIMAL_INSTRUCTION : TITLE_INSTRUCTION;
  // The retry drops the legacy cap because some providers reject it outright.
  const body = { model, stream: false, messages: [
    { role: 'system', content: instruction },
    { role: 'user', content: JSON.stringify(String(message || '').slice(0, minimal ? 600 : MAX_MESSAGE_CHARS)) },
  ] };
  if (!minimal) body.max_tokens = MAX_OUTPUT_TOKENS;
  const response = await fetch(route.baseUrl + '/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${route.authToken}`, 'Content-Type': 'application/json', [AUXILIARY_HEADER]: 'title' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try { detail = JSON.parse(text)?.error?.message || text; } catch {}
    throw new TitleRequestError(titleErrorKind(response.status),
      `HTTP ${response.status}: ${String(detail).slice(0, 200)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new TitleRequestError('transient', 'The title response was not valid JSON'); }
  const choice = data?.choices?.[0];
  // Reasoning models can stop on the output cap before writing any text; the
  // retry layer needs that fact so a truncated answer is retried without the
  // cap instead of being treated as a model that cannot write titles.
  return { text: choice?.message?.content || '', truncated: choice?.finish_reason === 'length' };
}

const conversationTitles = createConversationTitles({
  candidates: model => {
    try {
      return titleCandidates(model, { fallback: loadConfig().sharedChat?.apiModel, router: readOllamaProxyConfig() });
    } catch (error) { log(`conversation title: cannot read API routes (${error.message})`); return []; }
  },
  request: requestConversationTitle,
  normalize: shortTitle,
  log,
});
async function generateConversationTitle(message, model) { return conversationTitles.generate(message, model); }

// Portable compaction summarizes through the API router whenever it can reach
// the conversation's model, so the summary never starts an engine process.
const compactionSummarizer = createCompactionSummarizer({
  getConfig: readOllamaProxyConfig, getRoute: resolveClaudeRoute,
  // Routes can be configured while the local proxy is stopped or still
  // starting; the summary then stays on the engine-session path.
  isRunning: () => Boolean(ollamaProxyHandle) && ollamaProxyHandle.getState().running,
  log,
});

// Fields that require a fresh process when changed (mid-session switching is
// not possible for model/effort/permission via the stream-json control API we use).
function sessionSettingsEqual(a, b) {
  return CLAUDE_SETTING_FIELDS.every((k) => String(a[k] || '') === String(b[k] || ''));
}

// Ensure a live session matching the requested settings; respawn when the
// conversation id changes or a locking setting changed mid-conversation.
function ensureClaudeSession(settings, opts) {
  claudeSessions.assertAccess(opts);
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
    if (sameConversation && !opts.fork && current.opts.goalBridge === opts.goalBridge && current.opts.workspaceId === opts.workspaceId && sessionSettingsEqual(current.settings, settings)) {
      return current;
    }
  }
  // The selected ID is the resume target, including after a settings change.
  // An absent ID starts a new conversation.
  const sessionOpts = { sessionId: opts.sessionId || null, fork: Boolean(opts.fork), workspaceId: opts.workspaceId, conversationId: opts.conversationId, lockPermissionMode: true, goalBridge: opts.goalBridge };
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
  kimiSessions.assertAccess(opts);
  const current = kimiSessions.get(opts);
  const context = opts.cwd ? { cwd: opts.cwd, workspaceId: null } : kimiWorkspaces.resolveContext(settings, opts);
  settings = { ...settings, cwd: context.cwd };
  opts = { ...opts, workspaceId: context.workspaceId };
  if (settings.cwd === kimiStandaloneCwd({})) fs.mkdirSync(settings.cwd, { recursive: true });
  if (!fs.existsSync(settings.cwd) || !fs.statSync(settings.cwd).isDirectory()) throw new Error("Working directory does not exist: " + settings.cwd);
  if (!settings.model) throw new Error("Select a configured model in the composer first");
  const subscription = settings.connection === 'subscription';
  let route;
  let home = path.join(app.getPath('userData'), 'kimi-code', ...(opts.conversationId ? ['conversations', opts.conversationId] : []));
  if (subscription) {
    // A conversation keeps the account that owns its native session; a new one
    // uses whichever signed-in account still has quota.
    const accountId = opts.conversationId && settings.subscriptionId || kimiAccount.bind(opts.sessionId);
    if (accountId) settings = { ...settings, subscriptionId: accountId };
    home = kimiAccount.home(accountId);
    const account = kimiAccount.state(accountId);
    if (account.loginPending || account.refreshing || account.signingOut) throw new Error('Wait for the Kimi account operation to finish');
    if (!account.account) throw new Error('Sign in with Kimi in Settings → Engine Settings → Kimi Code first');
    if (!account.models.some(model => model.id === settings.model)) throw new Error('Refresh the Kimi account and select an available model');
  } else {
    settings.model = routerConfig.modelId(settings.model);
    route = resolveClaudeRoute();
    if (!routerConfig.publicState(readOllamaProxyConfig()).models.includes(settings.model)) throw new Error("No route is available for this model. Add one in Camellia settings.");
    const configuredContext = modelContextWindow(settings.model);
    if (configuredContext) settings.contextWindow = configuredContext;
  }
  if (current && !current.dead && !opts.fork && current.opts.goalBridge === opts.goalBridge && current.sessionId === (opts.sessionId || null)
      && current.opts.workspaceId === opts.workspaceId && sessionSettingsEqual(current.settings, settings)
      && current.settings.contextWindow === settings.contextWindow && current.settings.connection === settings.connection
      && (current.settings.subscriptionId || null) === (settings.subscriptionId || null)) return current;
  const runtime = runtimes().locate('kimi')?.file;
  if (!runtime) throw new Error("Kimi is being prepared. Check progress or retry in Settings → Engine Settings.");
  const exe = detectNode();
  if (!exe) throw new Error("Kimi Code requires Node.js 22.19 or later. Configure the runtime in settings.");
  const spec = kimiSpawnSpec({ home,
    sharedSubscription: Boolean(opts.conversationId), runtime, route, connection: settings.connection,
    model: settings.model, contextWindow: settings.contextWindow, env: runtimeEnvironment(exe, 'kimi'), ...engineSettings().kimiConfig() });
  const previousClosed = current?.shutdown();
  const session = new KimiSession({ gen: ++kimiGen, settings, opts, exe, spec, spawn, log, history: kimiHistory,
    usageMeter: createUsageMeter('kimi', { settings, home, version: runtimes().locate('kimi')?.version }),
    onEvent: event => {
      if (kimiSessions.get(opts) === session) publishChatEvent('kimi', { ...event, conversationId: opts.conversationId });
    },
    onSessionId: id => {
      saveConfig({ kimiSessionConnections: { ...loadConfig().kimiSessionConnections, [id]: settings.connection || 'api' },
        // A new session starts from the connection the last one actually used,
        // so the settings page does not need a global selector.
        kimi: { ...loadConfig().kimi, connection: settings.connection || 'api' },
        ...(subscription && settings.subscriptionId ? { kimiSessionAccounts: { ...loadConfig().kimiSessionAccounts, [id]: settings.subscriptionId } } : {}) });
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

// One Kimi account service per signed-in account. The official CLI keeps every
// account's credentials inside its own KIMI_CODE_HOME, so several Kimi logins
// stay valid at once and switch automatically by quota.
const kimiAccount = createAccountPool({ engine: 'kimi', userData: app.getPath('userData'),
  root: path.join(app.getPath('userData'), 'kimi-subscription'), bindingsKey: 'kimiSessionAccounts', loadConfig, saveConfig,
  createService: (profile, notify) => createKimiAccount({ home: profile.home,
    runtime: () => runtimes().locate('kimi'), ensureRuntime: () => runtimes().ensure('kimi'), node: detectNode,
    environment: () => runtimeEnvironment(detectNode(), 'kimi'), region: () => kimiSettings().region,
    isBusy: () => kimiSessions.legacy?.running || kimiGoalDriver.armed || sharedConversations?.isBusy('kimi'),
    openExternal: url => shell.openExternal(url),
    onModels: models => {
      if (!kimiSettings().subscriptionModel && models.length) saveConfig({ kimi: { ...loadConfig().kimi, subscriptionModel: (models.find(model => model.isDefault) || models[0]).id } });
    },
    onChange: () => notify(),
  }),
  onState: account => {
    broadcastAccountInsights();
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) {
      window.webContents.send('dsh:kimi-account', account);
      window.webContents.send('dsh:engine-settings-changed', { engine: 'kimi' });
    }
  },
});

const codex = createCodex({ dataDir: app.getPath('userData'), loadConfig, saveConfig,
  createUsageMeter,
  getRoute: resolveClaudeRoute, getModels: () => routerConfig.publicState(readOllamaProxyConfig()).models,
  getContextWindow: codexContextWindow,
  runtimes, log, environment: () => runtimeEnvironment(detectNode(), 'codex'), openExternal: url => shell.openExternal(url),
  isBusy: () => sharedConversations?.isBusy('codex'),
  onEvent: event => publishChatEvent('codex', event),
  onGoal: goal => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:codex-goal', goal); },
  onAccount: account => {
    broadcastAccountInsights();
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) {
      window.webContents.send('dsh:codex-account', account);
      window.webContents.send('dsh:engine-settings-changed', { engine: 'codex' });
    }
    if (nativeSettingsView && !nativeSettingsView.webContents.isDestroyed()) nativeSettingsView.webContents.send('dsh:codex-account', account);
  },
});

const antigravity = createAntigravity({ dataDir: app.getPath('userData'), loadConfig, saveConfig,
  createUsageMeter,
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
  python: () => runtimes().pythonSelection(),
  isBusy: () => sharedConversations?.isBusy('antigravity'),
  onEvent: event => publishChatEvent('antigravity', event),
  onGoal: goal => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:antigravity-goal', goal); },
  onAccount: account => {
    broadcastAccountInsights();
    for (const window of BrowserWindow?.getAllWindows?.() || []) if (!window.isDestroyed()) {
      window.webContents.send('dsh:antigravity-account', account);
    }
  },
});

const dshChat = createDshChat({ dataDir: app.getPath('userData'), loadConfig, saveConfig, getRoute: resolveClaudeRoute,
  getModels: () => routerConfig.publicState(readOllamaProxyConfig()).models,
  getModelThinking: model => routerConfig.publicState(readOllamaProxyConfig()).modelThinking[model],
  runtime: () => ({ file: detectDshBin() }), node: detectNode, environment: () => runtimeEnvironment(detectNode(), 'dsh'),
  onEvent: event => publishChatEvent('dsh', event), log });
const piChat = createPiChat({ dataDir: app.getPath('userData'), loadConfig, saveConfig, getRoute: resolveClaudeRoute,
  getModels: () => routerConfig.publicState(readOllamaProxyConfig()).models,
  runtime: () => runtimes().locate('pi'), node: detectNode, environment: () => runtimeEnvironment(detectNode(), 'pi'),
  instructions: () => engineSettings().piInstructions(),
  onEvent: event => publishChatEvent('pi', event), log });
function sessionPools() { return [claudeSessions, kimiSessions, codex.sessions, antigravity.sessions, dshChat.sessions, piChat.sessions]; }
async function stopEngineForUpdate(engine, operation = 'the update') {
  const pool = { claude: claudeSessions, kimi: kimiSessions, codex: codex.sessions,
    antigravity: antigravity.sessions, dsh: dshChat.sessions, pi: piChat.sessions }[engine];
  const processes = [...(pool?.sessions.values() || [])]
    .map(session => session.proc || session.client?.proc)
    .filter(proc => proc && proc.exitCode == null && proc.signalCode == null);
  // Register exit listeners before shutdown so a fast exit cannot be missed.
  const exits = processes.map(proc => once(proc, 'exit', { signal: AbortSignal.timeout(10000) }));
  for (const exit of exits) void exit.catch(() => {});
  await stopEngine(engine);
  try { await Promise.all(exits); }
  catch (error) {
    if (error.name === 'AbortError') throw new Error(`${ENGINES[engine]?.name || engine} process did not stop before ${operation}`);
    throw error;
  }
}
discussionBoundary = require('../engines/discussions/native-boundary').createDiscussionBoundary({
  dataDir: app.getPath('userData'), conversations: () => sharedConversations ? [...sharedConversations.items.values()] : null,
  managedNative: () => productionDiscussions().inventory(),
  nativeStorage: () => productionDiscussions().nativeStorage(),
  ordinaryNativeSeparate: input => productionDiscussions().ordinaryStorageSeparate(input),
  drivers: {
    claude: { sessions: claudeSessions, history: claudeHistory }, kimi: { sessions: kimiSessions, history: kimiHistory },
    codex, antigravity, dsh: dshChat, pi: piChat,
  },
});
sharedConversations = new SharedConversations({ dir: path.join(app.getPath('userData'), 'conversations'), loadConfig, saveConfig, log, modelContextWindow, generateTitle: generateConversationTitle,
  assertAvailable: assertRuntimeAvailable,
  contextCapacity: { budget: options => capacity().budget(options) },
  summarize: compactionSummarizer,
  contextRoute: (engine, settings) => {
    if (settings.connection === 'subscription') return settings.subscriptionId || engine;
    const config = readOllamaProxyConfig();
    const routes = config.providers.filter(provider => provider.enabled && provider.keys.some(key => key.enabled))
      .flatMap(provider => provider.models.filter(model => model.id === settings.model).map(model =>
        [provider.id, provider.baseUrl, provider.anthropicBaseUrl, provider.protocol, model.upstream, model.protocol,
          model.contextWindow, model.maxContext, provider.keys.filter(key => key.enabled).map(key => key.id).sort()]));
    return require('node:crypto').createHash('sha256').update(JSON.stringify(routes)).digest('hex');
  },
  conversationModels: (engine, settings) => require('../engines/conversation-models').conversationModels(engine, settings, {
    router: readOllamaProxyConfig, codex: id => codex.accountState(id), kimi: id => kimiAccount.state(id),
    antigravity: () => antigravity.handlers['account-state'](),
  }),
  createGoalBridge: options => require('../engines/goal-tool-bridge').createGoalToolBridge({ ...options, node: detectNode() }),
  drivers: {
    claude: { sessions: claudeSessions, history: claudeHistory, settings: claudeSettings, saveSettings: saveClaudeSettings, ensure: opts => ensureClaudeSession({ ...claudeSettings(), ...opts.settings }, opts), nativeCompaction: true, nativeAutoCompaction: true },
    kimi: { sessions: kimiSessions, history: kimiHistory, settings: kimiSettings, saveSettings: saveKimiSettings, subscriptionAccounts: () => kimiAccount.state(), ensure: opts => ensureKimiSession({ ...kimiSettings(opts.sessionId), ...opts.settings }, opts), nativeCompaction: true, nativeAutoCompaction: true },
    codex: { sessions: codex.sessions, history: codex.history, settings: codex.settings, saveSettings: codex.saveSettings, subscriptionAccounts: () => codex.accountState(), ensure: codex.ensureSession, nativeCompaction: true, nativeEditing: true },
    antigravity: { sessions: antigravity.sessions, history: antigravity.history, settings: antigravity.settings, saveSettings: antigravity.saveSettings, ensure: antigravity.ensureSession, nativeAutoCompaction: true },
    dsh: dshChat,
    pi: piChat,
  },
  prepare: async (engine, settings) => {
    assertRuntimeAvailable(engine);
    if (engine !== 'dsh' || !loadConfig().dshBin) await runtimes().ensure(engine, settings?.connection);
  },
  onEvent: event => {
    if (event.type === 'conversation:deleted') {
      for (const pool of sessionPools()) {
        void pool.release({ conversationId: event.session_id }).catch(error => log('Conversation release failed: ' + error.message));
      }
    }
    if (event.type === 'conversation:settings') {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('dsh:engine-settings-changed', { engine: event.engine });
      }
    }
    // A network change retires busy engines as soon as their turn ends.
    if (event.type === 'conversation:turn-end') retirePendingEngines();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:conversation-event', event);
    remoteDesktop?.publish(event);
  },
  onGoal: goal => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:conversation-goal', goal); },
  onStatus: status => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:conversation-status', status);
    remoteDesktop?.publish(status);
  },
});

remoteDesktop = require('./remote/desktop').createRemoteDesktop({ app, BrowserWindow, ipcMain, nativeTheme,
  getDiscussions: ['win32', 'darwin'].includes(process.platform) ? discussions : null,
  manager: sharedConversations, rendererRoot: RENDERER_ROOT, loadConfig, getSettingsWindow: () => settingsWindow, apiRoutes: apiRoutesBundle,
  networkFactory: sharedDesktopNetwork.factory, computerName, saveComputerName: name => normalizeComputerName(saveConfig({ computerName: normalizeComputerName(name) }).computerName) });
const cliDevices = require('./remote/devices-desktop').createDevicesDesktop({ app, ipcMain, BrowserWindow,
  safeStorage: require('electron').safeStorage, shell, dialog, nativeImage: require('electron').nativeImage,
  getSurfaces: () => [settingsWindow, nativeSettingsView].map(liveWebContents).filter(Boolean),
  getSettingsWindow: () => settingsWindow, openSettings: target => openSettingsWindow(target),
  authorizedSender: webContents => Boolean(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents),
  networkFactory: sharedDesktopNetwork.factory,
  loadConfig, apiSource: readOllamaProxyConfig });

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
  const custom = loadConfig().runtimePaths?.dsh;
  if (custom?.file) return [runtimes().locate('dsh').file];
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
// Each conversation can retain one process per engine between messages. The
// configured retention starts when work finishes; once the process is idle for
// that long it is stopped, preserving the transcript and stored native context
// for the next message. The minute-long sweep is the granularity of this setting.
const IDLE_SESSION_SWEEP_MS = 60 * 1000;
function engineStatusText() {
  const pools = [
    ['claude', 'Claude Code', claudeSessions],
    ['codex', 'Codex CLI', codex.sessions],
    ['dsh', 'DSH', dshChat.sessions],
    ['kimi', 'Kimi Code', kimiSessions],
    ['antigravity', 'Antigravity', antigravity.sessions],
    ['pi', 'Pi', piChat.sessions],
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
let settingsCloseReady = false, settingsFlush = null, settingsQuitPending = false;
let nativeSettingsView = null;
let nativeSettingsLoad = null;
const { errorHtml } = require('./desktop-views.js').createDesktopViews({
  appName: APP_NAME,
  isDark: () => nativeTheme.shouldUseDarkColors,
});

function openApiSettingsWindow() {
  openSettingsWindow();
}

function flushSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed() || settingsWindow.webContents.isLoading()) return Promise.resolve(true);
  if (settingsFlush) return settingsFlush;
  const contents = settingsWindow.webContents;
  let timeout;
  settingsFlush = Promise.race([
    contents.executeJavaScript('window.flushApiSettings ? window.flushApiSettings() : ({ ok: true })'),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('API settings save timed out')), 10000); }),
  ]).then(result => result?.ok === true).catch(error => {
    log(`settings close: ${error.message}`);
    return false;
  }).finally(() => { clearTimeout(timeout); settingsFlush = null; });
  return settingsFlush;
}

function openSettingsWindow(target = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    const existingSettingsWindow = settingsWindow;
    existingSettingsWindow.show();
    existingSettingsWindow.focus();
    const navigate = () => {
      if (settingsWindow !== existingSettingsWindow || existingSettingsWindow.isDestroyed()) return;
      existingSettingsWindow.webContents.send('dsh:settings-navigate', target);
    };
    if (existingSettingsWindow.webContents.isLoading()) existingSettingsWindow.webContents.once('did-finish-load', navigate);
    else navigate();
    return;
  }
  settingsCloseReady = false;
  settingsWindow = new BrowserWindow({
    width: 1160,
    height: 860,
    minWidth: 760,
    minHeight: 620,
    // Create hidden and centered: showing the window before the renderer has
    // painted makes it appear at the OS default position for a moment and then
    // jump to its final place.
    show: false,
    center: true,
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
  const settingsContents = settingsWindow.webContents;
  const closingWindow = settingsWindow;
  settingsWindow.on('close', event => {
    if (settingsCloseReady) return;
    event.preventDefault();
    void flushSettingsWindow().then(saved => {
      if (!saved || closingWindow.isDestroyed()) return;
      settingsCloseReady = true;
      closingWindow.close();
    });
  });
  desktopZoom().attach(settingsContents);
  settingsWindow.once('ready-to-show', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    settingsWindow.center();
    settingsWindow.show();
  });
  settingsWindow.on('closed', () => {
    const nativeContents = liveWebContents(nativeSettingsView);
    settingsWindow = null;
    nativeSettingsView = null; nativeSettingsLoad = null;
    cliDevices.detach([settingsContents, nativeContents]);
    if (nativeContents && !nativeContents.isDestroyed()) nativeContents.close();
  });
  settingsWindow.loadFile(path.join(RENDERER_ROOT, 'settings/api-settings.html'), { query: { page: target.page || 'general', engine: target.engine || 'dsh', ...(target.focus ? { focus: target.focus } : {}) } });
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
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.on('web-contents-created', (_event, contents) => {
    attachInputContextMenu(contents, { Menu, uiText });
    attachImageContextMenu(contents, { Menu, dialog, BrowserWindow, uiText });
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
      if (runtimeUpdatesService?.isUpdating('dsh')) return { ok: false, error: 'DeepSeek Harness is updating. Reload this panel after the update.' };
      if (!loadConfig().dshBin && !runtimes().locate('dsh')) return { ok: false, needsRuntime: true,
        error: 'Download DeepSeek Harness from Settings → Engine Settings to use its native panel.' };
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

  for (const [name, handler] of Object.entries({
    'benchmark-state': () => ({ ok: true, ...benchmarks().state() }),
    'benchmark-start': async payload => {
      if (anyRuntimeUpdating()) throw new Error('Wait for runtime updates to finish before starting a benchmark');
      return { ok: true, ...await benchmarks().start(payload) };
    },
    'benchmark-cancel': () => benchmarks().cancel(),
    'benchmark-report': ({ id }) => ({ ok: true, report: benchmarks().report(id) }),
    'benchmark-delete': ({ id }) => benchmarks().deleteReport(id),
    'benchmark-install': async ({ engine }) => {
      if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(engine)) throw new Error('Unknown benchmark engine');
      assertRuntimeAvailable(engine);
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
      const result = await dialog.showSaveDialog(settingsWindow || mainWindow, { title: uiText('Export API route configuration'),
        defaultPath: `camellia-api-routes-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON configuration', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      writeJson(result.filePath, apiRoutesBundle(cfg));
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
    'subscription-preferences-get': ({ engine }) => {
      if (!['codex', 'kimi', 'antigravity'].includes(engine)) throw new Error('Unknown subscription engine');
      const settings = engine === 'codex' ? codex.settings() : engine === 'kimi' ? kimiSettings() : antigravity.settings();
      return { ok: true, preferences: { autoSwitchQuota: loadConfig().subscriptionAutoSwitch?.[engine] !== false, connection: settings.connection,
        ...(engine === 'kimi' ? { region: settings.region || 'mainland-cn' } : { proxyUrl: settings.proxyUrl || '' }),
        ...(engine === 'antigravity' ? { useG1Credits: readJson(path.join(os.homedir(), '.gemini/antigravity-cli/settings.json'), {}).useG1Credits === true } : {}) } };
    },
    'subscription-preferences-save': async ({ engine, preferences = {} }) => {
      if (!['codex', 'kimi', 'antigravity'].includes(engine)) throw new Error('Unknown subscription engine');
      if (preferences.autoSwitchQuota !== undefined) {
        if (typeof preferences.autoSwitchQuota !== 'boolean') throw new Error('Invalid automatic account switching preference');
        saveConfig({ subscriptionAutoSwitch: { ...loadConfig().subscriptionAutoSwitch, [engine]: preferences.autoSwitchQuota } });
        if (Object.keys(preferences).length === 1) return { ok: true, preferences: { autoSwitchQuota: preferences.autoSwitchQuota } };
      }
      if (engineBusy(engine)) throw new Error('Stop the current response or goal before changing global settings');
      if (preferences.connection !== undefined && !['api', 'subscription'].includes(preferences.connection)) throw new Error('Invalid subscription connection');
      const connection = preferences.connection === undefined ? {} : { connection: preferences.connection };
      if (engine === 'kimi') {
        if (kimiAccount.changingAccount) throw new Error('Complete the account operation before changing login preferences');
        saveKimiSettings({ region: preferences.region, ...connection });
        return { ok: true, preferences: { region: kimiSettings().region, connection: kimiSettings().connection } };
      }
      const savedProxy = engine === 'codex' ? codex.settings().proxyUrl : antigravity.settings().proxyUrl;
      const requestedProxy = preferences.proxyUrl ?? savedProxy ?? '';
      const proxyUrl = downloadSettings({ mode: requestedProxy ? 'proxy' : 'direct', url: requestedProxy }).url;
      if (engine === 'codex') {
        if (codex.accountState().accounts.some(account => account.loginPending)) throw new Error('Complete the account operation before changing login preferences');
        await codex.shutdown();
        codex.saveSettings({ proxyUrl, ...connection });
      } else {
        const file = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
        const native = readJson(file, {});
        if (preferences.useG1Credits !== undefined) {
          if (typeof preferences.useG1Credits !== 'boolean') throw new Error('Invalid AI credits preference');
          backup(file);
          writeJson(file, { ...native, useG1Credits: preferences.useG1Credits });
        }
        await antigravity.shutdown();
        antigravity.saveSettings({ proxyUrl, ...connection });
        return { ok: true, preferences: { proxyUrl, connection: antigravity.settings().connection,
          useG1Credits: preferences.useG1Credits ?? (native.useG1Credits === true) } };
      }
      return { ok: true, preferences: { proxyUrl, connection: codex.settings().connection } };
    },
    'engine-settings-save': async ({ engine, ...payload }) => {
      assertRuntimeAvailable(engine);
      if (engineBusy(engine)) throw new Error("Stop the current response or goal before changing global settings");
      if (engine === 'antigravity' && payload.expectedConnection && payload.expectedConnection !== antigravity.settings().connection)
        throw new Error('The subscription connection changed. Reload engine settings before saving.');
      const result = engineSettings().save(engine, payload);
      if (engine === 'claude') await claudeSessions.shutdown();
      if (engine === 'kimi') await kimiSessions.shutdown();
      if (engine === 'antigravity') await antigravity.shutdown();
      if (engine === 'codex') await codex.shutdown();
      if (engine === 'dsh') { await dshChat.shutdown(); syncOllamaBaseUrl(Boolean(ollamaProxyHandle?.getState().running)); }
      if (engine === 'pi') await piChat.shutdown();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:engine-settings-changed', { engine });
      return { ok: true, ...result };
    },
    'runtime-state': () => ({ ok: true, engines: runtimeUpdates().state() }),
    'runtime-set-path': async ({ engine, file, mode }) => {
      assertRuntimeAvailable(engine);
      if (engineBusy(engine)) throw new Error('Stop conversations using this engine before changing its path');
      const engines = await runtimes().setPath(engine, file, mode);
      if (engine === 'claude') await claudeSessions.shutdown();
      if (engine === 'kimi') await kimiSessions.shutdown();
      if (engine === 'antigravity') await antigravity.shutdown();
      if (engine === 'codex') await codex.shutdown();
      if (engine === 'dsh') await dshChat.shutdown();
      if (engine === 'pi') await piChat.shutdown();
      return { ok: true, engines: runtimeUpdates().state(engines) };
    },
    'runtime-python-state': () => ({ ok: true, python: runtimes().pythonState() }),
    'runtime-set-python': async ({ file }) => {
      if (anyRuntimeUpdating()) throw new Error('Wait for runtime updates to finish before changing Python');
      // Python is shared by every harness, so a running session anywhere may be
      // using it; stop the engines that depend on it before switching.
      if (['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].some(engineBusy)) {
        throw new Error('Stop running responses before changing the shared Python path');
      }
      const engines = await runtimes().setPython(file);
      await antigravity.shutdown();
      return { ok: true, engines, python: runtimes().pythonState() };
    },
    'runtime-ensure': async ({ engine }) => { assertRuntimeAvailable(engine); return { ok: true, runtime: await runtimes().ensure(engine) }; },
    'runtime-check-updates': async () => ({ ok: true, engines: await runtimeUpdates().check() }),
    'app-update-check': () => appUpdates().check(),
    'app-update-install': async () => {
      if (anyRuntimeUpdating()) throw new Error('Wait for runtime updates to finish before updating Camellia');
      const send = state => {
        for (const window of [settingsWindow, mainWindow]) if (window && !window.isDestroyed()) window.webContents.send('dsh:app-update-state', state);
      };
      // Replacing the installation closes the application, so confirm first and
      // reuse this check instead of querying the release feed twice.
      const available = await appUpdates().check();
      if (anyRuntimeUpdating()) throw new Error('Wait for runtime updates to finish before updating Camellia');
      if (!available.updateAvailable) throw new Error('Camellia is already up to date');
      const busy = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].filter(engineBusy);
      const { response } = await dialog.showMessageBox(settingsWindow || mainWindow, {
        type: 'question', title: uiText('Install update'), noLink: true,
        message: uiText(`Download and install Camellia v${available.latest}?`),
        detail: uiText(busy.length ? 'Camellia will close and replace the current installation. Running responses will stop; your conversations and settings are kept.'
          : 'Camellia will close and replace the current installation. Your conversations, settings and downloaded engines are kept.'),
        buttons: [uiText('Cancel'), uiText('Install and restart')], defaultId: 1, cancelId: 0,
      });
      if (response !== 1) return { ok: true, canceled: true };
      if (anyRuntimeUpdating()) throw new Error('Wait for runtime updates to finish before updating Camellia');
      return appUpdates().install(send, available);
    },
    'runtime-update': async ({ engine }) => {
      if (appUpdatesService?.state().installing) throw new Error('Wait for the Camellia update to finish before updating a runtime');
      if (benchmarkRunner?.pending || discussionService?.active) throw new Error('Stop the benchmark or discussion before updating a runtime');
      if (engineBusy(engine)) throw new Error('Stop conversations using this engine before updating it');
      if (engine === 'kimi' && kimiAccount.active) throw new Error('Wait for Kimi account activity to finish before updating it');
      return runtimeUpdates().update(engine);
    },
    'runtime-reinstall-preview': ({ engine }) => {
      assertRuntimeReinstallAllowed(engine);
      const plan = runtimes().reinstallPlan(engine);
      const token = require('node:crypto').randomUUID();
      runtimeReinstallPreviews.set(engine, { token, plan, expiresAt: Date.now() + 5 * 60 * 1000 });
      return { ok: true, engine, token, name: ENGINES[engine].name, file: plan.file, destination: plan.destination };
    },
    'runtime-reinstall': async ({ engine, token }) => {
      assertRuntimeReinstallAllowed(engine);
      const preview = runtimeReinstallPreviews.get(engine);
      if (!preview || !token || token !== preview.token || Date.now() > preview.expiresAt) {
        throw new Error('Review the installation paths before reinstalling this CLI');
      }
      runtimeReinstallPreviews.delete(engine);
      return runtimeUpdates().reinstall(engine, preview.plan);
    },
    'network-settings': async () => ({ ok: true, ...await networkSettings().detect() }),
    'network-test': () => networkSettings().testConnectivity(),
    'network-save-settings': async payload => {
      const result = await networkSettings().save(payload);
      // Engine processes inherit the proxy environment, so they have to be
      // replaced for a change to take effect without restarting Camellia. The
      // embedded network node is left alone: rebuilding it would drop a phone
      // that is connected right now. Toggling mobile access off and on picks
      // up the new settings there.
      const deferred = applyNetworkChange();
      return { ok: true, ...result, engineRestart: deferred.length === 0, deferred };
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
  ipcMain.handle('dsh:subscription-prices-refresh', async () => {
    const result = await subscriptionPrices().refresh({ force: true });
    return { ...apiRouterState(), ...result };
  });
  for (const [channel, handler] of Object.entries({
    'provider-insights': () => accountInsights(),
    'provider-refresh': payload => refreshInsights(payload),
    'provider-models': payload => insights().models(payload),
    'provider-verify': payload => insights().verify(payload),
  })) ipcMain.handle('dsh:' + channel, async (_event, payload) => {
    try { return await handler(payload); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dsh:workbench-settings', () => ({ ok: true, language: normalizeLanguage(loadConfig().language), theme: loadConfig().theme || 'system',
    conversations: conversationPreferences(loadConfig()), autoRefreshBalances: accountRefreshEnabled(), accountRefreshMinutes: accountRefreshMinutes(),
    subscriptionAutoRefresh: { antigravity: subscriptionAutoRefreshEnabled('antigravity'), codex: subscriptionAutoRefreshEnabled('codex'), kimi: subscriptionAutoRefreshEnabled('kimi') },
    closeToTray: loadConfig().closeToTray === true,
    memoryDirectory: loadConfig().memoryDirectory || '',
    quickSwitchModels: loadConfig().quickSwitchModels || {},
    quickSwitchLevels: loadConfig().quickSwitchLevels || {},
    hiddenSubscriptionModels: loadConfig().hiddenSubscriptionModels || {},
    chatContentWidth: normalizeChatContentWidth(loadConfig().chatContentWidth),
    computerName: computerName(), dataPath: app.getPath('userData'), version: app.getVersion(),
    pluginCacheMaintenance: pluginCacheMaintenanceStatus(app.getPath('userData')),
    dataDirectory: { ...dataDirectoryStatus({ appData: appDataDirectory, dataDir: app.getPath('userData') }),
      ...(!managedDataDirectory ? { legacy: false, canMigrate: false } : {}), migrationError: lastDirectoryMigration?.error || null } }));
  ipcMain.handle('dsh:workbench-save-settings', (_event, payload) => {
    try {
      // The router's quota probe follows only its own switch and cadence:
      // saving a theme, language or tray preference must not re-query every
      // provider account or re-broadcast router state.
      const previousQuotaCheck = { enabled: accountRefreshEnabled(), minutes: accountRefreshMinutes() };
      const theme = ['system', 'light', 'dark'].includes(payload?.theme) ? payload.theme : loadConfig().theme || 'system';
      const language = normalizeLanguage(payload?.language ?? loadConfig().language);
      const previousContentWidth = normalizeChatContentWidth(loadConfig().chatContentWidth);
      const patch = { theme, language, autoRefreshBalances: payload?.autoRefreshBalances === undefined ? accountRefreshEnabled() : payload.autoRefreshBalances !== false };
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'accountRefreshMinutes')) {
        const minutes = Number(payload.accountRefreshMinutes);
        patch.accountRefreshMinutes = ACCOUNT_REFRESH_MINUTES.includes(minutes) ? minutes : accountRefreshMinutes();
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'closeToTray')) patch.closeToTray = payload.closeToTray === true;
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'computerName')) patch.computerName = normalizeComputerName(payload.computerName);
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'chatContentWidth')) patch.chatContentWidth = normalizeChatContentWidth(payload.chatContentWidth);
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'memoryDirectory')) patch.memoryDirectory = validateMemoryDirectory(payload.memoryDirectory);
      if (payload?.quickSwitchModels !== undefined) {
        const models = payload.quickSwitchModels;
        if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('Invalid quick-switch models');
        patch.quickSwitchModels = { ...loadConfig().quickSwitchModels };
        for (const [engine, model] of Object.entries(models)) {
          if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(engine) || typeof model !== 'string' || model.length > 256) {
            throw new Error('Invalid quick-switch model');
          }
          if (model.trim()) patch.quickSwitchModels[engine] = model.trim();
          else delete patch.quickSwitchModels[engine];
        }
      }
      if (payload?.quickSwitchLevels !== undefined) {
        const levels = payload.quickSwitchLevels;
        if (!levels || typeof levels !== 'object' || Array.isArray(levels)) throw new Error('Invalid quick-switch levels');
        patch.quickSwitchLevels = { ...loadConfig().quickSwitchLevels };
        for (const [engine, level] of Object.entries(levels)) {
          if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(engine) || typeof level !== 'string' || level.length > 64) {
            throw new Error('Invalid quick-switch level');
          }
          if (level.trim()) patch.quickSwitchLevels[engine] = level.trim();
          else delete patch.quickSwitchLevels[engine];
        }
      }
      if (payload?.hiddenSubscriptionModels !== undefined) {
        const models = payload.hiddenSubscriptionModels;
        if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('Invalid hidden subscription models');
        const previous = loadConfig().hiddenSubscriptionModels || {};
        patch.hiddenSubscriptionModels = { ...previous };
        for (const [engine, ids] of Object.entries(models)) {
          if (!SUBSCRIPTION_MODEL_ENGINES.includes(engine) || !Array.isArray(ids) || ids.length > 512
            || ids.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 256)) {
            throw new Error('Invalid hidden subscription models');
          }
          if (ids.length) patch.hiddenSubscriptionModels[engine] = [...new Set(ids)];
          else delete patch.hiddenSubscriptionModels[engine];
        }
      }
      if (payload?.subscriptionAutoRefresh !== undefined) {
        const engines = payload.subscriptionAutoRefresh;
        if (!engines || typeof engines !== 'object' || Array.isArray(engines)) throw new Error('Invalid subscription auto-refresh preference');
        patch.subscriptionAutoRefresh = { ...loadConfig().subscriptionAutoRefresh };
        for (const [engine, enabled] of Object.entries(engines)) {
          if (!SUBSCRIPTION_MODEL_ENGINES.includes(engine) || typeof enabled !== 'boolean') throw new Error('Invalid subscription auto-refresh preference');
          // Only an opt-out is stored, so an untouched engine keeps the default.
          if (enabled) delete patch.subscriptionAutoRefresh[engine];
          else patch.subscriptionAutoRefresh[engine] = false;
        }
      }
      saveConfig(patch);
      if (payload?.conversations) saveConfig({ conversations: conversationPreferences({ conversations: payload.conversations }) });
      const contentWidth = normalizeChatContentWidth(patch.chatContentWidth ?? previousContentWidth);
      nativeTheme.themeSource = theme;
      setMenu();
      refreshTrayMenu();
      for (const window of [mainWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send('dsh:language-changed', language);
      }
      if (nativeSettingsView) nativeSettingsView.webContents.send('dsh:language-changed', language);
      if (contentWidth !== previousContentWidth && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh:chat-content-width-changed', contentWidth);
      }
      if (patch.hiddenSubscriptionModels && mainWindow && !mainWindow.isDestroyed()) {
        for (const engine of Object.keys(payload.hiddenSubscriptionModels)) {
          mainWindow.webContents.send('dsh:engine-settings-changed', { engine });
        }
      }
      if (accountRefreshEnabled() !== previousQuotaCheck.enabled || accountRefreshMinutes() !== previousQuotaCheck.minutes) syncQuotaCheck();
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
      assertRuntimeAvailable('claude');
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
    'delete-session': async payload => {
      await removeEngineSession('claude', payload.id);
      notifyArchivedChanged('claude', payload.id, 'delete');
      return { ok: true };
    },
    'meta-op': claudeMetaOp,
    'goal-get': () => ({ ok: true, goal: goalDriver.view() }),
    'goal-start': payload => goalDriver.start(payload),
    'goal-pause': () => goalDriver.setPhase('paused'),
    'goal-resume': () => goalDriver.resume(),
    'goal-complete': () => goalDriver.setPhase('complete'),
    'goal-clear': () => goalDriver.clear(),
  };
  for (const [name, handler] of Object.entries(claudeCommands)) ipcMain.handle('dsh:claude-' + name, (_event, payload) => {
    try {
      if (['goal-start', 'goal-resume'].includes(name)) assertRuntimeAvailable('claude');
      return handler(payload || {});
    }
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
    'delete-session': async payload => {
      await removeEngineSession('kimi', payload.id);
      notifyArchivedChanged('kimi', payload.id, 'delete');
      return { ok: true };
    },
    'meta-op': payload => kimiWorkspaces.metaOp(payload),
    'send': async payload => {
      assertRuntimeAvailable('kimi');
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
    'account-state': payload => {
      if (payload?.id && !kimiAccount.list().some(account => account.id === payload.id)) throw new Error('Unknown Kimi account');
      return { ok: true, ...kimiAccount.state(payload?.id) };
    },
    'account-refresh': async payload => {
      const id = payload?.id || kimiAccount.activeId();
      if (!kimiAccount.list().some(account => account.id === id)) throw new Error('Unknown Kimi account');
      await kimiAccount.refresh(id); await kimiAccount.refreshUsage({}, id);
      return { ok: true, ...kimiAccount.state() };
    },
    'account-wake': async payload => {
      const id = payload?.id || kimiAccount.activeId();
      if (!kimiAccount.list().some(account => account.id === id)) throw new Error('Unknown Kimi account');
      const service = kimiAccount.service(id);
      const result = await service.wake();
      broadcastAccountInsights();
      return { ok: true, ...result };
    },
    'account-select': payload => ({ ok: true, ...kimiAccount.select(payload?.id) }),
    'account-add': async payload => ({ ok: true, ...await kimiAccount.beginAdd(payload?.label) }),
    'account-remove': async payload => ({ ok: true, ...await kimiAccount.remove(payload?.id) }),
    'account-label': payload => ({ ok: true, ...kimiAccount.rename(payload?.id, payload?.label) }),
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
    try {
      if (['goal-start', 'goal-resume', 'account-refresh', 'account-wake', 'account-add', 'account-remove', 'sign-in', 'sign-out'].includes(name)) assertRuntimeAvailable('kimi');
      return await handler(payload);
    }
    catch (error) { log('kimi-' + name + ': ' + error.message); return { ok: false, error: error.message }; }
  });

  for (const [engine, instance] of Object.entries({ codex, antigravity })) for (const [name, handler] of Object.entries(instance.handlers)) ipcMain.handle('dsh:' + engine + '-' + name, async (_event, payload) => {
    try {
      if (['send', 'goal-start', 'goal-resume', 'account-state', 'account-refresh', 'account-refresh-usage',
        'account-wake', 'account-add', 'account-remove', 'sign-in', 'sign-out'].includes(name)) assertRuntimeAvailable(engine);
      const result = await handler(payload);
      if (name === 'account-refresh' && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:engine-settings-changed', { engine });
      return result;
    } catch (error) { return error.code === 'DOWNLOAD_CANCELLED' ? { ok: true, canceled: true } : { ok: false, error: error.message }; }
  });

  for (const engine of ['codex', 'antigravity']) ipcMain.handle('dsh:' + engine + '-delete-session', async (_event, payload) => {
    try {
      await removeEngineSession(engine, payload?.id);
      notifyArchivedChanged(engine, payload?.id, 'delete');
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  require('./discussion-ipc').registerDiscussionIpc({ ipcMain, service: { call: (...args) => discussions().call(...args) },
    page: path.join(RENDERER_ROOT, 'discussions/discussions.html'), chatPage: path.join(RENDERER_ROOT, 'chat/claude.html'),
    navigate: query => switchMode('discussions', null, query), getWindow: () => mainWindow });
  ipcMain.handle('dsh:switch-mode', (_event, mode) => navigateMode(mode));
  ipcMain.handle('dsh:conversation-command', async (_event, { engine, action, payload, historyPage }) => {
    try { return await sharedConversations.command(engine, action, payload, { historyPage }); }
    catch (error) { return { ok: false, error: error.message }; }
    finally {
      if (!['list-sessions', 'load-session', 'get-live', 'get-settings', 'goal-get', 'task-list', 'list-attachable-conversations'].includes(action))
        remoteDesktop?.publish();
    }
  });
  ipcMain.handle('dsh:conversation-switch', async (_event, payload) => {
    try {
      if (payload.sessionId) {
        if (payload.navigate) {
          if (sharedConversations.get(payload.sessionId).currentEngine !== payload.engine) throw new Error('The conversation engine changed. Open the conversation again.');
        } else await sharedConversations.switchEngine(payload.sessionId, payload.engine, payload.mode);
      }
      const navigation = !payload.sessionId && payload.newSession === true ? { new: '1',
        ...(typeof payload.workspaceId === 'string' ? { workspace: payload.workspaceId } : {}), ...(payload.addWorkspace === true ? { addWorkspace: '1' } : {}) } : undefined;
      const result = await switchMode(payload.engine, payload.sessionId, navigation);
      return result;
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:conversation-open-handoff', (_event, { sessionId, file }) => {
    const c = sharedConversations.get(sessionId);
    if (!sharedConversations.handoffFiles(c).has(path.resolve(file))) return { ok: false, error: 'Handoff not found' };
    void shell.openPath(file); return { ok: true };
  });

  // ---- Archived conversations (Settings → Archived) ------------------------

  // ---- Idle native sessions ------------------------------------------------
  const idleSessionReaper = new IdleSessionReaper(sessionPools(), {
    intervalMs: IDLE_SESSION_SWEEP_MS, log,
    timeoutMs: () => conversationPreferences(loadConfig()).sessionTtlMinutes * 60000,
    isBlocked: id => sharedConversations.busy(id) || Boolean(sharedConversations.goals.get(id)?.armed),
    onRelease: ids => log('Stopped idle engine processes for: ' + ids.join(', ')),
  });

  const cleanupActivity = () => appQuitting || dataDirectoryRestart || discussionService?.active || remoteDesktop?.attachmentReferences().active
    || sharedConversations.isBusy() || goalDriver.armed || kimiGoalDriver.armed || codex.goal.armed || antigravity.goal.armed
    || sessionPools().some(pool => pool.running);
  const storageActivity = () => migrationBusy || cleanupActivity();
  const storageCleanup = new StorageCleanup({
    dataDir: app.getPath('userData'), conversations: sharedConversations,
    isActive: storageActivity,
    histories: [claudeHistory, kimiHistory, codex.history, antigravity.history, dshChat.history, piChat.history],
    liveOwners: () => sessionPools()
      .flatMap(pool => [...pool.sessions.entries()].filter(([, session]) => !session.dead).map(([id]) => id)),
    references: async () => {
      let active = Boolean(storageActivity());
      const contents = require('electron').webContents.getAllWebContents().filter(contents => {
        const url = contents.getURL().split('?')[0];
        return url === pathToFileURL(path.join(RENDERER_ROOT, 'settings/api-settings.html')).href
          || url === pathToFileURL(path.join(RENDERER_ROOT, 'chat/claude.html')).href
          || url === pathToFileURL(path.join(RENDERER_ROOT, 'discussions/discussions.html')).href;
      });
      if (!contents.length) throw new Error('Could not verify saved drafts; cleanup was stopped');
      const references = await Promise.all(contents.map(async contents => {
        let timer;
        try {
          const result = await Promise.race([
            contents.executeJavaScript(`(() => {
              try {
                const saved = [];
                for (let index = 0; index < localStorage.length; index++) {
                  const key = localStorage.key(index);
                  if (key.startsWith('camellia-chat-draft:') || key.startsWith('camellia-chat-queue:') || key.startsWith('camellia:discussion:draft:')) saved.push(JSON.parse(localStorage.getItem(key)));
                }
                let active = false;
                if (document.getElementById('attachRow') && !document.body.classList.contains('discussion-workbench')) {
                  if (loadingSession || switchingEngine || !uiReady) throw new Error('Could not verify saved drafts; cleanup was stopped');
                  active = sending;
                  saved.push(attachments, messageQueue, [...conversationQueues.values()]);
                }
                if (window.CamelliaDiscussions) {
                  const discussions = window.CamelliaDiscussions.references();
                  saved.push(discussions.references);
                  active ||= discussions.active;
                }
                return { ok: true, references: saved, active };
              } catch (error) { return { ok: false, error: error.message }; }
            })()`),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Could not verify saved drafts; cleanup was stopped')), 5000); }),
          ]);
          if (!result?.ok) throw new Error(result?.error || 'Could not verify saved drafts; cleanup was stopped');
          active ||= Boolean(result.active);
          return result.references;
        } finally { clearTimeout(timer); }
      }));
      active ||= Boolean(storageActivity());
      const remote = remoteDesktop?.attachmentReferences();
      return { references: [references, remote?.references || []], active: active || Boolean(remote?.active) };
    },
  });
  remoteDesktop?.maintainAttachments(storageCleanup, log);
  ipcMain.handle('dsh:storage-references-changed', () => { remoteDesktop?.attachmentsChanged(); });
  ipcMain.handle('dsh:storage-scan', async () => {
    try { return { ok: true, ...await storageCleanup.scan() }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:storage-clean', async (_event, payload) => {
    try { const result = await storageCleanup.clean(payload?.token); remoteDesktop?.attachmentsChanged(); return { ok: true, ...result }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  // Move a profile between installs, folders or computers. Both directions are
  // explicit, refuse to run while an engine is busy, and report progress so the
  // settings page can show a real bar instead of a frozen button.
  let dataDirectoryRestart = false;
  let pluginCacheRestart = false;
  const migrationHome = os.homedir();
  const migrationProgress = state => {
    for (const window of [settingsWindow, mainWindow]) if (window && !window.isDestroyed()) window.webContents.send('dsh:data-migration-progress', state);
  };
  const assertMigrationIdle = () => {
    if (cleanupActivity()) throw new Error('Stop the current response or goal before moving your data');
    if (benchmarkRunner?.pending || discussionService?.active) throw new Error('Stop the benchmark or discussion before moving your data');
    if (runtimeManager?.busy || anyRuntimeUpdating() || benchmarkLibraryManager?.busy || appUpdatesService?.state().installing) {
      throw new Error('Wait for downloads and updates to finish before moving your data');
    }
  };
  ipcMain.handle('dsh:data-directory-migrate', async () => {
    if (migrationBusy) return { ok: false, error: uiText('A data transfer is already running') };
    migrationBusy = true;
    let requested = false;
    try {
      if (!managedDataDirectory) throw new Error('Custom data directories are kept unchanged');
      assertMigrationIdle();
      if (!await flushSettingsWindow()) throw new Error('Save your settings before moving your data');
      assertMigrationIdle();
      const state = requestDirectoryMigration({ appData: appDataDirectory, dataDir: app.getPath('userData') });
      requested = true;
      dataDirectoryRestart = true;
      app.relaunch();
      app.quit();
      return { ok: true, restarting: true, ...state };
    } catch (error) {
      if (requested) cancelDirectoryMigration(appDataDirectory);
      dataDirectoryRestart = false;
      migrationBusy = false;
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('dsh:plugin-cache-maintain', async () => {
    if (migrationBusy) return { ok: false, error: uiText('A data transfer is already running') };
    migrationBusy = true;
    let requested = false;
    try {
      assertMigrationIdle();
      if (!await flushSettingsWindow()) throw new Error('Save your settings before moving your data');
      assertMigrationIdle();
      requestPluginCacheMaintenance(app.getPath('userData'));
      requested = true;
      pluginCacheRestart = true;
      dataDirectoryRestart = true;
      app.relaunch();
      app.quit();
      return { ok: true, restarting: true };
    } catch (error) {
      if (requested) cancelPluginCacheMaintenance(app.getPath('userData'));
      pluginCacheRestart = false; dataDirectoryRestart = false; migrationBusy = false;
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('dsh:data-export', async (_event, payload) => {
    if (migrationBusy) throw new Error('A data transfer is already running');
    migrationBusy = true;
    try {
      assertMigrationIdle();
      const scope = normalizeMigrationScope(payload?.scope === undefined ? 'all' : payload.scope);
      if (!scope) return { ok: false, error: uiText('Choose at least one category to export') };
      const result = await dialog.showSaveDialog(settingsWindow || mainWindow, { title: uiText('Export Camellia data'),
        defaultPath: `camellia-data-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'Camellia data package', extensions: ['zip'] }] });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      assertMigrationIdle();
      migrationProgress({ phase: 'export', bytes: 0, totalBytes: 0 });
      // Native API history needs its writers to finish before snapshotting.
      // Configuration-only transfers leave engine and account clients running.
      if (scope.includes('conversations')) {
        for (const engine of NETWORK_ENGINES) await stopEngineForUpdate(engine, 'data export');
        assertMigrationIdle();
      }
      const summary = await createDataPackage({ dataDir: app.getPath('userData'), home: migrationHome, appVersion: app.getVersion(),
        destination: result.filePath, scope, onProgress: migrationProgress });
      return { ok: true, file: result.filePath, ...summary };
    } catch (error) { log('data export failed: ' + error.message); return { ok: false, error: error.message }; }
    finally { migrationBusy = false; migrationProgress({ phase: 'done' }); remoteDesktop?.attachmentsChanged(); }
  });
  ipcMain.handle('dsh:data-import', async (_event, payload) => {
    if (migrationBusy) throw new Error('A data transfer is already running');
    migrationBusy = true;
    try {
      assertMigrationIdle();
      let file = payload?.file;
      if (!file) {
        const result = await dialog.showOpenDialog(settingsWindow || mainWindow, { title: uiText('Import Camellia data'),
          filters: [{ name: 'Camellia data package', extensions: ['zip'] }], properties: ['openFile'] });
        if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };
        file = result.filePaths[0];
      }
      const scope = payload?.scope === 'all' ? 'all' : normalizeMigrationScope(payload?.scope);
      if (!scope) {
        if (payload?.scope !== undefined && payload?.scope !== null) return { ok: false, error: uiText('Choose at least one category to import') };
        const { categories } = await inspectDataPackage(file);
        if (!Object.values(categories).some(category => category.files > 0)) return { ok: false, error: uiText('The package has no Camellia data to import') };
        return { ok: true, needsSelection: true, file, categories };
      }
      assertMigrationIdle();
      migrationProgress({ phase: 'import', bytes: 0, totalBytes: 0 });
      const summary = await importDataPackage({ file, scope, dataDir: app.getPath('userData'), home: migrationHome, onProgress: migrationProgress });
      return { ok: true, ...summary };
    } catch (error) { log('data import failed: ' + error.message); return { ok: false, error: error.message,
      ...(error.backupDir ? { backupDir: error.backupDir, rolledBack: error.rolledBack, recoveryRequired: error.recoveryRequired === true } : {}) }; }
    finally { migrationBusy = false; migrationProgress({ phase: 'done' }); remoteDesktop?.attachmentsChanged(); }
  });
  const archivedSources = () => ({
    claude: claudeWorkspaces, kimi: kimiWorkspaces, codex: codex.workspaces,
    antigravity: antigravity.workspaces, shared: sharedConversations.workspaces,
  });
  const notifyArchivedChanged = (source, id, action, ids) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:archived-changed', { source, id, action, ...(ids ? { ids } : {}) });
  };
  let deletingAllArchived = false;
  // Permanent delete of one conversation from the sidebar: stop and clear any
  // goal that owns it (a running goal must be paused first), drop its native
  // connection binding, then remove the transcript and every metadata entry.
  async function removeEngineSession(source, id) {
    const goal = { claude: goalDriver, kimi: kimiGoalDriver, codex: codex.goal, antigravity: antigravity.goal, shared: null }[source];
    if (goal?.goal?.sessionId === id) {
      if (goal.armed) throw new Error('Pause the goal before deleting its conversation');
      goal.clear();
    }
    if (source === 'shared') {
      if (sharedConversations.busy(id)) throw new Error('Stop this conversation before deleting it');
      await sharedConversations.deleteConversation(id);
    } else await archivedSources()[source].removeSession(id);
    const bindingKeys = [
      { kimi: 'kimiSessionConnections', codex: 'codexSessionConnections' }[source],
      { kimi: 'kimiSessionAccounts', codex: 'codexSessionAccounts' }[source],
    ].filter(Boolean);
    for (const key of bindingKeys) {
      if (!loadConfig()[key]?.[id]) continue;
      const bindings = { ...loadConfig()[key] };
      delete bindings[id];
      saveConfig({ [key]: bindings });
    }
  }
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
      const sessions = mod.listDesktopImportCandidates(sharedConversations, mod.desktopStatePath());
      return { ok: true, sessions, truncated: sessions.truncated };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:codex-desktop-sync', async (_event, payload) => {
    try {
      const mod = codexDesktop();
      return { ok: true, ...await mod.syncDesktopSession(sharedConversations, mod.desktopStatePath(), payload?.id) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:codex-desktop-import', async (_event, payload) => {
    try {
      const mod = codexDesktop();
      const result = await mod.importDesktopSessions(sharedConversations, mod.desktopStatePath(), payload?.ids || [], log);
      return { ok: true, ...result };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('dsh:archived-session-action', async (event, payload) => {
    const notify = notifyArchivedChanged;
    const removeArchived = removeEngineSession;
    try {
      const { source, id, action } = payload || {};
      if (!['restore', 'delete', 'delete-all'].includes(action)) throw new Error('Unknown action');
      if (action === 'delete-all') {
        if (deletingAllArchived) throw new Error('Archived conversations are already being deleted');
        deletingAllArchived = true;
        let deleted = 0;
        const deletedIds = [];
        try {
          // Metadata already identifies archived conversations. Avoid reading
          // every transcript head again just to build the deletion queue.
          const sources = archivedSources();
          const targets = Object.entries(sources).flatMap(([each, workspaces]) =>
            Object.keys(workspaces.sessionMeta().archived).map(id => ({ source: each, id })));
          let processed = 0, lastReport = 0;
          const report = () => {
            const now = Date.now();
            if (processed && processed < targets.length && processed % 10 && now - lastReport < 100) return;
            lastReport = now;
            try {
              if (event?.sender && !event.sender.isDestroyed()) event.sender.send('dsh:archived-delete-progress', { processed, total: targets.length, deleted });
            } catch { /* Closing Settings must not interrupt deletion. */ }
          };
          report();
          // Each removal can synchronously update configuration and files. A
          // real event-loop turn between removals keeps Electron responsive.
          await nextEventLoopTurn();
          for (const target of targets) {
            if (sources[target.source].sessionMeta().archived[target.id]) {
              await removeArchived(target.source, target.id);
              deleted++;
              deletedIds.push(target.id);
            }
            processed++;
            report();
            await nextEventLoopTurn();
          }
          return { ok: true, deleted, skipped: targets.length - deleted };
        } finally {
          // One sidebar refresh is enough, including after a partial failure.
          deletingAllArchived = false;
          try { if (deletedIds.length) notify(null, null, 'delete-all', deletedIds); }
          catch (error) { log('Could not notify chat windows after deleting archived conversations: ' + error.message); }
        }
      }
      if (deletingAllArchived) throw new Error('Archived conversations are being deleted');
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

  ipcMain.handle('dsh:preview-file', async (_event, filePath) => {
    try {
      const file = describePreview(filePath);
      // The pre-2007 formats are `document`/`spreadsheet` OLE2 binaries rather
      // than ZIP archives, so they route to their own readers. An OLE container
      // that fails its format check falls through to the system-app message
      // instead of failing the whole preview request.
      const isLegacy = file.kind === 'document';
      if (file.kind === 'spreadsheet' && isOleWorkbook(file.path)) file.office = readXlsPreview(file.path);
      else if (isLegacy && isWordDocument(file.path)) file.office = readDocPreview(file.path);
      else if (isLegacy && isLegacyPresentation(file.path)) file.office = readPptPreview(file.path);
      else if (['word', 'presentation', 'spreadsheet'].includes(file.kind)) file.office = await readOfficePreview(file.path, file.kind);
      return { ok: true, file };
    }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  });

  ipcMain.handle('dsh:resolve-artifacts', (_event, payload) => {
    try {
      const sessionCwd = payload?.sessionId ? sharedConversations.get(payload.sessionId).cwd : '';
      const cwd = sessionCwd || payload?.cwd || '';
      return { ok: true, files: resolveArtifacts({ paths: payload?.paths, text: payload?.text, cwd, roots: payload?.roots }) };
    } catch (error) { return { ok: false, error: error?.message || String(error) }; }
  });

  ipcMain.handle('dsh:open-file-externally', async (_event, filePath) => {
    try {
      const preview = describePreview(filePath);
      const error = await shell.openPath(preview.path);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) { return { ok: false, error: error?.message || String(error) }; }
  });

  ipcMain.handle('dsh:reveal-file', async (_event, filePath) => {
    try {
      await revealInFileManager(filePath, {
        openPath: folder => shell.openPath(folder),
        showItemInFolder: file => shell.showItemInFolder(file),
      });
      return { ok: true };
    } catch (error) { return { ok: false, error: error?.message || String(error) }; }
  });

  ipcMain.handle('dsh:save-clipboard-image', (_event, payload) => {
    try { return { ok: true, attachment: saveClipboardImage(app.getPath('userData'), payload) }; }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  });

  ipcMain.handle('dsh:save-pasted-text', (_event, payload) => {
    try { return { ok: true, attachment: savePastedText(app.getPath('userData'), payload) }; }
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
    const mode = ['home', 'benchmark', 'claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(currentMode) ? currentMode : 'home';
    currentMode = mode;
    void loadMode(mode);
  }
  function refreshTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: uiText('Open Camellia'), click: () => showMainWindow() },
      { label: uiText('Settings…'), click: () => openSettingsWindow() },
      { label: normalizeLanguage(loadConfig().language) === 'en' ? 'Mobile access…' : '手机访问…', click: () => remoteDesktop.open() },
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
    try { await networkSettings().initialize(); }
    catch (error) { log('Network settings: ' + error.message); }
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(path.join(APP_ROOT, 'assets/icon-1024.png'));
    }
    nativeTheme.themeSource = loadConfig().theme || 'system';
    void remoteDesktop.startTrustedDevices().catch(error => log('Mobile access auto-start failed:', error.message));
    setMenu();
    cleanupOpencodeProxyRoute(); // strip the removed OpenCode proxy's stale route
    await startOllamaProxyHandle();
    goalDriver.load();
    kimiGoalDriver.load();
    antigravity.goal.load();
    codex.goal.load();
    createMainWindow();
    setupTray();
    if (sharedConversations.recoveryWarnings.length) {
      void dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Saved data recovery',
        message: 'Some saved records could not be loaded. Other conversations remain available.',
        detail: sharedConversations.recoveryWarnings.map(warning => warning.error).join('\n\n'), buttons: ['OK'] })
        .catch(error => log('Could not show data recovery warning:', error.message));
    }
    idleSessionReaper.start();
    void refreshAccountBalances();
    subscriptionPrices().start();
    try { subscriptionUsage().reprice(); } catch (error) { log('Subscription repricing:', error.message); }
    switchMode('home');

    if (!app.isPackaged && process.argv.includes('--hot-reload')) {
      try {
        let reloadTimer = null;
        fs.watch(path.join(RENDERER_ROOT, 'chat'), (_event, filename) => {
          if (!['claude.html', 'claude.css', 'claude.js', 'chat-runtime.js'].includes(String(filename))) return;
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            if (['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(currentMode) && mainWindow && !mainWindow.isDestroyed()) {
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

  let kimiClosing = false, directoryClosing = false, directoryCloseReady = false, logClosing = false, logCloseReady = false;
  app.on('before-quit', event => {
    if (settingsWindow && !settingsWindow.isDestroyed() && !settingsCloseReady) {
      event.preventDefault();
      if (settingsQuitPending) return;
      settingsQuitPending = true;
      void flushSettingsWindow().then(saved => {
        settingsQuitPending = false;
        if (!saved) return;
        settingsCloseReady = true;
        app.quit();
      });
      return;
    }
    if (dataDirectoryRestart && directoryClosing && !directoryCloseReady) { event.preventDefault(); return; }
    appQuitting = true;
    idleSessionReaper.stop();
    if (!dataDirectoryRestart) { void remoteDesktop?.close(); void cliDevices.close(); }
    clearTimeout(balanceRefreshTimer);
    for (const goal of [goalDriver, kimiGoalDriver, antigravity.goal, codex.goal]) {
      if (goal.armed) goal.setPhase('paused');
      else goal.cancelTimer();
    }
    sharedConversations.pauseGoals();
    sharedConversations.closeGoalTools();
    if (dataDirectoryRestart && !directoryClosing) {
      event.preventDefault();
      directoryClosing = true;
      kimiClosing = true;
      void Promise.allSettled([remoteDesktop?.close(), cliDevices.close(), backend.stopAndWait(), stopOllamaProxyHandle(),
        discussionService?.shutdown(), claudeSessions.shutdown(), codex.shutdown(), kimiAccount.shutdown(), piChat.shutdown(),
        dshChat.shutdown(), kimiSessions.shutdown(), antigravity.shutdown(), benchmarkRunner?.shutdown()]).then(results => {
        if (results.some(result => result.status === 'rejected')) {
          if (pluginCacheRestart) {
            try { cancelPluginCacheMaintenance(app.getPath('userData')); } catch (error) { log('Cancel plugin cache maintenance: ' + error.message); }
          }
          try { cancelDirectoryMigration(appDataDirectory); } catch (error) { log('Cancel directory migration: ' + error.message); }
          log('Data directory migration canceled because a background process did not stop');
        }
        directoryCloseReady = true;
        app.quit();
      });
      return;
    }
    if ((discussionService?.active || claudeSessions.active || codex.active || kimiAccount.active || piChat.sessions.active || dshChat.sessions.active || kimiSessions.active || antigravity.sessions.active || benchmarkRunner?.pending) && !kimiClosing) {
      event.preventDefault();
      kimiClosing = true;
      void Promise.allSettled([discussionService?.shutdown(), claudeSessions.shutdown(), codex.shutdown(), kimiAccount.shutdown(), piChat.shutdown(), dshChat.shutdown(), kimiSessions.shutdown(), antigravity.shutdown(), benchmarkRunner?.shutdown()]).finally(() => app.quit());
      return;
    }
    stopBackend();
    stopOllamaProxyHandle();
    if (logWriter && !logCloseReady) {
      event.preventDefault();
      if (!logClosing) {
        logClosing = true;
        void logWriter.close().finally(() => { logCloseReady = true; app.quit(); });
      }
    }
  });

  app.on('will-quit', () => {
    networkSettingsService?.close();
    stopBackend();
    stopOllamaProxyHandle();
  });

  let modeRequest = 0;
  function navigateMode(mode) {
    const chatModes = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'];
    if (chatModes.includes(currentMode) && chatModes.includes(mode) && mainWindow && !mainWindow.isDestroyed()) {
      // The renderer owns the current logical session and unsent draft. All
      // engine menu switches must use the same handoff flow as its selector.
      mainWindow.webContents.send('dsh:harness-navigate', mode);
      return { ok: true };
    }
    return switchMode(mode);
  }
  async function switchMode(mode, conversationId, navigation) {
    if (!['home', 'benchmark', 'discussions', 'claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(mode)) {
      return { ok: false, error: 'Unknown engine or page' };
    }
    const request = ++modeRequest;
    const next = mode;
    if (Object.hasOwn(ENGINES, next)) {
      try { assertRuntimeAvailable(next); }
      catch (error) { return { ok: false, error: error.message }; }
    }
    if (next === 'discussions' && mainWindow && !mainWindow.isDestroyed()
      && mainWindow.webContents.getURL().split(/[?#]/)[0] === require('node:url').pathToFileURL(path.join(RENDERER_ROOT, 'chat/claude.html')).href) {
      mainWindow.webContents.send('dsh:discussion-navigate', navigation || {});
      return { ok: true };
    }
    try {
      if (!['home', 'benchmark', 'discussions'].includes(next) && !(next === 'dsh' && loadConfig().dshBin)) await runtimes().ensure(next, conversationId ? sharedConversations.settings(next, conversationId).connection : undefined);
    } catch (error) {
      if (error.code === 'DOWNLOAD_CANCELLED') return { ok: true, canceled: true };
      log(`runtime preparation failed: ${error.message}`);
      openSettingsWindow({ page: 'engines', engine: next });
      return { ok: false, error: error.message };
    }
    if (request !== modeRequest) return { ok: true, canceled: true };
    if (!['home', 'benchmark', 'discussions'].includes(next)) saveConfig({ mode: next });
    currentMode = next;
    log(`switch mode → ${next}`);
    // Update window title and menu according to mode
    if (mainWindow && !mainWindow.isDestroyed()) {
      const engineName = next === 'claude' ? APP_NAME_CLAUDE : ENGINES[next]?.name;
      mainWindow.setTitle(engineName ? `${engineName} — ${APP_NAME}` : APP_NAME);
    }
    setMenu();
    void loadMode(next, conversationId, navigation);
    return { ok: true };
  }

  async function loadMode(next, conversationId, navigation) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (currentMode !== next) return;
        const discussionEngine = Object.hasOwn(ENGINES, loadConfig().mode) ? loadConfig().mode : 'claude';
        await mainWindow.loadFile(path.join(RENDERER_ROOT, next === 'benchmark' ? 'benchmark/benchmark.html' : next === 'home' ? 'home/home.html' : 'chat/claude.html'),
          ['home', 'benchmark'].includes(next) ? undefined : { query: next === 'discussions' ? { harness: discussionEngine, discussion: '1', ...navigation }
            : { harness: next, ...(conversationId ? { conversation: conversationId } : {}), ...navigation } });
      }
    } catch (err) {
      log(`switch mode failed: ${err && err.stack || err}`);
      if (['claude', 'codex', 'kimi', 'antigravity', 'pi'].includes(next)) openSettingsWindow({ page: 'engines', engine: next });
      if (next === 'dsh' && currentMode === 'dsh' && mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml(err)));
      }
    }
  }

  function setMenu() {
    const template = [
      {
        label: APP_NAME,
        submenu: [
          { label: "About", click: () => dialog.showMessageBox({ type: 'info', title: `About ${APP_NAME}`, message: APP_NAME, detail: `Version ${app.getVersion()}\nEngine: ${engineStatusText()}` }) },
          { type: 'separator' },
          { label: "Settings…", accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
          { label: normalizeLanguage(loadConfig().language) === 'en' ? 'Mobile access…' : '手机访问…', click: () => remoteDesktop.open() },
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
