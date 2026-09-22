'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { attachImageContextMenu } = require('../src/main/image-context-menu');
const { translate } = require('../src/shared/i18n');
const { removeTree } = require('./test-fs.cjs');

function createHarness(sourcePath, language = 'zh-CN') {
  const contents = new EventEmitter();
  const templates = [];
  const popups = [];
  const copies = [];
  const dialogs = [];
  const errors = [];
  const owner = {};
  const state = { result: { canceled: true }, destroyed: false };
  contents.isDestroyed = () => state.destroyed;
  contents.copyImageAt = (...coordinates) => copies.push(coordinates);
  attachImageContextMenu(contents, {
    Menu: { buildFromTemplate: template => {
      templates.push(template);
      return { popup: options => popups.push(options) };
    } },
    dialog: {
      showSaveDialog: async (...args) => { dialogs.push(args); return state.result; },
      showErrorBox: (...args) => errors.push(args),
    },
    BrowserWindow: { fromWebContents: () => owner },
    uiText: text => translate(text, language),
  });
  const params = {
    mediaType: 'image', srcURL: pathToFileURL(sourcePath).href,
    hasImageContents: true, x: 120, y: 240, frame: {},
  };
  return { contents, templates, popups, copies, dialogs, errors, owner, state, params,
    open: overrides => contents.emit('context-menu', {}, { ...params, ...overrides }) };
}

test('local image menu has two localized actions and copies image pixels at the clicked position', () => {
  const harness = createHarness(path.resolve('figure.svg'));
  harness.open();
  assert.deepEqual(harness.templates[0].map(item => item.label), ['复制到剪贴板', '另存为…']);
  assert.equal(harness.popups[0].frame, harness.params.frame);
  harness.templates[0][0].click();
  assert.deepEqual(harness.copies, [[120, 240]]);
  const english = createHarness(path.resolve('figure.avif'), 'en');
  english.open();
  assert.deepEqual(english.templates[0].map(item => item.label), ['Copy image to clipboard', 'Save image as…']);
});

test('menu ignores non-images, editable elements, remote URLs and unsupported files', () => {
  const harness = createHarness(path.resolve('figure.png'));
  for (const overrides of [
    { mediaType: 'none' }, { isEditable: true }, { srcURL: 'https://example.com/image.png' },
    { srcURL: 'invalid' }, { srcURL: pathToFileURL(path.resolve('notes.txt')).href },
  ]) harness.open(overrides);
  assert.equal(harness.templates.length, 0);
  harness.open({ hasImageContents: false });
  assert.equal(harness.templates[0][0].enabled, false);
});

test('save as preserves original bytes and name, handles cancellation and same-file saves', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-image-menu-'));
  context.after(() => removeTree(directory));
  const sourcePath = path.join(directory, '图片 #1.gif');
  const destination = path.join(directory, 'saved.gif');
  const bytes = Buffer.from('GIF89a original animated image bytes');
  fs.writeFileSync(sourcePath, bytes);
  const harness = createHarness(sourcePath);
  harness.open();
  const save = harness.templates[0][1].click;
  await save();
  assert.equal(fs.existsSync(destination), false);
  assert.equal(harness.dialogs[0][0], harness.owner);
  assert.equal(harness.dialogs[0][1].defaultPath, '图片 #1.gif');
  assert.deepEqual(harness.dialogs[0][1].filters[0], { name: 'GIF', extensions: ['gif'] });
  harness.state.result = { canceled: false, filePath: destination };
  await save();
  assert.deepEqual(fs.readFileSync(destination), bytes);
  harness.state.result.filePath = sourcePath;
  await save();
  assert.deepEqual(fs.readFileSync(sourcePath), bytes);
  assert.deepEqual(harness.errors, []);
});

test('save errors are reported and destroyed views do not perform actions', async () => {
  const harness = createHarness(path.join(os.tmpdir(), 'missing-camellia-image', 'image.png'));
  harness.open();
  harness.state.result = { canceled: false, filePath: path.join(os.tmpdir(), 'unused-camellia-image.png') };
  await harness.templates[0][1].click();
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0][0], '图片操作失败');
  harness.state.destroyed = true;
  harness.templates[0][0].click();
  await harness.templates[0][1].click();
  assert.equal(harness.copies.length, 0);
  assert.equal(harness.dialogs.length, 1);
});
