'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { removeTree } = require('./test-fs.cjs');
const { createDevicesDesktop } = require('../src/main/remote/devices-desktop');

function fixture(context, overrides = {}) {
  const handlers = new Map(), calls = [], opened = [];
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = {}; this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; }
    send(...args) { calls.push(['event', ...args]); }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  }
  const windows = [];
  class Window extends EventEmitter {
    static fromWebContents(contents) { return windows.find(window => window.webContents === contents); }
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); windows.push(this); }
    async loadFile(file, options) { this.file = file; this.query = options.query; }
    isDestroyed() { return this.webContents.isDestroyed(); }
    isMinimized() { return false; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    close() { this.emit('closed'); this.webContents.close(); }
  }
  const main = { webContents: new Contents(), isDestroyed: () => false };
  const settings = { webContents: new Contents(), isDestroyed: () => false };
  const network = { async start() { calls.push(['start']); }, async status() { return { state: 'NeedsLogin' }; }, async login() { calls.push(['login']); }, async stop() { calls.push(['stop']); } };
  const client = { pending: new Map(), list: () => [{ id: 'server', name: 'Server' }],
    async command(...args) { calls.push(['command', ...args]); return { ok: true }; },
    async conversations(...args) { calls.push(['conversations', ...args]); return { conversations: [] }; },
    async close() { calls.push(['close']); },
    async *events(device, target, signal) {
      calls.push(['subscribe', device, target]);
      yield { type: 'snapshot' };
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      calls.push(['aborted', target]);
    },
  };
  const controller = createDevicesDesktop({ app: { getPath: () => 'test-data' }, BrowserWindow: Window, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    getSettingsWindow: () => settings, getSurfaces: () => [settings.webContents], openSettings: target => opened.push(target),
    authorizedSender: webContents => webContents === main.webContents, loadConfig: () => ({}),
    networkFactory: options => { calls.push(['networkFactory', options]); return network; }, clientFactory: () => client, ...overrides });
  context.after(() => controller.close());
  const event = surface => ({ sender: surface.webContents, senderFrame: surface.webContents.mainFrame });
  return { controller, handlers, calls, opened, main, settings, event, client, windows };
}

test('home lists server metadata and opens one sandboxed window per server', async context => {
  const { handlers, main, event, windows } = fixture(context);
  const list = handlers.get('camellia:list-servers'), open = handlers.get('camellia:open-server');
  assert.equal(list({}).ok, false);
  assert.equal(list(event(main)).devices[0].name, 'Server');
  assert.equal((await open({ ...event(main), senderFrame: {} }, { deviceId: 'server' })).ok, false);
  assert.equal((await open(event(main), { deviceId: 'missing' })).ok, false);
  assert.equal((await open(event(main), { deviceId: 'server' })).ok, true);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].query, { device: 'server' });
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  assert.deepEqual(windows[0].webContents.windowOpenHandler(), { action: 'deny' });
  assert.equal((await open(event(main), { deviceId: 'server' })).ok, true);
  assert.equal(windows.length, 1); assert.equal(windows[0].focused, true);
  const invoke = (action, payload) => handlers.get('camellia:devices')(event(windows[0]), { action, payload });
  assert.equal((await invoke('conversations', { deviceId: 'server' })).ok, true);
  assert.equal((await invoke('conversations', { deviceId: 'other' })).ok, false);
  assert.equal((await invoke('forget', { id: 'server' })).ok, false);
});

test('closing settings or another server does not cancel remaining server watches', async context => {
  const { handlers, main, event, windows, client, calls, controller, settings } = fixture(context);
  client.list = () => [{ id: 'server', name: 'First' }, { id: 'second', name: 'Second' }];
  for (const deviceId of ['server', 'second']) await handlers.get('camellia:open-server')(event(main), { deviceId });
  const watch = (surface, deviceId) => handlers.get('camellia:devices')(event(surface), { action: 'watch', payload: { deviceId, conversationId: 'chat', watchId: deviceId } });
  await watch(windows[0], 'server'); await watch(windows[1], 'second'); await watch(settings, 'settings');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call[0] === 'aborted').length, 0);
  controller.detach(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call[0] === 'aborted').length, 2);
  windows[0].close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call[0] === 'aborted').length, 4);
  assert.equal(windows[1].isDestroyed(), false);
});

