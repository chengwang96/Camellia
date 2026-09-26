'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceUnit, unitArgument } = require('../src/cli/service-unit');
const { options } = require('../scripts/camellia-server.cjs');

const settings = { node: '/opt/node/bin/node', script: '/opt/camellia/scripts/camellia-server.cjs', dataDir: '/home/user/.local/share/camellia-server' };

test('systemd unit runs unprivileged foreground service with private files and process-group cleanup', () => {
  const unit = serviceUnit(settings);
  assert.match(unit, /Type=exec/);
  assert.match(unit, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/camellia\/scripts\/camellia-server.cjs" "serve"/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /Restart=no/);
  assert.match(unit, /WantedBy=default.target/);
  assert.doesNotMatch(unit, /User=root|sudo|--restore-network|ExecStartPre|ExecStopPost/);
});

test('service paths escape systemd expansion and never invoke a shell', () => {
  const unit = serviceUnit({ ...settings, dataDir: '/home/user/space " $HOME %n \\ data', executable: '/opt/bin/tailnet', keyFile: '/private/key', restoreNetwork: true });
  assert.ok(unit.includes('\\" $$HOME %%n \\\\ data'));
  assert.match(unit, /"--key-file" "\/private\/key"/);
  assert.match(unit, /"--restore-network"/);
  assert.doesNotMatch(unit, /\/bin\/sh|\/bin\/bash/);
  assert.equal(unitArgument('hello%world$'), '"hello%%world$$"');
  assert.equal(unitArgument('${HOME}'), '"$${HOME}"');
});

test('service generation rejects injection, relative paths and invalid hostnames', () => {
  for (const dataDir of ['relative', 'C:\\data', '//ambiguous', '/path\nExecStart=evil', '/path\0bad']) {
    assert.throws(() => serviceUnit({ ...settings, dataDir }));
  }
  assert.throws(() => serviceUnit({ ...settings, hostname: 'bad\nname' }));
  assert.throws(() => serviceUnit({ ...settings, keyFile: 'relative' }));
  assert.throws(() => options(['menu', '--restore-network']), /only valid/);
  assert.equal(options(['serve', '--restore-network']).restoreNetwork, true);
  assert.equal(options(['service-unit', '--restore-network']).restoreNetwork, true);
});
