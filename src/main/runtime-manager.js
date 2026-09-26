'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const patchDsh = require('../../integrations/dsh/patch.cjs');
const { locatePythonRuntime, installPythonRuntime } = require('./python-runtime');
const { createDownloadConnection } = require('./download-network');
const { locateAntigravityCli, installAntigravityCli } = require('./antigravity-cli-runtime');
const { createLocalRuntimeDiscovery } = require('./local-runtimes');
const { runtimePathKey, checkRuntimeFile, validateRuntimePath } = require('./custom-runtimes');

const ENGINES = {
  // The official wrapper installs the native binary at this path on every OS.
  claude: { name: 'Claude Code', package: '@anthropic-ai/claude-code', entry: 'bin/claude.exe' },
  codex: { name: 'Codex CLI', package: '@openai/codex' },
  dsh: { name: 'DeepSeek Harness', package: '@deepseek-ai/dsh', entry: 'lib/bin.js' },
  kimi: { name: 'Kimi Code', package: '@moonshot-ai/kimi-code', entry: 'dist/main.mjs' },
  antigravity: { name: 'Antigravity', type: 'python' },
};
function run(exe, args, options = {}, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let head = '', tail = '', length = 0;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      const text = String(data);
      length += text.length;
      const remaining = 4000 - head.length;
      head += text.slice(0, remaining);
      tail = (tail + text.slice(remaining)).slice(-4000);
      onOutput(text);
    });
    child.once('error', reject);
    child.once('close', code => {
      const output = head + (length > 8000 ? '\n…\n' : '') + tail;
      code === 0 ? resolve() : reject(new Error(`Installation failed (${code}): ${output.trim()}`));
    });
  });
}
function createRuntimeManager({ root, installRoot, node, npm, onChange = () => {}, runCommand = run, downloadOptions = () => undefined, runtimeMode = () => 'api', platform = process.platform, arch = process.arch, discoverLocal = true, env = process.env, home, customPaths = () => ({}), saveCustomPaths, beforePathSave = () => {}, probe }) {
  const pending = new Map(), progress = new Map();
  const changingPaths = new Set();
  const locateLocal = createLocalRuntimeDiscovery({ engines: ENGINES, node, platform, arch, env, home });
  const entry = (dir, engine) => {
    if (engine === 'codex') {
      const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
      const suffix = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-musl' }[platform];
      if (!cpu || !suffix) throw new Error('Unsupported Codex runtime platform');
      return path.join(dir, 'node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor', `${cpu}-${suffix}`, 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
    }
    return path.join(dir, 'node_modules', ENGINES[engine].package, ENGINES[engine].entry);
  };
  function locate(engine, mode = runtimeMode(engine)) {
    if (!ENGINES[engine]) throw new Error("Unknown engine");
    const custom = customPaths()[runtimePathKey(engine, mode)];
    if (custom?.file) {
      checkRuntimeFile(custom.file, platform);
      return { ...custom, dir: path.dirname(custom.file), external: true, custom: true, mode, source: 'Custom local path' };
    }
    for (const [base, source] of [[root, "Available locally"], [installRoot, "Installed by Camellia"]]) {
      if (ENGINES[engine].type === 'python') {
        const found = (mode === 'subscription' ? locateAntigravityCli : locatePythonRuntime)(path.join(base, 'runtimes', engine));
        if (found) return { ...found, source };
        continue;
      }
      const dir = path.join(base, 'runtimes', engine), file = entry(dir, engine);
      if (fs.existsSync(file)) return { file, dir, source, version: JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ENGINES[engine].package, 'package.json'))).version };
    }
    return discoverLocal ? locateLocal(engine, mode) : null;
  }
  function state() {
    return Object.entries(ENGINES).map(([id, engine]) => {
      const mode = runtimeMode(id), customPath = customPaths()[runtimePathKey(id, mode)]?.file || '';
      const paths = Object.fromEntries(['api', 'subscription'].map(connection => [connection, customPaths()[runtimePathKey(id, connection)]?.file || '']));
      try {
        const found = locate(id, mode);
        return { id, name: engine.name, mode, customPath, paths, ...found, status: found ? 'ready' : 'missing', ...progress.get(id + ':' + mode) };
      } catch (error) { return { id, name: engine.name, mode, customPath, paths, external: Boolean(customPath), status: 'error', message: error.message }; }
    });
  }
  function report(engine, mode, value) { progress.set(engine + ':' + mode, value); onChange(state()); }
  async function install(engine, mode, options) {
    const connection = createDownloadConnection(options);
    const source = path.join(root, 'runtimes', engine);
    const dir = path.join(installRoot, 'runtimes', engine);
    const update = value => report(engine, mode, value);
    update({ status: 'installing', message: engine === 'antigravity' ? `Preparing the official Antigravity ${mode === 'subscription' ? 'CLI' : 'SDK'}…` : "Preparing runtime from the official npm package…" });
    try {
      if (ENGINES[engine].type === 'python') {
        const installer = mode === 'subscription' ? installAntigravityCli : installPythonRuntime;
        const found = await installer({ source, dir, run: runCommand, connection,
          report: message => update({ status: 'installing', message }) });
        update({ status: 'ready', message: 'Ready' });
        return found;
      }
      if (!node || !npm) throw new Error("Node.js/npm not found. Install Node.js 22.19+ and retry.");
      fs.mkdirSync(dir, { recursive: true });
      for (const name of ['package.json', 'package-lock.json']) {
        if (path.resolve(source, name) !== path.resolve(dir, name)) fs.copyFileSync(path.join(source, name), path.join(dir, name));
      }
      // npm 11 can reject a valid lockfile when the prefix contains a symlink
      // (including macOS /var -> /private/var). Install from the physical path.
      const installDir = fs.realpathSync.native(dir);
      const args = [npm, 'ci', '--prefix', installDir, '--no-audit', '--no-fund'];
      if (engine === 'kimi') args.push('--omit=optional', '--ignore-scripts');
      await runCommand(node, args, { cwd: installDir, env: { ...connection.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH } });
      if (engine === 'dsh') patchDsh(dir);
      const found = locate(engine);
      if (!found) throw new Error("Installation did not produce an executable. Please retry.");
      update({ status: 'ready', message: "Ready" });
      return found;
    } catch (e) { update({ status: 'error', message: e.message }); throw e; }
    finally { await connection.close(); }
  }
  function ensure(engine, mode = runtimeMode(engine)) {
    if (changingPaths.has(engine)) return Promise.reject(new Error('Wait for runtime path validation to finish'));
    const key = engine + ':' + mode;
    if (pending.has(key)) return pending.get(key);
    const found = locate(engine, mode);
    if (found) {
      // Downloaded DSH survives application upgrades; refresh our integration
      // when it is reused so it stays in step with the installed workbench.
      if (engine === 'dsh' && !found.external) patchDsh(found.dir);
      progress.delete(key);
      return Promise.resolve(found);
    }
    const task = Promise.resolve().then(() => downloadOptions(engine, mode)).then(options => install(engine, mode, options))
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  async function setPath(engine, file, mode = runtimeMode(engine)) {
    if (!Object.hasOwn(ENGINES, engine) || !['api', 'subscription'].includes(mode)) throw new Error('Unknown runtime');
    if (!saveCustomPaths) throw new Error('Custom runtime paths are unavailable');
    if (changingPaths.has(engine)) throw new Error('Wait for runtime path validation to finish');
    if (['api', 'subscription'].some(connection => pending.has(engine + ':' + connection))) throw new Error('Wait for the runtime download to finish');
    if (typeof file !== 'string') throw new Error('Choose an executable path');
    changingPaths.add(engine);
    try {
      const selected = file.trim() ? await validateRuntimePath({ engine, mode, file, node, locateLocal, platform, probe, env }) : null;
      beforePathSave(engine);
      const paths = { ...customPaths() }, key = runtimePathKey(engine, mode);
      if (selected) paths[key] = selected;
      else delete paths[key];
      saveCustomPaths(paths);
      progress.delete(engine + ':' + mode);
      const engines = state();
      onChange(engines);
      return engines;
    } finally { changingPaths.delete(engine); }
  }
  return { locate, ensure, state, setPath };
}
module.exports = { ENGINES, createRuntimeManager, run };
