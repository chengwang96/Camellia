'use strict';
const { removeTree } = require('./test-fs.cjs');
// Install selected engines from a lightweight distribution into empty app data,
// using its Node/npm and no global Node, Python, or harness installations.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createRuntimeManager, ENGINES, run } = require('../src/main/runtime-manager');
const { spawnSync } = require('node:child_process');
async function main() {
  const isMac = process.platform === 'darwin';
  const root = path.resolve(process.argv[2] || (isMac ? 'dist/mac-arm64/Camellia.app/Contents/Resources' : 'dist/win-unpacked/resources'));
  const engines = process.argv[3] === '--all' ? Object.keys(ENGINES) : process.argv.slice(3);
  if (!engines.length) engines.push('claude');
  // Hosted Windows runners put RUNNER_TEMP on the workspace drive. Keeping
  // this large fresh install there avoids the slower system-profile temp
  // tree, while retaining an empty app profile and the symlink regression.
  const tempBase = path.resolve(process.env.RUNNER_TEMP || os.tmpdir());
  const tempRoot = fs.mkdtempSync(path.join(tempBase, 'workbench-install-test-'));
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
    let timing;
    const manager = createRuntimeManager({ root, installRoot, node, npm, discoverLocal: false,
      runCommand: async (...args) => {
        const started = performance.now();
        try { return await run(...args); }
        finally { if (timing) timing.installerMs += Math.round(performance.now() - started); }
      }, onChange: rows => {
      for (const row of rows) if (row.status === 'installing' && progress.get(row.id) !== row.message) {
        progress.set(row.id, row.message); console.log(row.name + ': ' + row.message);
      }
    } });
    assert.ok(manager.state().every(row => row.status === 'missing'));
    const selected = new Set();
    const check = (exe, args, includeStderr = false) => {
      const result = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 120000,
        env: { ...process.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH } });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout + (includeStderr ? result.stderr : '');
    };
    for (const engine of engines) {
      timing = { engine, installerMs: 0 };
      console.log('Downloading selected engine: ' + engine);
      const started = performance.now();
      const installed = await manager.ensure(engine); selected.add(engine);
      timing.installMs = Math.round(performance.now() - started);
      assert.ok(installed.file.startsWith(installRoot));
      const reusing = performance.now();
      assert.equal((await manager.ensure(engine)).file, installed.file);
      timing.reuseMs = Math.round(performance.now() - reusing);
      assert.ok(manager.state().filter(row => !selected.has(row.id)).every(row => row.status === 'missing'), 'Unselected engines stay uninstalled');
      const verifying = performance.now();
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
        else {
          const version = ['claude', 'grok'].includes(engine) ? check(installed.file, ['--version'], true) : check(node, [installed.file, '--version'], true);
          assert.ok(version.includes(expected), `${engine}: expected ${expected}, received ${JSON.stringify(version)}`);
        }
        if (engine === 'dsh') {
          // Both supported releases receive the faster line scan. DSH 0.2
          // already caches lazy artifacts upstream and needs no extra cache.
          for (const [pkg, marker] of [['dsh-client-ui-settings-general', 'WorkbenchSettingsRoot'], ['dsh-client-modules', 'for (let index = value.indexOf(']]) {
            const file = pkg === 'dsh-client-modules' ? 'index.js' : 'client.js';
            assert.ok(fs.readFileSync(path.join(installed.dir, 'node_modules/@deepseek-ai', pkg, 'lib', file), 'utf8').includes(marker), 'DSH download receives the maintained frontend patches');
          }
        }
      }
      timing.verifyMs = Math.round(performance.now() - verifying);
      console.log('PASS: downloaded and reused ' + engine + ' with shared installer tools; unselected engines remain missing');
      console.log('TIMING runtime-install ' + JSON.stringify(timing));
    }
  } finally {
    process.env.PATH = previous;
    assert.equal(path.dirname(tempRoot), tempBase); assert.ok(path.basename(tempRoot).startsWith('workbench-install-test-'));
    const cleaning = performance.now();
    removeTree(tempRoot);
    console.log('TIMING runtime-cleanup ' + JSON.stringify({ ms: Math.round(performance.now() - cleaning) }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
