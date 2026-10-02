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
    async function wait(check, label = 'native settings', timeout = 90000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
      throw new Error(label + ' did not become ready: ' + errors.join('\n'));
    }
    const home = await wait(async () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('#enterDsh')")) return window;
    });
    await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'engines',engine:'dsh'})");
    const settings = await wait(async () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('#dshSettingsSurface')")) return window;
    });
    // Windows stay hidden during QA; keep layout frames running for scroll and
    // ResizeObserver checks just as they do in the visible application.
    settings.webContents.setBackgroundThrottling(false);
    // The installation controls precede the native panel; bring its surface
    // into view so the lazy native view can be created on shorter windows.
    await wait(() => settings.webContents.executeJavaScript("!document.querySelector('#engineContent').hidden && !!document.querySelector('#runtimeCards .runtime-card')"));
    await settings.webContents.executeJavaScript("document.querySelector('#dshSettingsSurface').scrollIntoView({block:'start'})");
    const native = await wait(async () => {
      for (const wc of webContents.getAllWebContents()) if (wc.getURL().startsWith('http://127.0.0.1:') && !wc.isLoading() && await wc.executeJavaScript("!!document.querySelector('.workbench-native-settings')")) return wc;
    });
    assert.equal(await native.executeJavaScript('window.dshDesktop.settingsEmbedded'), true);
    assert.equal(await native.executeJavaScript('document.documentElement.lang'), 'en', 'Fresh DSH profiles default to English');
    assert.ok(!native.getURL().includes('token='), 'Auth token is exchanged for an HttpOnly cookie');
    const navigation = await native.executeJavaScript("document.querySelector('.workbench-native-nav').textContent");
    assert.match(navigation, /Providers & Keys/);
    const view = settings.contentView.children.find(view => view.webContents === native);
    await wait(() => view.getVisible() && view.getBounds().height > 150);
    // Runtime progress or update results above DSH must reposition its native
    // view even when the embedded settings content keeps the same dimensions.
    const surfaceY = async () => Math.round(await settings.webContents.executeJavaScript("Math.max(document.querySelector('#dshSettingsSurface').getBoundingClientRect().top, document.querySelector('.scroll-content').getBoundingClientRect().top)") * settings.webContents.getZoomFactor());
    await wait(async () => view.getBounds().y === await surfaceY(), 'initial native position', 15000).catch(async error => {
      throw new Error(error.message + JSON.stringify({ bounds: view.getBounds(), expectedY: await surfaceY(), zoom: settings.webContents.getZoomFactor() }));
    });
    const originalY = view.getBounds().y;
    await settings.webContents.executeJavaScript("document.querySelector('.scroll-content').style.overflowAnchor='none'; document.querySelector('#runtimeCards').style.paddingTop='48px'");
    const shiftedY = await surfaceY();
    assert.notEqual(shiftedY, originalY);
    await wait(() => view.getBounds().y === shiftedY, 'native position after runtime resize', 15000);
    await settings.webContents.executeJavaScript("document.querySelector('#runtimeCards').style.paddingTop=''");
    await wait(() => view.getBounds().y === originalY, 'restored native position', 15000);
    const dropdowns = '.workbench-native-content button[aria-haspopup="menu"]';
    const dropdownCount = require('../runtimes/dsh/node_modules/@deepseek-ai/dsh/package.json').version === '0.2.0-rc.2' ? 4 : 3;
    await wait(() => native.executeJavaScript(`document.querySelectorAll('${dropdowns}').length === ${dropdownCount} && [...document.querySelectorAll('${dropdowns}')].every(button => !button.disabled)`), 'native controls', 15000).catch(async error => {
      throw new Error(error.message + '\n' + await native.executeJavaScript("document.querySelector('.workbench-native-content').innerText"));
    });
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
    const persistedSettings = () => [path.join(root, 'dsh/settings.yaml'), path.join(root, 'dsh/profiles/web/cordis.patch.yml')]
      .map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').join('\n');
    for (let index = 0; index < dropdownCount; index++) {
      await clickNative(dropdowns, index);
      await wait(() => native.executeJavaScript("!!document.querySelector('[role=menu] [role=menuitem]')"));
      const option = await native.executeJavaScript(`(() => {
        const current = document.querySelectorAll('${dropdowns}')[${index}].textContent.trim();
        const items = [...document.querySelectorAll('[role=menu] [role=menuitem]')];
        const index = items.findIndex(item => item.textContent.trim() !== current && !/full access/i.test(item.textContent));
        return { index, label: items[index]?.textContent.trim() };
      })()`);
      assert.ok(option.index >= 0, 'Each dropdown offers an alternative');
      const beforeSave = persistedSettings();
      await clickNative('[role=menu] [role=menuitem]', option.index);
      selections.push(option.label);
      await wait(() => native.executeJavaScript(`document.querySelectorAll('${dropdowns}')[${index}].textContent.trim() === ${JSON.stringify(option.label)} && !document.querySelector('[role=menu]')`));
      // DSH 0.2 optimistically renders preferences before the Host saves them.
      // Reload only after each native write has reached the profile on disk.
      await wait(() => persistedSettings() !== beforeSave, 'native preference saved', 15000);
    }
    native.reload();
    await wait(() => native.executeJavaScript(`JSON.stringify([...document.querySelectorAll('${dropdowns}')].map(button => button.textContent.trim())) === ${JSON.stringify(JSON.stringify(selections))}`), 'saved native controls', 15000).catch(async error => {
      throw new Error(error.message + '\n' + JSON.stringify({ expected: selections,
        actual: await native.executeJavaScript(`Array.from(document.querySelectorAll('${dropdowns}'), button => button.textContent.trim())`) }));
    });
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
    console.log(`PASS: real DSH authenticated settings inside the Electron settings window; ${dropdownCount} dropdowns are reachable and persist selections after reload, API redirect, engine navigation, no separate browser, native view disposal, redacted logs`);
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
