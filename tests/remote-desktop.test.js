'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createRemoteDesktop } = require('../src/main/remote/desktop');
const { assetStem, createTailnetUpdates } = require('../src/main/remote/tailnet-updates');
const { removeTree } = require('./test-fs.cjs');

function startupHarness(context, devices = [], initialState = 'Running', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-startup-'));
  context.after(() => removeTree(root));
  const file = path.join(root, 'remote', 'devices.json');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, JSON.stringify({ devices }));
  const calls = { start: 0, login: 0, listen: 0, stop: 0 };
  const network = {
    snapshot: { state: 'Stopped' },
    async start() { calls.start++; this.snapshot = { state: initialState, address: initialState === 'Running' ? '100.80.1.2' : null }; },
    async status() { return this.snapshot; },
    async login() { calls.login++; },
    async openLogin() { assert.fail('Automatic startup must not open a browser'); },
    async listen(target, token) { calls.listen++; assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/); assert.match(token, /^[a-f0-9]{64}$/); },
    async stop() { calls.stop++; this.snapshot = { state: 'Stopped' }; },
  };
  const handlers = new Map(), logs = [];
  const settings = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  const controller = createRemoteDesktop({ app: { getPath: () => root },
    BrowserWindow: class { constructor() { assert.fail('Automatic startup must not open a window'); } },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } }, loadConfig: () => ({}),
    getSettingsWindow: () => settings, networkFactory: () => network, guard: options.guard || null,
    log: message => logs.push(message) });
  context.after(() => controller.close());
  const command = (action, payload) => handlers.get('dsh:remote-control')({ sender: settings.webContents, senderFrame: settings.webContents.mainFrame }, { action, payload });
  return { controller, command, network, calls, file, logs };
}

const trustedPhone = () => ({ id: 'trusted-phone', name: 'Phone', tokenDigest: 'a'.repeat(64),
  permission: 'control', workspaceIds: [], allWorkspaces: true, includeUnassigned: true });

test('startup restores trusted mobile access without opening settings and manual stop stays stopped', async context => {
  const { controller, command, calls } = startupHarness(context, [trustedPhone()]);
  await controller.startTrustedDevices();
  assert.equal(calls.start, 1); assert.equal(calls.listen, 1); assert.equal(calls.login, 0);
  const state = (await command('state')).result;
  assert.equal(state.enabled, true); assert.equal(state.running, true); assert.equal(state.address, 'http://100.80.1.2:43127');
  await controller.startTrustedDevices(); assert.equal(calls.start, 1);
  assert.equal((await command('stop')).ok, true);
  await controller.startTrustedDevices();
  assert.equal(calls.start, 1); assert.equal((await command('state')).result.enabled, false);
});

test('startup leaves mobile access disabled without a saved valid trusted device', async context => {
  for (const devices of [[], [{ id: 'unclaimed', permission: 'control' }], [{ ...trustedPhone(), tokenDigest: 'invalid' }]]) {
    const { controller, command, calls } = startupHarness(context, devices);
    await controller.startTrustedDevices();
    assert.equal(calls.start, 0); assert.equal(calls.listen, 0);
    assert.equal((await command('state')).result.enabled, false);
  }
});

