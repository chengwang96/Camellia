'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readNodeVersion(root = path.resolve(__dirname, '..')) {
  const file = path.join(root, '.node-version');
  const version = fs.readFileSync(file, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${file} must contain an exact Node.js version, such as 24.16.0`);
  }
  return 'v' + version;
}

function assertNodeVersion({ root, version = process.version } = {}) {
  const expected = readNodeVersion(root);
  if (version !== expected) throw new Error(`Packaging requires Node.js ${expected} from .node-version; the build host uses ${version}`);
  return expected;
}

module.exports = { readNodeVersion, assertNodeVersion };
