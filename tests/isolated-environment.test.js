'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { removeTree } = require('./test-fs.cjs');
const { isolatedEnvironment } = require('../src/engines/isolated-environment');
const { stopProcess } = require('./native-engine-harness.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-environment-test-'));
  t.after(() => removeTree(dir));
  return dir;
}

test('timeout cleanup releases inherited pipes after the native process exits', { timeout: 3000 }, async () => {
  const proc = Object.assign(new EventEmitter(), { pid: 1, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let closed = 0, terminated = false;
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) stream.once('close', () => {
    if (++closed === 3) proc.emit('close', proc.exitCode);
  });
  // No OS PID is touched. Exit arrived, but close waits for inherited pipes.
  await stopProcess(proc, async child => { terminated = true; child.exitCode = 1; child.emit('exit', 1); });
  assert.equal(terminated, true); assert.equal(closed, 3);
  await stopProcess(proc, () => { throw new Error('Never kill a PID after its process has exited'); });
});

test('isolated environment does not inherit API keys, personal settings, or Node injection', t => {
  const root = temp(t), env = isolatedEnvironment(root, process.execPath, { PATH: process.env.PATH, SOME_API_KEY: 'secret',
    NODE_OPTIONS: '--require bad', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CONFIG_DIR: '/personal', DSH_HOME: '/personal' });
  assert.equal(env.SOME_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined); assert.equal(env.DSH_HOME, undefined); assert.equal(env.HOME, root);
});
