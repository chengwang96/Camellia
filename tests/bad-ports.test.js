'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetch } = require('undici');
const { BAD_PORTS } = require('./bad-ports.cjs');

test('ephemeral test ports exclude the additional ports blocked by fetch', async () => {
  for (const blockedPort of [4190, 6679]) {
    assert.ok(BAD_PORTS.has(blockedPort));
    await assert.rejects(fetch('http://127.0.0.1:' + blockedPort), error => error.cause?.message === 'bad port');
  }
});
