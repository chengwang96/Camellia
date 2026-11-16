'use strict';

// Isolated, hidden Electron host for the Python/Playwright regression. Use the
// production main-window constructor, preload and file-preview renderer without
// starting engines or touching the user's application profile.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { attachExternalNavigation } = require('../../src/main/external-navigation');
const { describePreview } = require('../../src/main/file-preview');

const root = process.env.CAMELLIA_NAVIGATION_TEST_ROOT;
if (!root || !path.basename(root).startsWith('camellia-navigation-')) throw new Error('An isolated navigation test profile is required');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const opened = [], failures = [], navigations = [];
let window;
app.on('browser-window-created', (_event, item) => {
  item.show = () => {}; item.showInactive = () => {}; item.focus = () => {};
  item.webContents.setBackgroundThrottling(false);
});

async function main() {
  await app.whenReady();
  ipcMain.handle('dsh:preview-file', (_event, file) => {
    if (path.resolve(file) !== path.join(root, 'links.pdf')) throw new Error('Unexpected preview path');
    return { ok: true, file: describePreview(file) };
  });
  const appRoot = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(appRoot, 'src/main/main.js'), 'utf8');
  const begin = source.indexOf('function createMainWindow() {');
  const end = source.indexOf('\n// ---------------------------------------------------------------------------', begin);
  if (begin < 0 || end <= begin) throw new Error('Main-window constructor not found');
  class HiddenWindow extends BrowserWindow {
    constructor(options) {
      super({ ...options, width: 1100, height: 900, frame: false, show: false,
        webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    }
  }
  window = vm.runInNewContext(source.slice(begin, end) + '\ncreateMainWindow();', {
    mainWindow: null, BrowserWindow: HiddenWindow, path, APP_ROOT: appRoot, APP_NAME: 'Camellia navigation test',
    __dirname: path.join(appRoot, 'src/main'), nativeTheme,
    desktopZoom: () => ({ factor: 1, attach() {} }), windowChrome: { options: () => ({}), attach() {} },
    loadConfig: () => ({ closeToTray: false }), appQuitting: false, attachExternalNavigation,
    shell: { openExternal: async url => { opened.push(url); } }, log: message => failures.push(message),
  });
  const contents = window.webContents;
  contents.on('will-navigate', event => navigations.push({ event: 'will-navigate', url: event.url, prevented: event.defaultPrevented }));
  contents.on('will-frame-navigate', event => navigations.push({ event: 'will-frame-navigate', url: event.url, main: event.isMainFrame, prevented: event.defaultPrevented }));
  contents.on('did-fail-load', (_event, code, description, url, main) => {
    if (code !== -3) failures.push({ code, description, url, main });
  });
  await window.loadFile(path.join(root, 'host.html'));
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const route = new URL(request.url, 'http://127.0.0.1');
      if (route.pathname === '/state') {
        response.end(JSON.stringify({ url: contents.getURL(), opened, failures, navigations,
          frames: contents.mainFrame.framesInSubtree.map(frame => frame.url) }));
      } else if (route.pathname === '/pdf-state') {
        const frame = contents.mainFrame.framesInSubtree.find(item => item.url.startsWith('chrome-extension://'));
        const value = frame && await frame.executeJavaScript(`(() => {
          const viewer = document.querySelector('pdf-viewer');
          const viewport = viewer?.viewport || viewer?.viewport_;
          return { position: viewport?.position, zoom: viewport?.getZoom(),
            page: viewport?.getMostVisiblePage(), originalUrl: viewer?.originalUrl };
        })()`);
        response.end(JSON.stringify(value || {}));
      } else if (route.pathname === '/pdf-prepare') {
        const frame = contents.mainFrame.framesInSubtree.find(item => item.url.startsWith('chrome-extension://'));
        if (!frame) throw new Error('The native PDF viewer is not loaded');
        await frame.executeJavaScript(`(() => {
          const viewport = document.querySelector('pdf-viewer').viewport_;
          viewport.setZoom(1.21); viewport.goToPage(1);
        })()`);
        response.end(JSON.stringify({ ok: true }));
      } else if (route.pathname === '/pdf-navigate') {
        const frame = contents.mainFrame.framesInSubtree.find(item => item.url.startsWith('chrome-extension://'));
        if (!frame) throw new Error('The native PDF viewer is not loaded');
        const result = await frame.executeJavaScript(`(async () => {
          const viewer = document.querySelector('pdf-viewer');
          viewer.navigator_.navigatorDelegate_.navigateInCurrentTab('https://s.taobao.com/search?q=TCT40-16T');
          return { ok: true };
        })()`, true);
        response.end(JSON.stringify(result));
      } else if (route.pathname === '/reload') {
        await window.loadFile(path.join(root, 'host.html'), { query: { mode: 'reloaded' } });
        response.end(JSON.stringify({ ok: true }));
      } else if (route.pathname === '/quit') {
        response.end(JSON.stringify({ ok: true })); server.close(); setImmediate(() => app.exit(0));
      } else { response.statusCode = 404; response.end('{}'); }
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ control: 'http://127.0.0.1:' + server.address().port }));
  });
}

main().catch(error => { console.error(error); app.exit(1); });
