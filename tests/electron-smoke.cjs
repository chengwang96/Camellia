'use strict';
const { removeTree } = require('./test-fs.cjs');
// Real Electron main + preload + renderer, with isolated storage and hidden
// windows. No model requests, installed user credentials, or live CLI sessions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  if (process.versions.electron) {
    const electron = require('electron');
    const NativeBrowserWindow = electron.BrowserWindow;
    // Keep test windows hidden even when production code calls show()/focus().
    // Inputs below go directly to isolated webContents, never to the desktop.
    const testElectron = Object.create(electron);
    Object.defineProperty(testElectron, 'BrowserWindow', { value: class BrowserWindow extends NativeBrowserWindow {
      constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); }
      show() {}
      showInactive() {}
      focus() {}
    } });
    const Module = require('node:module'), loadModule = Module._load;
    const kimiAccountModule = require('../src/engines/kimi-account');
    const kimiLoginProcesses = [], kimiRpcCalls = [];
    let kimiAccountHome;
    // Exercise real IPC and account state transitions with a fake official
    // process. No browser authorization or subscription requests in this test.
    const kimiAccountTest = { createKimiAccount(options) {
      kimiAccountHome = options.home;
      return kimiAccountModule.createKimiAccount({ ...options,
        spawnProcess(_exe, args, spec) {
          assert.equal(args[1], 'login'); assert.equal(spec.windowsHide, true);
          const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
          const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
            kill() { queueMicrotask(() => this.emit('close', null)); } });
          kimiLoginProcesses.push(proc);
          setTimeout(() => proc.stderr.write('Opening browser for Kimi device login: https://auth.kimi.com/device\nenter code: TEST-123\nCode expires in 600s.\n'), 10);
          return proc;
        },
        createClient: () => ({ start() {}, async shutdown() {}, async request(method) {
          kimiRpcCalls.push(method);
          if (method === 'session/new') return { sessionId: 'account-probe', configOptions: [] };
          if (method === 'logout') fs.writeFileSync(path.join(options.home, 'config.toml'), '');
          return {};
        } }),
      });
    } };
    Module._load = function (id, ...args) {
      if (id === 'electron') return testElectron;
      if (id === '../engines/kimi-account.js') return kimiAccountTest;
      return loadModule.call(this, id, ...args);
    };
    const { app, BrowserWindow, Menu } = testElectron;
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
    // This UI check does not execute the SDK; provide a ready runtime marker so
    // it stays offline even on machines where the Python download was deferred.
    const sdkDir = path.join(userData, 'runtimes/antigravity');
    const sdkConfig = require('../runtimes/antigravity/runtime.json');
    const sdkPython = path.join(sdkDir, 'python', sdkConfig.platforms[process.platform + '-' + process.arch].python);
    fs.mkdirSync(path.dirname(sdkPython), { recursive: true });
    fs.writeFileSync(sdkPython, 'UI fixture only');
    fs.mkdirSync(path.join(sdkDir, 'packages/google/antigravity'), { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'packages/google/antigravity/__init__.py'), '');
    fs.writeFileSync(path.join(sdkDir, 'runtime.json'), JSON.stringify(sdkConfig));
    fs.writeFileSync(path.join(sdkDir, 'installed.json'), JSON.stringify({ sdk: sdkConfig.sdk, python: sdkConfig.python }));
    app.disableHardwareAcceleration();
    const sharedDir = path.join(userData, 'conversations'); fs.mkdirSync(sharedDir, { recursive: true });
    for (const [id, model] of [['switch-fixture-a', 'shared-api-a'], ['switch-fixture-b', 'shared-api-b']]) {
      fs.writeFileSync(path.join(sharedDir, id + '.json'), JSON.stringify({ id, origin: 'claude', currentEngine: 'claude',
        title: 'Remember ' + model, cwd: root, workspaceId: null, createdAt: Date.now(), updatedAt: Date.now(), seq: 1,
        segments: {}, handoffs: [], apiModel: model }));
      fs.writeFileSync(path.join(sharedDir, id + '.jsonl'), JSON.stringify({ role: 'user', seq: 1, text: 'Remember this shared conversation' }) + '\n');
    }
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
    const closingWindows = new Set();
    const closeWindow = window => new Promise(resolve => {
      closingWindows.add(window.id);
      window.once('closed', resolve);
      window.close();
    });
    const waitWindow = async match => {
      // CI runners can be slow to render the first page; keep the budget generous
      // and report live window state so a timeout is diagnosable.
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed() || closingWindows.has(window.id)) continue;
          const contents = window.webContents;
          if (!contents.getURL() || contents.isLoading()) continue;
          let timer;
          try {
            const matched = await Promise.race([
              contents.executeJavaScript(`Boolean(${match})`),
              new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
            ]);
            if (matched && !window.isDestroyed() && !closingWindows.has(window.id)) return window;
          } catch (error) {
            if (!window.isDestroyed() && !contents.isDestroyed() && !contents.isLoading()) throw error;
          } finally { clearTimeout(timer); }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const states = BrowserWindow.getAllWindows().map(w => `${w.getTitle()} loading=${w.webContents.isLoading()} url=${w.webContents.getURL()}`).join('; ');
      throw new Error('Electron window did not finish loading: ' + match + ' | windows: ' + (states || '(none)'));
    };
    const home = await waitWindow("document.querySelector('#enterDsh')");
    assert.equal(await home.webContents.executeJavaScript('document.documentElement.lang'), 'en');
    assert.equal(home.getTitle(), 'Camellia');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('.home-brand').textContent"), 'Camellia');
    assert.deepEqual(await home.webContents.executeJavaScript("[...document.querySelectorAll('[data-mode]')].map(el => el.dataset.mode)"), ['claude', 'codex', 'dsh', 'kimi', 'antigravity']);
    const mobileMenu = electron.Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Mobile access…');
    assert.ok(mobileMenu);
    assert.equal((await home.webContents.executeJavaScript('window.dshDesktop.openMobileAccess()')).ok, false);
    await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'general'})");
    const pairingSettings = await waitWindow("window.mobileAccessUI && typeof window.mobileAccessUI.setVisible === 'function'");
    assert.equal(await pairingSettings.webContents.executeJavaScript("document.querySelector('#generalPage').hidden"), false);
    await pairingSettings.webContents.executeJavaScript("setView('mobile')");
    assert.equal(await pairingSettings.webContents.executeJavaScript("document.querySelector('#mobilePage').hidden"), false);
    assert.equal(await pairingSettings.webContents.executeJavaScript("document.querySelector('#generalPage').hidden"), true);
    assert.equal(await pairingSettings.webContents.executeJavaScript("document.querySelector('#mobile-invite').disabled"), true);
    assert.equal((await pairingSettings.webContents.executeJavaScript('window.dshDesktop.openMobileAccess()')).ok, true);
    const mobile = await waitWindow("document.querySelector('#toggle') && !document.querySelector('#toggle').disabled");
    mobileMenu.click();
    assert.equal(BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes('/remote/remote.html')).length, 1);
    const mobileState = await mobile.webContents.executeJavaScript("window.camelliaRemote.control('state')");
    assert.equal(mobileState.ok, true);
    assert.equal(mobileState.result.running, false);
    assert.equal(mobileState.result.address, null);
    assert.equal(await mobile.webContents.executeJavaScript("typeof window.dshDesktop"), 'undefined');
    assert.equal(await mobile.webContents.executeJavaScript("document.querySelector('#invite').disabled"), true);
    assert.equal(await mobile.webContents.executeJavaScript("document.querySelector('#error').textContent"), '');
    const unsupportedRemote = await mobile.webContents.executeJavaScript("window.camelliaRemote.control('send', { prompt: 'Never execute' })");
    assert.equal(unsupportedRemote.ok, false);
    await Promise.all([mobile, pairingSettings].map(closeWindow));
    console.log('PASS mobile access: real sandboxed preload, local IPC, disabled startup and read-only controls');
    const marker = path.join(root, 'backend-starts.txt');
    assert.equal(fs.existsSync(marker), false, 'The home panel must not start DSH');
    await home.webContents.executeJavaScript("document.querySelector('#openConfig').click()");
    const initialSettings = await waitWindow("document.querySelector('#providersPage')");
    assert.equal(initialSettings.getTitle(), "Settings — Camellia");
    assert.equal(await initialSettings.webContents.executeJavaScript("document.querySelector('#dshBin') === null && document.querySelector('#nodeExe') === null"), true);
    await initialSettings.webContents.executeJavaScript("document.querySelector('[data-view=general]').click(); window.dshDesktop.workbenchSaveSettings({ theme: 'system', autoRefreshBalances: false })");
    await initialSettings.webContents.executeJavaScript("document.querySelector('#port').value = '8789'; document.querySelector('#port').dispatchEvent(new Event('input', { bubbles: true }))");
    await closeWindow(initialSettings);
    assert.equal(initialSettings.isDestroyed(), true, 'Unsaved settings must not trap the Electron window open');
    assert.equal(fs.existsSync(marker), false, 'Saving configuration at home must not enter DSH');
    assert.ok(await home.webContents.executeJavaScript("document.querySelector('#enterDsh') !== null"));

    await home.webContents.executeJavaScript("document.querySelector('#openBenchmark').click()");
    const benchmark = await waitWindow("document.querySelector('#scoreboard')?.children.length === 5");
    const benchState = await benchmark.webContents.executeJavaScript('window.dshDesktop.benchmarkState()');
    assert.equal(benchState.ok, true); assert.equal(benchState.models.length, 0);
    assert.deepEqual(benchState.engines.map(engine => engine.id), ['claude', 'codex', 'dsh', 'kimi', 'antigravity']); assert.equal(benchState.suites.length, 10);
    assert.deepEqual(benchState.libraries.map(library => library.id), ['builtin', 'ds1000', 'scicode']);
    assert.equal(await benchmark.webContents.executeJavaScript("document.querySelector('#library').options.length"), 3);
    await benchmark.webContents.executeJavaScript("document.querySelector('input[name=runMode][value=custom]').click();document.querySelector('#library').value='scicode';document.querySelector('#library').dispatchEvent(new Event('change'))");
    assert.equal(await benchmark.webContents.executeJavaScript("document.querySelector('#prepareLibrary').hidden"), false);
    assert.equal(await benchmark.webContents.executeJavaScript("document.querySelector('#suite').value"), 'scicode-quick');
    const invalidLibrary = await benchmark.webContents.executeJavaScript("window.dshDesktop.benchmarkPrepareLibrary('unknown')");
    assert.equal(invalidLibrary.ok, false); assert.match(invalidLibrary.error, /Unknown question library/);
    assert.equal(await benchmark.webContents.executeJavaScript("document.querySelector('#start').disabled"), true);
    assert.equal(await benchmark.webContents.executeJavaScript("[...document.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0)"), true);
    const invalidStart = await benchmark.webContents.executeJavaScript("window.dshDesktop.benchmarkStart({model: 'missing', providerId: 'missing'})");
    assert.equal(invalidStart.ok, false);
    assert.equal(fs.existsSync(marker), false, 'Opening Benchmark must not start a harness or send model requests');
    await benchmark.webContents.executeJavaScript("document.querySelector('#home').click()");
    await waitWindow("document.querySelector('#enterDsh')");

    await home.webContents.executeJavaScript("document.querySelector('#enterDsh').click()");
    await waitWindow("document.body.dataset.harness === 'dsh'");
    assert.equal(fs.existsSync(marker), false, 'The shared DSH chat is lazy and does not start the native web backend');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#backToDsh')"), null);
    const removedMode = await home.webContents.executeJavaScript("window.dshDesktop.switchMode('dsh-native')");
    assert.equal(removedMode.ok, false, 'The removed native chat route cannot be opened through IPC');
    assert.equal(await home.webContents.executeJavaScript('document.body.dataset.harness'), 'dsh');
    assert.equal(fs.existsSync(marker), false);
    await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'engines',engine:'dsh'})");
    const startupSettings = await waitWindow("document.querySelector('#dshNative') && !document.querySelector('#dshNative').hidden");

    for (let i = 0; i < 150 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(marker), true, 'DSH settings still start their native backend');
    assert.equal(fs.existsSync(path.join(root, 'browser-opened')), false, 'DSH settings must not open an external browser, even when CLI help is unavailable');
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
    await closeWindow(startupSettings);
    assert.equal(home.getTitle(), 'Camellia');
    await home.webContents.executeJavaScript("document.querySelector('#enterClaude').click()");
    const claude = await waitWindow("document.querySelector('#engineSwitch')");
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
    assert.equal(await claude.webContents.executeJavaScript("document.querySelector('#engineSwitch').value"), "claude");
    assert.equal(await claude.webContents.executeJavaScript("typeof window.dshDesktop.onApiRouterState(() => {})"), 'function');
    const folder = path.join(root, 'workspace'); fs.mkdirSync(folder, { recursive: true });
    const workspace = await claude.webContents.executeJavaScript(`chatApi.metaOp(${JSON.stringify({ op: 'create-workspace', name: 'Electron 工作区', path: folder })})`);
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
    await waitWindow("document.querySelector('#engineSwitch')");
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
    await home.webContents.executeJavaScript('sidebar.load()');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#sessionList').textContent.includes('Electron 工作区')"), true);
    const kimiFolder = path.join(root, 'kimi-workspace'); fs.mkdirSync(kimiFolder, { recursive: true });
    const kimiWs = await home.webContents.executeJavaScript(`chatApi.metaOp(${JSON.stringify({ op: 'create-workspace', name: 'Kimi 工程', path: kimiFolder })})`);
    assert.equal(kimiWs.ok, true);
    await home.webContents.executeJavaScript('sidebar.load()');
    assert.match(await home.webContents.executeJavaScript("document.querySelector('#sessionList').textContent"), /Kimi 工程/);
    assert.equal(await home.webContents.executeJavaScript('typeof chatApi.onEvent(() => {})'), 'function');
    assert.equal((await home.webContents.executeJavaScript('chatApi.getSettings()')).contextWindow, 131072);
    await home.webContents.executeJavaScript("document.querySelector('#settingsBtn').click()");
    const generalSettings = await waitWindow("document.querySelector('#generalPage') && !document.querySelector('#generalPage').hidden");
    assert.equal(await generalSettings.webContents.executeJavaScript("document.querySelector('[data-view=general]').getAttribute('aria-current')"), 'page');
    await home.webContents.executeJavaScript("document.querySelector('#connectionInfo').click()");
    const engineSettings = await waitWindow("document.querySelector('#engineContext')");
    assert.equal(engineSettings, generalSettings);
    assert.equal(await engineSettings.webContents.executeJavaScript("document.querySelector('[data-engine=kimi]').getAttribute('aria-selected')"), 'true');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#settingsPanel') === null"), true);
    const globalState = await engineSettings.webContents.executeJavaScript("window.dshDesktop.engineSettingsGet({engine:'kimi'})");
    assert.equal(globalState.ok, true);
    assert.ok(globalState.files.every(file => file.path.startsWith(process.env.USERPROFILE)));

    await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiConnection').value='subscription'; document.querySelector('#kimiConnection').dispatchEvent(new Event('change'))");
    assert.equal(await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiSignIn').disabled"), true);
    await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiSaveConnection').click()");
    await waitWindow("document.querySelector('#kimiAccountPanel') && !document.querySelector('#kimiSignIn').disabled");
    await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiSignIn').click()");
    await waitWindow("document.querySelector('#kimiUserCode')?.textContent === 'TEST-123'");
    assert.equal(await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiCancelLogin').hidden"), false);
    await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiCancelLogin').click()");
    await waitWindow("document.querySelector('#kimiUserCode')?.textContent === '' && !document.querySelector('#kimiSignIn').disabled");
    assert.equal((await engineSettings.webContents.executeJavaScript('window.dshDesktop.kimiAccountState()')).loginPending, false);
    await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiSignIn').click()");
    await waitWindow("document.querySelector('#kimiUserCode')?.textContent === 'TEST-123'");
    fs.writeFileSync(path.join(kimiAccountHome, 'config.toml'), require('smol-toml').stringify({ default_model: 'kimi-code/subscription-fixture',
      providers: { 'managed:kimi-code': { type: 'kimi', base_url: 'https://api.kimi.com/coding', api_key: '', oauth: { storage: 'file', key: 'oauth/kimi-code' } } },
      models: { 'kimi-code/subscription-fixture': { provider: 'managed:kimi-code', model: 'subscription-fixture', display_name: 'Kimi account fixture', max_context_size: 262144 } },
    }));
    kimiLoginProcesses.at(-1).emit('close', 0);
    await waitWindow("document.querySelector('#kimiAccountStatus')?.textContent.includes('Signed in')");
    assert.deepEqual(kimiRpcCalls, ['initialize', 'authenticate', 'session/new', 'session/delete']);
    await home.webContents.executeJavaScript('loadSettings()');
    assert.equal(await home.webContents.executeJavaScript('currentModel'), 'kimi-code/subscription-fixture');
    assert.equal(await home.webContents.executeJavaScript('currentConnection'), 'subscription');
    assert.match(await home.webContents.executeJavaScript("document.querySelector('#connectionInfo').textContent"), /Kimi subscription/);
    assert.equal(await home.webContents.executeJavaScript("MODELS.some(model => model.id === 'kimi-code/subscription-fixture')"), true);
    await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiModelDetails').open=true; document.querySelector('#kimiConnectionPanel').scrollIntoView({block:'start'})");
    assert.equal(await engineSettings.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
    await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiSignOut').click()");
    await waitWindow("document.querySelector('#kimiSignOut')?.hidden && !document.querySelector('#kimiSignIn').disabled");
    assert.equal((await engineSettings.webContents.executeJavaScript('window.dshDesktop.kimiAccountState()')).account, null);
    assert.deepEqual(kimiRpcCalls.slice(-2), ['initialize', 'logout']);
    await engineSettings.webContents.executeJavaScript("document.querySelector('#kimiConnection').value='api'; document.querySelector('#kimiConnection').dispatchEvent(new Event('change')); document.querySelector('#kimiSaveConnection').click()");
    await waitWindow("document.querySelector('#kimiSaveConnection')?.hidden && document.querySelector('#kimiConnection')?.value === 'api'");
    await home.webContents.executeJavaScript('loadSettings()');
    assert.equal(await home.webContents.executeJavaScript('currentConnection'), 'api');
    console.log('PASS Kimi subscription: real IPC, save, device code, cancel, account models, logout and API return; mocked OAuth only');

    await engineSettings.webContents.executeJavaScript("document.querySelector('[data-engine=dsh]').click()");
    await waitWindow("document.querySelector('#dshNative') && !document.querySelector('#dshNative').hidden");
    let dshSettingsReady = false;
    for (let i = 0; i < 150; i++) {
      for (const child of engineSettings.contentView.children) {
        if (child.webContents && !child.webContents.isDestroyed() && !child.webContents.isLoading()) {
          if (await child.webContents.executeJavaScript("Boolean(document.querySelector('#fakeDsh')?.textContent.trim())")) {
            const bounds = child.getBounds(), viewport = engineSettings.getContentBounds();
            assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.y < viewport.height);
            dshSettingsReady = true;
          }
        }
      }
      if (dshSettingsReady) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(dshSettingsReady, 'Embedded DSH settings must render controls, not a blank child view');
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'Reopening DSH settings reuses its running backend');

    await home.webContents.executeJavaScript("document.querySelector('#backToHome').click()");
    await waitWindow("document.querySelector('#enterAntigravity')");
    assert.equal(await home.webContents.executeJavaScript("[...document.querySelectorAll('.engine-mark img')].every(img => img.complete && img.naturalWidth > 0)"), true);
    await home.webContents.executeJavaScript("document.querySelector('#enterAntigravity').click()");
    await waitWindow("document.body.dataset.harness === 'antigravity'");
    assert.equal(await home.webContents.executeJavaScript('document.title'), 'Antigravity — Camellia');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#input').placeholder"), 'Message Antigravity');
    await home.webContents.executeJavaScript('sidebar.load()');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#sessionList').textContent.includes('Kimi 工程')"), true);
    const sdkFolder = path.join(root, 'sdk-workspace'); fs.mkdirSync(sdkFolder, { recursive: true });
    const sdkWorkspace = await home.webContents.executeJavaScript(`chatApi.metaOp(${JSON.stringify({ op: 'create-workspace', name: 'Antigravity project', path: sdkFolder })})`);
    assert.equal(sdkWorkspace.ok, true);
    await home.webContents.executeJavaScript('sidebar.load()');
    assert.match(await home.webContents.executeJavaScript("document.querySelector('#sessionList').textContent"), /Antigravity project/);
    assert.equal(await home.webContents.executeJavaScript('typeof chatApi.onEvent(() => {})'), 'function');
    await home.webContents.executeJavaScript("document.querySelector('#connectionInfo').click()");
    await waitWindow("document.querySelector('[data-field=instructions]')");
    assert.equal(await engineSettings.webContents.executeJavaScript("document.querySelector('[data-engine=antigravity]').getAttribute('aria-selected')"), 'true');
    assert.equal(await engineSettings.webContents.executeJavaScript("document.querySelector('#engineScopeTitle').textContent"), 'Antigravity in Camellia');
    const sdkSettings = await engineSettings.webContents.executeJavaScript("window.dshDesktop.engineSettingsGet({engine:'antigravity'})");
    assert.ok(sdkSettings.files.every(file => file.path.startsWith(userData)));
    assert.equal((await engineSettings.webContents.executeJavaScript('window.dshDesktop.runtimeState()')).engines.length, 5);

    await home.webContents.executeJavaScript("window.dshDesktop.switchMode('codex')");
    await waitWindow("document.body.dataset.harness === 'codex'");
    assert.equal(await home.webContents.executeJavaScript('document.title'), 'Codex CLI — Camellia');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#input').placeholder"), 'Message Codex CLI');
    assert.equal((await home.webContents.executeJavaScript('chatApi.getSettings()')).connection, 'subscription');
    assert.equal((await home.webContents.executeJavaScript('window.dshDesktop.codexAccountState()')).account, null);
    const codexFolder = path.join(root, 'codex-workspace'); fs.mkdirSync(codexFolder, { recursive: true });
    const codexWs = await home.webContents.executeJavaScript(`chatApi.metaOp(${JSON.stringify({ op: 'create-workspace', name: 'Codex project', path: codexFolder })})`);
    assert.equal(codexWs.ok, true); await home.webContents.executeJavaScript('sidebar.load()');
    assert.match(await home.webContents.executeJavaScript("document.querySelector('#sessionList').textContent"), /Codex project/);
    await home.webContents.executeJavaScript("document.querySelector('#connectionInfo').click()");
    await waitWindow("document.querySelector('#codexConnectionPanel') && !document.querySelector('#codexConnectionPanel').hidden");
    const codexSettings = await engineSettings.webContents.executeJavaScript("window.dshDesktop.engineSettingsGet({engine:'codex'})");
    assert.equal(codexSettings.scope, 'app'); assert.ok(codexSettings.files.every(file => file.path.startsWith(userData)));
    assert.equal(await engineSettings.webContents.executeJavaScript("document.querySelector('#engineScopeTitle').textContent"), 'Codex in Camellia');
    assert.deepEqual(await engineSettings.webContents.executeJavaScript("[...document.querySelectorAll('.engine-tabs [data-engine]')].map(el => el.dataset.engine)"), ['claude', 'codex', 'dsh', 'kimi', 'antigravity']);

    const layouts = [];
    for (const engine of ['claude', 'codex', 'dsh', 'kimi', 'antigravity']) {
      await home.webContents.executeJavaScript(`window.dshDesktop.switchMode('${engine}')`);
      await waitWindow(`document.body.dataset.harness === '${engine}'`);
      assert.equal(await home.webContents.executeJavaScript("document.querySelector('#backToDsh')"), null);
      await home.webContents.executeJavaScript('loadSettings()');
      const empty = await home.webContents.executeJavaScript("document.querySelector('#inputCard').getBoundingClientRect().toJSON()");
      await home.webContents.executeJavaScript("clearEmpty(); renderHistoryMessages([{role:'user',text:'Shared research task'},{role:'assistant',text:'The same conversation is available in all five engines.'}])");
      const active = await home.webContents.executeJavaScript("document.querySelector('#inputCard').getBoundingClientRect().toJSON()");
      layouts.push({ engine, empty, active });
    }
    for (const layout of layouts) for (const state of ['empty', 'active']) for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(layout[state][key] - layouts[0][state][key]) < 1, `${layout.engine} ${state} ${key} differs: ${JSON.stringify(layouts)}`);
    const preferences = await home.webContents.executeJavaScript('window.dshDesktop.workbenchSettings()');
    assert.deepEqual(preferences.conversations, { mode: 'direct', warnOnSwitch: false, showOrigin: false });
    await home.webContents.executeJavaScript("document.querySelector('#handoffBtn').click()");
    await waitWindow("document.querySelector('#switchDialog')?.open");
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('#switchMethod').value"), 'markdown');
    await home.webContents.executeJavaScript("document.querySelector('#switchCancel').click()");
    console.log('PASS composer alignment: five engines, start pages and active conversations');
    await home.webContents.executeJavaScript('window.dshDesktop.codexSaveSettings({connection:"api"})');
    await home.webContents.executeJavaScript('openHistorySession("switch-fixture-a")');
    await home.webContents.executeJavaScript(`input.value='Keep this unsent draft'; input.dispatchEvent(new Event('input')); addAttachments([${JSON.stringify(path.join(root, 'notes.md'))}]);`);
    Menu.getApplicationMenu().items.find(item => item.label === 'Engine').submenu.items.find(item => item.label === 'Switch to DSH').click();
    await waitWindow("document.body.dataset.harness === 'dsh' && typeof uiReady !== 'undefined' && uiReady");
    assert.equal(await home.webContents.executeJavaScript('context.sessionId'), 'switch-fixture-a');
    assert.equal(await home.webContents.executeJavaScript('currentModel'), 'shared-api-a');
    assert.equal(await home.webContents.executeJavaScript('input.value'), 'Keep this unsent draft');
    assert.equal(await home.webContents.executeJavaScript('attachments[0].name'), 'notes.md');
    assert.equal(await home.webContents.executeJavaScript("document.querySelector('.logo-icon img').naturalWidth > 0"), true);
    await home.webContents.executeJavaScript('window.dshDesktop.switchMode("home")'); await waitWindow("document.querySelector('#enterCodex')");
    await home.webContents.executeJavaScript("document.querySelector('#enterCodex').click()");
    await waitWindow("document.body.dataset.harness === 'codex' && typeof uiReady !== 'undefined' && uiReady");
    assert.equal(await home.webContents.executeJavaScript('currentModel'), 'shared-api-a');
    assert.equal(await home.webContents.executeJavaScript('input.value'), 'Keep this unsent draft');
    await home.webContents.executeJavaScript('openHistorySession("switch-fixture-b")');
    assert.equal(await home.webContents.executeJavaScript('currentModel'), 'shared-api-b');
    assert.equal(await home.webContents.executeJavaScript('input.value'), '');
    await home.webContents.executeJavaScript('openHistorySession("switch-fixture-a")');
    assert.equal(await home.webContents.executeJavaScript('currentModel'), 'shared-api-a');
    home.webContents.reload();
    await waitWindow("document.body.dataset.harness === 'codex' && typeof uiReady !== 'undefined' && uiReady");
    assert.equal(await home.webContents.executeJavaScript('input.value'), 'Keep this unsent draft');
    await home.webContents.executeJavaScript(`newSession(${JSON.stringify(codexWs.workspace.id)})`);
    await home.webContents.executeJavaScript("input.value='A workspace draft'; input.dispatchEvent(new Event('input'))");
    Menu.getApplicationMenu().items.find(item => item.label === 'Engine').submenu.items.find(item => item.label === 'Switch to Kimi Code').click();
    await waitWindow("document.body.dataset.harness === 'kimi' && typeof uiReady !== 'undefined' && uiReady");
    assert.equal(await home.webContents.executeJavaScript('context.workspaceId'), codexWs.workspace.id);
    assert.equal(await home.webContents.executeJavaScript('input.value'), 'A workspace draft');
    console.log('PASS shared state: native Engine menu, home return, model per conversation, draft/attachments, workspace and reload');
    const zoomMenu = Menu.getApplicationMenu().items.find(item => item.label === 'View').submenu;
    const initialZoom = home.webContents.getZoomLevel();
    home.webContents.sendInputEvent({ type: 'keyDown', keyCode: '+', modifiers: ['control', 'shift'] });
    home.webContents.sendInputEvent({ type: 'keyUp', keyCode: '+', modifiers: ['control', 'shift'] });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(Math.abs(home.webContents.getZoomLevel() - initialZoom - 0.5) < 0.00001, 'Ctrl + changes zoom once');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'desktop-config.json'))).zoomLevel, initialZoom + 0.5);
    assert.ok(Math.abs(engineSettings.webContents.getZoomLevel() - home.webContents.getZoomLevel()) < 0.00001);
    await home.webContents.executeJavaScript("window.dshDesktop.switchMode('home')"); await waitWindow("document.querySelector('#enterDsh')");
    assert.ok(Math.abs(home.webContents.getZoomLevel() - initialZoom - 0.5) < 0.00001);
    await home.webContents.executeJavaScript("window.dshDesktop.switchMode('dsh')"); await waitWindow("document.body.dataset.harness === 'dsh'");
    assert.ok(Math.abs(home.webContents.getZoomLevel() - initialZoom - 0.5) < 0.00001, 'Shared DSH chat keeps the same zoom');
    zoomMenu.items.find(item => item.label === 'Zoom out').click();
    assert.ok(Math.abs(home.webContents.getZoomLevel() - initialZoom) < 0.00001);
    zoomMenu.items.find(item => item.label === 'Actual size').click();
    assert.equal(home.webContents.getZoomLevel(), 0);
    console.log('PASS saved zoom: Ctrl +, menus, settings window, home, shared DSH and reset');
    assert.ok(BrowserWindow.getAllWindows().every(window => !window.isVisible()), 'Smoke tests must not display or focus windows');
    assert.deepEqual(errors, []);
    console.log('PASS: real Electron home, configuration, DSH startup/navigation, Claude/Codex/Kimi/Antigravity shared UI, isolated workspaces and API settings; firstRun=' + firstRun);
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
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, 120000);
      const code = await new Promise((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
      clearTimeout(timeout);
      assert.equal(timedOut, false, `Electron smoke timed out after 120s (mode=${mode}, firstRunComplete=${firstRunComplete})\n${stderr}\n${stdout}`);
      assert.equal(code, 0, stderr + '\n' + stdout);
      assert.match(stdout, /PASS: real Electron/);
      console.log(stdout.trim());
    }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-electron-smoke-'));
    removeTree(root);
  }
}
main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
