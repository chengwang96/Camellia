'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { removeTree } = require('./test-fs.cjs');

const version = 'v999.999.999';

async function electronMain() {
  const { app, BrowserWindow, ipcMain, nativeTheme, safeStorage } = require('electron');
  const root = process.env.TAILNET_RESTART_TEST_ROOT;
  const done = path.join(root, 'updated.json');
  app.setPath('userData', root);
  app.disableHardwareAcceleration();
  await app.whenReady();
  let controller, network, restoreApp = () => {};
  try {
    const { EmbeddedNetwork, bundleDirectory } = require('../src/main/remote/embedded-network');
    const bundle = bundleDirectory(app);
    const executableName = process.platform === 'win32' ? 'camellia-tailnet.exe' : 'camellia-tailnet';
    const binary = fs.readFileSync(path.join(bundle, executableName));
    const notices = fs.readFileSync(path.join(bundle, 'TAILNET-NOTICES.txt'));
    const stem = ['camellia-tailnet-ipc1', process.platform, process.arch, version].join('-');
    const assets = [['bin', binary], ['txt', notices]].map(([extension, bytes]) => {
      const name = stem + '.' + extension;
      return { name, browser_download_url: 'https://github.com/chengwang96/Camellia/releases/download/v9.9.9/' + name,
        size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
    });
    fs.mkdirSync(path.join(root, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(root, 'remote', 'devices.json'), JSON.stringify({ devices: [{
      id: 'trusted-phone', name: 'Phone', tokenDigest: 'a'.repeat(64),
      permission: 'control', workspaceIds: [], allWorkspaces: true, includeUnassigned: true,
    }] }));
    let applicationCalls = 0;
    const relaunch = app.relaunch, quit = app.quit;
    app.relaunch = () => { applicationCalls++; };
    app.quit = () => { applicationCalls++; };
    restoreApp = () => { app.relaunch = relaunch; app.quit = quit; };
    const settings = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(__dirname, '../src/main/remote/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    controller = require('../src/main/remote/desktop').createRemoteDesktop({
      app, BrowserWindow, ipcMain, nativeTheme,
      rendererRoot: path.join(__dirname, '../src/renderer'), loadConfig: () => ({}),
      getSettingsWindow: () => settings,
      manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } },
      networkFactory: options => {
        network = new EmbeddedNetwork({ ...options, safeStorage, openExternal: async () => {} });
        return network;
      },
      downloadConnection: () => ({
        async fetch(url) {
          if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v9.9.9', assets });
          const asset = assets.find(item => item.browser_download_url === url);
          if (!asset) throw new Error('Unexpected download URL');
          return new Response(asset.name.endsWith('.bin') ? binary : notices);
        },
        close() {},
      }),
    });
    await settings.loadURL('data:text/html,<html><body>Tailnet hot update test</body></html>');
    const control = action => settings.webContents.executeJavaScript(`window.camelliaRemote.control(${JSON.stringify(action)})`, true);
    assert.equal((await control('state')).ok, true);
    await controller.startTrustedDevices();
    const previousHelper = network.child;
    assert.ok(previousHelper);
    const checked = await control('tailnet-update-check');
    assert.equal(checked.result?.available, version, JSON.stringify(checked));
    const installed = await control('tailnet-update-install');
    assert.equal(installed.ok, true, installed.error);
    assert.equal(installed.result.current, version);
    assert.equal(installed.result.updated, version);
    assert.equal(installed.result.reconnected, false, 'A logged-out test node remains disconnected');
    assert.equal(installed.result.pending, null);
    assert.ok(network.child);
    assert.notEqual(network.child.pid, previousHelper.pid);
    assert.ok(previousHelper.exitCode !== null || previousHelper.signalCode !== null);
    assert.equal(applicationCalls, 0, 'The desktop application must stay running');
    assert.equal(settings.isDestroyed(), false);
    const state = await control('state');
    assert.equal(state.ok, true);
    assert.equal(state.result.enabled, true);
    assert.equal(state.result.tailnetUpdate.current, version);
    fs.writeFileSync(done, JSON.stringify({ ok: true, pid: process.pid, previousHelper: previousHelper.pid, currentHelper: network.child.pid }));
    restoreApp();
    await controller.close();
    app.quit();
  } catch (error) {
    fs.writeFileSync(done, JSON.stringify({ ok: false, error: error.stack, pid: process.pid }));
    restoreApp();
    await controller?.close();
    app.exit(1);
  }
}

async function main() {
  if (process.versions.electron) return electronMain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tailnet-hot-update-'));
  const env = { ...process.env, TAILNET_RESTART_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  let timer;
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
      timer = setTimeout(() => { child.kill(); reject(new Error('Timed out waiting for the Electron hot update')); }, 90000);
    });
    assert.equal(code, 0);
    const result = JSON.parse(fs.readFileSync(path.join(root, 'updated.json'), 'utf8'));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.pid, child.pid, 'The helper update must retain the same application process');
    assert.notEqual(result.currentHelper, result.previousHelper);
    console.log('PASS: verified update and real helper restart in the same Electron process without application relaunch or quit');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-tailnet-hot-update-'));
    removeTree(root);
  }
}

main().catch(error => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
