'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nodeCandidates, npmCandidates, globalPackageRoots, npmCacheRoot } = require('../src/main/runtime-paths');
const { ENGINES } = require('../src/main/runtime-manager');
const { assertBuildHost } = require('../scripts/prepare-package.cjs');

test('macOS finds bundled Node, PATH installs and Homebrew without Windows paths', () => {
  const paths = nodeCandidates({ platform: 'darwin', explicit: '/custom/node', resourcesPath: '/Applications/Camellia.app/Contents/Resources', env: { PATH: '/opt/node/bin:/usr/bin' } });
  assert.deepEqual(paths.slice(0, 4), ['/custom/node', '/Applications/Camellia.app/Contents/Resources/runtime/node', '/opt/node/bin/node', '/usr/bin/node']);
  assert.ok(paths.includes('/opt/homebrew/bin/node'));
  assert.ok(!paths.some(file => file.includes('.exe') || file.includes('Program Files')));
});

test('Windows keeps explicit and bundled executables ahead of PATH and system installs', () => {
  const paths = nodeCandidates({ platform: 'win32', explicit: 'D:\\Tools\\node.exe', resourcesPath: 'D:\\Camellia\\resources', env: { PATH: 'C:\\Node;C:\\Windows', ProgramFiles: 'C:\\Program Files' } });
  assert.deepEqual(paths.slice(0, 3), ['D:\\Tools\\node.exe', 'D:\\Camellia\\resources\\runtime\\node.exe', 'C:\\Node\\node.exe']);
  assert.ok(paths.includes('C:\\Program Files\\nodejs\\node.exe'));
});

test('npm discovery handles bundled npm, npm lifecycle paths and Unix prefix layout', () => {
  const paths = npmCandidates('/opt/homebrew/bin/node', { platform: 'darwin', resourcesPath: '/app/Contents/Resources', env: { npm_execpath: '/node/bin/npm-cli.js' } });
  assert.deepEqual(paths.slice(0, 2), ['/app/Contents/Resources/runtime/npm/bin/npm-cli.js', '/node/bin/npm-cli.js']);
  assert.ok(paths.includes('/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js'));
});

test('Unix global packages and npx cache follow native locations', () => {
  assert.ok(globalPackageRoots({ platform: 'darwin', node: '/opt/node/bin/node', env: {} }).includes('/opt/node/lib/node_modules'));
  assert.equal(npmCacheRoot({ platform: 'darwin', home: '/Users/test', env: {} }), '/Users/test/.npm');
  assert.equal(npmCacheRoot({ platform: 'darwin', home: '/Users/test', env: { npm_config_cache: '/custom/cache' } }), '/custom/cache');
});

test('Claude uses the upstream wrapper binary path even on Unix', () => {
  // The pinned install.cjs always writes a native binary named bin/claude.exe.
  assert.equal(ENGINES.claude.entry, 'bin/claude.exe');
});

test('packaging rejects a host whose native runtimes do not match the target', () => {
  assert.doesNotThrow(() => assertBuildHost('darwin', 'arm64', 'darwin', 'arm64'));
  assert.throws(() => assertBuildHost('darwin', 'arm64', 'win32', 'x64'), /matching host/);
  assert.throws(() => assertBuildHost('darwin', 'arm64', 'darwin', 'x64'), /matching host/);
});
