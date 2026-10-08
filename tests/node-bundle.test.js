'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readNodeVersion, assertNodeVersion } = require('../scripts/node-version.cjs');
const { bundleNode, verifyNode } = require('../scripts/bundle-node.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-node-pin-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  fs.writeFileSync(path.join(root, '.node-version'), '22.19.0\n');
  const target = path.join(root, 'App With Spaces', 'runtime');
  const cacheDir = path.join(root, 'cache');
  const calls = [];
  const payload = name => Buffer.from('official archive: ' + name);
  const checksum = name => createHash('sha256').update(payload(name)).digest('hex');
  const fetchImpl = async url => {
    calls.push(url);
    const version = url.split('/').at(-2);
    const file = url.split('/').at(-1);
    const archives = ['win-x64.zip', 'win-arm64.zip', 'darwin-x64.tar.gz', 'darwin-arm64.tar.gz'].map(suffix => `node-${version}-${suffix}`);
    return new Response(file === 'SHASUMS256.txt' ? archives.map(name => `${checksum(name)}  ${name}`).join('\n') : payload(file));
  };
  const run = (command, args) => {
    assert.equal(command, 'tar');
    const archiveName = path.basename(args[1]);
    assert.deepEqual(fs.readFileSync(args[1]), payload(archiveName));
    const windows = archiveName.endsWith('.zip');
    const source = path.join(args[3], archiveName.replace(/\.zip$|\.tar\.gz$/, ''));
    const node = path.join(source, windows ? 'node.exe' : 'bin/node');
    const npm = path.join(source, windows ? 'node_modules/npm' : 'lib/node_modules/npm');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.mkdirSync(path.join(npm, 'bin'), { recursive: true });
    fs.writeFileSync(node, archiveName);
    fs.writeFileSync(path.join(npm, 'bin/npm-cli.js'), 'official npm');
    fs.writeFileSync(path.join(npm, 'package.json'), JSON.stringify({ version: '10.9.3' }));
    fs.writeFileSync(path.join(source, 'LICENSE'), 'official Node license');
  };
  return { root, target, cacheDir, fetchImpl, run, calls };
}

test('the version pin requires an exact release and never falls back to the build host', t => {
  const { root } = fixture(t);
  assert.equal(readNodeVersion(root), 'v22.19.0');
  assert.throws(() => assertNodeVersion({ root, version: 'v26.3.1' }), /requires Node.js v22\.19\.0/);
  assert.equal(assertNodeVersion({ root, version: 'v22.19.0' }), 'v22.19.0');
  for (const value of ['24', '24.x', '^24.0.0', 'latest', '']) {
    fs.writeFileSync(path.join(root, '.node-version'), value);
    assert.throws(() => readNodeVersion(root), /exact Node.js version/);
  }
  fs.unlinkSync(path.join(root, '.node-version'));
  assert.throws(() => readNodeVersion(root), /ENOENT/);
});

test('Windows downloads the project pin with its own npm and license instead of the build host', async t => {
  const options = fixture(t);
  fs.mkdirSync(path.join(options.target, 'npm'), { recursive: true });
  fs.writeFileSync(path.join(options.target, 'npm/stale-module'), 'old host npm');
  const info = await bundleNode({ ...options, platform: 'win32', arch: 'x64' });
  assert.equal(info.node, 'v22.19.0');
  assert.equal(info.platform, 'win32');
  assert.equal(info.source, 'nodejs.org');
  assert.match(options.calls[1], /v22\.19\.0\/node-v22\.19\.0-win-x64\.zip$/);
  assert.equal(fs.readFileSync(path.join(options.target, 'node.exe'), 'utf8'), 'node-v22.19.0-win-x64.zip');
  assert.equal(fs.existsSync(path.join(options.target, 'npm/stale-module')), false);
  assert.equal(fs.readFileSync(path.join(options.target, 'NODE-LICENSE'), 'utf8'), 'official Node license');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.target, 'version.json'), 'utf8')), info);
  assert.ok(!fs.readdirSync(options.target).some(file => /\.zip$|\.sha256$/.test(file)));
});

test('a verified archive cache allows repeated builds without network access', async t => {
  const options = fixture(t);
  const first = await bundleNode({ ...options, platform: 'darwin', arch: 'arm64' });
  const second = await bundleNode({ ...options, platform: 'darwin', arch: 'arm64',
    fetchImpl: () => assert.fail('A valid cached archive must not be downloaded again') });
  assert.deepEqual(second, first);
  assert.equal(options.calls.length, 2);
});

test('a corrupt cache is downloaded again and an offline failure preserves existing runtime assets', async t => {
  const options = fixture(t);
  await bundleNode({ ...options, platform: 'win32', arch: 'x64' });
  fs.writeFileSync(path.join(options.cacheDir, 'node-v22.19.0-win-x64.zip'), 'corrupt cache');
  fs.writeFileSync(path.join(options.target, 'node.exe'), 'previous working runtime');
  await assert.rejects(bundleNode({ ...options, platform: 'win32', arch: 'x64',
    fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(fs.readFileSync(path.join(options.target, 'node.exe'), 'utf8'), 'previous working runtime');
  options.calls.length = 0;
  await bundleNode({ ...options, platform: 'win32', arch: 'x64' });
  assert.equal(options.calls.length, 2);
  assert.equal(fs.readFileSync(path.join(options.target, 'node.exe'), 'utf8'), 'node-v22.19.0-win-x64.zip');
});

test('archive caches are separate for every version, operating system and architecture', async t => {
  const options = fixture(t);
  for (const selection of [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'win32', arch: 'x64' },
    { platform: 'win32', arch: 'x64', version: 'v24.16.0' },
  ]) await bundleNode({ ...options, ...selection });
  assert.equal(options.calls.length, 8);
  assert.equal(fs.readdirSync(options.cacheDir).filter(file => !file.endsWith('.sha256')).length, 4);
});

test('Windows validates the real Node, SQLite and npm versions without host Node overrides', t => {
  const { target } = fixture(t);
  fs.mkdirSync(path.join(target, 'npm'), { recursive: true });
  fs.writeFileSync(path.join(target, 'npm/package.json'), JSON.stringify({ version: '10.9.3' }));
  const calls = [];
  const node = path.join(target, 'node.exe');
  const run = (command, args, options) => {
    assert.equal(command, node);
    assert.equal(options.env.PATH, 'C:\\Windows\\System32;C:\\Windows');
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.NODE_PATH, undefined);
    calls.push(args);
    return args[0] === '-p' ? JSON.stringify({ node: 'v22.19.0', platform: 'win32', arch: 'x64', sqlite: 'function' }) : '10.9.3\n';
  };
  const options = { node, platform: 'win32', arch: 'x64', version: 'v22.19.0', run,
    env: { PATH: 'C:\\Host Node', SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--require host.js', NODE_PATH: 'C:\\Host Modules' } };
  assert.equal(verifyNode(options).node, 'v22.19.0');
  assert.equal(calls.length, 2);
  assert.throws(() => verifyNode({ ...options, version: 'v24.16.0' }), /platform\/version\/SQLite check/);
  assert.throws(() => verifyNode({ ...options, run: (command, args) => args[0] === '-p'
    ? JSON.stringify({ node: 'v22.19.0', platform: 'win32', arch: 'x64', sqlite: 'function' }) : 'different npm' }), /npm failed/);
});
