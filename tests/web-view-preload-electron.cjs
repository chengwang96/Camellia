'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', error => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once('exit', code => {
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.whenReady().then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../src/main/web-view-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    try {
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
        <style>.sidebar-slot,.dc04ec1d,._4cbcd96{display:block;width:100px;height:100px}</style>
        <div class="sidebar-slot" id="kimi"></div>
        <div class="dc04ec1d" id="deepseek"></div>
        <div class="_4cbcd96" id="mobile"></div>`));
      const before = await window.webContents.executeJavaScript(
        "[...document.querySelectorAll('.sidebar-slot,.dc04ec1d,._4cbcd96')].map(node => getComputedStyle(node).display)");
      assert.deepEqual(before, ['none', 'none', 'none']);
      // Readiness alone never reveals provider navigation; only the extraction's
      // explicit fallback opt-in does.
      await window.webContents.executeJavaScript(
        "document.documentElement.setAttribute('data-camellia-web-ready', '')");
      const afterReady = await window.webContents.executeJavaScript(
        "[...document.querySelectorAll('.sidebar-slot,.dc04ec1d,._4cbcd96')].map(node => getComputedStyle(node).display)");
      assert.deepEqual(afterReady, ['none', 'none', 'none']);
      await window.webContents.executeJavaScript(
        "document.documentElement.setAttribute('data-camellia-web-site-sidebar-visible', '')");
      const afterVisible = await window.webContents.executeJavaScript(
        "[...document.querySelectorAll('.sidebar-slot,.dc04ec1d,._4cbcd96')].map(node => getComputedStyle(node).display)");
      assert.deepEqual(afterVisible, ['block', 'block', 'block']);
      console.log('PASS: web view preload hides provider sidebars until the layout runtime opts in');
    } finally {
      window.destroy();
      app.quit();
    }
  }).catch(error => {
    console.error(error);
    app.exit(1);
  });
}