test('background guard follows mobile access and trusted-device lifecycle', async context => {
  const calls = [];
  let enabled = true;
  const guard = {
    enabled: () => enabled,
    start() { calls.push('start'); return enabled; },
    pause() { calls.push('pause'); },
    ensureStarted() { calls.push('ensure'); },
    enable() { enabled = true; calls.push('enable'); },
    disable() { enabled = false; calls.push('disable'); },
    view() { return { supported: true, available: true, enabled, running: enabled, retrying: false }; },
  };
  const { controller, command } = startupHarness(context, [trustedPhone()], 'Running', { guard });
  await controller.startTrustedDevices();
  assert.ok(calls.includes('start'));
  await command('state');
  assert.ok(calls.includes('ensure'));
  assert.equal((await command('stop')).ok, true);
  assert.equal(calls.at(-1), 'pause');
  assert.equal((await command('start')).ok, true);
  assert.equal(calls.filter(call => call === 'start').length, 2);
  assert.equal((await command('guard-disable')).result.guard.enabled, false);
  assert.equal(calls.at(-1), 'disable');
  assert.equal((await command('guard-enable')).result.guard.enabled, true);
  assert.equal(calls.at(-1), 'enable');
  assert.equal((await command('revoke', { id: 'trusted-phone' })).ok, true);
  assert.equal(calls.at(-1), 'pause');
  assert.equal((await command('stop')).ok, true);
  assert.match((await command('guard-enable')).error, /Enable mobile access first/);

  const emptyCalls = [];
  const emptyGuard = {
    enabled: () => true, start() { emptyCalls.push('start'); },
    pause() { emptyCalls.push('pause'); }, ensureStarted() {},
    view: () => ({ supported: true, available: true, enabled: true, running: false }),
  };
  const empty = startupHarness(context, [], 'Running', { guard: emptyGuard });
  await empty.controller.startTrustedDevices();
  assert.deepEqual(emptyCalls, ['pause']);
});

test('expired login waits for manual authorization; connecting nodes can become ready later', async context => {
  for (const initial of ['NeedsLogin', 'Starting']) {
    const { controller, command, network, calls } = startupHarness(context, [trustedPhone()], initial);
    await controller.startTrustedDevices();
    assert.equal(calls.start, 1); assert.equal(calls.login, 0); assert.equal(calls.listen, 0);
    assert.equal((await command('state')).result.running, false);
    network.snapshot = { state: 'Running', address: '100.80.1.2' };
    assert.equal((await command('state')).result.running, true);
    assert.equal(calls.listen, 1);
  }
});

test('automatic startup retries a connecting network without the healthy monitor delay', async context => {
  const { controller, network, calls } = startupHarness(context, [trustedPhone()], 'Starting');
  await controller.startTrustedDevices();
  assert.equal(calls.listen, 0);
  network.snapshot = { state: 'Running', address: '100.80.1.2' };
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(calls.listen, 1);
});

test('a live helper with persistent status errors is restarted automatically', async context => {
  const { controller, command, network, calls, logs } = startupHarness(context, [trustedPhone()]);
  const start = network.start, stop = network.stop;
  let recovered = false;
  network.start = async () => {
    if (network.child) return;
    await start.call(network);
    network.child = {};
  };
  network.stop = async () => {
    recovered = true;
    network.child = null;
    await stop.call(network);
  };
  await controller.startTrustedDevices();
  assert.equal(calls.listen, 1);
  network.status = async () => {
    if (!recovered) throw new Error('Local status unavailable');
    return network.snapshot;
  };
  const deadline = Date.now() + 8000;
  while (calls.listen < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls.stop, 1);
  assert.equal(calls.start, 2);
  assert.equal(calls.listen, 2);
  assert.equal((await command('state')).result.running, true);
  assert.ok(logs.some(message => message.includes('Local status unavailable')));
  assert.ok(logs.some(message => message.includes('restarting the embedded network helper')));
});

test('automatic startup failures keep the enabled preference and can be retried manually', async context => {
  const { controller, command, network, calls } = startupHarness(context, [trustedPhone()]);
  const start = network.start;
  network.start = async () => { throw new Error('Secure storage locked'); };
  await assert.rejects(controller.startTrustedDevices(), /Secure storage locked/);
  const state = (await command('state')).result;
  assert.equal(state.enabled, true); assert.equal(state.running, false); assert.equal(state.network.state, 'Error');
  network.start = start;
  assert.equal((await command('start')).result.running, true);
});

test('closing during automatic startup never creates a listener', async context => {
  const { controller, command, network, calls } = startupHarness(context, [trustedPhone()]);
  let release;
  network.start = () => new Promise(resolve => { release = resolve; });
  const starting = controller.startTrustedDevices();
  assert.equal((await command('start')).ok, false);
  await controller.close(); release(); await starting;
  assert.equal(calls.listen, 0);
  await controller.startTrustedDevices(); assert.equal(calls.listen, 0);
});

