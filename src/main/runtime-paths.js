'use strict';
const path = require('node:path');
const os = require('node:os');

function nodeCandidates({ explicit, resourcesPath, platform = process.platform, env = process.env } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'node.exe' : 'node';
  const paths = [];
  if (explicit) paths.push(explicit);
  if (resourcesPath) paths.push(p.join(resourcesPath, 'runtime', name));
  paths.push(...(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(dir => p.join(dir, name)));
  if (platform === 'win32') {
    paths.push(p.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', name),
      p.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', name));
  } else {
    paths.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  }
  return [...new Set(paths)];
}

function npmCandidates(node, { resourcesPath, platform = process.platform, env = process.env } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const paths = [];
  if (resourcesPath) paths.push(p.join(resourcesPath, 'runtime/npm/bin/npm-cli.js'));
  if (env.npm_execpath) paths.push(env.npm_execpath);
  if (node) {
    const dir = p.dirname(node);
    paths.push(p.join(dir, 'node_modules/npm/bin/npm-cli.js'), p.resolve(dir, '../lib/node_modules/npm/bin/npm-cli.js'));
  }
  return [...new Set(paths)];
}

function globalPackageRoots({ node, platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return env.APPDATA ? [path.win32.join(env.APPDATA, 'npm/node_modules')] : [];
  return [...new Set([...(node ? [path.posix.resolve(path.posix.dirname(node), '../lib/node_modules')] : []),
    '/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules'])];
}

function npmCacheRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.npm_config_cache || env.NPM_CONFIG_CACHE) return env.npm_config_cache || env.NPM_CONFIG_CACHE;
  return platform === 'win32'
    ? path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData/Local'), 'npm-cache')
    : path.posix.join(home, '.npm');
}

module.exports = { nodeCandidates, npmCandidates, globalPackageRoots, npmCacheRoot };
