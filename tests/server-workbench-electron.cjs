'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  if (!process.versions.electron) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-server-window-'));
    try {
      const env = { ...process.env, SERVER_WINDOW_QA_ROOT: root };
      delete env.ELECTRON_RUN_AS_NODE;
      const processHandle = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'pipe' });
      let output = '';
      processHandle.stdout.on('data', chunk => { output += chunk; });
      processHandle.stderr.on('data', chunk => { output += chunk; });
      const timeout = setTimeout(() => processHandle.kill(), 60000);
      const code = await new Promise((resolve, reject) => { processHandle.once('close', resolve); processHandle.once('error', reject); });
      clearTimeout(timeout);
      assert.equal(code, 0, output);
      assert.match(output, /PASS: server windows/);
      console.log('PASS: server windows — real Electron preload, home launch, defaults, isolation and reuse');
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      removeTree(root);
    }
    return;
  }
  const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
  app.setPath('userData', process.env.SERVER_WINDOW_QA_ROOT);
  app.disableHardwareAcceleration();
  app.on('browser-window-created', (_event, window) => { window.show = () => {}; window.hide(); });
  await app.whenReady();
  const requests = [], errors = [];
  app.on('web-contents-created', (_event, contents) => contents.on('preload-error', (_event, _file, error) => errors.push(error.message)));
  const home = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false } });
  const settings = new BrowserWindow({ show: false });
  const nativeView = new WebContentsView();
  settings.contentView.addChildView(nativeView);
  const { liveWebContents } = require('../src/main/live-web-contents');
  const nativeContents = nativeView.webContents;
  const nativeDestroyed = new Promise(resolve => nativeContents.once('destroyed', resolve));
  nativeContents.close();
  await nativeDestroyed;
  settings.destroy();
  assert.equal(liveWebContents(settings), null);
  assert.equal(liveWebContents(nativeView), null);
  const devices = [{ id: 'server-a', name: 'GPU server', address: 'http://100.80.1.2:43127', defaultHarness: 'codex' }, { id: 'server-b', name: 'Build server', address: 'http://100.80.1.3:43127', defaultHarness: 'kimi' }];
  const client = {
    pending: new Map(), list: () => devices, async close() {},
    async conversations(deviceId) { requests.push(deviceId); return { instanceId: deviceId, conversations: [], workspaces: [], engines: ['codex', 'kimi'], capabilities: ['create-workspace'], nextOffset: null }; },
    async *events(_device, _conversation, signal) { await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); },
  };
  const controller = require('../src/main/remote/devices-desktop').createDevicesDesktop({
    app, BrowserWindow, ipcMain, loadConfig: () => ({ language: 'en', theme: 'light' }),
    getSurfaces: () => [settings, nativeView].map(liveWebContents).filter(Boolean),
    getSettingsWindow: () => null, authorizedSender: contents => contents === home.webContents,
    openSettings: () => {}, clientFactory: () => client,
    networkFactory: () => ({ async status() { return { state: 'Running' }; }, async stop() {} }),
  });
  ipcMain.handle('dsh:workbench-settings', () => ({ ok: true, language: 'en' }));
  ipcMain.handle('dsh:runtime-state', () => ({ ok: true, engines: [] }));
  async function waitFor(contents, expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await contents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${expression}`);
  }
  try {
    await home.loadFile(path.join(__dirname, '../src/renderer/home/home.html'));
    await waitFor(home.webContents, 'document.querySelectorAll("[data-server]").length === 2');
    await home.webContents.executeJavaScript('document.querySelector("[data-server=server-a]").click()');
    await waitFor(home.webContents, '!document.querySelector("[data-server=server-a]").disabled');
    const first = BrowserWindow.getAllWindows().find(window => window !== home);
    assert.ok(first);
    await waitFor(first.webContents, 'document.getElementById("harness")?.value === "codex"');
    assert.equal(await first.webContents.executeJavaScript('document.getElementById("serverName").textContent'), 'GPU server');
    assert.equal((await first.webContents.executeJavaScript('camelliaDevices.call("conversations", {deviceId:"server-b"})')).ok, false);
    await home.webContents.executeJavaScript('document.querySelector("[data-server=server-b]").click()');
    await waitFor(home.webContents, '!document.querySelector("[data-server=server-b]").disabled');
    const second = BrowserWindow.getAllWindows().find(window => window !== home && window !== first);
    await waitFor(second.webContents, 'document.getElementById("harness")?.value === "kimi"');
    await home.webContents.executeJavaScript('document.querySelector("[data-server=server-a]").click()');
    await waitFor(home.webContents, '!document.querySelector("[data-server=server-a]").disabled');
    assert.equal(BrowserWindow.getAllWindows().length, 3);
    const firstClosed = new Promise(resolve => first.once('closed', resolve));
    first.close(); await firstClosed;
    assert.equal(second.isDestroyed(), false);
    assert.equal((await second.webContents.executeJavaScript('camelliaDevices.call("state")')).ok, true);
    await home.webContents.executeJavaScript('document.querySelector("[data-server=server-a]").click()');
    await waitFor(home.webContents, '!document.querySelector("[data-server=server-a]").disabled');
    const reopened = BrowserWindow.getAllWindows().find(window => window !== home && window !== second);
    await waitFor(reopened.webContents, 'document.getElementById("harness")?.value === "codex"');
    assert.equal((await second.webContents.executeJavaScript('camelliaDevices.call("state")')).ok, true);
    assert.deepEqual([...new Set(requests)].sort(), ['server-a', 'server-b']);
    assert.deepEqual(errors, []);
    console.log('PASS: server windows');
  } finally {
    await controller.close(); home.destroy(); app.quit();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
