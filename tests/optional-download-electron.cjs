'use strict';
// Run packaged sources with a fresh profile. Download attempts are intercepted;
// real downloads are exercised separately by runtime-install-smoke.cjs.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

async function main() {
  if (process.versions.electron) {
    const { app, BrowserWindow, dialog } = require('electron');
    const resources = process.env.CAMELLIA_OPTIONAL_RESOURCES;
    const profile = process.env.CAMELLIA_OPTIONAL_PROFILE;
    app.setPath('userData', profile); app.setPath('sessionData', profile);
    app.disableHardwareAcceleration();
    Object.defineProperty(app, 'isPackaged', { value: true });
    const runtimeProcess = Object.create(process);
    Object.defineProperty(runtimeProcess, 'resourcesPath', { value: resources });
    const errors = [], downloads = [], prompts = [], replies = [];
    dialog.showMessageBox = async (_window, options) => {
      prompts.push(options);
      assert.ok(replies.length, 'Every download must ask which connection to use');
      return { response: replies.shift() };
    };
    app.on('browser-window-created', (_event, window) => {
      window.show = () => {}; window.hide();
      window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
    });
    childProcess.spawn = (exe, args, options) => { downloads.push({ exe, args, env: options.env }); throw new Error('Offline download fixture'); };
    const entry = path.join(resources, 'app.asar/src/main/main.js');
    require('node:vm').runInNewContext(fs.readFileSync(entry, 'utf8'), {
      require: require('node:module').createRequire(entry), module: { exports: {} },
      __dirname: path.dirname(entry), __filename: entry, process: runtimeProcess,
      Buffer, URL, console, setTimeout, clearTimeout, setInterval, clearInterval,
    }, { filename: entry });
    await app.whenReady();
    async function wait(check) {
      for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw new Error('Optional-download UI did not become ready');
    }
    const windowFor = selector => wait(async () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading()
        && await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return window;
    });
    const home = await windowFor('#enterDsh');
    await wait(() => home.webContents.executeJavaScript("document.querySelectorAll('[data-runtime-state=missing]').length === 5"));
    assert.equal(downloads.length, 0, 'Home must not download any engine');
    assert.equal(prompts.length, 0, 'Startup must not prompt for a download');
    assert.match(await home.webContents.executeJavaScript("document.querySelector('#enterKimi').getAttribute('aria-label')"), /Download & open/);
    replies.push(2); // Cancel without configuring a proxy.
    await home.webContents.executeJavaScript("document.querySelector('#enterKimi').click()");
    await wait(() => home.webContents.executeJavaScript("!document.querySelector('#enterKimi').disabled && document.querySelector('#homeStatus').textContent === ''"));
    assert.equal(downloads.length, 0);
    assert.equal(prompts[0].defaultId, 0);
    assert.equal(prompts[0].buttons[0], 'Download directly');
    await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'engines',engine:'dsh'})");
    const settings = await windowFor('#retryNative');
    await wait(() => settings.webContents.executeJavaScript("!document.querySelector('#retryNative').hidden && document.querySelector('#retryNative').textContent === 'Manage downloads'"));
    assert.equal(downloads.length, 0, 'Browsing DSH settings must not download DSH');
    await settings.webContents.executeJavaScript("document.querySelector('#retryNative').click()");
    await wait(() => settings.webContents.executeJavaScript("document.querySelectorAll('[data-install]:not(:disabled)').length === 5"));
    assert.equal(downloads.length, 0, 'Listing available downloads is read-only');
    replies.push(1); // Set up a proxy from the download prompt.
    await home.webContents.executeJavaScript("document.querySelector('#enterKimi').click()");
    await wait(() => settings.webContents.executeJavaScript("document.activeElement.id === 'downloadProxyUrl'"));
    await settings.webContents.executeJavaScript(`
      document.querySelector('#downloadMode').value = 'proxy';
      document.querySelector('#downloadProxyUrl').value = 'http://127.0.0.1:18899';
      document.querySelector('#downloadProxyUrl').dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('#saveDownload').click();
    `);
    await wait(() => settings.webContents.executeJavaScript("document.querySelector('#status').textContent === 'Download connection saved'"));
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'desktop-config.json')));
    assert.deepEqual(saved.downloadProxy, { mode: 'proxy', url: 'http://127.0.0.1:18899/' });
    replies.push(0); // Use the saved proxy.
    await home.webContents.executeJavaScript("document.querySelector('#enterKimi').click()");
    await wait(() => settings.webContents.executeJavaScript("document.querySelector('[data-install=kimi]')?.textContent === 'Retry download'"));
    assert.equal(downloads.length, 1);
    assert.equal(prompts.at(-1).defaultId, 0);
    assert.equal(prompts.at(-1).buttons[0], 'Download with proxy');
    assert.equal(downloads[0].env.HTTPS_PROXY, saved.downloadProxy.url);
    assert.equal(downloads[0].env.npm_config_https_proxy, saved.downloadProxy.url);
    assert.equal(downloads[0].exe, path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
    assert.ok(downloads[0].args.includes(fs.realpathSync.native(path.join(profile, 'runtimes/kimi'))));
    assert.deepEqual(fs.readdirSync(path.join(profile, 'runtimes')), ['kimi']);
    const rows = await settings.webContents.executeJavaScript('window.dshDesktop.runtimeState()');
    assert.ok(rows.engines.filter(row => row.id !== 'kimi').every(row => row.status === 'missing'));
    replies.push(1); // Retry directly, without changing the saved preference.
    await settings.webContents.executeJavaScript("document.querySelector('[data-install=kimi]').click()");
    await wait(async () => downloads.length === 2 && await settings.webContents.executeJavaScript("!document.querySelector('[data-install=kimi]').disabled"));
    assert.equal(downloads[1].env.HTTPS_PROXY, '');
    assert.equal(downloads[1].env.NO_PROXY, '*');
    assert.equal(downloads[1].env.npm_config_noproxy, '*');
    replies.push(3);
    await settings.webContents.executeJavaScript("document.querySelector('[data-install=kimi]').click()");
    await wait(() => settings.webContents.executeJavaScript("!document.querySelector('[data-install=kimi]').disabled && document.querySelector('#status').textContent === ''"));
    assert.equal(downloads.length, 2, 'Canceling a retry must not start another download');
    replies.push(0);
    await home.webContents.executeJavaScript("document.querySelector('#enterCodex').click()");
    await wait(async () => downloads.length === 3 && await home.webContents.executeJavaScript("!document.querySelector('#enterCodex').disabled"));
    assert.ok(downloads[2].args.includes(fs.realpathSync.native(path.join(profile, 'runtimes/codex'))));
    assert.equal(downloads[2].env.HTTPS_PROXY, saved.downloadProxy.url);
    assert.deepEqual(fs.readdirSync(path.join(profile, 'runtimes')), ['codex', 'kimi']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'desktop-config.json'))).downloadProxy, saved.downloadProxy);
    assert.deepEqual(replies, []);
    assert.deepEqual(errors, []);
    console.log('PASS: packaged downloads prompt for direct/proxy/cancel, save device preferences, pass the chosen connection to bundled installers, and retry without downloading other engines');
    app.quit(); return;
  }
  const resources = path.resolve(process.argv[2] || (process.platform === 'darwin' ? 'dist/mac-arm64/Camellia.app/Contents/Resources' : 'dist/win-unpacked/resources'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-optional-ui-'));
  const profile = path.join(root, 'app'), home = path.join(root, 'home');
  fs.mkdirSync(profile); fs.mkdirSync(home);
  fs.writeFileSync(path.join(profile, 'desktop-config.json'), JSON.stringify({ autoRefreshBalances: false }));
  const env = { ...process.env, CAMELLIA_OPTIONAL_RESOURCES: resources, CAMELLIA_OPTIONAL_PROFILE: profile,
    HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = childProcess.spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => proc.kill(), 30000);
  const code = await new Promise(resolve => proc.once('exit', resolve)); clearTimeout(timer);
  try { assert.equal(code, 0); }
  finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('camellia-optional-ui-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