test('the workbench shortcut opens the settings panel and never a separate window', async context => {
  const { handlers, main, event, opened } = fixture(context);
  const open = handlers.get('camellia:open-devices');
  assert.equal(open({}).ok, false);
  assert.equal(open({ ...event(main), senderFrame: {} }).ok, false);
  assert.equal(open(event(main)).ok, true);
  assert.deepEqual(opened, [{ page: 'devices' }]);
});

test('destroyed settings detach uses captured contents without enumerating destroyed windows', async context => {
  const { handlers, event, settings, controller, calls } = fixture(context);
  const contents = settings.webContents;
  await handlers.get('camellia:devices')(event(settings), { action: 'watch', payload: { deviceId: 'server', conversationId: 'chat', watchId: 'settings' } });
  await new Promise(resolve => setImmediate(resolve));
  contents.close();
  Object.defineProperty(settings, 'webContents', { configurable: true, get() { throw new Error('Object has been destroyed'); } });
  try {
    assert.doesNotThrow(() => controller.detach([contents, undefined]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(call => call[0] === 'aborted').length, 2);
  } finally { Object.defineProperty(settings, 'webContents', { value: contents }); }
});

test('a server window stays usable when an unrelated settings surface cannot be read', async context => {
  let stale = false;
  const { handlers, main, event, windows, controller } = fixture(context, {
    getSurfaces: () => { if (stale) throw new TypeError('Object has been destroyed'); return []; },
  });
  await handlers.get('camellia:open-server')(event(main), { deviceId: 'server' });
  stale = true;
  try {
    const invoke = (action, payload) => handlers.get('camellia:devices')(event(windows[0]), { action, payload });
    assert.equal((await invoke('state')).ok, true);
    assert.equal((await invoke('conversations', { deviceId: 'server' })).ok, true);
    assert.equal((await invoke('conversations', { deviceId: 'other' })).ok, false);
    assert.equal((await handlers.get('camellia:devices')(event(main), { action: 'state' })).ok, false);
    assert.doesNotThrow(() => controller.detach());
  } finally { stale = false; }
});

test('server authorization does not read another destroyed BrowserWindow webContents getter', async context => {
  const { handlers, main, event, windows, client } = fixture(context);
  client.list = () => [{ id: 'server', name: 'First' }, { id: 'second', name: 'Second' }];
  for (const deviceId of ['server', 'second']) await handlers.get('camellia:open-server')(event(main), { deviceId });
  const first = windows[0], contents = first.webContents;
  contents.close();
  first.isDestroyed = () => true;
  Object.defineProperty(first, 'webContents', { configurable: true, get() { throw new TypeError('Object has been destroyed'); } });
  try {
    const result = await handlers.get('camellia:devices')(event(windows[1]), { action: 'state' });
    assert.equal(result.ok, true);
    const rejected = await handlers.get('camellia:devices')({ sender: contents, senderFrame: contents.mainFrame }, { action: 'state' });
    assert.equal(rejected.ok, false);
  } finally { Object.defineProperty(first, 'webContents', { value: contents }); }
});

test('device operations are accepted from the settings surfaces only and broadcast their events there', async context => {
  const { handlers, calls, main, settings, event } = fixture(context);
  const invoke = handlers.get('camellia:devices');
  assert.equal((await invoke(event(main), { action: 'state' })).ok, false);
  assert.equal((await invoke({ ...event(settings), senderFrame: {} }, { action: 'state' })).ok, false);
  const state = await invoke(event(settings), { action: 'state' });
  assert.equal(state.result.devices[0].name, 'Server');
  assert.equal((await invoke(event(settings), { action: 'network-start' })).ok, true);
  assert.ok(calls.some(call => call[0] === 'login'));
  assert.equal((await invoke(event(settings), { action: 'command', payload: { deviceId: 'server', command: { action: 'api-keys' } } })).ok, false);
  assert.equal((await invoke(event(settings), { action: 'command', payload: { deviceId: 'server', command: { action: 'create', requestId: 'stable' } } })).ok, true);
  assert.equal(calls.find(call => call[0] === 'command')[1], 'server');
});

test('disposed IPC frames are rejected without accessing settings or starting networking', async context => {
  let enumerations = 0;
  const { handlers, settings, calls, event } = fixture(context, { getSurfaces: () => { enumerations++; return []; } });
  const disposed = { ...event(settings), get senderFrame() { throw new Error('Render frame was disposed'); } };
  for (const channel of ['camellia:devices', 'camellia:list-servers', 'camellia:open-server', 'camellia:open-devices']) {
    const result = await handlers.get(channel)(disposed, { action: 'state', deviceId: 'server' });
    assert.equal(result.ok, false, channel);
  }
  assert.equal(enumerations, 0);
  assert.equal(calls.length, 0);
});

test('destroyed server contents are unregistered before another window sends IPC', async context => {
  const { handlers, main, event, windows } = fixture(context);
  const open = handlers.get('camellia:open-server');
  await open(event(main), { deviceId: 'server' });
  const contents = windows[0].webContents;
  contents.close(); contents.emit('destroyed');
  assert.equal((await open(event(main), { deviceId: 'server' })).ok, true);
  assert.equal(windows.length, 2);
  assert.equal((await handlers.get('camellia:devices')(event(windows[1]), { action: 'state' })).ok, true);
  assert.equal((await handlers.get('camellia:devices')({ sender: contents, senderFrame: contents.mainFrame }, { action: 'state' })).ok, false);
});

test('device watches only emit invalidations and cancel when the panel detaches', async context => {
  const { controller, handlers, settings, event, calls } = fixture(context);
  assert.equal((await handlers.get('camellia:devices')(event(settings), { action: 'watch', payload: { deviceId: 'server', conversationId: 'chat', watchId: 'view-1' } })).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  const notifications = calls.filter(call => call[0] === 'event' && call[1] === 'camellia:device-event');
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(call => call[2].type === 'changed' && call[2].watchId === 'view-1' && !call[2].data));
  controller.detach();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call[0] === 'aborted').length, 2);
});

