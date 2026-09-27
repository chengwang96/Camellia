'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  if (!process.versions.electron) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-settings-close-'));
    try {
      const env = { ...process.env, SETTINGS_CLOSE_ROOT: root, DSH_HOME: path.join(root, 'dsh'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'pipe' });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const timeout = setTimeout(() => child.kill(), 60000);
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      clearTimeout(timeout);
      assert.equal(code, 0, output);
      assert.match(output, /PASS: settings close/);
      console.log('PASS: settings close/reopen through the real application main process, preload and renderer');
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      removeTree(root);
    }
    return;
  }
  const { app, BrowserWindow } = require('electron');
  process.on('uncaughtException', error => { console.error(error); app.exit(1); });
  const root = process.env.SETTINGS_CLOSE_ROOT;
  const userData = path.join(root, 'app');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'desktop-config.json'), JSON.stringify({ firstRunComplete: true, mode: 'home', port: 0 }));
  app.setPath('userData', userData);
  app.disableHardwareAcceleration();
  app.on('browser-window-created', (_event, window) => { window.show = () => {}; window.hide(); });
  require('../src/main/main');
  await app.whenReady();
  async function waitFor(check) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for application window');
  }
  const home = await waitFor(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isLoading() && await window.webContents.executeJavaScript('!!document.getElementById("openConfig")')) return window;
    }
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({ page: 'devices' })");
    const settings = await waitFor(async () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window !== home && !window.webContents.isLoading() && await window.webContents.executeJavaScript('!!window.cliDevicesUI')) return window;
      }
    });
    await waitFor(() => settings.webContents.executeJavaScript('!document.getElementById("cli-refresh").disabled'));
    const state = await settings.webContents.executeJavaScript("window.dshDesktop.camelliaDevices.call('state')");
    assert.equal(state.ok, true, state.error);
    const contents = settings.webContents;
    settings.close();
    await waitFor(() => settings.isDestroyed());
    assert.equal(contents.isDestroyed(), true);
    const servers = await home.webContents.executeJavaScript('window.dshDesktop.listCliServers()');
    assert.equal(servers.ok, true, servers.error);
  }
  console.log('PASS: settings close');
  app.quit();
}
main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
