'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  if (process.versions.electron) {
    const electron = require('electron'), { app, ipcMain } = electron;
    const root = process.env.CAMELLIA_DIRECTORY_TEST_ROOT;
    assert.ok(root && path.basename(root).startsWith('camellia-directory-electron-'));
    const phase = Number(process.env.CAMELLIA_DIRECTORY_TEST_PHASE);
    const appData = phase === 0 ? path.join(root, 'fresh') : root;
    fs.mkdirSync(appData, { recursive: true });
    const legacy = path.join(appData, 'dsh-desktop'), destination = path.join(appData, 'camellia');
    const initial = path.join(appData, 'camellia-desktop');
    app.setName('camellia-desktop');
    app.setPath('appData', appData);
    fs.mkdirSync(initial, { recursive: true });
    app.setPath('userData', initial);
    app.setPath('sessionData', initial);
    app.disableHardwareAcceleration();
    if (phase === 3) {
      require('../src/main/data-directory').configureDataDirectory(app);
      app.setName('Camellia');
      assert.equal(app.requestSingleInstanceLock(), false, 'The migrated app owns the new directory lock');
      console.log('PASS: real Electron data directory migration phase 3 (second instance blocked)');
      app.exit(0);
      return;
    }

    const handles = new Map(), realHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (name, handler) => { handles.set(name, handler); realHandle(name, handler); };
    const NativeBrowserWindow = electron.BrowserWindow;
    const testElectron = Object.create(electron);
    Object.defineProperty(testElectron, 'BrowserWindow', { value: class BrowserWindow extends NativeBrowserWindow {
      constructor(options) { super({ ...options, show: false }); }
      show() {}
      focus() {}
    } });
    let restarting = false;
    app.relaunch = () => { restarting = true; };
    const Module = require('node:module'), loadModule = Module._load;
    Module._load = function (name, ...args) {
      if (name === 'electron') return testElectron;
      return loadModule.call(this, name, ...args);
    };
    require('../src/main/entry.js');
    await app.whenReady();
    const settings = await handles.get('dsh:workbench-settings')();
    assert.equal(settings.dataPath, phase === 1 ? legacy : destination);
    assert.equal(settings.dataDirectory.legacy, phase === 1);
    if (phase === 0) {
      assert.equal(app.getPath('sessionData'), destination);
      assert.equal(fs.existsSync(legacy), false);
      app.quit();
    } else if (phase === 1) {
      const { BrowserWindow } = electron;
      const window = new BrowserWindow({ show: false });
      await window.loadFile(path.join(__dirname, '../assets/icon-256.png'));
      await window.webContents.executeJavaScript('localStorage.setItem("saved-draft", "keep my draft")');
      await window.webContents.session.flushStorageData();
      const result = await handles.get('dsh:data-directory-migrate')();
      assert.equal(result.ok, true, result.error);
      assert.equal(restarting, true);
      assert.equal(fs.existsSync(destination), false, 'Copy starts only after the old process exits');
    } else {
      const migration = require('../src/main/data-directory').readDirectoryMigrationResult(appData);
      assert.equal(migration.method, 'rename', JSON.stringify(migration));
      const { BrowserWindow } = electron;
      const window = new BrowserWindow({ show: false });
      await window.loadFile(path.join(__dirname, '../assets/icon-256.png'));
      assert.equal(await window.webContents.executeJavaScript('localStorage.getItem("saved-draft")'), 'keep my draft');
      assert.equal(fs.existsSync(legacy), false, JSON.stringify({ status: settings.dataDirectory, remaining: fs.existsSync(legacy) ? fs.readdirSync(legacy) : [] }));
      assert.equal(fs.readFileSync(path.join(destination, 'clipboard-attachments/keep.txt'), 'utf8'), 'original attachment');
      const saved = JSON.parse(fs.readFileSync(path.join(destination, 'conversations/metadata.json'), 'utf8'));
      assert.equal(saved.attachment, path.join(destination, 'clipboard-attachments/keep.txt'));
      const { spawn } = require('node:child_process');
      const second = spawn(process.execPath, [__filename], { env: { ...process.env, CAMELLIA_DIRECTORY_TEST_PHASE: '3' }, windowsHide: true, stdio: 'pipe' });
      let output = '', errors = '';
      second.stdout.on('data', chunk => { output += chunk; });
      second.stderr.on('data', chunk => { errors += chunk; });
      const code = await new Promise((resolve, reject) => { second.on('close', resolve); second.on('error', reject); });
      assert.equal(code, 0, output + '\n' + errors);
      assert.match(output, /second instance blocked/);
      app.quit();
    }
    console.log('PASS: real Electron data directory migration phase ' + phase);
    return;
  }

  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-directory-electron-'));
  const legacy = path.join(root, 'dsh-desktop');
  fs.mkdirSync(path.join(legacy, 'clipboard-attachments'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'clipboard-attachments/keep.txt'), 'original attachment');
  fs.writeFileSync(path.join(legacy, 'conversations/metadata.json'), JSON.stringify({ attachment: path.join(legacy, 'clipboard-attachments/keep.txt') }));
  fs.writeFileSync(path.join(legacy, 'desktop-config.json'), JSON.stringify({ firstRunComplete: true, mode: 'home', port: 0, autoRefreshBalances: false }));
  try {
    for (const phase of [0, 1, 2]) {
      const env = { ...process.env, CAMELLIA_DIRECTORY_TEST_ROOT: root, CAMELLIA_DIRECTORY_TEST_PHASE: String(phase),
        CAMELLIA_DIRECTORY_PROGRESS_HIDDEN: '1',
        DSH_HOME: path.join(root, 'home/.dsh'), USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home') };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'pipe' });
      let output = '', errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      const timeout = setTimeout(() => {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      }, 60000);
      const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
      clearTimeout(timeout);
      assert.equal(code, 0, output + '\n' + errors);
      assert.match(output, /PASS: real Electron data directory migration/);
      console.log(output.trim());
    }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-directory-electron-'));
    removeTree(root);
  }
}

main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
