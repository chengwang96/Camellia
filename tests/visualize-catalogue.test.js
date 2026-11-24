'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVisualizeStore } = require('../src/engines/visualize-store');
const { removeTree } = require('./test-fs.cjs');
const { SharedConversations } = require('../src/engines/shared-conversations');

test('the compaction catalogue names existing cards so a duplicate is avoidable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-catalogue-'));
  try {
    const store = createVisualizeStore({ dir: path.join(root, 'visualize') });
    const first = store.create('conversation-1', { title: 'Wave basics', fragment: '<div>a</div>' });
    store.update('conversation-1', first.cardId, { oldStr: 'a', newStr: 'b' });
    store.create('conversation-1', { title: 'Element delay', fragment: '<div>c</div>' });
    const manager = Object.create(SharedConversations.prototype);
    manager.visualize = store;
    manager.log = () => {};
    const text = manager.visualizationCatalogue({ id: 'conversation-1' });
    assert.match(text, /Interactive cards in this conversation/);
    assert.match(text, new RegExp(first.cardId));
    assert.match(text, /· v2 ·/);
    assert.match(text, /Wave basics/);
    assert.match(text, /Element delay/);
    assert.match(text, /action:"update"/);
    assert.equal(manager.visualizationCatalogue({ id: 'conversation-2' }), '');
  } finally {
    removeTree(root);
  }
});

test('a conversation with no cards contributes no catalogue section', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-catalogue-empty-'));
  try {
    const manager = Object.create(SharedConversations.prototype);
    manager.visualize = createVisualizeStore({ dir: path.join(root, 'visualize') });
    manager.log = () => {};
    assert.equal(manager.visualizationCatalogue({ id: 'conversation-1' }), '');
  } finally {
    removeTree(root);
  }
});