test('revoking the last trusted device persists an empty startup authorization list', async context => {
  const { controller, command, file } = startupHarness(context, [trustedPhone()]);
  await controller.startTrustedDevices();
  assert.equal((await command('revoke', { id: 'trusted-phone' })).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).devices, []);
});

test('desktop control is disabled by default and accepts only remote-access and settings main frames', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-desktop-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  context.after(() => removeTree(root));
  const handlers = new Map(), windows = [];
  let listenTarget = null, openedLogin = false, failure;
  const network = { snapshot: { state: 'Stopped' }, async start() { this.snapshot.state = 'NeedsLogin'; },
    async status() { return this.snapshot; }, async login() { this.snapshot.loginUrl = 'https://login.tailscale.com/a/test'; },
    async openLogin() { openedLogin = true; }, async stop() { this.snapshot = { state: 'Stopped' }; },
    async logout() { this.snapshot = { state: 'Stopped' }; }, async listen(target, token) { listenTarget = target; assert.match(token, /^[a-f0-9]{64}$/); } };
  const settings = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  const desktop = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
    }
    isDestroyed() { return false; }
    show() { this.shown = true; }
    focus() {}
    async loadFile(file) { this.file = file; }
  }
  const controller = createRemoteDesktop({ app: { getPath: () => root }, BrowserWindow: FakeWindow,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }, nativeTheme: { shouldUseDarkColors: false },
    manager: { workspaces: { sessionMeta: () => ({ workspaces: [{ id: 'workspace', name: 'Work' }] }) } },
    rendererRoot: path.join(__dirname, '../src/renderer'), loadConfig: () => ({ closeToTray: false, language: 'en' }), getSettingsWindow: () => settings, getMainWindow: () => desktop,
    networkFactory: options => { failure = options.onFailure; return network; } });
  context.after(() => controller.close());
  const command = handlers.get('dsh:remote-control');
  const open = handlers.get('dsh:open-mobile-access');
  const settingsEvent = { sender: settings.webContents, senderFrame: settings.webContents.mainFrame };
  const desktopEvent = { sender: desktop.webContents, senderFrame: desktop.webContents.mainFrame };
  assert.equal(open({}).ok, false);
  assert.equal(open({ ...settingsEvent, senderFrame: {} }).ok, false);
  assert.equal(open({ ...desktopEvent, senderFrame: {} }).ok, false);
  assert.equal(windows.length, 0);
  assert.equal((await command({}, { action: 'state' })).ok, false);
  const embeddedState = await command(settingsEvent, { action: 'state' });
  assert.equal(embeddedState.ok, true);
  assert.equal(embeddedState.result.running, false);
  assert.equal(windows.length, 0);
  assert.equal((await command({ ...settingsEvent, senderFrame: {} }, { action: 'state' })).ok, false);
  assert.equal((await command(desktopEvent, { action: 'state' })).ok, false, 'opening the panel does not grant desktop remote controls');
  assert.equal(open(desktopEvent).ok, true);
  assert.equal((await command(settingsEvent, { action: 'state' })).ok, true);
  assert.equal(windows.length, 1);
  const window = windows[0], event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.equal(window.options.show, false, 'the mobile window stays hidden until its first paint');
  assert.equal(window.options.center, true);
  assert.equal(window.shown, undefined);
  window.emit('ready-to-show');
  assert.equal(window.shown, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.ok(window.options.webPreferences.preload.endsWith(path.join('remote', 'preload.js')));
  assert.deepEqual(window.openHandler(), { action: 'deny' });
  let blocked = false;
  window.webContents.emit('will-navigate', { preventDefault() { blocked = true; } });
  assert.equal(blocked, true);
  assert.equal((await command({ ...event, senderFrame: {} }, { action: 'state' })).ok, false);
  assert.equal((await command({ ...event, sender: {} }, { action: 'state' })).ok, false);
  const state = await command(event, { action: 'state' });
  assert.equal(state.ok, true);
  assert.equal(state.result.running, false);
  assert.equal(state.result.address, null);
  assert.deepEqual(state.result.devices, []);
  assert.equal(fs.existsSync(path.join(root, 'remote', 'devices.json')), false);
  assert.equal((await command(event, { action: 'invite', payload: { workspaceIds: ['workspace'] } })).ok, false);
  assert.equal((await command(event, { action: 'send', payload: { prompt: 'Never execute' } })).ok, false);
  controller.open(); assert.equal(windows.length, 1); assert.equal(window.shown, true);
  assert.equal(open(settingsEvent).ok, true); assert.equal(windows.length, 1);
  assert.equal(open(desktopEvent).ok, true); assert.equal(windows.length, 1);
  desktop.isDestroyed = () => true;
  assert.equal(open(desktopEvent).ok, false);
  settings.isDestroyed = () => true;
  assert.equal(open(settingsEvent).ok, false);
  assert.equal((await command(settingsEvent, { action: 'state' })).ok, false);
  assert.equal((await command(event, { action: 'stop' })).ok, true);
  assert.equal((await command(event, { action: 'open-login' })).ok, false);
  const starting = await command(event, { action: 'start' });
  assert.equal(starting.ok, true);
  assert.equal(starting.result.enabled, true);
  assert.equal(starting.result.running, false);
  assert.equal(starting.result.network.state, 'NeedsLogin');
  assert.equal(starting.result.network.loginUrl, 'https://login.tailscale.com/a/test');
  assert.equal((await command(event, { action: 'invite' })).ok, false);
  assert.equal((await command(event, { action: 'open-login' })).ok, true);
  assert.equal(openedLogin, true);
  network.snapshot = { state: 'Running', address: '100.80.1.2' };
  const online = await command(event, { action: 'state' });
  assert.equal(online.ok, true);
  assert.equal(online.result.running, true);
  assert.equal(online.result.address, 'http://100.80.1.2:43127');
  assert.match(listenTarget, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await command(event, { action: 'invite' })).ok, true);
  failure();
  const disconnected = await command(event, { action: 'state' });
  assert.equal(disconnected.result.running, false);
  assert.equal(disconnected.result.enabled, true);
  assert.equal((await command(event, { action: 'stop' })).ok, true);
  await command(event, { action: 'start' });
  network.snapshot = { state: 'Running', address: '100.80.1.2' };
  network.listen = async () => { throw new Error('listener failed'); };
  const failedListen = await command(event, { action: 'state' });
  assert.equal(failedListen.ok, false);
  assert.equal(failedListen.error, 'listener failed');
  const afterFailure = await command(event, { action: 'state' });
  assert.equal(afterFailure.result.running, false);
  assert.equal(afterFailure.result.enabled, true);
  assert.equal((await command(event, { action: 'logout' })).ok, true);
  assert.equal(network.snapshot.state, 'Stopped');
  await controller.close();
  assert.equal((await command(event, { action: 'start' })).ok, false);
});

