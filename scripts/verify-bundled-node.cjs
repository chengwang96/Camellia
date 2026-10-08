'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

function verifyBundledNode(directory, { platform, arch, node: version }) {
  directory = path.resolve(directory);
  const node = path.join(directory, platform === 'win32' ? 'node.exe' : 'node');
  if (platform === 'darwin') {
    const libraries = execFileSync('/usr/bin/otool', ['-L', node], { encoding: 'utf8' })
      .trim().split('\n').slice(1).map(line => line.trim().split(' (')[0]);
    for (const library of libraries) {
      assert.ok(library.startsWith('/usr/lib/') || library.startsWith('/System/Library/'),
        'Bundled Node depends on a non-system library: ' + library);
    }
  }
  const env = { ...process.env, PATH: platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    : '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of Object.keys(env)) if (/^(NODE_|DYLD_)/i.test(key)) delete env[key];
  const options = { env, cwd: directory, encoding: 'utf8', timeout: 30000, windowsHide: true };
  const actual = JSON.parse(execFileSync(node, ['-p',
    'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch})'], options));
  assert.deepEqual(actual, { node: version, platform, arch }, 'Bundled Node runs with the expected version and architecture');
  const npm = path.join(directory, 'npm');
  const npmVersion = execFileSync(node, [path.join(npm, 'bin/npm-cli.js'), '--version'], options).trim();
  assert.equal(npmVersion, JSON.parse(fs.readFileSync(path.join(npm, 'package.json'), 'utf8')).version,
    'Bundled npm runs without a global Node installation');
  return { ...actual, npm: npmVersion };
}

module.exports = { verifyBundledNode };
