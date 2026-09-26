'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSharedNetwork } = require('../src/main/remote/shared-network');

test('mobile access and CLI devices receive one embedded network instance', () => {
  const created = [];
  const shared = createSharedNetwork({ options: { directory: '/state/tailnet' }, create: options => { created.push(options); return { options }; } });
  const mobile = shared.factory({ onFailure: () => {} });
  const cli = shared.factory({ onFailure: () => {} });
  assert.equal(created.length, 1);
  assert.equal(created[0].directory, '/state/tailnet');
  assert.equal(mobile, cli);
  assert.equal(shared.network, mobile);
  assert.equal(shared.listenerCount(), 2);
  assert.equal(shared.factory().listenerCount, undefined, 'a consumer without a handler still shares the node');
});

test('a helper failure reaches every consumer and a broken handler cannot hide it', () => {
  let options;
  const shared = createSharedNetwork({ options: {}, create: value => { options = value; return {}; } });
  const seen = [];
  shared.factory({ onFailure: () => seen.push('mobile') });
  shared.factory({ onFailure: () => { seen.push('cli'); throw new Error('window already closed'); } });
  options.onFailure();
  assert.deepEqual(seen.sort(), ['cli', 'mobile']);
  assert.equal(shared.network, shared.factory({ onFailure: () => {} }));
});

test('the desktop app wires both features to the shared node instead of two logins', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(main, /const sharedDesktopNetwork = require\('\.\/remote\/shared-network'\)\.createSharedNetwork/);
  assert.equal([...main.matchAll(/networkFactory: sharedDesktopNetwork\.factory/g)].length, 2);
  assert.doesNotMatch(main, /new EmbeddedNetwork\(/);
  const devices = fs.readFileSync(path.join(__dirname, '../src/main/remote/devices-desktop.js'), 'utf8');
  assert.doesNotMatch(devices, /client-tailnet/);
});
