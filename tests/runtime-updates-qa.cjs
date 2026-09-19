'use strict';
const { removeTree } = require('./test-fs.cjs');
// Throwaway QA: drive Settings → Runtime in a real Electron window, click
// "Check for updates", and verify update info renders on every engine card.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (process.versions.electron) {
    const { app, BrowserWindow } = require('electron');
    const root = process.env.RUNTIME_UPDATES_QA_ROOT;
    app.setPath('userData', path.join(root, 'app')); app.disableHardwareAcceleration();
    const errors = [];
    app.on('web-contents-created', (_event, wc) => {
      wc.on('preload-error', (_event, _file, error) => errors.push(error.message));
      wc.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    });
    app.on('browser-window-created', (_event, window) => { window.show = () => {}; window.hide(); });
    require('../src/main/main'); await app.whenReady();
    async function wait(check, label) {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(150); }
      throw new Error('QA timed out: ' + label + '\n' + errors.join('\n'));
    }
    const home = await wait(async () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('#enterDsh')")) return window;
    }, 'home window');
    await home.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({page:'runtimes'})");
    const settings = await wait(async () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('#checkRuntimeUpdates')")) return window;
    }, 'settings runtimes page');
    const cards = await wait(() => settings.webContents.executeJavaScript("document.querySelectorAll('#runtimeCards article').length"), 'runtime cards');
    assert.equal(cards, 5, 'All five engine cards render');
    await settings.webContents.executeJavaScript("document.querySelector('#checkRuntimeUpdates').click()");
    await wait(() => settings.webContents.executeJavaScript(
      "document.querySelectorAll('#runtimeCards article p.hint').length && Array.from(document.querySelectorAll('#runtimeCards article')).every(a => /Up to date|available|failed|ships with the app|已是最新|可更新|失败|随应用更新/.test(a.textContent))"
    ), 'update info on every card');
    const summary = await settings.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('#runtimeCards article')).map(a => a.querySelector('h2').textContent.trim() + ' => ' + Array.from(a.querySelectorAll('p.hint')).map(p => p.textContent.trim()).join(' | '))");
    for (const line of summary) console.log('CARD ' + line);
    try {
      const shot = await settings.capturePage();
      fs.mkdirSync(path.resolve(__dirname, '../dist/engine-settings-qa'), { recursive: true });
      fs.writeFileSync(path.resolve(__dirname, '../dist/engine-settings-qa/runtime-updates.png'), shot.toPNG());
    } catch (error) { console.log('Skipping QA screenshot: ' + (error.message || error)); }
    assert.deepEqual(errors, []);
    console.log('PASS: Settings → Runtime shows a working Check-for-updates flow with per-engine results');
    app.quit(); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-updates-qa-'));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/desktop-config.json'), JSON.stringify({ port: 0, autoRefreshBalances: false }));
  const env = { ...process.env, RUNTIME_UPDATES_QA_ROOT: root, DSH_HOME: path.join(root, 'dsh'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), KIMI_CODE_HOME: path.join(root, 'home/.kimi-code') };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => proc.kill(), 150000);
  const code = await new Promise(resolve => proc.once('exit', resolve)); clearTimeout(timeout);
  try { assert.equal(code, 0); }
  finally {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('runtime-updates-qa-'));
    removeTree(root);
  }
}
main().catch(error => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
