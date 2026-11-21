'use strict';

const { runtimeDirectory } = require('./verify-tailnet-isolation.cjs');

if (process.argv.length !== 4) {
  console.error('Usage: node scripts/tailnet-runtime-path.cjs <bundle> <windows|macos>');
  process.exitCode = 1;
} else {
  const [, , bundle, platform] = process.argv;
  process.stdout.write(runtimeDirectory(bundle, platform));
}
