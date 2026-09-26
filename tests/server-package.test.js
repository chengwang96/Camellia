'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { packageManifest } = require('../scripts/pack-server.cjs');
const { packServer } = require('../scripts/pack-server.cjs');

test('server package manifest excludes Electron and desktop install hooks', () => {
  const source = require('../package.json');
  const manifest = packageManifest(source);
  assert.equal(manifest.version, source.version);
  assert.deepEqual(manifest.dependencies, source.dependencies);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
  assert.equal(manifest.scripts.server, 'node scripts/camellia-server.cjs');
  assert.equal(manifest.build, undefined);
});

test('server packaging refuses foreign build hosts before writing files', { skip: process.platform === 'linux' }, () => {
  assert.throws(() => packServer(), /natively on Linux/);
});
