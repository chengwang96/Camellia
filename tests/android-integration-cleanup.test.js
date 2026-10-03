'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');

for (const name of ['pairing', 'gateway', 'discussions']) {
  test(`Android ${name} integration closes its host server when ADB cleanup fails`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-adb-cleanup-'));
    t.after(() => removeTree(root));
    const preload = path.join(root, 'offline-adb.cjs');
    // Reach the real gateway's startup, then lose the emulator during install.
    // No emulator or model is needed; host shutdown and process exit are real.
    fs.writeFileSync(preload, `
      const childProcess = require('node:child_process');
      const original = childProcess.spawnSync;
      childProcess.spawnSync = (file, args, options) => {
        if (file !== 'fixture-adb') return original(file, args, options);
        if (args.includes('install')) return { status: 1, stdout: '', stderr: 'ORIGINAL_INSTALL_FAILURE' };
        if (args.includes('-D') || args.includes('--remove')) return { status: 1, stdout: '', stderr: 'OFFLINE_CLEANUP' };
        return { status: 0, stdout: args.includes('id') ? 'uid=0(root)' : '', stderr: '' };
      };
    `);
    const result = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, `android-${name}-smoke.cjs`)], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...process.env, ADB: 'fixture-adb', ANDROID_SERIAL: 'emulator-5584' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /ADB cleanup failed:.*OFFLINE_CLEANUP/);
    assert.match(result.stderr, /ORIGINAL_INSTALL_FAILURE/);
  });
}