test('desktop scope authorization always grants current and future workspaces without changing control permission', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-desktop-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  context.after(() => removeTree(root));
  const file = path.join(root, 'remote', 'devices.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ devices: [{ id: 'phone', name: 'Phone', workspaceIds: ['old'], permission: 'read' }] }));
  const handlers = new Map();
  const settings = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  const controller = createRemoteDesktop({ app: { getPath: () => root },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } }, loadConfig: () => ({}), getSettingsWindow: () => settings });
  context.after(() => controller.close());
  const command = handlers.get('dsh:remote-control');
  const event = { sender: settings.webContents, senderFrame: settings.webContents.mainFrame };
  const initial = await command(event, { action: 'state' });
  assert.deepEqual(initial.result.devices[0].workspaceIds, ['old']);
  assert.notEqual(initial.result.devices[0].allWorkspaces, true);
  assert.equal(initial.result.devices[0].permission, 'control');
  assert.equal((await command(event, { action: 'permission', payload: { id: 'phone', permission: 'read' } })).ok, false);
  for (const payload of [{ id: 'phone' }, { id: 'phone', workspaceIds: ['missing'], allWorkspaces: false, includeUnassigned: false }]) {
    const response = await command(event, { action: 'scope', payload });
    assert.equal(response.ok, true);
    const device = response.result.devices[0];
    assert.deepEqual(device.workspaceIds, []);
    assert.equal(device.allWorkspaces, true);
    assert.equal(device.includeUnassigned, true);
    assert.equal(device.permission, 'control');
  }
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).devices[0];
  assert.equal(stored.allWorkspaces, true);
  assert.equal(stored.includeUnassigned, true);
  assert.equal(stored.permission, 'control');
});

