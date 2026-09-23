'use strict';
const { removeTree } = require('./test-fs.cjs');

// Exercise the real main-process IPC handlers with isolated storage and a local
// fake CLI. No application startup, network calls, or user configuration access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const mainDir = path.resolve(__dirname, '../src/main');

function createHarness(existingRoot) {
  const root = existingRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspaces-'));
  const userData = path.join(root, 'app');
  const home = path.join(root, 'home');
  const handlers = new Map();
  const processes = [];
  const events = [];
  const timers = new Map();
  let timerId = 0;
  const dialogBehavior = {
    open: async () => ({ canceled: true, filePaths: [] }),
    save: async () => ({ canceled: true }),
  };
  const electron = {
    app: { getPath: () => userData, getName: () => 'camellia-desktop', setName() {}, commandLine: { appendSwitch() {} }, getVersion: () => '0.1.0', requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) },
    nativeTheme: { themeSource: 'system' },
    Menu: { buildFromTemplate: template => template, setApplicationMenu(menu) { this.current = menu; } },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async (...args) => dialogBehavior.open(...args), showSaveDialog: async (...args) => dialogBehavior.save(...args) },
  };
  const mockProcess = Object.create(process);
  mockProcess.env = { ...process.env, DSH_HOME: path.join(home, '.dsh'), APPDATA: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: '' };
  const mockFs = Object.create(fs);
  mockFs.createWriteStream = () => Object.assign(new EventEmitter(), { write() {}, end() {} });
  function spawn(exe, args, options) {
    const proc = new EventEmitter();
    Object.assign(proc, { exe, args, cwd: options.cwd, stdout: new EventEmitter(), stderr: new EventEmitter(), messages: [], killed: false });
    proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: (line) => proc.messages.push(JSON.parse(line)) });
    proc.kill = () => { proc.killed = true; };
    processes.push(proc);
    return proc;
  }
  const sandbox = {
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === 'node:child_process') return { spawn, spawnSync: () => ({ status: 0, stdout: '' }) };
      if (name === 'node:os') return { ...os, homedir: () => home };
      if (name === 'node:fs') return mockFs;
      if (name.startsWith('.')) return require(path.resolve(mainDir, name));
      return require(name);
    },
    module: { exports: {} }, __dirname: mainDir,
    process: mockProcess, Buffer, URL, console,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports = { claudeSessionMeta, resolveClaudeSessionContext, claudeGoalDrive: () => goalDriver.drive(), syncOllamaBaseUrl, resolveClaudeRoute, claudeSpawnSpec, stopRouter: stopOllamaProxyHandle, getSession: () => claudeSessions.legacy, sharedConversations, claudeSessions, kimiSessions, codex, antigravity, dshChat, setWindow: (w) => { mainWindow = w; } };', sandbox, { filename: 'src/main/main.js' });
  const api = sandbox.module.exports;
  api.setWindow({ isDestroyed: () => false, webContents: { send: (channel, data) => events.push({ channel, data }) } });
  function call(channel, payload) {
    const handler = handlers.get('dsh:' + channel);
    if (!handler) throw new Error('Unknown IPC: ' + channel);
    return handler(null, payload);
  }
  function folder(name) { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true }); return dir; }
  function configureApi() {
    const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
    writeConfig(path.join(home, '.dsh', 'ollama-proxy.json'), normalizeConfig({ providers: [{
      id: 'test', name: 'Local test', baseUrl: 'http://127.0.0.1:19099/v1', protocol: 'openai',
      models: [{ id: 'test-model', upstream: 'test-model' }], keys: [{ id: 'test-key', key: 'isolated-test-key' }],
    }] }));
    call('claude-save-settings', { model: 'test-model' });
  }
  function seedSession(id, cwd, title = 'Existing conversation', mtimeMs = Date.now()) {
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-z0-9]/gi, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: title } }) + '\n');
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }
  function finishTurn(proc = processes.at(-1)) {
    if (!proc) throw new Error('No CLI process');
    const target = proc.args.includes('--resume') ? proc.args[proc.args.indexOf('--resume') + 1] : null;
    const resumed = target && target.endsWith('.jsonl') ? path.basename(target, '.jsonl') : target;
    if (!proc.sid) proc.sid = proc.args.includes('--fork-session') ? randomUUID() : (resumed || randomUUID());
    const prompt = proc.messages.filter((m) => m.type === 'user').at(-1)?.message.content[0].text || 'Goal';
    seedSession(proc.sid, proc.cwd, prompt);
    for (const ev of [
      { type: 'system', subtype: 'init', session_id: proc.sid },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Test response' }] } },
      { type: 'result', subtype: 'success', session_id: proc.sid, result: 'Test response', usage: { input_tokens: 12, output_tokens: 8 } },
    ]) proc.stdout.emit('data', JSON.stringify(ev) + '\n');
    return proc.sid;
  }
  function cleanup() {
    api.sharedConversations.pauseGoals();
    for (const session of api.claudeSessions.sessions.values()) session.kill();
    timers.clear();
    // The only recursive deletion is the explicitly verified, per-test sandbox.
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('dsh-workspaces-')) throw new Error('Unsafe test cleanup path');
    removeTree(resolved);
  }
  return { root, userData, home, call, folder, configureApi, seedSession, finishTurn, processes, events, api, cleanup, dialogBehavior };
}
module.exports = { createHarness };
