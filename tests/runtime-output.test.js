'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/main/runtime-manager');

test('installer errors retain the initial cause and final log path around long npm help output', async () => {
  await assert.rejects(run(process.execPath, ['-e', `
    process.stderr.write('npm error Missing: package from lock file\\n' +
      'npm help output\\n'.repeat(1000) + 'npm error Log: /tmp/npm-debug.log\\n', () => process.exit(1));
  `]), error => {
    assert.match(error.message, /Missing: package from lock file/);
    assert.match(error.message, /Log: \/tmp\/npm-debug.log/);
    assert.ok(error.message.length < 8200);
    return true;
  });
});
