'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { locatePythonRuntime, detectSystemPython } = require('../src/main/python-runtime');

test('Antigravity session forks snapshot committed WAL data while the source closes', () => {
  const runtime = locatePythonRuntime(path.resolve(__dirname, '../runtimes/antigravity')) || detectSystemPython();
  assert.ok(runtime?.file, 'Python is required for the native session storage regression');
  const run = spawnSync(runtime.file, ['-I', '-X', 'utf8', path.join(__dirname, 'fixtures/antigravity-session-storage.py')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(run.status, 0, run.error?.message || run.stdout + run.stderr);
});
