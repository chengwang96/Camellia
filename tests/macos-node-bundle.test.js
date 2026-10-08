'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { bundleMacNode, verifyMacNode } = require('../scripts/bundle-macos-node.cjs');

const version = 'v24.16.0', arch = 'arm64';
const archiveName = `node-${version}-darwin-${arch}.tar.gz`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-mac-node-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const target = path.join(root, 'App With Spaces', 'runtime');
  fs.mkdirSync(path.join(target, 'npm/bin'), { recursive: true });
  fs.writeFileSync(path.join(target, 'node'), 'old Homebrew-linked node');
  fs.writeFileSync(path.join(target, 'npm/stale-module'), 'old npm content');
  fs.writeFileSync(path.join(target, 'npm/package.json'), JSON.stringify({ version: '11.13.0' }));
  return { root, target };
}

test('macOS bundling downloads verified official Node and replaces the host npm tree', async t => {
  const { target } = fixture(t);
  const payload = Buffer.from('official archive fixture');
  const checksum = createHash('sha256').update(payload).digest('hex');
  const urls = [];
  const info = await bundleMacNode({ target, arch, version, cacheDir: null,
    fetchImpl: async url => {
      urls.push(url);
      return new Response(url.endsWith('SHASUMS256.txt') ? `${checksum}  ${archiveName}\n` : payload);
    },
    run: (command, args) => {
      assert.equal(command, 'tar');
      assert.deepEqual(fs.readFileSync(args[1]), payload);
      const source = path.join(args[3], archiveName.replace(/\.tar\.gz$/, ''));
      fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(source, 'lib/node_modules/npm/bin'), { recursive: true });
      fs.writeFileSync(path.join(source, 'bin/node'), 'official standalone Node');
      fs.writeFileSync(path.join(source, 'lib/node_modules/npm/bin/npm-cli.js'), 'official npm entry');
      fs.writeFileSync(path.join(source, 'lib/node_modules/npm/package.json'), JSON.stringify({ version: '11.13.0' }));
      fs.writeFileSync(path.join(source, 'LICENSE'), 'official Node license');
    },
  });
  assert.deepEqual(urls, [`https://nodejs.org/download/release/${version}/SHASUMS256.txt`, `https://nodejs.org/download/release/${version}/${archiveName}`]);
  assert.equal(fs.readFileSync(path.join(target, 'node'), 'utf8'), 'official standalone Node');
  assert.equal(fs.existsSync(path.join(target, 'npm/stale-module')), false);
  assert.equal(fs.readFileSync(path.join(target, 'NODE-LICENSE'), 'utf8'), 'official Node license');
  assert.deepEqual(info, { node: version, platform: 'darwin', arch, source: 'nodejs.org', sha256: checksum });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'version.json'), 'utf8')), info);
});

test('a corrupt official download is rejected before extracting or changing existing assets', async t => {
  const { target } = fixture(t);
  await assert.rejects(bundleMacNode({ target, arch, version, cacheDir: null,
    fetchImpl: async url => new Response(url.endsWith('SHASUMS256.txt') ? `${'0'.repeat(64)}  ${archiveName}\n` : 'corrupted archive'),
    run: () => assert.fail('An unverified archive must not be extracted'),
  }), /checksum mismatch/);
  assert.equal(fs.readFileSync(path.join(target, 'node'), 'utf8'), 'old Homebrew-linked node');
  assert.equal(fs.existsSync(path.join(target, 'npm/stale-module')), true);
});

test('a missing checksum or unavailable official release fails before replacing assets', async t => {
  const { target } = fixture(t);
  await assert.rejects(bundleMacNode({ target, arch, version, cacheDir: null, fetchImpl: async () => new Response('no matching archive') }), /Missing official Node.js checksum/);
  await assert.rejects(bundleMacNode({ target, arch, version, cacheDir: null, fetchImpl: async () => new Response('', { status: 404 }) }), /HTTP 404/);
  assert.equal(fs.readFileSync(path.join(target, 'node'), 'utf8'), 'old Homebrew-linked node');
});

test('package verification rejects missing libnode and Homebrew dependencies before launching Node', t => {
  const { target } = fixture(t);
  for (const dependency of ['@rpath/libnode.147.dylib', '/opt/homebrew/opt/openssl/lib/libcrypto.dylib']) {
    assert.throws(() => verifyMacNode({ node: path.join(target, 'node'), arch, version,
      run: command => {
        assert.equal(command, '/usr/bin/otool');
        return `${target}/node:\n\t${dependency} (compatibility version 0.0.0, current version 0.0.0)\n`;
      },
    }), /build-machine libraries/);
  }
});

test('package verification runs bundled Node, SQLite and npm without host loader or Node overrides', t => {
  const { target } = fixture(t);
  const node = path.join(target, 'node');
  const calls = [];
  verifyMacNode({ node, arch, version,
    env: { PATH: '/opt/homebrew/bin', DYLD_LIBRARY_PATH: '/opt/homebrew/lib', DYLD_FALLBACK_LIBRARY_PATH: '/host/libs', NODE_OPTIONS: '--require host-only.js', NODE_PATH: '/host/modules', LANG: 'en_US.UTF-8' },
    run: (command, args, options) => {
      assert.deepEqual(options.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' });
      assert.equal(options.cwd, target);
      calls.push([command, args]);
      if (command === '/usr/bin/otool') return `${node}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`;
      assert.equal(command, node);
      if (args[0] === '-p') return JSON.stringify({ node: version, platform: 'darwin', arch, sqlite: 'function' });
      return '11.13.0\n';
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], [node, [path.join(target, 'npm/bin/npm-cli.js'), '--version']]);
});

test('package verification rejects a wrong native architecture and broken npm', t => {
  const { target } = fixture(t);
  const run = wrongArch => (command, args) => command === '/usr/bin/otool' ? 'node:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n'
    : args[0] === '-p' ? JSON.stringify({ node: version, platform: 'darwin', arch: wrongArch ? 'x64' : arch, sqlite: 'function' }) : 'different npm version';
  assert.throws(() => verifyMacNode({ node: path.join(target, 'node'), arch, version, run: run(true) }), /platform\/version\/SQLite check/);
  assert.throws(() => verifyMacNode({ node: path.join(target, 'node'), arch, version, run: run(false) }), /npm failed/);
});
