'use strict';

// Real window frame + isolated application main, IPC, preload and renderer.
// Native menus are intercepted so QA never opens a menu on the user's desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  if (!process.versions.electron) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-window-chrome-'));
    try {
      const env = { ...process.env, CHROME_TEST_ROOT: root, DSH_HOME: path.join(root, 'dsh'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'pipe' });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const timeout = setTimeout(() => child.kill(), 90000);
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      clearTimeout(timeout);
      assert.equal(code, 0, output);
      console.log(output.trim());
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      removeTree(root);
    }
    return;
  }
  const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
  const root = process.env.CHROME_TEST_ROOT;
  app.setPath('appData', root); app.setPath('userData', path.join(root, 'app'));
  app.disableHardwareAcceleration();
  const errors = [], captionOverlays = new Map(), windowFrames = new Map();
  app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', (_event, _file, error) => errors.push(error.message));
    contents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  });
  app.on('browser-window-created', (_event, window) => {
    const parent = window.getParentWindow();
    const frame = { shows: 0, ready: false, initialCaption: parent ? captionOverlays.get(parent.id) : null };
    windowFrames.set(window.id, frame);
    window.once('ready-to-show', () => { frame.ready = true; });
    window.show = () => { frame.shows++; }; window.focus = () => {};
    window.webContents.setBackgroundThrottling(false);
    // capturePage does not include Windows caption buttons. Record and forward
    // the real native setter so their applied color is checked separately.
    const setOverlay = window.setTitleBarOverlay.bind(window);
    window.setTitleBarOverlay = options => {
      setOverlay(options); captionOverlays.set(window.id, { ...options });
    };
  });
  require('../src/main/main');
  await app.whenReady();
  async function wait(check, label) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await check(); if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out: ' + label + '\n' + errors.join('\n'));
  }
  const home = await wait(async () => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading()
      && await window.webContents.executeJavaScript('!!document.querySelector("#enterDsh")')) return window;
  }, 'home');
  const wc = home.webContents;
  if (process.platform !== 'win32') {
    assert.deepEqual(await wc.executeJavaScript('camelliaWindowChrome.getState()'), { enabled: false });
    console.log('PASS: native platform frame retained'); app.quit(); return;
  }
  await wait(() => wc.executeJavaScript('!!document.querySelector(".desktop-titlebar")'), 'caption');
  assert.equal(home.isMenuBarVisible(), false);
  assert.deepEqual(await wc.executeJavaScript('[...document.querySelectorAll(".desktop-titlebar button")].map(button => button.textContent)'), ['Application', 'Engine', 'Edit', 'View']);
  assert.equal(await wc.executeJavaScript('document.querySelector(".desktop-titlebar").textContent.includes("Camellia")'), false);
  // The native overlay publishes the available caption rect to Chromium.
  const overlay = await wc.executeJavaScript('navigator.windowControlsOverlay.getTitlebarAreaRect().toJSON()');
  assert.ok(overlay.height >= 38 && overlay.height <= 40, JSON.stringify(overlay));

  let popup;
  const edit = Menu.getApplicationMenu().items[2].submenu;
  edit.popup = options => { popup = options; options.callback(); };
  await wc.executeJavaScript('document.querySelectorAll(".desktop-titlebar button")[2].click()');
  await wait(() => popup, 'native edit menu');
  assert.equal(popup.window, home); assert.ok(popup.y <= 40);
  for (const type of ['keyDown', 'keyUp']) wc.emit('before-input-event', { preventDefault() {} }, { key: 'F10', type });
  await wait(() => wc.executeJavaScript('document.activeElement === document.querySelector(".desktop-titlebar button")'), 'F10 menu focus');

  const preview = path.join(__dirname, '../dist/ui-preview/window-chrome');
  fs.mkdirSync(preview, { recursive: true });
  async function capture(contents, name) {
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await contents.executeJavaScript('Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))');
    const shot = await contents.capturePage(undefined, { stayHidden: true });
    fs.writeFileSync(path.join(preview, name + '.png'), shot.toPNG());
    return shot;
  }
  function checkNativeCaption(shot, label) {
    // A clear pixel at the left of the caption row contains its actual
    // composited backdrop. Windows bitmaps are BGRA, not RGBA.
    const bitmap = shot.toBitmap(), offset = (4 * shot.getSize().width + 4) * 4;
    const color = '#' + [2, 1, 0].map(channel => bitmap[offset + channel].toString(16).padStart(2, '0')).join('');
    assert.equal(captionOverlays.get(home.id)?.color, color, label + ': native caption must match the rendered caption');
  }
  for (const theme of ['light', 'dark']) {
    await wc.executeJavaScript(`window.dshDesktop.workbenchSaveSettings({theme:${JSON.stringify(theme)},language:'zh-CN'})`);
    await wait(() => wc.executeJavaScript(`document.documentElement.dataset.theme === '${theme}' && document.querySelector('.desktop-titlebar button').textContent === '应用'`), theme + ' caption');
    assert.equal(nativeTheme.shouldUseDarkColors, theme === 'dark');
    checkNativeCaption(await capture(wc, 'home-' + theme), theme);
  }
  for (const zoom of [0.8, 1, 1.5]) {
    wc.setZoomFactor(zoom);
    await wait(() => wc.executeJavaScript(`Math.abs(document.querySelector('.desktop-titlebar').getBoundingClientRect().height * ${zoom} - 40) < 0.2`), 'caption zoom ' + zoom);
    assert.equal(home.isMenuBarVisible(), false);
  }
  wc.setZoomFactor(1);
  // Hold only the acknowledgement after a real backdrop frame is painted.
  // This deliberately separates modal-ready and background-ready, exposing
  // first-frame races that a settled screenshot would miss.
  await wc.executeJavaScript(`(() => {
    window.originalBackdropPaint = window.paintSettingsBackdrop;
    window.paintSettingsBackdrop = async () => {
      await window.originalBackdropPaint();
      window.backdropFramePainted = true;
      return new Promise(resolve => { window.releaseBackdropFrame = resolve; });
    };
  })()`);
  await wc.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'general'})");
  await wait(() => wc.executeJavaScript('window.backdropFramePainted === true'), 'initial backdrop frame');
  const settingsChildren = () => BrowserWindow.getAllWindows().filter(window => window.getParentWindow() === home);
  assert.equal(settingsChildren().length, 0, 'modal construction must wait for the native and renderer backdrop frame');
  await wc.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'general'})");
  assert.equal(settingsChildren().length, 0, 'repeated clicks must not bypass backdrop preparation');
  checkNativeCaption(await capture(wc, 'settings-opening-dark'), 'before modal construction');
  await wc.executeJavaScript(`(() => {
    window.releaseBackdropFrame();
    window.paintSettingsBackdrop = window.originalBackdropPaint;
  })()`);
  const settings = await wait(async () => {
    for (const window of BrowserWindow.getAllWindows()) if (window !== home && !window.webContents.isLoading()
      && await window.webContents.executeJavaScript('document.documentElement.hasAttribute("data-settings-window")')) return window;
  }, 'rounded settings');
  await wait(() => windowFrames.get(settings.id).ready, 'settings ready-to-show');
  const openingFrame = windowFrames.get(settings.id);
  assert.equal(openingFrame.initialCaption?.color, '#0a0a0b', 'native caption must be prepared before constructing the modal');
  await wait(() => openingFrame.shows === 1, 'modal shown after backdrop paint');
  assert.equal(settingsChildren().length, 1, 'repeated clicks open only one settings window');
  await wait(() => settings.webContents.executeJavaScript('getComputedStyle(document.body).visibility === "visible"'), 'settings language');
  const layout = await settings.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.settings-main').getBoundingClientRect();
    return {top:rect.top,bottom:rect.bottom,height:innerHeight,
      radius:getComputedStyle(document.querySelector('.settings-shell')).borderTopLeftRadius,
      menus:document.querySelectorAll('.desktop-titlebar').length,
      close:!document.querySelector('#closeSettings').hidden};
  })()`);
  assert.ok(layout.top <= 1 && layout.bottom <= layout.height + 1, JSON.stringify(layout));
  assert.equal(layout.radius, '24px'); assert.equal(layout.menus, 0); assert.equal(layout.close, true);
  assert.equal(settings.getParentWindow(), home); assert.equal(settings.isModal(), true);
  assert.equal(settings.isResizable(), false); assert.equal(settings.isMaximizable(), false);
  assert.equal(settings.isMenuBarVisible(), false);
  const parentBounds = home.getContentBounds(), panelBounds = settings.getBounds();
  assert.ok(panelBounds.x >= parentBounds.x + 20 && panelBounds.y >= parentBounds.y + 20);
  assert.ok(panelBounds.x + panelBounds.width <= parentBounds.x + parentBounds.width - 20);
  assert.ok(panelBounds.y + panelBounds.height <= parentBounds.y + parentBounds.height - 20);
  await wait(() => wc.executeJavaScript('!!document.querySelector(".settings-window-backdrop:not([hidden])")'), 'settings backdrop');
  assert.deepEqual(await wc.executeJavaScript('dshDesktop.closeSettingsWindow()'), { ok: false }, 'parent cannot invoke the settings close control');
  // A nested settings dialog owns Escape; it must not close its parent window.
  await settings.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#addDialog'); dialog.showModal();
    dialog.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
  })()`);
  assert.equal(settings.isDestroyed(), false);
  await settings.webContents.executeJavaScript('document.querySelector("#addDialog").close()');
  for (const theme of ['light', 'dark']) {
    await settings.webContents.executeJavaScript(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
    await wait(() => settings.webContents.executeJavaScript(`document.documentElement.dataset.theme === '${theme}'`), 'settings ' + theme);
    assert.equal(settings.isMenuBarVisible(), false);
    await capture(settings.webContents, 'settings-' + theme);
    checkNativeCaption(await capture(wc, 'settings-backdrop-' + theme), 'settings ' + theme);
    const bitmap = (await settings.webContents.capturePage(undefined, {stayHidden:true})).toBitmap();
    assert.equal(bitmap[3], 0, 'the rounded panel corner must be transparent');
  }
  await settings.webContents.executeJavaScript('document.querySelector("#closeSettings").click()');
  await wait(() => settings.isDestroyed(), 'settings custom close');
  await wait(() => wc.executeJavaScript('!!document.querySelector(".settings-window-backdrop[hidden]")'), 'settings backdrop removed');
  checkNativeCaption(await capture(wc, 'settings-closed-dark'), 'settings closed');

  // Fit the panel inside a smaller workbench on reopen, and exercise Escape
  // through the renderer rather than bypassing the close/save IPC.
  const originalBounds = home.getBounds();
  home.setSize(960, 680);
  await wc.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'general'})");
  const small = await wait(async () => {
    for (const window of BrowserWindow.getAllWindows()) if (window !== home && !window.webContents.isLoading()
      && await window.webContents.executeJavaScript('document.documentElement.hasAttribute("data-settings-window")')) return window;
  }, 'small settings');
  const smallOwner = home.getContentBounds(), smallBounds = small.getBounds();
  // Windows can round a native rectangle up by one DIP at fractional display
  // scaling, leaving a 23-DIP margin on the far edge instead of 24.
  assert.ok(smallBounds.width <= smallOwner.width - 47 && smallBounds.height <= smallOwner.height - 47,
    JSON.stringify({owner:smallOwner,panel:smallBounds}));
  for (const zoom of [0.8, 1, 1.5]) {
    small.webContents.setZoomFactor(zoom);
    assert.ok(await small.webContents.executeJavaScript(`(() => {
      const close = document.querySelector('#closeSettings').getBoundingClientRect();
      return close.right <= innerWidth && close.top >= 0 && document.documentElement.scrollWidth <= innerWidth;
    })()`));
  }
  small.webContents.setZoomFactor(1);
  await small.webContents.executeJavaScript("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))");
  await wait(() => small.isDestroyed(), 'settings Escape close');
  await wait(() => wc.executeJavaScript('!!document.querySelector(".settings-window-backdrop[hidden]")'), 'small settings backdrop removed');
  home.setBounds(originalBounds);

  await wc.executeJavaScript('window.dshDesktop.openMobileAccess()');
  const remote = await wait(async () => {
    for (const window of BrowserWindow.getAllWindows()) if (window !== home && !window.webContents.isLoading()
      && await window.webContents.executeJavaScript('!!document.querySelector("#toggle") && !!document.querySelector(".desktop-titlebar")')) return window;
  }, 'mobile-access caption');
  assert.equal(remote.isMenuBarVisible(), false);
  remote.close(); await wait(() => remote.isDestroyed(), 'mobile-access close');

  await home.loadFile(path.join(__dirname, '../src/renderer/chat/claude.html'), { query: { harness: 'codex' } });
  await wait(() => wc.executeJavaScript('!!document.querySelector(".desktop-titlebar") && uiReady'), 'chat caption');
  assert.equal(await wc.executeJavaScript('Math.round(document.querySelector(".app").getBoundingClientRect().top)'), 40);
  const fits = await wc.executeJavaScript('document.querySelector("#inputCard").getBoundingClientRect().bottom <= innerHeight');
  assert.ok(fits);
  home.maximize();
  await wait(() => home.isMaximized(), 'maximize');
  assert.equal(home.isMenuBarVisible(), false);
  home.unmaximize();
  await capture(wc, 'chat-dark');
  home.setFullScreen(true);
  await wait(() => wc.executeJavaScript('document.querySelector(".desktop-titlebar").hidden'), 'fullscreen');
  home.setFullScreen(false);
  await wait(() => wc.executeJavaScript('!document.querySelector(".desktop-titlebar").hidden'), 'exit fullscreen');
  assert.equal(home.isMenuBarVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: Windows caption menus, rounded modal settings with transparent corners and backdrop, custom/Escape close, small-window and zoom layout, real IPC, theme/language, chat/mobile, maximize and fullscreen');
  app.quit();
}

main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1;
});
