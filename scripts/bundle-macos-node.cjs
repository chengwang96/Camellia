'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bundleNode, verifyNode } = require('./bundle-node.cjs');

// Homebrew Node can require libnode and other libraries outside its binary.
// Use the official distribution instead of copying the build host's executable.
function bundleMacNode(options) {
  return bundleNode({ ...options, platform: 'darwin' });
}

function verifyMacNode({ node, arch, version, run = execFileSync, env = process.env }) {
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^DYLD_|^NODE_OPTIONS$|^NODE_PATH$/.test(key)));
  cleanEnv.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const options = { env: cleanEnv, cwd: path.dirname(node), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 };
  const dependencies = run('/usr/bin/otool', ['-L', node], options).split(/\r?\n/).slice(1)
    .map(line => line.trim().split(' (')[0]).filter(Boolean);
  const external = dependencies.filter(file => !file.startsWith('/usr/lib/') && !file.startsWith('/System/Library/'));
  if (external.length) throw new Error('Bundled Node.js depends on build-machine libraries: ' + external.join(', '));
  return verifyNode({ node, platform: 'darwin', arch, version, run, env: cleanEnv });
}

module.exports = { bundleMacNode, verifyMacNode };