test('saving the computer name also renames the embedded node', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-name-'));
  context.after(() => removeTree(root));
  const calls = [];
  const network = {
    child: {},
    snapshot: { state: 'Running', address: '100.80.1.2', deviceId: 'node', hostName: 'old-name' },
    async start() {},
    async status() { return this.snapshot; },
    async login() {},
    async openLogin() {},
    async listen() {},
    async stop() {},
    async setHostname(hostname) { calls.push(hostname); this.snapshot = { ...this.snapshot, hostName: hostname }; return { hostName: hostname }; },
  };
  const handlers = new Map();
  const settings = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  let savedName = '';
  const controller = createRemoteDesktop({ app: { getPath: () => root },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } }, loadConfig: () => ({}),
    getSettingsWindow: () => settings, networkFactory: () => network,
    computerName: () => savedName || 'old-name', saveComputerName: name => { savedName = name; return name; } });
  context.after(() => controller.close());
  const command = handlers.get('dsh:remote-control');
  const event = { sender: settings.webContents, senderFrame: settings.webContents.mainFrame };
  assert.equal((await command(event, { action: 'start' })).ok, true);
  const response = await command(event, { action: 'set-name', payload: { name: 'Work PC' } });
  assert.equal(response.ok, true);
  assert.equal(response.result.computerName, 'Work PC');
  assert.deepEqual(calls, ['work-pc']);
  assert.equal(network.snapshot.hostName, 'work-pc');
});

test('the embedded node starts with the saved computer name, or the helper fallback', async context => {
  for (const [saved, expected] of [['Work PC', 'work-pc'], ['', '']]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-boot-name-'));
    context.after(() => removeTree(root));
    let options;
    const network = {
      snapshot: { state: 'Running', address: '100.80.1.2' },
      async start() {}, async status() { return this.snapshot; }, async login() {}, async openLogin() {},
      async listen() {}, async stop() {},
    };
    const handlers = new Map();
    const settings = { webContents: { mainFrame: {} }, isDestroyed: () => false };
    const controller = createRemoteDesktop({ app: { getPath: () => root },
      ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
      manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } }, loadConfig: () => ({}),
      getSettingsWindow: () => settings, networkFactory: value => { options = value; return network; },
      computerName: () => saved, saveComputerName: name => name });
    context.after(() => controller.close());
    await handlers.get('dsh:remote-control')({ sender: settings.webContents, senderFrame: settings.webContents.mainFrame }, { action: 'state' });
    assert.equal(options.hostname(), expected);
  }
});

test('a transient network state and an address change recover without reenabling manually', async context => {
  const { controller, command, network, calls } = startupHarness(context, [trustedPhone()]);
  await controller.startTrustedDevices(); assert.equal(calls.listen, 1);
  network.snapshot = { state: 'Starting', address: null };
  let state = (await command('state')).result;
  assert.equal(state.enabled, true); assert.equal(state.running, false);
  network.snapshot = { state: 'Running', address: '100.80.1.2' };
  assert.equal((await command('state')).result.running, true); assert.equal(calls.listen, 2);
  network.snapshot = { state: 'Running', address: '100.80.1.3' };
  state = (await command('state')).result;
  assert.equal(state.address, 'http://100.80.1.3:43127'); assert.equal(calls.listen, 3);
  await command('stop'); await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await command('state')).result.enabled, false); assert.equal(calls.listen, 3);
});

test('manual stop during slow startup never opens a listener after startup finishes', async context => {
  const { controller, command, network, calls } = startupHarness(context, [trustedPhone()]);
  let release; network.start = () => new Promise(resolve => release = resolve);
  const starting = controller.startTrustedDevices();
  assert.equal((await command('stop')).ok, true); release(); await starting;
  assert.equal(calls.listen, 0); assert.equal((await command('state')).result.enabled, false);
});

