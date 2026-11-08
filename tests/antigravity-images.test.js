'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { locatePythonRuntime, pythonEnvironment } = require('../src/main/python-runtime');

test('Antigravity advertises native images, preserves ordered bytes and rejects invalid media before chat', t => {
  const root = path.resolve(__dirname, '../runtimes/antigravity');
  const runtime = locatePythonRuntime(root);
  if (!runtime) return t.skip('Antigravity SDK runtime is not installed');
  const result = spawnSync(runtime.file, ['-X', 'utf8', path.join(__dirname, 'fixtures/antigravity-images.py')], {
    env: pythonEnvironment(root, process.env), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
