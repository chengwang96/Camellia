'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { completeDirectoryMigration, saveDirectoryMigrationResult } = require('./data-directory');

const PREFIX = 'camellia-directory-progress-';
const CANCEL = 'cancel';
const PROGRESS = 'progress.json';

function createDirectoryMigrationProgress({ app, appData, dataDir }) {
  if (!fs.existsSync(path.join(appData, '.camellia-directory-migration.json'))) return null;
  let directory, child, lastWrite = 0, lastStage = '', finished = false;
  let language = 'en';
  try { language = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-config.json'), 'utf8')).language || 'en'; } catch {}
  const initial = { startedAt: Date.now(), source: dataDir, destination: path.join(appData, 'camellia'), language };
  const write = state => {
    if (!directory) return;
    const file = path.join(directory, PROGRESS), temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ ...initial, ...state }));
    fs.renameSync(temporary, file);
  };
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
    write({ stage: 'scan', processedEntries: 0, processedBytes: 0, cancellable: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // A separate Electron process can show a responsive window while the
    // owner keeps its offline, synchronous migration before Electron ready.
    // Its disposable browser profile never opens or locks either data folder.
    child = spawn(process.execPath, [...(app.isPackaged ? [] : [app.getAppPath()]),
      '--camellia-directory-progress', directory], { env, windowsHide: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const cleanup = () => {
      if (directory && path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir())
        && path.basename(directory).startsWith(PREFIX)) {
        try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
      }
    };
    child.once('error', error => { process.stderr.write('Camellia migration progress window: ' + error.message + '\n'); cleanup(); });
    child.once('exit', cleanup);
  } catch (error) {
    process.stderr.write('Camellia migration progress window: ' + error.message + '\n');
  }
  return {
    onProgress(state) {
      const now = Date.now(), stageChanged = state.stage !== lastStage;
      if (!stageChanged && !state.phaseComplete && now - lastWrite < 150) return;
      lastWrite = now;
      lastStage = state.stage;
      if (stageChanged) process.stdout.write('Camellia data migration: ' + state.stage + '\n');
      if (state.cancellable && directory && fs.existsSync(path.join(directory, CANCEL))) {
        throw new Error('Data directory migration canceled; the old folder was kept intact');
      }
      try { write(state); } catch { /* Progress reporting must not damage a migration. */ }
    },
    finish(result) {
      if (finished) return;
      finished = true;
      const status = result?.error ? (result.migrated ? 'warning' : 'error') : 'done';
      try { write({ stage: status, error: result?.error || '', rollbackError: result?.rollbackError || '', cancellable: false }); } catch {}
      process.stdout.write('Camellia data migration: ' + (result?.error || 'completed') + '\n');
      // The helper normally exits itself; this also handles a failed renderer.
      if (child && status === 'done') setTimeout(() => { if (child.exitCode === null) child.kill(); }, 10_000).unref();
    },
  };
}

function migrateDataDirectory(options) {
  const progress = createDirectoryMigrationProgress(options);
  const result = completeDirectoryMigration({ ...options, onProgress: progress?.onProgress });
  if (result) {
    try { saveDirectoryMigrationResult(options.appData, result); }
    catch (error) { process.stderr.write('Could not save the migration result: ' + error.message + '\n'); }
  }
  progress?.finish(result);
  return result;
}

async function showDirectoryMigrationProgress() {
  const { app, BrowserWindow, ipcMain, Menu } = require('electron');
  const index = process.argv.indexOf('--camellia-directory-progress');
  const directory = process.argv[index + 1];
  if (!directory || path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
    || !path.basename(directory).startsWith(PREFIX) || fs.lstatSync(directory).isSymbolicLink()) {
    app.exit(1);
    return;
  }
  const profile = path.join(directory, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setName('Camellia');
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  process.on('disconnect', () => app.exit(0));
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({ width: 620, height: 440, minWidth: 520, minHeight: 400,
    title: 'Camellia', show: false, autoHideMenuBar: true, maximizable: false,
    icon: path.resolve(__dirname, '../../assets/icon-256.png'),
    webPreferences: { preload: path.join(__dirname, 'data-directory-progress-preload.js'), contextIsolation: true, nodeIntegration: false } });
  let current = null, complete = false, closing = false, timer;
  const cancel = () => {
    if (complete) { window.destroy(); app.quit(); return; }
    if (current?.cancellable !== false) fs.writeFileSync(path.join(directory, CANCEL), 'cancel');
  };
  ipcMain.on('camellia:directory-migration-cancel', event => { if (event.sender === window.webContents) cancel(); });
  window.on('close', event => { if (!complete) { event.preventDefault(); cancel(); } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const update = async () => {
    if (window.isDestroyed()) return;
    try {
      current = JSON.parse(fs.readFileSync(path.join(directory, PROGRESS), 'utf8'));
      complete = ['done', 'error', 'warning'].includes(current.stage);
      await window.webContents.executeJavaScript('window.updateMigrationProgress(' + JSON.stringify(current) + ')');
      const fraction = current.totalBytes > 0 && current.stage !== 'rewrite' ? current.processedBytes / current.totalBytes
        : current.totalEntries > 0 ? current.processedEntries / current.totalEntries : -1;
      window.setProgressBar(complete ? -1 : fraction < 0 ? 2 : Math.min(1, fraction));
      if (current.stage === 'done' && !closing) {
        closing = true;
        setTimeout(() => { if (!window.isDestroyed()) window.destroy(); app.quit(); }, 1500);
      }
    } catch { /* Retry an update if it races a progress-file replacement. */ }
  };
  await window.loadFile(path.join(__dirname, '../renderer/migration/progress.html'));
  await update();
  if (process.env.CAMELLIA_DIRECTORY_PROGRESS_HIDDEN !== '1') window.show();
  timer = setInterval(() => { void update(); }, 200);
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => clearInterval(timer));
  return window;
}

module.exports = { createDirectoryMigrationProgress, migrateDataDirectory, showDirectoryMigrationProgress };
