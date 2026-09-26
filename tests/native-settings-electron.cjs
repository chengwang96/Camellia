'use strict';
const { removeTree } = require('./test-fs.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (process.versions.electron) {
    const { app, BrowserWindow, webContents } = require('electron');
    const root = process.env.NATIVE_SETTINGS_TEST_ROOT;
    app.setPath('userData', path.join(root, 'app')); app.disableHardwareAcceleration();
    const errors = [];
    app.on('web-contents-created', (_event, wc) => {
      wc.on('preload-error', (_event, _file, error) => errors.push(error.message));
      wc.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    });
    app.on('browser-window-created', (_event, window) => { window.show = () => {}; window.hide(); });
    require('../src/main/main'); await app.whenReady();
    async function wait(check) {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
      throw new Error('Native settings did not become ready: ' + errors.join('\n'));
    }
    const home = await wait(async () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('#enterDsh')")) return window;
    });
    await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'engines',engine:'dsh'})");
    const settings = await wait(async () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('#dshSettingsSurface')")) return window;
    });
    const native = await wait(async () => {
      for (const wc of webContents.getAllWebContents()) if (wc.getURL().startsWith('http://127.0.0.1:') && !wc.isLoading() && await wc.executeJavaScript("!!document.querySelector('.workbench-native-settings')")) return wc;
    });
    assert.equal(await native.executeJavaScript('window.dshDesktop.settingsEmbedded'), true);
    assert.equal(await native.executeJavaScript('document.documentElement.lang'), 'en', 'Fresh DSH profiles default to English');
    assert.ok(!native.getURL().includes('token='), 'Auth token is exchanged for an HttpOnly cookie');
    const navigation = await native.executeJavaScript("document.querySelector('.workbench-native-nav').textContent");
    assert.match(navigation, /Providers & Keys/);
    const view = settings.contentView.children.find(view => view.webContents === native);
    assert.ok(view.getVisible()); assert.ok(view.getBounds().height > 150);
    const dropdowns = '.workbench-native-content button[aria-haspopup="menu"]';
    await wait(() => native.executeJavaScript(`document.querySelectorAll('${dropdowns}').length === 3 && [...document.querySelectorAll('${dropdowns}')].every(button => !button.disabled)`));
    async function clickNative(selector, index = 0) {
      const point = await native.executeJavaScript(`(() => {
        const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        element.scrollIntoView({ block: 'center' });
        const bounds = element.getBoundingClientRect();
        const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
        return { ...point, reachable: element.contains(document.elementFromPoint(point.x, point.y)) };
      })()`);
      assert.ok(point.reachable, `${selector} (${index}) must not be covered by the settings shell`);
      await native.executeJavaScript(`document.elementFromPoint(${point.x}, ${point.y}).closest('button, [role=menuitem]').click()`);
    }
    const selections = [];
    for (let index = 0; index < 3; index++) {
      await clickNative(dropdowns, index);
      await wait(() => native.executeJavaScript("!!document.querySelector('[role=menu] [role=menuitem]')"));
      const option = await native.executeJavaScript(`(() => {
        const current = document.querySelectorAll('${dropdowns}')[${index}].textContent.trim();
        const items = [...document.querySelectorAll('[role=menu] [role=menuitem]')];
        const index = items.findIndex(item => item.textContent.trim() !== current && !item.textContent.includes('Full access'));
        return { index, label: items[index]?.textContent.trim() };
      })()`);
      assert.ok(option.index >= 0, 'Each dropdown offers an alternative');
      await clickNative('[role=menu] [role=menuitem]', option.index);
      selections.push(option.label);
      await wait(() => native.executeJavaScript(`document.querySelectorAll('${dropdowns}')[${index}].textContent.trim() === ${JSON.stringify(option.label)} && !document.querySelector('[role=menu]')`));
    }
    native.reload();
    await wait(() => native.executeJavaScript(`JSON.stringify([...document.querySelectorAll('${dropdowns}')].map(button => button.textContent.trim())) === ${JSON.stringify(JSON.stringify(selections))}`));
    // Screenshots are QA artifacts; locked or remote displays cannot capture pages.
    try {
      const shot = await settings.capturePage();
      fs.mkdirSync(path.resolve(__dirname, '../dist/engine-settings-qa'), { recursive: true });
      fs.writeFileSync(path.resolve(__dirname, '../dist/engine-settings-qa/native-electron.png'), shot.toPNG());
      fs.writeFileSync(path.resolve(__dirname, '../dist/engine-settings-qa/native-view.png'), (await native.capturePage()).toPNG());
    } catch (error) {
      console.log('Skipping QA screenshots: ' + (error.message || error));
    }
    await native.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('Providers & Keys')).click()");
    await wait(() => settings.webContents.executeJavaScript("!document.querySelector('#providersPage').hidden"));
    await wait(() => !view.getVisible());
    await settings.webContents.executeJavaScript("document.querySelector('[data-view=engines]').click()");
    await wait(() => settings.webContents.executeJavaScript("!document.querySelector('#enginesPage').hidden"));
    await settings.webContents.executeJavaScript("document.querySelector('[data-engine=claude]').click()");
    await wait(() => settings.webContents.executeJavaScript("!!document.querySelector('#engineCwd')"));
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'Native settings stay inside the central settings window');
    const logFile = path.join(root, 'app/logs/dsh-desktop.log');
    assert.ok(!/token=(?!\[redacted\])\S/.test(fs.readFileSync(logFile, 'utf8')), 'Logs must not contain launch tokens');
    assert.deepEqual(errors, []);
    settings.close();
    await delay(100);
    assert.equal(native.isDestroyed(), true, 'Closing settings releases its native view');
    console.log('PASS: real DSH authenticated settings inside the Electron settings window; three dropdowns are reachable and persist selections after reload, API redirect, engine navigation, no separate browser, native view disposal, redacted logs');
    app.quit(); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-native-electron-'));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/desktop-config.json'), JSON.stringify({ port: 0, autoRefreshBalances: false }));
  const env = { ...process.env, NATIVE_SETTINGS_TEST_ROOT: root, DSH_HOME: path.join(root, 'dsh'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), KIMI_CODE_HOME: path.join(root, 'home/.kimi-code') };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => proc.kill(), 120000);
  const code = await new Promise(resolve => proc.once('exit', resolve)); clearTimeout(timeout);
  try { assert.equal(code, 0); }
  finally {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('workbench-native-electron-'));
    removeTree(root);
  }
}
main().catch(error => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
