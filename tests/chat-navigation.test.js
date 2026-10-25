'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const start = source.indexOf('  async function switchMode(');
const end = source.indexOf('\n  async function loadMode(', start);
assert.ok(start !== -1 && end > start);

function fixture(prepare = async () => {}) {
  const loads = [], saved = [], titles = [];
  const rendererRoot = path.join(__dirname, '../src/renderer');
  const state = {
    require, path, RENDERER_ROOT: rendererRoot, modeRequest: 0, currentMode: 'codex',
    APP_NAME: 'Camellia', APP_NAME_CLAUDE: 'Claude Code',
    ENGINES: { codex: { name: 'Codex CLI' }, kimi: { name: 'Kimi Code' }, claude: { name: 'Claude Code' } },
    assertRuntimeAvailable() {}, runtimes: () => ({ ensure: prepare }),
    sharedConversations: { settings: () => ({ connection: 'api' }) },
    loadConfig: () => ({}), saveConfig: patch => saved.push(patch),
    log() {}, setMenu() {}, openSettingsWindow() {},
    loadMode: (...args) => loads.push(args),
    mainWindow: { isDestroyed: () => false, setTitle: title => titles.push(title),
      webContents: { getURL: () => pathToFileURL(path.join(rendererRoot, 'chat/claude.html')).href + '?harness=codex' } },
  };
  vm.createContext(state);
  vm.runInContext(source.slice(start, end), state);
  return { state, loads, saved, titles };
}

test('in-place engine navigation updates native state without loading a document', async () => {
  const { state, loads, saved, titles } = fixture();
  assert.equal((await state.switchMode('kimi', 'kimi-session', undefined, true)).ok, true);
  assert.equal(state.currentMode, 'kimi');
  assert.equal(saved.at(-1).mode, 'kimi');
  assert.deepEqual(titles, ['Kimi Code — Camellia']);
  assert.deepEqual(loads, []);
});

test('returning to the current engine cancels a pending cross-engine navigation', async () => {
  let finish;
  const { state, loads, saved, titles } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = state.switchMode('kimi', 'kimi-session', undefined, true);
  assert.equal((await state.switchMode('codex', 'codex-session', undefined, true)).ok, true);
  finish();
  assert.equal((await pending).canceled, true);
  assert.equal(state.currentMode, 'codex');
  assert.deepEqual([loads, saved, titles], [[], [], []]);
});

test('a fresh draft also supersedes pending engine navigation', async () => {
  let finish;
  const { state } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = state.switchMode('kimi', 'kimi-session', undefined, true);
  await state.switchMode('codex', undefined, undefined, true);
  finish();
  assert.equal((await pending).canceled, true);
  assert.equal(state.currentMode, 'codex');
});

test('the most recent cross-engine navigation owns the native title and mode', async () => {
  let finish;
  const { state, loads, titles } = fixture(engine => engine === 'kimi' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
  const pending = state.switchMode('kimi', 'kimi-session', undefined, true);
  await state.switchMode('claude', 'claude-session', undefined, true);
  finish();
  assert.equal((await pending).canceled, true);
  assert.equal(state.currentMode, 'claude');
  assert.deepEqual(titles, ['Claude Code — Camellia']);
  assert.deepEqual(loads, []);
});

test('cancelling runtime preparation keeps the current document and engine', async () => {
  const { state, loads, saved } = fixture(async () => { throw Object.assign(new Error('Canceled'), { code: 'DOWNLOAD_CANCELLED' }); });
  assert.equal((await state.switchMode('kimi', 'kimi-session', undefined, true)).canceled, true);
  assert.equal(state.currentMode, 'codex');
  assert.deepEqual([loads, saved], [[], []]);
});

test('a page that has left chat cannot receive an in-place engine switch', async () => {
  const { state, loads, saved } = fixture();
  state.mainWindow.webContents.getURL = () => pathToFileURL(path.join(state.RENDERER_ROOT, 'home/home.html')).href;
  assert.equal((await state.switchMode('kimi', 'kimi-session', undefined, true)).ok, false);
  assert.equal(state.currentMode, 'codex');
  assert.deepEqual([loads, saved], [[], []]);
});

test('ordinary navigation from other pages still loads the requested chat', async () => {
  const { state, loads } = fixture();
  assert.equal((await state.switchMode('kimi', 'kimi-session')).ok, true);
  assert.deepEqual(loads, [['kimi', 'kimi-session', undefined]]);
});