test('pasted attachments are server-scoped opaque IDs and reject renderer filesystem paths', async context => {
  const { handlers, settings, event, client, calls } = fixture(context);
  client.snapshot = async () => ({});
  const invoke = (action, payload) => handlers.get('camellia:devices')(event(settings), { action, payload });
  const payload = { deviceId: 'server', conversationId: 'chat', files: [{ name: 'paste.txt', data: Buffer.from('hello').toString('base64') }] };
  const added = await invoke('attachments-add', payload);
  assert.equal(added.ok, true); assert.equal('data' in added.result.files[0], false);
  const ids = added.result.files.map(file => file.id);
  assert.equal((await invoke('command', { deviceId: 'other', conversationId: 'chat', attachmentIds: ids, command: { action: 'send' } })).ok, false);
  assert.equal((await invoke('command', { deviceId: 'server', conversationId: 'chat', attachmentIds: ids, command: { action: 'send' } })).ok, true);
  assert.equal(calls.find(call => call[0] === 'command')[3].attachments[0].name, 'paste.txt');
  assert.equal((await invoke('attachments-add', { ...payload, files: [{ ...payload.files[0], path: 'C:/private' }] })).ok, false);
});

test('native settings IPC forwards only from the settings window and links require native confirmation', async context => {
  const opened = [];
  const { handlers, settings, event, client, main } = fixture(context, {
    dialog: { showMessageBox: async () => ({ response: 1 }) }, shell: { openExternal: async url => opened.push(url) },
  });
  client.nativeSettings = async (id, engine) => ({ id, engine, files: [] });
  client.saveNativeSettings = async (id, settings) => ({ id, ...settings, ok: true });
  const invoke = (action, payload) => handlers.get('camellia:devices')(event(settings), { action, payload });
  assert.equal((await handlers.get('camellia:devices')(event(main), { action: 'native-settings-get', payload: { engine: 'codex' } })).ok, false);
  assert.equal((await invoke('native-settings-get', { deviceId: 'server', engine: 'codex' })).result.engine, 'codex');
  const document = { engine: 'codex', id: 'settings', text: '', confirmed: true, revision: 'a'.repeat(64) };
  assert.equal((await invoke('native-settings-save', { deviceId: 'server', settings: document })).result.ok, true);
  assert.equal((await invoke('open-output-link', { url: 'file:///private' })).ok, false);
  assert.equal((await invoke('open-output-link', { url: 'https://user:secret@example.com' })).ok, false);
  assert.equal((await invoke('open-output-link', { url: 'https://example.com' })).ok, true);
  assert.deepEqual(opened, ['https://example.com/']);
});

