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
  const controller = createDevicesDesktop({ app: { getPath: () => 'test-data' }, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    getSettingsWindow: () => settings, getSurfaces: () => [settings.webContents], openSettings: target => opened.push(target),
    authorizedSender: webContents => webContents === main.webContents, loadConfig: () => ({}),
    networkFactory: options => { calls.push(['networkFactory', options]); return network; }, clientFactory: () => client, ...overrides });
  context.after(() => controller.close());
  const event = surface => ({ sender: surface.webContents, senderFrame: surface.webContents.mainFrame });
  return { controller, handlers, calls, opened, main, settings, event, client };
}

test('the workbench shortcut opens the settings panel and never a separate window', async context => {
  const { handlers, main, event, opened } = fixture(context);
  const open = handlers.get('camellia:open-devices');
  assert.equal(open({}).ok, false);
  assert.equal(open({ ...event(main), senderFrame: {} }).ok, false);
  assert.equal(open(event(main)).ok, true);
  assert.deepEqual(opened, [{ page: 'devices' }]);
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
