'use strict';

// Electron/IPC integration fixture. Only this test injects an adapter. No model
// endpoint, subscription credential, native engine or production data is used.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const electron = require('electron');
const { app, BrowserWindow } = electron;
const root = process.env.DISCUSSION_UI_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('An isolated test directory is required');
if (process.env.DISCUSSION_UI_NAVIGATION === '1') {
  // Page navigation must not download or start a real harness in a UI test.
  const runtimes = require('../src/main/runtime-manager');
  const originalCreate = runtimes.createRuntimeManager;
  runtimes.createRuntimeManager = options => ({ ...originalCreate(options), async ensure(engine) {
    fs.appendFileSync(path.join(root, 'navigation.jsonl'), JSON.stringify({ engine }) + '\n');
    return { file: 'ui-navigation-fixture-only' };
  } });
}
app.setPath('userData', path.join(root, 'app'));
app.disableHardwareAcceleration();
const testElectron = Object.create(electron);
Object.defineProperty(testElectron, 'BrowserWindow', { value: new Proxy(BrowserWindow, {
  construct(Type, args) {
    const options = args[0] || {};
    return new Type({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
  },
}) });
app.on('browser-window-created', (_event, window) => {
  window.show = () => {}; window.hide(); window.webContents.setBackgroundThrottling(false);
});
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const serviceModule = require('../src/engines/discussions/service');
const OriginalService = serviceModule.DiscussionService;
const checks = Object.fromEntries(['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed',
  'shellRestricted', 'mcpRestricted', 'subagentsRestricted', 'escalationDisabled',
  'conversationControlDisabled', 'toolsDisabled'].map(key => [key, true]));
const bindings = ['codex', 'antigravity'].flatMap(engine => ['subscription', 'api'].map(connection => ({
  label: engine === 'codex' ? 'Test Codex' : 'Test Antigravity', accountLabel: 'UI fixture',
  binding: { engine, connection, model: 'fixture-model', accountRef: 'fixture-account', thinking: '', contextWindow: 64000 },
})));
const callsFile = path.join(root, 'calls.jsonl');
const rich = process.env.DISCUSSION_UI_RICH === '1';
let richRun = 0;
const adapters = Object.fromEntries(['codex', 'antigravity'].map(engine => [engine, {
  runtime: { version: 'fixture', policyVersion: 'fixture' },
  evidence: binding => binding.connection === 'api' ? null : ({ kind: 'real', reference: 'synthetic-ui-test-only',
    bindingFingerprint: bindingFingerprint(binding), runtimeVersion: 'fixture', policyVersion: 'fixture', mode: rich ? 'native-tools' : 'tool-free',
    supportsImages: engine === 'codex', checks: { ...checks, permissionsRouted: true, workspaceQueue: true } }),
  create(identity) {
    let stopped = false, respond; const runId = ++richRun;
    return {
      async execute({ plan, signal, onEvent }) {
        fs.appendFileSync(callsFile, JSON.stringify({ identity, plan }) + '\n');
        const current = JSON.parse(plan.prompt.split('Current user request: ')[1].split('\n\n')[0]);
        onEvent({ ...identity, type: 'started', nativeId: identity.nativeId || randomUUID() });
        if (rich && current.text.includes('[questions]')) {
          await new Promise(resolve => {
            signal.addEventListener('abort', resolve, { once: true });
            respond = answer => {
              if (answer.runId !== runId) return false;
              fs.writeFileSync(path.join(root, 'question-answer.json'), JSON.stringify(answer)); resolve(); return true;
            };
            onEvent({ ...identity, type: 'permission', permission: { runId, requestId: 'fixture-question', toolName: 'AskUserQuestion',
              questions: [{ id: 'role', question: 'Choose the review role', options: [{ label: 'Scientist' }, { label: 'Programmer' }] },
                { id: 'formats', question: 'Output formats', multiSelect: true, options: [{ label: 'CSV' }, { label: 'JSON' }] }] } });
          });
        }
        if (rich && current.text.includes('[tools]')) {
          const file = path.join(identity.cwd, 'fixture-result.txt');
          onEvent({ ...identity, type: 'tool', tool: { id: 'fixture-write', name: 'Write', input: { file_path: file, content: 'Synthetic UI result' }, status: 'running' } });
          const allow = await new Promise(resolve => {
            signal.addEventListener('abort', () => resolve(false), { once: true });
            respond = answer => { if (answer.runId !== runId) return false; resolve(answer.allow); return true; };
            onEvent({ ...identity, type: 'permission', permission: { runId, requestId: 'fixture-permission', toolName: 'Write', input: { file_path: file } } });
          });
          if (allow) fs.writeFileSync(file, 'Synthetic UI result');
          onEvent({ ...identity, type: 'tool', tool: { id: 'fixture-write', output: allow ? 'Saved synthetic file' : 'Denied by the user', status: allow ? 'completed' : 'failed' } });
        }
        onEvent({ ...identity, type: 'answer', text: '[UI fixture] Preparing a reply…' });
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new Error('Fixture stopped')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, current.text.includes('[hold]') ? 60000 : 700);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        if (current.text.includes('[fail]')) throw new Error('Test connection failed.');
        return { text: '[UI fixture] ' + engine + ' reply to: ' + current.text };
      },
      cancel() { stopped = true; },
      respond(answer) { return respond?.(answer) === true; },
      async stop() { stopped = true; return { ...identity, stopped, released: true }; },
    };
  },
}]));
if (process.env.DISCUSSION_UI_REAL_SERVICE !== '1') {
  serviceModule.DiscussionService = class extends OriginalService {
    constructor(options) { super({ ...options, registry: undefined, production: undefined, adapters, getCatalog: () => bindings }); }
    async call(action, payload) {
      if (rich) {
        fs.appendFileSync(path.join(root, 'actions.jsonl'), JSON.stringify({ action }) + '\n');
        const unsupported = path.join(root, 'unsupported-actions.json');
        // Reproduce a newly loaded renderer calling a main process from before
        // rich interactions existed, including its original unstructured error.
        if (fs.existsSync(unsupported) && JSON.parse(fs.readFileSync(unsupported, 'utf8')).includes(action)) throw new Error('Unknown discussion action');
      }
      return super.call(action, payload);
    }
  };
}
const Module = require('node:module'), originalLoad = Module._load;
try {
  Module._load = function (request, ...args) { return request === 'electron' ? testElectron : originalLoad.call(this, request, ...args); };
  require('../src/main/main');
} finally { Module._load = originalLoad; }
app.whenReady().then(() => {
  // Explicit fixture-only shutdown command for Python; the real application's
  // before-quit handler still drains the real discussion scheduler.
  require('node:http').createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/quit') { res.end('ok'); setImmediate(() => app.quit()); }
    else { res.statusCode = 404; res.end(); }
  }).listen(Number(process.env.DISCUSSION_UI_CONTROL_PORT), '127.0.0.1');
});