test('file IPC uses user-selected paths and opaque attachment IDs bound to the selected device', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-ipc-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  context.after(() => removeTree(root));
  const source = path.join(root, 'notes.txt'); fs.writeFileSync(source, 'fixture');
  const { handlers, settings, event, calls, client } = fixture(context, { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [source] }) } });
  client.snapshot = async () => ({ conversation: { id: 'chat' } });
  const invoke = (action, payload) => handlers.get('camellia:devices')(event(settings), { action, payload });
  const selected = await invoke('attachments-select', { deviceId: 'server', conversationId: 'chat' });
  assert.equal(selected.ok, true);
  const [file] = selected.result.files;
  assert.equal(file.name, 'notes.txt'); assert.equal(Object.hasOwn(file, 'data'), false); assert.equal(Object.hasOwn(file, 'path'), false);
  const payload = { deviceId: 'other', conversationId: 'chat', attachmentIds: [file.id], command: { action: 'send' } };
  assert.equal((await invoke('command', payload)).ok, false);
  assert.equal((await invoke('command', { ...payload, deviceId: 'server', command: { action: 'send', attachments: [] } })).ok, false);
  assert.equal((await invoke('command', { ...payload, deviceId: 'server' })).ok, true);
  const command = calls.find(call => call[0] === 'command');
  assert.equal(command[3].attachments[0].data, Buffer.from('fixture').toString('base64'));
  assert.equal((await invoke('command', { ...payload, deviceId: 'server' })).ok, false);
});

test('download IPC revalidates remote metadata, saves through a native dialog and reports completion', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-download-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  const destination = path.join(root, 'saved.txt');
  let proposed;
  const { controller, handlers, settings, event, calls, client } = fixture(context, { dialog: { showSaveDialog: async (_window, options) => {
    proposed = options.defaultPath; return { canceled: false, filePath: destination };
  } } });
  client.artifacts = async () => ({ artifacts: [{ id: 'a'.repeat(64), name: '../../report.txt', size: 7 }], nextOffset: null });
  client.artifact = async () => { const stream = Readable.from([Buffer.from('fixture')]); stream.statusCode = 200; stream.headers = { 'content-length': '7' }; return stream; };
  const completed = new Promise(resolve => {
    const send = settings.webContents.send;
    settings.webContents.send = (...args) => { send(...args); if (args[0] === 'camellia:device-transfer' && ['complete', 'failed'].includes(args[1].state)) resolve(args[1]); };
  });
  try {
    const result = await handlers.get('camellia:devices')(event(settings), { action: 'download', payload: { deviceId: 'server', conversationId: 'chat', artifactId: 'a'.repeat(64), filePath: '/never-use-renderer-path' } });
    assert.equal(result.ok, true); assert.equal(proposed, '.._.._report.txt');
    assert.equal((await completed).state, 'complete');
    assert.equal(fs.readFileSync(destination, 'utf8'), 'fixture');
    assert.ok(calls.some(call => call[0] === 'event' && call[1] === 'camellia:device-transfer'));
  } finally { await controller.close(); removeTree(root); }
});

test('download cancellation remains available while another device command is busy', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-cancel-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  const { controller, handlers, settings, event, client } = fixture(context, { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'out') }) } });
  client.artifacts = async () => ({ artifacts: [{ id: 'a'.repeat(64), name: 'out', size: 100 }], nextOffset: null });
  const stream = new Readable({ read() {} }); stream.statusCode = 200; stream.headers = { 'content-length': '100' };
  client.artifact = async () => stream;
  const invoke = (action, payload) => handlers.get('camellia:devices')(event(settings), { action, payload });
  let release;
  try {
    const canceled = new Promise(resolve => { settings.webContents.send = (_channel, value) => { if (value.state === 'cancelled') resolve(); }; });
    const download = await invoke('download', { deviceId: 'server', conversationId: 'chat', artifactId: 'a'.repeat(64) });
    client.conversations = () => new Promise(resolve => { release = () => resolve({ conversations: [] }); });
    const listing = invoke('conversations', { deviceId: 'server' });
    assert.equal((await invoke('download-cancel', { id: download.result.id })).ok, true);
    await canceled;
    assert.equal(stream.destroyed, true);
    release(); await listing;
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { release?.(); await controller.close(); removeTree(root); }
});
