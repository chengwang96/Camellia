'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const manifest = require('../package.json');
const { createRuntimeManager } = require('../src/main/runtime-manager');

const root = path.resolve(__dirname, '..');
const defaultBundle = process.platform === 'darwin' ? 'dist/mac-arm64/' + manifest.build.productName + '.app' : 'dist/win-unpacked';
const unpacked = path.resolve(process.argv[2] || path.join(root, defaultBundle));
const isMac = path.extname(unpacked) === '.app';
const resources = path.join(unpacked, isMac ? 'Contents/Resources' : 'resources');
const executable = path.join(unpacked, isMac ? 'Contents/MacOS/' + manifest.build.productName : manifest.build.productName + '.exe');
const archive = path.join(resources, 'app.asar');
const packagedManifest = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(packagedManifest.name, manifest.name);
assert.equal(packagedManifest.version, manifest.version);
assert.equal(packagedManifest.main, manifest.main);
assert.ok(fs.existsSync(executable), 'Product executable uses the current brand');
let count = 0;
for (const file of fs.globSync(manifest.build.files.filter(file => file !== 'package.json'), { cwd: root })
  .filter(file => fs.statSync(path.join(root, file)).isFile() && !/(^|[\\/])__pycache__([\\/]|$)|\.py[co]$/i.test(file))) {
  assert.ok(asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), 'Packaged source differs: ' + file);
  count++;
}
assert.ok(!asar.listPackage(archive).some(file => /^\\?tests[\\/]/.test(file)), 'Tests must not be packaged');
const runtimeNode = isMac ? 'runtime/node' : 'runtime/node.exe';
const runtimeInfo = JSON.parse(fs.readFileSync(path.join(resources, 'runtime/version.json')));
assert.equal(runtimeInfo.platform, isMac ? 'darwin' : 'win32');
assert.equal(runtimeInfo.arch, isMac ? 'arm64' : 'x64');
for (const engine of ['claude', 'codex', 'dsh', 'kimi']) {
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join('runtimes', engine, name);
    assert.ok(fs.readFileSync(path.join(resources, file)).equals(fs.readFileSync(path.join(root, file))), 'Installer manifest differs: ' + file);
  }
}
for (const file of [runtimeNode, 'runtime/npm/bin/npm-cli.js', 'runtime/NODE-LICENSE']) {
  assert.ok(fs.existsSync(path.join(resources, file)), 'Missing runtime asset: ' + file);
}
assert.ok(asar.listPackage(archive).some(file => file.includes('smol-toml')));

const sdkDir = path.join(resources, 'runtimes/antigravity');
for (const file of ['runtime.json', 'requirements.lock']) {
  assert.ok(fs.readFileSync(path.join(sdkDir, file)).equals(fs.readFileSync(path.join(root, 'runtimes/antigravity', file))), 'Antigravity manifest differs: ' + file);
}
assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked/src/engines/antigravity/bridge.py')), 'Python bridge must be outside the ASAR archive');
assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked/src/engines/antigravity/cli-bridge.cjs')), 'The Google CLI bridge must run under bundled Node outside ASAR');
assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked/src/benchmark/python/check.py')), 'The scientific checker must run outside ASAR');
assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked/src/benchmark/python/scicode_targets.py')), 'The SciCode target reader must run outside ASAR');
assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked/src/benchmark/python/scicode/compare/cmp.py')), 'Official SciCode comparisons must be importable outside ASAR');
assert.ok(!asar.listPackage(archive).some(file => /test_data\.h5|ds1000\.jsonl|problems_test\.jsonl/.test(file)), 'Official datasets are downloaded on demand');
for (const engine of ['claude', 'codex', 'dsh', 'kimi', 'antigravity']) {
  const files = fs.readdirSync(path.join(resources, 'runtimes', engine));
  assert.ok(files.every(file => ['package.json', 'package-lock.json', 'runtime.json', 'requirements.lock', 'README.md'].includes(file)), 'Only download manifests belong in the base package: ' + engine);
}
assert.ok(createRuntimeManager({ root: resources, installRoot: resources }).state().every(row => row.status === 'missing'), 'No harness runtime is bundled');
assert.equal(createRuntimeManager({ root: resources, installRoot: resources }).locate('antigravity', 'subscription'), null, 'The Google CLI is an optional download too');

if (isMac) {
  const header = fs.readFileSync(path.join(resources, runtimeNode));
  assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'Bundled Node is a Mach-O executable');
  assert.equal(header.readUInt32LE(4), 0x0100000c, 'Bundled Node targets Apple Silicon');
}
console.log('PASS: ' + count + ' source files match; five engine download manifests and shared Node/npm bundled; no harness runtimes included.');
