'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { globalPackageRoots, npmCacheRoot } = require('./runtime-paths');
const { isAntigravityCliHelp } = require('./antigravity-cli-runtime');

function probeNative(file, args, options) {
  const result = spawnSync(file, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CLI probe exited (${result.status})`);
  // The official Go CLI writes --help to stderr, including on success.
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function antigravityDirectories({ platform, env, home }) {
  if (platform !== 'win32') return [];
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  // A running desktop process can retain PATH from before the CLI installer
  // ran. Check the official installer and WinGet links without a shell.
  return [path.join(local, 'agy', 'bin'), path.join(local, 'Microsoft', 'WinGet', 'Links'),
    path.join(local, 'Packages', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'LocalState', 'links'),
    path.join(local, 'Packages', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'LocalState', 'WinGet', 'Links'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'antigravity-cli'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'WinGet', 'Links')];
}

function createLocalRuntimeDiscovery({ engines, node, platform = process.platform, arch = process.arch, env = process.env, home = os.homedir(), probe = probeNative }) {
  const versions = new Map();
  const directories = () => [...new Set([
    ...(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').map(dir => dir.replace(/^"|"$/g, '')).filter(dir => path.isAbsolute(dir)),
    path.join(home, '.local', 'bin'),
    ...(platform === 'win32' ? [env.APPDATA && path.join(env.APPDATA, 'npm'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'claude-code')].filter(Boolean)
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ])];
  function packageRoots() {
    const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
    const roots = [
      ...(prefix ? [path.join(prefix, platform === 'win32' ? 'node_modules' : 'lib/node_modules')] : []),
      ...globalPackageRoots({ node: typeof node === 'function' ? node() : node, platform, env }),
      ...directories().flatMap(dir => [path.join(dir, 'node_modules'), path.resolve(dir, '../lib/node_modules')]),
    ];
    try {
      const cache = path.join(npmCacheRoot({ platform, env, home }), '_npx');
      const entries = fs.readdirSync(cache, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => path.join(cache, entry.name));
      entries.sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);
      roots.push(...entries.map(dir => path.join(dir, 'node_modules')));
    } catch {}
    return [...new Set(roots)];
  }
  function usable(file, native = false) {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, native && platform !== 'win32' ? fs.constants.X_OK : fs.constants.R_OK);
      return true;
    } catch { return false; }
  }
  function npmRuntime(engine, modules) {
    const definition = engines[engine];
    if (!definition?.package) return null;
    const packageDir = path.join(modules, definition.package);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      if (manifest.name !== definition.package || !/^\d+\.\d+\.\d+/.test(manifest.version || '')) return null;
      let files;
      if (engine === 'codex') {
        const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
        const suffix = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-musl' }[platform];
        if (!cpu || !suffix) return null;
        const binary = path.join('vendor', `${cpu}-${suffix}`, 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
        files = [path.join(modules, '@openai', `codex-${platform}-${arch}`, binary),
          path.join(packageDir, 'node_modules', '@openai', `codex-${platform}-${arch}`, binary), path.join(packageDir, binary)];
      } else files = [path.join(packageDir, definition.entry)];
      const file = files.find(candidate => usable(candidate, ['claude', 'codex'].includes(engine)));
      return file ? { file, dir: path.dirname(modules), version: manifest.version } : null;
    } catch { return null; }
  }
  function nativeRuntime(engine, directoriesToScan) {
    const command = engine === 'antigravity' ? 'agy' : engine;
    for (const dir of directoriesToScan) {
      const file = path.join(dir, command + (platform === 'win32' ? '.exe' : ''));
      if (!usable(file, true)) continue;
      try {
        const real = fs.realpathSync(file);
        const header = Buffer.alloc(4);
        const descriptor = fs.openSync(real, 'r');
        try { fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
        const magic = header.toString('hex');
        if (!(magic.startsWith('4d5a') || ['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(magic))) continue;
        const stat = fs.statSync(real);
        const key = `${engine}:${real}:${stat.mtimeMs}:${stat.size}`;
        if (!versions.has(key)) {
          let version = null;
          try {
            const options = { env: engine === 'antigravity' ? { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : env,
              timeout: 3000, maxBuffer: 16384, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
            const output = String(probe(real, ['--version'], options));
            version = output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] || null;
            if (version && engine === 'antigravity'
              && !isAntigravityCliHelp(String(probe(real, ['--help'], options)))) version = null;
          } catch { version = null; }
          versions.set(key, version);
        }
        const version = versions.get(key);
        if (version) return { file: real, dir: path.dirname(real), version };
      } catch {}
    }
    return null;
  }
  function locate(engine, mode) {
    if (engine === 'antigravity' && mode !== 'subscription') return null;
    let found = null;
    if (engines[engine].package) {
      for (const modules of packageRoots()) {
        found = npmRuntime(engine, modules);
        if (found) break;
      }
    }
    if (!found && ['claude', 'codex', 'antigravity'].includes(engine)) found = nativeRuntime(engine,
      engine === 'antigravity' ? [...directories(), ...antigravityDirectories({ platform, env, home })] : directories());
    return found ? { ...found, source: 'Available locally', external: true, ...(engine === 'antigravity' ? { mode } : {}) } : null;
  }
  locate.packageRuntime = npmRuntime;
  return locate;
}

module.exports = { createLocalRuntimeDiscovery };
