'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const start = source.indexOf("    if (!app.isPackaged && process.argv.includes('--hot-reload')) {");
assert.notEqual(start, -1);
const end = source.indexOf('\n  });', start);
assert.notEqual(end, -1);
const watcherSource = source.slice(start, end);

function harness({ argv = ['electron', '.'], isPackaged = false, mode = 'codex' } = {}) {
  const state = { watches: [], reloads: 0, timers: new Map() };
  let timerId = 0;
  const context = {
    app: { isPackaged }, process: { argv }, path, RENDERER_ROOT: '/renderer', currentMode: mode,
    fs: { watch(directory, callback) { state.watches.push({ directory, callback }); } },
    mainWindow: { isDestroyed: () => false, webContents: { reloadIgnoringCache() { state.reloads++; } } },
    setTimeout(callback) { state.timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { state.timers.delete(id); }, log() {},
  };
  vm.runInNewContext(watcherSource, context);
  state.flush = () => {
    const callbacks = [...state.timers.values()];
    state.timers.clear();
    for (const callback of callbacks) callback();
  };
  return { state, context };
}

test('normal source launches never register a page-reloading file watcher', () => {
  const { state } = harness();
  assert.equal(state.watches.length, 0);
  assert.equal(state.reloads, 0);
});

test('packaged launches ignore the hot-reload opt-in', () => {
  const { state } = harness({ isPackaged: true, argv: ['camellia', '--hot-reload'] });
  assert.equal(state.watches.length, 0);
});

test('explicit development hot reload debounces chat changes', () => {
  const { state } = harness({ argv: ['electron', '.', '--hot-reload'] });
  assert.equal(state.watches.length, 1);
  assert.equal(state.watches[0].directory, path.join('/renderer', 'chat'));
  state.watches[0].callback('change', 'claude.js');
  state.watches[0].callback('change', 'claude.css');
  assert.equal(state.timers.size, 1);
  assert.equal(state.reloads, 0);
  state.flush();
  assert.equal(state.reloads, 1);
});

test('unwatched files and navigation away from chat do not reload the page', () => {
  const { state, context } = harness({ argv: ['electron', '.', '--hot-reload'] });
  state.watches[0].callback('change', 'unrelated.js');
  assert.equal(state.timers.size, 0);
  state.watches[0].callback('change', 'claude.html');
  context.currentMode = 'home';
  state.flush();
  assert.equal(state.reloads, 0);
});

test('closing the window before a pending reload is safe', () => {
  const { state, context } = harness({ argv: ['electron', '.', '--hot-reload'] });
  state.watches[0].callback('change', 'chat-runtime.js');
  context.mainWindow.isDestroyed = () => true;
  state.flush();
  assert.equal(state.reloads, 0);
});

test('standard launch scripts do not opt into hot reload', () => {
  const { scripts } = require('../package.json');
  assert.equal(scripts.start, 'electron .');
  assert.equal(scripts.dev, 'electron .');
  assert.equal(scripts['dev:hot'], 'electron . --hot-reload');
});
