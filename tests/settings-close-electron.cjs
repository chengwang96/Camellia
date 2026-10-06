'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
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
      assert.match(output, /PASS: API autosave/);
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
  await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({ page: 'data' })");
  const dataSettings = await waitFor(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== home && !window.webContents.isLoading() && await window.webContents.executeJavaScript('!!document.querySelector("#dataPage") && typeof window.flushApiSettings === "function"')) return window;
    }
  });
  const dataContents = dataSettings.webContents;
  await waitFor(() => dataContents.executeJavaScript('document.querySelector("#dataPath").textContent'));
  assert.equal(await dataContents.executeJavaScript('document.querySelector("#dataPage").hidden'), false);
  assert.equal(await dataContents.executeJavaScript('document.querySelector("#pageTitle").textContent'), 'Data & backups');
  assert.equal(await dataContents.executeJavaScript('document.querySelector("#dataPath").textContent'), userData);
  assert.equal(await dataContents.executeJavaScript('document.querySelector("#storageStatus").textContent'), 'No scan yet.');
  assert.equal(await dataContents.executeJavaScript('document.querySelector("#cleanStorage").disabled'), true);
  for (const target of [{ page: 'storage' }, { page: 'general', focus: 'exportData' }]) {
    await home.webContents.executeJavaScript('window.dshDesktop.openSettingsWindow(' + JSON.stringify(target) + ')');
    await waitFor(() => dataContents.executeJavaScript('document.querySelector("#dataPage").hidden === false'));
    assert.equal(await dataContents.executeJavaScript('document.querySelector("#generalPage").hidden'), true);
  }
  await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({ page: 'archived' })");
  await waitFor(() => dataContents.executeJavaScript('document.querySelector("#archivedPage").hidden === false'));
  assert.equal(await dataContents.executeJavaScript('document.querySelector("#dataPage").hidden'), true);
  assert.equal(await dataContents.executeJavaScript('document.querySelector("#storageStatus").textContent'), 'No scan yet.');
  dataSettings.close();
  await waitFor(() => dataSettings.isDestroyed());
  await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({ page: 'providers' })");
  const settings = await waitFor(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== home && !window.webContents.isLoading() && await window.webContents.executeJavaScript('typeof window.flushApiSettings === "function" && !!config')) return window;
    }
  });
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await settings.webContents.executeJavaScript(`(async () => {
    document.getElementById('enabled').checked = false;
    document.getElementById('enabled').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('port').value = ${port};
    document.getElementById('port').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('addProvider').click();
    document.getElementById('preset').value = 'custom';
    document.getElementById('confirmAdd').click();
    const fill = (selector, value) => {
      const field = document.querySelector(selector);
      field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill('#pUrl', 'http://127.0.0.1:19099/v1');
    fill('#keyRows [data-field=key]', 'isolated-api-key');
    document.getElementById('addModel').click();
    fill('[data-model="0"][data-field=id]', 'close-test-model');
    fill('[data-model="0"][data-field=upstream]', 'close-test-upstream');
    await window.flushApiSettings();
    fill('#pName', 'Edited immediately before closing');
  })()`);
  settings.close();
  await waitFor(() => settings.isDestroyed());
  let state = await home.webContents.executeJavaScript('window.dshDesktop.apiRouterGetState()');
  assert.equal(state.providers[0].name, 'Edited immediately before closing');
  assert.equal(state.providers[0].models[0].upstream, 'close-test-upstream');
  assert.equal(state.providers[0].keys.length, 1);

  await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({ page: 'providers' })");
  const reopened = await waitFor(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== home && !window.webContents.isLoading() && await window.webContents.executeJavaScript('typeof window.flushApiSettings === "function" && !!config')) return window;
    }
  });
  await reopened.webContents.executeJavaScript(`(() => {
    document.querySelector('#providers [data-select]').click();
    const input = document.getElementById('pUrl'); input.value = 'https://';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  reopened.close();
  await waitFor(() => reopened.webContents.executeJavaScript('document.getElementById("status").classList.contains("error")'));
  assert.equal(reopened.isDestroyed(), false, 'invalid API settings keep the window open');
  state = await home.webContents.executeJavaScript('window.dshDesktop.apiRouterGetState()');
  assert.equal(state.providers[0].baseUrl, 'http://127.0.0.1:19099/v1');
  await reopened.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('pUrl'); input.value = 'http://127.0.0.1:19099/v1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const name = document.getElementById('pName'); name.value = 'Saved on application quit';
    name.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const configFile = path.join(root, 'dsh', 'ollama-proxy.json');
  app.once('will-quit', () => {
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(saved.providers[0].name, 'Saved on application quit');
    assert.equal(saved.providers[0].keys[0].key, 'isolated-api-key');
    console.log('PASS: API autosave waits on close and quit, preserves edits and blocks failed saves');
  });
  console.log('PASS: settings close');
  app.quit();
}
main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