test('settings updates restart only the mobile helper, restore the old helper on failure and retry without downloading', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-tailnet-hot-update-'));
  context.after(() => removeTree(root));
  const file = path.join(root, 'remote', 'devices.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ devices: [trustedPhone()] }));
  const version = 'v999.999.999';
  const platform = 'win32', arch = 'x64';
  const stem = assetStem(platform, arch, version);
  const binary = Buffer.from('updated helper'), notices = Buffer.from('updated notices');
  const assets = [['bin', binary], ['txt', notices]].map(([extension, bytes]) => {
    const name = stem + '.' + extension;
    return { name, browser_download_url: 'https://github.com/chengwang96/Camellia/releases/download/v1.1.0/' + name,
      size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
  });
  const calls = [];
  let failUpdated = true, downloads = 0;
  const replacementStarted = Promise.withResolvers(), finishFailedStart = Promise.withResolvers();
  const network = {
    executable: null,
    snapshot: { state: 'Stopped' },
    async start() {
      const selected = this.executable || 'bundled';
      calls.push('start:' + selected);
      if (failUpdated && this.executable) {
        failUpdated = false;
        replacementStarted.resolve();
        await finishFailedStart.promise;
        throw new Error('Updated helper failed');
      }
      this.snapshot = { state: 'Running', address: '100.80.1.2' };
    },
    async status() { return this.snapshot; },
    async listen() {},
    async stop() { calls.push('stop'); this.snapshot = { state: 'Stopped' }; },
  };
  const handlers = new Map();
  const settings = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  const controller = createRemoteDesktop({
    app: { getPath: () => root, relaunch: () => assert.fail('Application must not relaunch'), quit: () => assert.fail('Application must not quit') },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    manager: { workspaces: { sessionMeta: () => ({ workspaces: [] }) } }, loadConfig: () => ({}),
    getSettingsWindow: () => settings,
    networkFactory: options => { network.executable = options.executable; return network; },
    createUpdates: options => createTailnetUpdates({ ...options, platform, arch }),
    prepareRestart: async () => assert.fail('Conversation restart preparation must not run'),
    downloadConnection: () => ({
      async fetch(url) {
        if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v1.1.0', assets });
        const asset = assets.find(item => item.browser_download_url === url);
        if (!asset) throw new Error('Unexpected download URL');
        downloads++;
        return new Response(asset.name.endsWith('.bin') ? binary : notices);
      },
      close() {},
    }),
  });
  context.after(() => controller.close());
  const event = { sender: settings.webContents, senderFrame: settings.webContents.mainFrame };
  const command = action => handlers.get('dsh:remote-control')(event, { action });
  await controller.startTrustedDevices();
  const initial = await command('state');
  const originalVersion = initial.result.tailnetUpdate.current;
  assert.equal(initial.result.running, true);
  assert.equal((await command('tailnet-update-check')).result.available, version);
  const installing = command('tailnet-update-install');
  await Promise.race([replacementStarted.promise, installing]);
  try {
    assert.equal(controller.updatingTailnet(), true);
    assert.equal((await command('state')).result.tailnetUpdate.busy, true);
    assert.equal((await command('tailnet-update-check')).ok, false);
  } finally { finishFailedStart.resolve(); }
  const failed = await installing;
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Updated helper failed/);
  const pending = await command('state');
  assert.equal(pending.result.tailnetUpdate.pending, version);
  assert.equal(pending.result.tailnetUpdate.current, originalVersion);
  assert.equal(pending.result.enabled, true);
  assert.equal(pending.result.running, true);
  assert.equal(network.executable, null);
  assert.equal(calls.filter(call => call === 'start:bundled').length, 2);
  calls.length = 0;
  const applied = await command('tailnet-update-install');
  assert.equal(applied.ok, true);
  assert.equal(applied.result.current, version);
  assert.equal(applied.result.updated, version);
  assert.equal(applied.result.reconnected, true);
  assert.equal(applied.result.pending, null);
  assert.ok(network.executable.endsWith(path.join(version, 'camellia-tailnet.exe')));
  assert.deepEqual(calls, ['stop', 'start:' + network.executable]);
  assert.equal(downloads, 2);
});
