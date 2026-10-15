'use strict';

// Real Electron IPC with failed diagnostic pipes. No installed profiles, model
// requests, CLI sessions or visible windows are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function child(root, mode) {
  assert.ok(path.basename(root).startsWith('camellia-diagnostic-output-'));
  const failure = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });
  for (const stream of [process.stdout, process.stderr]) {
    if (mode === 'sync') stream.write = () => { throw failure(); };
    else stream._write = (_data, _encoding, done) => done(failure());
  }
  const { installDiagnosticOutput } = require('../src/main/diagnostic-output');
  const output = installDiagnosticOutput();
  console.error('early diagnostic before profile selection');
  const { app, BrowserWindow, ipcMain, dialog } = require('electron');
  const { RotatingLog } = require('../src/main/rotating-log');
  const directory = path.join(root, mode);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['appData', 'userData', 'sessionData']) app.setPath(name, directory);
  app.disableHardwareAcceleration();
  const writer = new RotatingLog({ directory: path.join(directory, 'logs') });
  output.setLogger(message => writer.write(message));
  const dialogs = [], exceptions = [];
  dialog.showErrorBox = (...args) => { dialogs.push(args); };
  process.on('uncaughtExceptionMonitor', error => exceptions.push(String(error.stack || error)));
  const deadline = setTimeout(() => {
    fs.writeFileSync(path.join(directory, 'timeout.json'), JSON.stringify({ dialogs, exceptions }));
    app.exit(2);
  }, 20000);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  ipcMain.handle('fixture:reject', () => { throw new Error('ORIGINAL_IPC_FAILURE_' + mode); });
  ipcMain.handle('fixture:ping', () => 'responsive');
  await window.loadURL('data:text/html,<title>Isolated diagnostic output check</title>');
  const response = await window.webContents.executeJavaScript(`(async () => {
    const { ipcRenderer } = require('electron');
    const rejections = [];
    for (let i = 0; i < 2; i++) {
      try { await ipcRenderer.invoke('fixture:reject'); }
      catch (error) { rejections.push(error.message); }
    }
    return { rejections, ping: await ipcRenderer.invoke('fixture:ping') };
  })()`);
  console.log('stdout remains harmless after disconnection');
  console.error('diagnostic after IPC rejection');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(response.ping, 'responsive');
  assert.equal(response.rejections.length, 2);
  for (const rejection of response.rejections) assert.ok(rejection.includes('ORIGINAL_IPC_FAILURE_' + mode));
  assert.deepEqual(dialogs, []);
  assert.deepEqual(exceptions, []);
  assert.equal(window.isDestroyed(), false);
  await writer.close();
  const log = fs.readFileSync(writer.file, 'utf8');
  for (const text of ['early diagnostic before profile selection', 'ORIGINAL_IPC_FAILURE_' + mode,
    'diagnostic after IPC rejection', 'stdout remains harmless after disconnection', 'Diagnostic stderr closed']) assert.ok(log.includes(text), text);
  fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({ mode, electron: process.versions.electron,
    dialogs: dialogs.length, uncaughtExceptions: exceptions.length, rejections: response.rejections.length,
    continuedIpc: response.ping, originalErrorLogged: true }, null, 2));
  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}

async function main() {
  if (process.versions.electron) return child(process.argv[2], process.argv[3]);
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-diagnostic-output-'));
  const electron = require('electron');
  const results = [];
  for (const mode of ['sync', 'async']) {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const home = path.join(root, 'home'); fs.mkdirSync(home, { recursive: true });
    Object.assign(environment, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home });
    const processChild = spawn(electron, [__filename, root, mode], { env: environment, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => processChild.kill(), 30000);
    const code = await new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('exit', resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, `${mode}: Electron failed; diagnostics retained at ${root}`);
    results.push(JSON.parse(fs.readFileSync(path.join(root, mode, 'verification.json'), 'utf8')));
  }
  console.log(JSON.stringify({ root, results }, null, 2));
}

main().catch(error => {
  // Test failures must remain observable even when the injected pipe is closed.
  if (process.versions.electron) {
    try { fs.writeFileSync(path.join(process.argv[2], process.argv[3], 'failure.txt'), String(error.stack || error)); } catch {}
    require('electron').app.exit(1);
  } else { console.error(error); process.exitCode = 1; }
});
