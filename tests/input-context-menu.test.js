'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachInputContextMenu } = require('../src/main/input-context-menu');
const { translate } = require('../src/shared/i18n');

function createHarness() {
  const contents = new EventEmitter();
  const templates = [];
  const popups = [];
  let language = 'zh-CN';
  attachInputContextMenu(contents, {
    Menu: {
      buildFromTemplate(template) {
        templates.push(template);
        return { popup: options => popups.push(options) };
      },
    },
    uiText: text => translate(text, language),
  });
  return { contents, templates, popups, setLanguage: value => { language = value; } };
}

test('editable context menu contains only cut, copy, paste and select all', () => {
  const harness = createHarness();
  const frame = {};
  harness.contents.emit('context-menu', {}, {
    isEditable: true, frame,
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  });
  assert.deepEqual(harness.templates[0], [
    { role: 'cut', label: '剪切', enabled: true },
    { role: 'copy', label: '复制', enabled: true },
    { role: 'paste', label: '粘贴', enabled: true },
    { role: 'selectAll', label: '全选', enabled: true },
  ]);
  assert.equal(harness.popups[0].frame, frame);
});

test('selected read-only text opens a copy and select all menu in its frame', () => {
  const harness = createHarness();
  const frame = {};
  harness.contents.emit('context-menu', {}, {
    isEditable: false, mediaType: 'none', frame,
    selectionText: '最新交付的产物优先',
    editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
  });
  assert.deepEqual(harness.templates[0], [
    { role: 'copy', label: '复制', enabled: true },
    { role: 'selectAll', label: '全选', enabled: true },
  ]);
  assert.equal(harness.popups[0].frame, frame);
});

test('read-only text menu follows edit flags and the current language', () => {
  const harness = createHarness();
  harness.setLanguage('en');
  harness.contents.emit('context-menu', {}, {
    isEditable: false, selectionText: 'Selected response',
    editFlags: { canCopy: true, canSelectAll: false },
  });
  assert.deepEqual(harness.templates[0], [
    { role: 'copy', label: 'Copy', enabled: true },
    { role: 'selectAll', label: 'Select all', enabled: false },
  ]);
});

test('non-editable content without selected text does not open a menu', () => {
  const harness = createHarness();
  for (const selectionText of [undefined, '', ' \n ']) {
    harness.contents.emit('context-menu', {}, { isEditable: false, selectionText });
  }
  assert.equal(harness.templates.length, 0);
  assert.equal(harness.popups.length, 0);
});

test('right-clicking an image leaves its context menu to the image handler', () => {
  const harness = createHarness();
  harness.contents.emit('context-menu', {}, {
    isEditable: false, mediaType: 'image', selectionText: 'Selected response',
    editFlags: { canCopy: true, canSelectAll: true },
  });
  assert.equal(harness.templates.length, 0);
  assert.equal(harness.popups.length, 0);
});

test('unavailable actions are disabled and labels follow the current language', () => {
  const harness = createHarness();
  const params = {
    isEditable: true,
    editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: false },
  };
  harness.contents.emit('context-menu', {}, params);
  assert.deepEqual(harness.templates[0].map(item => item.enabled), [false, false, true, false]);
  harness.setLanguage('en');
  harness.contents.emit('context-menu', {}, params);
  assert.deepEqual(harness.templates[1].map(item => item.label), ['Cut', 'Copy', 'Paste', 'Select all']);
  params.editFlags.canPaste = false;
  harness.contents.emit('context-menu', {}, params);
  assert.equal(harness.templates[2][2].enabled, false);
});
