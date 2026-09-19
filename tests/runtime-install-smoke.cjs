'use strict';
const { removeTree } = require('./test-fs.cjs');
// Install selected engines from a lightweight distribution into empty app data,
// using its Node/npm and no global Node, Python, or harness installations.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createRuntimeManager, ENGINES } = require('../src/main/runtime-manager');
const { spawnSync } = require('node:child_process');
async function main() {
  const isMac = process.platform === 'darwin';
  const root = path.resolve(process.argv[2] || (isMac ? 'dist/mac-arm64/Camellia.app/Contents/Resources' : 'dist/win-unpacked/resources'));
  const engines = process.argv[3] === '--all' ? Object.keys(ENGINES) : process.argv.slice(3);
  if (!engines.length) engines.push('claude');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-install-test-'));
  const profile = path.join(tempRoot, 'App Data'), installRoot = path.join(tempRoot, 'Profile Link');
  fs.mkdirSync(profile);
  // Reproduce macOS /var-style aliases on both platforms, including npm 11's
  // lockfile validation when a parent of the install prefix is a symlink.
  fs.symlinkSync(profile, installRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const node = path.join(root, isMac ? 'runtime/node' : 'runtime/node.exe'), npm = path.join(root, 'runtime/npm/bin/npm-cli.js');
  const previous = process.env.PATH;
  process.env.PATH = isMac ? '/usr/bin:/bin:/usr/sbin:/sbin' : [path.join(process.env.SystemRoot, 'System32'),
    path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0'), process.env.SystemRoot].join(path.delimiter);
  try {
    const progress = new Map();
    const manager = createRuntimeManager({ root, installRoot, node, npm, onChange: rows => {
      for (const row of rows) if (row.status === 'installing' && progress.get(row.id) !== row.message) {
        progress.set(row.id, row.message); console.log(row.name + ': ' + row.message);
      }
    } });
    assert.ok(manager.state().every(row => row.status === 'missing'));
    const selected = new Set();
    const check = (exe, args) => {
      const result = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 120000,
        env: { ...process.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH } });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout;
    };
    for (const engine of engines) {
      console.log('Downloading selected engine: ' + engine);
      const installed = await manager.ensure(engine); selected.add(engine);
      assert.ok(installed.file.startsWith(installRoot));
      assert.equal((await manager.ensure(engine)).file, installed.file);
      assert.ok(manager.state().filter(row => !selected.has(row.id)).every(row => row.status === 'missing'), 'Unselected engines stay uninstalled');
      if (engine === 'antigravity') {
        assert.match(check(node, [path.join(__dirname, 'antigravity-smoke.cjs'), installed.dir]), /PASS:/);
        const google = await manager.ensure('antigravity', 'subscription');
        assert.ok(google.file.startsWith(installRoot));
        assert.equal((await manager.ensure('antigravity', 'subscription')).file, google.file);
        assert.match(check(node, [path.join(__dirname, 'antigravity-subscription-smoke.cjs'), google.dir,
          path.join(root, 'app.asar.unpacked/src/engines/antigravity/cli-bridge.cjs')]), /PASS:/);
      } else {
        const expected = JSON.parse(fs.readFileSync(path.join(root, 'runtimes', engine, 'package.json'))).dependencies[ENGINES[engine].package];
        assert.equal(installed.version, expected);
        if (engine === 'kimi') assert.match(check(node, [path.join(__dirname, 'kimi-cli-smoke.cjs'), installed.file]), /PASS:/);
        else if (engine === 'codex') assert.match(check(node, [path.join(__dirname, 'codex-smoke.cjs'), installed.file]), /PASS:/);
        else assert.ok((engine === 'claude' ? check(installed.file, ['--version']) : check(node, [installed.file, '--version'])).includes(expected));
        if (engine === 'dsh') {
          for (const [pkg, marker] of [['dsh-client-ui-settings-general', 'WorkbenchSettingsRoot'], ['dsh-client-modules', 'workbenchComboCache']]) {
            const file = pkg === 'dsh-client-modules' ? 'index.js' : 'client.js';
            assert.ok(fs.readFileSync(path.join(installed.dir, 'node_modules/@deepseek-ai', pkg, 'lib', file), 'utf8').includes(marker), 'DSH download receives the maintained frontend patches');
          }
        }
      }
      console.log('PASS: downloaded and reused ' + engine + ' with shared installer tools; unselected engines remain missing');
    }
  } finally {
    process.env.PATH = previous;
    assert.equal(path.dirname(tempRoot), os.tmpdir()); assert.ok(path.basename(tempRoot).startsWith('workbench-install-test-'));
    removeTree(tempRoot);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
