'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const manifest = require('../package.json');

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
for (const file of fs.globSync(manifest.build.files.filter(file => file !== 'package.json'), { cwd: root }).filter(file => fs.statSync(path.join(root, file)).isFile())) {
  assert.ok(asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), 'Packaged source differs: ' + file);
  count++;
}
const runtime = 'runtimes/kimi/node_modules/@moonshot-ai/kimi-code';
for (const file of ['package.json', 'LICENSE', 'dist/main.mjs', 'dist/search-worker.mjs']) {
  const packaged = path.join(resources, runtime, file);
  assert.ok(fs.existsSync(packaged), 'Missing packaged runtime: ' + file);
  assert.ok(fs.readFileSync(packaged).equals(fs.readFileSync(path.join(root, runtime, file))), 'Runtime differs: ' + file);
}
assert.equal(require(path.join(resources, runtime, 'package.json')).version, '0.43.0');
for (const dependency of ['ws', 'qrcode']) assert.ok(fs.existsSync(path.join(resources, 'runtimes/kimi/node_modules', dependency, 'package.json')));
assert.ok(!asar.listPackage(archive).some(file => /^\\?tests[\\/]/.test(file)), 'Tests must not be packaged');
const runtimeNode = isMac ? 'runtime/node' : 'runtime/node.exe';
const runtimeInfo = JSON.parse(fs.readFileSync(path.join(resources, 'runtime/version.json')));
assert.equal(runtimeInfo.platform, isMac ? 'darwin' : 'win32');
assert.equal(runtimeInfo.arch, isMac ? 'arm64' : 'x64');
for (const engine of ['dsh', 'kimi', 'claude']) {
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join('runtimes', engine, name);
    assert.ok(fs.readFileSync(path.join(resources, file)).equals(fs.readFileSync(path.join(root, file))), 'Installer manifest differs: ' + file);
  }
}
for (const file of ['runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', 'runtimes/dsh/node_modules/pnpm/bin/pnpm.cjs',
  'runtimes/claude/package.json', 'runtimes/claude/package-lock.json', runtimeNode, 'runtime/npm/bin/npm-cli.js', 'runtime/NODE-LICENSE']) {
  assert.ok(fs.existsSync(path.join(resources, file)), 'Missing runtime asset: ' + file);
}
assert.ok(fs.readFileSync(path.join(resources, 'runtimes/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'), 'utf8').includes('WorkbenchSettingsRoot'));
assert.ok(fs.readFileSync(path.join(resources, 'runtimes/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'), 'utf8').includes('workbenchComboCache'));
assert.ok(!fs.existsSync(path.join(resources, 'runtimes/claude/node_modules')), 'Claude is installed from the official package on first use');
assert.ok(asar.listPackage(archive).some(file => file.includes('smol-toml')));

if (isMac) {
  const header = fs.readFileSync(path.join(resources, runtimeNode));
  assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'Bundled Node is a Mach-O executable');
  assert.equal(header.readUInt32LE(4), 0x0100000c, 'Bundled Node targets Apple Silicon');
  assert.ok(fs.existsSync(path.join(resources, 'runtimes/kimi/node_modules/@moonshot-ai/kimi-code/native/darwin')));
}
console.log('PASS: ' + count + ' source files match; DSH settings fork, DSH/Kimi dependencies, pnpm, Node/npm and licenses bundled; official Claude installer manifests present.');
