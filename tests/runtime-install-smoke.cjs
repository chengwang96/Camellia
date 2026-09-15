'use strict';
// Exercise the distributed Node/npm against the official Claude package, with
// an empty app-data install directory and no global Node/CLI on PATH.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createRuntimeManager } = require('../src/main/runtime-manager');
async function main() {
  const isMac = process.platform === 'darwin';
  const root = path.resolve(process.argv[2] || (isMac ? 'dist/mac-arm64/Camellia.app/Contents/Resources' : 'dist/win-unpacked/resources'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-install-test-'));
  const profile = path.join(tempRoot, 'App Data'), installRoot = path.join(tempRoot, 'Profile Link');
  fs.mkdirSync(profile);
  // Reproduce macOS /var-style aliases on both platforms, including npm 11's
  // lockfile validation when a parent of the install prefix is a symlink.
  fs.symlinkSync(profile, installRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const node = path.join(root, isMac ? 'runtime/node' : 'runtime/node.exe'), npm = path.join(root, 'runtime/npm/bin/npm-cli.js');
  const previous = process.env.PATH;
  process.env.PATH = isMac ? '/usr/bin:/bin:/usr/sbin:/sbin' : [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(path.delimiter);
  try {
    const manager = createRuntimeManager({ root, installRoot, node, npm });
    assert.equal(manager.locate('claude'), null);
    const installed = await manager.ensure('claude');
    assert.ok(installed.file.startsWith(installRoot));
    assert.equal(installed.version, '2.1.270');
    const version = require('node:child_process').spawnSync(installed.file, ['--version'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr); assert.match(version.stdout, /2\.1\.270/);
    assert.equal((await manager.ensure('claude')).file, installed.file);
    console.log('PASS: packaged Node/npm installs and reuses official Claude 2.1.270 through a linked app-data path with no global Node/npm/Claude on PATH');
  } finally {
    process.env.PATH = previous;
    assert.equal(path.dirname(tempRoot), os.tmpdir()); assert.ok(path.basename(tempRoot).startsWith('workbench-install-test-'));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
