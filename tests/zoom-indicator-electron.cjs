'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  if (!process.versions.electron) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-zoom-indicator-'));
    try {
      const proc = spawn(require('electron'), [__filename], {
        env: { ...process.env, CAMELLIA_ZOOM_TEST_ROOT: root }, windowsHide: true, stdio: 'pipe',
      });
      let output = '';
      proc.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
      proc.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
      const timeout = setTimeout(() => {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else proc.kill('SIGKILL');
      }, 45000);
      const code = await new Promise((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
      clearTimeout(timeout);
      assert.equal(code, 0, output);
      assert.match(output, /PASS: real Ctrl\+wheel/);
    } finally {
      assert.ok(path.basename(root).startsWith('camellia-zoom-indicator-'));
      removeTree(root);
    }
    return;
  }

  const electron = require('electron');
  const { app, BrowserWindow, ipcMain } = require('./hidden-electron-windows.cjs')(electron);
  const root = process.env.CAMELLIA_ZOOM_TEST_ROOT;
  assert.ok(root && path.basename(root).startsWith('camellia-zoom-indicator-'));
  app.setPath('userData', path.join(root, 'profile'));
  const { createZoomController } = require('../src/main/zoom-controller');
  let saved = {};
  const zoom = createZoomController({ loadConfig: () => saved, saveConfig: patch => { saved = { ...saved, ...patch }; } });
  ipcMain.handle('dsh:zoom-by-wheel', (_event, direction) => zoom.adjust(direction));
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1000, height: 700,
    webPreferences: { preload: path.join(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const contents = window.webContents;
  zoom.attach(contents);
  const fixture = path.join(root, 'fixture.html');
  fs.writeFileSync(fixture, `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'">
    <link rel="stylesheet" href="fixture.css"><title>Zoom indicator fixture</title></head>
    <body><main><p class="eyebrow">CAMELLIA WORKSPACE</p><h1>Research notes</h1>
    <p>Use Ctrl and the mouse wheel to change the interface scale.</p>
    <section><strong>Current experiment</strong><p>The floating indicator should remain readable without blocking this content.</p></section>
    </main></body></html>`);
  fs.writeFileSync(path.join(root, 'fixture.css'), `
    :root { color-scheme: light; font-family: "Segoe UI", sans-serif; background: #eef1f5; color: #18202b; }
    :root[data-theme="dark"] { color-scheme: dark; background: #151517; color: #f9fafb; }
    :root[data-theme="dark"] main { border-color: #ffffff1f; background: #232324; }
    :root[data-theme="dark"] section { background: #1b1b1c; }
    body { margin: 0; } main { width: 640px; margin: 110px auto; padding: 42px; box-sizing: border-box;
      border: 1px solid #d8dee7; border-radius: 18px; background: #fff; box-shadow: 0 18px 55px #26314814; }
    .eyebrow { color: #667085; font-size: 12px; letter-spacing: 2px; } h1 { margin: 12px 0; font-size: 34px; }
    p { line-height: 1.65; } section { margin-top: 32px; padding: 22px; border-radius: 12px; background: #f5f7fa; }
  `);
  await window.loadFile(fixture);
  contents.focus();
  const wait = async (expression, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await contents.executeJavaScript(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for ' + expression);
  };
  const indicatorAt = percent => `document.querySelector('#camellia-zoom-indicator')?.hasAttribute('data-visible') && document.querySelector('#camellia-zoom-indicator').shadowRoot.textContent.trim() === '${percent}'`;
  const wheel = async deltaY => {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 400, modifiers: 2 });
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY, modifiers: 2 });
  };
  const metrics = () => contents.executeJavaScript(`(() => {
    const host = document.querySelector('#camellia-zoom-indicator');
    const panel = host.shadowRoot.querySelector('.zoom-panel');
    const hostStyle = getComputedStyle(host), panelStyle = getComputedStyle(panel);
    return { pointerEvents: hostStyle.pointerEvents, fontSize: parseFloat(panelStyle.fontSize), background: panelStyle.backgroundColor,
      alpha: parseFloat(panelStyle.backgroundColor.match(/[\\d.]+/g).at(-1)), live: host.getAttribute('aria-live'),
      centered: Math.abs(host.getBoundingClientRect().left + host.getBoundingClientRect().width / 2 - innerWidth / 2) < 1 };
  })()`);

  assert.equal(await contents.executeJavaScript("document.querySelector('#camellia-zoom-indicator')"), null);
  await wheel(-120);
  await wait(indicatorAt('110%'));
  assert.ok(Math.abs(contents.getZoomLevel() - 0.5) < 0.00001);
  assert.equal(saved.zoomLevel, 0.5);
  let style = await metrics();
  assert.equal(style.pointerEvents, 'none');
  assert.ok(style.alpha > 0 && style.alpha < 1, 'The panel is translucent under the fixture CSP');
  assert.equal(style.live, 'polite');
  assert.equal(style.centered, true);
  assert.ok(Math.abs(style.fontSize * contents.getZoomFactor() - 13) < 0.1);

  contents.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
  contents.sendInputEvent({ type: 'keyUp', keyCode: '0', modifiers: ['control'] });
  await wait(indicatorAt('100%'));
  assert.equal(contents.getZoomLevel(), 0);
  zoom.adjust(-1);
  await wait(indicatorAt('91%'));

  await wheel(-120);
  await wait(indicatorAt('100%'));
  await new Promise(resolve => setTimeout(resolve, 900));
  await wheel(-120);
  await wait(indicatorAt('110%'));
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(await contents.executeJavaScript("document.querySelector('#camellia-zoom-indicator').hasAttribute('data-visible')"), true, 'Continuous zooming keeps the indicator visible');
  const lightBackground = style.background;
  const capture = process.env.CAMELLIA_ZOOM_CAPTURE ? path.resolve(process.env.CAMELLIA_ZOOM_CAPTURE) : null;
  if (capture) {
    fs.mkdirSync(path.dirname(capture), { recursive: true });
    fs.writeFileSync(capture, (await contents.capturePage()).toPNG());
  }
  await contents.executeJavaScript("document.documentElement.dataset.theme = 'dark'");
  zoom.adjust(1);
  await wait(indicatorAt('120%'));
  const darkStyle = await metrics();
  assert.notEqual(darkStyle.background, lightBackground, 'The indicator follows the dark theme');
  assert.ok(darkStyle.alpha > 0 && darkStyle.alpha < 1, 'The dark panel is also translucent');
  if (capture) fs.writeFileSync(capture.replace(/\.png$/i, '') + '-dark.png', (await contents.capturePage()).toPNG());

  for (const [level, percent] of [[-100, '50%'], [100, '300%']]) {
    zoom.set(level);
    await wait(indicatorAt(percent));
    style = await metrics();
    assert.ok(Math.abs(style.fontSize * contents.getZoomFactor() - 13) < 0.1, 'Readable at ' + percent);
  }
  await wait("!document.querySelector('#camellia-zoom-indicator').hasAttribute('data-visible')", 4000);
  console.log('PASS: real Ctrl+wheel, Ctrl+0 and menu zoom; live percentage, translucent centered styling, 50-300% legibility, continuous-input timer and automatic hiding');
  window.close();
  app.quit();
}

main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
