'use strict';
// Real Electron main + preload + renderer, with isolated storage and hidden
// windows. No model requests, installed user credentials, or live CLI sessions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  if (process.versions.electron) {
    const { app, BrowserWindow, Menu } = require('electron');
    const root = process.env.DSH_ELECTRON_SMOKE_ROOT;
    assert.ok(root && path.basename(root).startsWith('dsh-electron-smoke-'));
    const firstRun = !JSON.parse(fs.readFileSync(path.join(root, 'app', 'desktop-config.json'))).firstRunComplete;
    const userData = path.join(root, firstRun ? 'app' : 'dsh-desktop');
    if (firstRun) {
      app.setPath('userData', userData);
    } else {
      // Simulate Electron's new package name while existing data is in the old directory.
      fs.cpSync(path.join(root, 'app'), userData, { recursive: true });
      const renamedDefault = path.join(root, 'camellia-desktop');
      fs.mkdirSync(renamedDefault);
      app.setPath('appData', root);
      app.setName('camellia-desktop');
      app.setPath('userData', renamedDefault);
      app.setPath('sessionData', renamedDefault);
    }
    app.disableHardwareAcceleration();
    const errors = [];
    app.on('browser-window-created', (_event, window) => {
      window.hide();
      window.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
      window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    });
    require('../src/main/main.js');
    await app.whenReady();
    assert.equal(app.getName(), 'Camellia');
    assert.equal(app.getPath('userData'), userData, 'Renaming preserves old data and explicit profiles');
    if (!firstRun) assert.equal(app.getPath('sessionData'), userData, 'Browser cookies and caches stay with existing data');
    const waitWindow = async match => {
      for (let i = 0; i < 150; i++) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isLoading() && await window.webContents.executeJavaScript(`Boolean(${match})`)) return window;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Electron window did not finish loading: ' + match);
    };
    const home = await waitWindow("document.querySelector('#enterDsh')");
    assert.equal(await home.webContents.executeJavaScript('document.documentElement.lang'), 'en');
    assert.equal(home.getTitle(), 'Camellia');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('.home-brand').textContent"), 'Camellia');
    const marker = path.join(root, 'backend-starts.txt');
    assert.equal(fs.existsSync(marker), false, 'The home panel must not start DSH');
    await home.webContents.executeJavaScript("document.querySelector('#openConfig').click()");
    const initialSettings = await waitWindow("document.querySelector('#providersPage')");
    assert.equal(initialSettings.getTitle(), "Settings — Camellia");
    assert.equal(await initialSettings.webContents.executeJavaScript("document.querySelector('#dshBin') === null && document.querySelector('#nodeExe') === null"), true);
    await initialSettings.webContents.executeJavaScript("document.querySelector('[data-view=general]').click(); window.dshDesktop.workbenchSaveSettings({ theme: 'system', autoRefreshBalances: false })");
    await initialSettings.webContents.executeJavaScript("document.querySelector('#port').value = '8789'; document.querySelector('#port').dispatchEvent(new Event('input', { bubbles: true }))");
    initialSettings.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(initialSettings.isDestroyed(), true, 'Unsaved settings must not trap the Electron window open');
    assert.equal(fs.existsSync(marker), false, 'Saving configuration at home must not enter DSH');
    assert.ok(await home.webContents.executeJavaScript("document.querySelector('#enterDsh') !== null"));

    await home.webContents.executeJavaScript("document.querySelector('#enterDsh').click()");

    for (let i = 0; i < 150 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(marker), true, 'Choosing DSH starts the backend');
    assert.match(await home.webContents.executeJavaScript("document.querySelector('#homeStatus').textContent"), /Starting DSH/);
    assert.equal(fs.existsSync(path.join(root, 'browser-opened')), false, 'Entering DSH must not open an external browser, even when CLI help is unavailable');
    // Navigate away during startup; its eventual response cannot replace home.
    await home.webContents.executeJavaScript("void window.dshDesktop.switchMode('home')");
    await waitWindow("document.querySelector('#enterDsh')");
    fs.writeFileSync(path.join(root, 'backend-ready'), 'ready');
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      ready = await home.webContents.executeJavaScript('window.dshDesktop.getState().then(s => Boolean(s.backendUrl))');
      if (!ready) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready, true);
    assert.ok(await home.webContents.executeJavaScript("document.querySelector('#enterDsh') !== null"));
    await home.webContents.executeJavaScript("document.querySelector('#enterDsh').click()");
    await waitWindow("document.querySelector('#fakeDsh')");
    assert.equal(home.getTitle(), 'Camellia', 'The DSH page title cannot replace the product name');
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'DSH reuses its running backend');
    const modeMenu = Menu.getApplicationMenu().items.find(item => item.label === "Engine");
    modeMenu.submenu.items.find(item => item.label === "Home").click();
    await waitWindow("document.querySelector('#enterClaude')");
    await home.webContents.executeJavaScript("document.querySelector('#enterClaude').click()");
    const claude = await waitWindow("document.querySelector('#workspacePicker')");
    assert.equal(await claude.webContents.executeJavaScript("getComputedStyle(document.querySelector('#selPermission')).appearance"), 'base-select');
    assert.equal(await claude.webContents.executeJavaScript("CSS.supports('color', 'light-dark(white, black)')"), true);
    const picker = await claude.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('#selPermission');
      select.showPicker();
      return { open: select.matches(':open'), optionHeight: select.options[0].getBoundingClientRect().height };
    })()`, true);
    assert.equal(picker.open, true);
    assert.ok(picker.optionHeight >= 40);
    claude.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    assert.equal(await claude.webContents.executeJavaScript("document.querySelector('#workspaceLabel').textContent"), "No workspace");
    assert.equal(await claude.webContents.executeJavaScript("typeof window.dshDesktop.onApiRouterState(() => {})"), 'function');
    const folder = path.join(root, 'workspace'); fs.mkdirSync(folder, { recursive: true });
    const workspace = await claude.webContents.executeJavaScript(`window.dshDesktop.claudeMetaOp(${JSON.stringify({ op: 'create-workspace', name: 'Electron 工作区', path: folder })})`);
    assert.equal(workspace.ok, true);
    await claude.webContents.executeJavaScript('sidebar.load()');
    assert.match(await claude.webContents.executeJavaScript("document.querySelector('#sessionList').textContent"), /Electron 工作区/);
    await claude.webContents.executeJavaScript('window.dshDesktop.openSettingsWindow()');
    const settings = await waitWindow("document.querySelector('#providersPage')");
    assert.equal(await settings.webContents.executeJavaScript("document.querySelector('#dshHome') === null"), true);
    await claude.webContents.executeJavaScript('window.dshDesktop.openApiSettingsWindow()');
    const router = await waitWindow("document.querySelector('#addProvider')");
    assert.equal(router.id, settings.id, 'API and general settings share one window');
    const state = await router.webContents.executeJavaScript('window.dshDesktop.apiRouterGetState()');
    assert.equal(state.ok, true); assert.equal(state.providers.length, 0);
    await claude.webContents.executeJavaScript("document.querySelector('#backToHome').click()");
    await waitWindow("document.querySelector('#enterClaude')");
    await home.webContents.executeJavaScript("document.querySelector('#enterClaude').click()");
    await waitWindow("document.querySelector('#workspacePicker')");
    await home.webContents.executeJavaScript('sidebar.load()');
    assert.match(await home.webContents.executeJavaScript("document.querySelector('#sessionList').textContent"), /Electron 工作区/);
    await home.webContents.executeJavaScript("document.querySelector('#backToHome').click()");
    await waitWindow("document.querySelector('#enterKimi')");
    assert.ok(Menu.getApplicationMenu().items.find(item => item.label === "Engine").submenu.items.some(item => item.label === "Switch to Kimi Code"));
    await home.webContents.executeJavaScript("document.querySelector('#enterKimi').click()");
    await waitWindow("document.body.dataset.harness === 'kimi'");
    assert.equal(await home.webContents.executeJavaScript('document.title'), 'Kimi Code — Camellia');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('.logo-text').textContent"), 'Kimi Code');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#input').placeholder"), 'Message Kimi Code');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#sessionList').textContent.includes('Electron 工作区')"), false);
    const kimiWs = await home.webContents.executeJavaScript(`chatApi.metaOp(${JSON.stringify({ op: 'create-workspace', name: 'Kimi 工程', path: folder })})`);
    assert.equal(kimiWs.ok, true);
    await home.webContents.executeJavaScript('sidebar.load()');
    assert.match(await home.webContents.executeJavaScript("document.querySelector('#sessionList').textContent"), /Kimi 工程/);
    assert.equal(await home.webContents.executeJavaScript('typeof chatApi.onEvent(() => {})'), 'function');
    assert.equal((await home.webContents.executeJavaScript('chatApi.getSettings()')).contextWindow, 131072);
    await home.webContents.executeJavaScript("document.querySelector('#settingsBtn').click()");
    const engineSettings = await waitWindow("document.querySelector('#engineContext')");
    assert.equal(await engineSettings.webContents.executeJavaScript("document.querySelector('[data-engine=kimi]').getAttribute('aria-selected')"), 'true');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#settingsPanel') === null"), true);
    const globalState = await engineSettings.webContents.executeJavaScript("window.dshDesktop.engineSettingsGet({engine:'kimi'})");
    assert.equal(globalState.ok, true);
    assert.ok(globalState.files.every(file => file.path.startsWith(process.env.USERPROFILE)));

    assert.deepEqual(errors, []);
    console.log('PASS: real Electron home, configuration, DSH startup/navigation, Claude and Kimi shared UI, isolated workspaces and API settings; firstRun=' + firstRun);
    app.quit();
    return;
  }
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-electron-smoke-'));
  fs.mkdirSync(path.join(root, 'app'));
  const backendBin = path.join(root, 'fake-dsh.cjs');
  fs.writeFileSync(backendBin, `
    const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
    if (process.argv.includes('--version')) { console.log('test-dsh'); }
    else if (process.argv.includes('--help')) {
      if (process.env.DSH_SMOKE_HELP_UNAVAILABLE === '1') process.exit(1);
      console.log('--no-open');
    }
    else {
      if (!process.argv.includes('--no-open')) fs.writeFileSync(path.join(__dirname, 'browser-opened'), 'opened');
      const server = http.createServer((_req, res) => {
        const ready = fs.existsSync(path.join(__dirname, 'backend-ready'));
        res.writeHead(ready ? 200 : 503, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Test DSH</title><h1 id="fakeDsh">Local DSH test</h1>');
      });
      server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1', () => {
        fs.appendFileSync(path.join(__dirname, 'backend-starts.txt'), process.pid + '\\n');
      });
    }
  `);
  try {
    const env = { ...process.env, DSH_ELECTRON_SMOKE_ROOT: root, DSH_HOME: path.join(root, 'dsh'), USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home') };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const [mode, firstRunComplete] of [['claude', true], ['dsh', false]]) {
      for (const file of ['backend-starts.txt', 'backend-ready', 'browser-opened']) fs.rmSync(path.join(root, file), { force: true });
      fs.writeFileSync(path.join(root, 'app', 'desktop-config.json'), JSON.stringify({ mode, firstRunComplete, dshHome: path.join(root, 'dsh'), port: 0, nodeExe: process.execPath, dshBin: backendBin }));
      env.DSH_SMOKE_HELP_UNAVAILABLE = firstRunComplete ? '0' : '1';
      const proc = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'pipe' });
      let stdout = '', stderr = '';
      proc.stdout.on('data', chunk => { stdout += chunk; });
      proc.stderr.on('data', chunk => { stderr += chunk; });
      const timeout = setTimeout(() => proc.kill(), 20000);
      const code = await new Promise((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
      clearTimeout(timeout);
      assert.equal(code, 0, stderr + '\n' + stdout);
      assert.match(stdout, /PASS: real Electron/);
      console.log(stdout.trim());
    }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-electron-smoke-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
