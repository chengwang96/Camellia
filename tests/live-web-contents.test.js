'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { liveWebContents } = require('../src/main/live-web-contents');

test('live contents lookup never reads a destroyed BrowserWindow getter', () => {
  const window = { isDestroyed: () => true, get webContents() { assert.fail('Destroyed window getter read'); } };
  assert.equal(liveWebContents(window), null);
  assert.equal(liveWebContents(null), null);
});

test('view contents lookup skips destroyed native views and contents without masking other errors', () => {
  assert.equal(liveWebContents({ get webContents() { throw new TypeError('Object has been destroyed'); } }), null);
  assert.equal(liveWebContents({ webContents: { isDestroyed: () => true } }), null);
  const contents = { isDestroyed: () => false };
  assert.equal(liveWebContents({ webContents: contents }), contents);
  assert.throws(() => liveWebContents({ get webContents() { throw new Error('Unexpected failure'); } }), /Unexpected failure/);
});
