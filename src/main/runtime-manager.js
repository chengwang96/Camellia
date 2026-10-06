'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const patchDsh = require('../../integrations/dsh/patch.cjs');
const { locatePythonRuntime, installPythonRuntime, globalPythonEnvironment, detectSystemPython } = require('./python-runtime');
const { createDownloadConnection } = require('./download-network');
const { locateAntigravityCli, installAntigravityCli } = require('./antigravity-cli-runtime');
const { createLocalRuntimeDiscovery } = require('./local-runtimes');
const { checkRuntimeFile, validateRuntimePath, validatePythonPath } = require('./custom-runtimes');
const { runtimeRemovalPlan, removeRuntime } = require('./runtime-removal');

// Python is not an engine runtime: one interpreter is shared by every harness
// and by the benchmark verifier. It is stored as its own top-level setting.
const PYTHON_KEY = 'python';
// Probing PATH is synchronous and runs on every state read, so results are
// cached for the lifetime of the manager and invalidated only by file changes.
const pythonCache = new Map();

const ENGINES = {
  // The official wrapper installs the native binary at this path on every OS.
  claude: { name: 'Claude Code', package: '@anthropic-ai/claude-code', entry: 'bin/claude.exe' },
  codex: { name: 'Codex CLI', package: '@openai/codex' },
  // DSH is a microkernel plus ~240 sibling plugin packages, so its entry file
  // can survive while a wiped install leaves most companions as empty
  // directories. Require one companion to tell a real install from a shell.
  dsh: { name: 'DeepSeek Harness', package: '@deepseek-ai/dsh', entry: 'lib/bin.js',
    requires: ['node_modules/@deepseek-ai/dsh-app-boot/package.json'] },
  kimi: { name: 'Kimi Code', package: '@moonshot-ai/kimi-code', entry: 'dist/main.mjs' },
  pi: { name: 'Pi', package: '@mariozechner/pi-coding-agent', entry: 'dist/cli.js' },
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
  const managedPackages = () => path.join(installRoot, 'runtimes', 'antigravity', 'packages');
  // Saving an interpreter is explicit; an unset choice falls back to the first
  // usable Python 3 on PATH so installs and launches work without configuration.
  const pythonSelection = () => {
    const saved = customPaths()[PYTHON_KEY];
    if (saved?.file) return { ...saved, source: 'Custom local path', configured: true };
    // Auto-detection is part of local discovery: profiles that opt out of
    // scanning for local CLIs must not probe the machine for Python either.
    return discoverLocal ? detectSystemPython({ platform, env, home, cache: pythonCache }) : null;
  };
  const entry = (dir, engine) => {
    if (engine === 'codex') {
      const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
      const suffix = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-musl' }[platform];
      if (!cpu || !suffix) throw new Error('Unsupported Codex runtime platform');
      return path.join(dir, 'node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor', `${cpu}-${suffix}`, 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
    }
    return path.join(dir, 'node_modules', ENGINES[engine].package, ENGINES[engine].entry);
  };
  // Antigravity consumes a runtime only in Google subscription mode; API mode
  // runs on the shared Python interpreter instead.
  const usesCustomPath = (engine, mode) => engine !== 'antigravity' || mode === 'subscription';
  function locateIn(dir, engine, mode) {
    if (ENGINES[engine].type === 'python') return (mode === 'subscription' ? locateAntigravityCli
      : runtimeDir => locatePythonRuntime(runtimeDir, pythonSelection()))(dir);
    const file = entry(dir, engine);
    const complete = (ENGINES[engine].requires || []).every(relative => fs.existsSync(path.join(dir, relative)));
    if (!fs.existsSync(file) || !complete) return null;
    return { file, dir, version: JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ENGINES[engine].package, 'package.json'))).version };
  }
  function locate(engine, mode = runtimeMode(engine)) {
    if (!ENGINES[engine]) throw new Error("Unknown engine");
    const custom = usesCustomPath(engine, mode) ? customPaths()[engine] : null;
    if (custom?.file) {
      checkRuntimeFile(custom.file, platform);
      return { ...custom, dir: path.dirname(custom.file), external: true, custom: true, mode, source: 'Custom local path' };
    }
    for (const [base, source] of [[installRoot, "Installed by Camellia"], [root, "Available locally"]]) {
      const found = locateIn(path.join(base, 'runtimes', engine), engine, mode);
      if (found) return { ...found, source };
    }
    return discoverLocal ? locateLocal(engine, mode) : null;
  }
  function state() {
    return Object.entries(ENGINES).map(([id, engine]) => {
      const mode = runtimeMode(id), customPath = usesCustomPath(id, mode) ? customPaths()[id]?.file || '' : '';
      const paths = Object.fromEntries(['api', 'subscription'].map(connection =>
        [connection, usesCustomPath(id, connection) ? customPaths()[id]?.file || '' : '']));
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
        const found = await installer({ source, dir, run: runCommand, connection, python: pythonSelection(),
          report: message => update({ status: 'installing', message }) });
        update({ status: 'ready', message: 'Ready' });
        return found;
      }
      if (!node || !npm) throw new Error("Node.js/npm not found. Install Node.js 22.19+ and retry.");
      // Build in a sibling staging directory instead of in place. `npm ci`
      // deletes node_modules before it installs, so an interrupted run
      // (antivirus, a cancelled download, or quitting mid-install) would
      // otherwise leave the engine as an empty directory shell that still
      // looks installed. The finished tree replaces the old one only after
      // the install completes.
      const staging = path.join(installRoot, 'runtimes', `.${engine}.staging-${randomUUID()}`);
      try {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, name), path.join(staging, name));
        // npm 11 can reject a valid lockfile when the prefix contains a symlink
        // (including macOS /var -> /private/var). Install from the physical path.
        const installDir = fs.realpathSync.native(staging);
        const args = [npm, 'ci', '--prefix', installDir, '--no-audit', '--no-fund'];
        if (engine === 'kimi') args.push('--omit=optional', '--ignore-scripts');
        await runCommand(node, args, { cwd: installDir, env: { ...connection.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH } });
        // Keep the previous tree until the swap succeeds, then drop it.
        const backup = path.join(installRoot, 'runtimes', `.${engine}.old-${randomUUID()}`);
        let moved = false;
        try {
          if (fs.existsSync(dir)) { fs.renameSync(dir, backup); moved = true; }
          fs.renameSync(staging, dir);
        } catch (error) {
          if (moved && !fs.existsSync(dir)) { try { fs.renameSync(backup, dir); } catch { /* leave the backup for inspection */ } }
          throw error;
        } finally {
          if (moved) fs.rmSync(backup, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
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
  function reinstallPlan(engine) {
    if (!Object.hasOwn(ENGINES, engine)) throw new Error('Unknown engine');
    const mode = runtimeMode(engine), found = locate(engine, mode);
    if (!found?.external) throw new Error('This runtime is already managed by Camellia');
    if (found.custom && !saveCustomPaths) throw new Error('Custom runtime paths are unavailable');
    const runtimeDir = path.join(installRoot, 'runtimes', engine);
    const destination = ENGINES[engine].type === 'python' ? path.join(runtimeDir, 'cli') : runtimeDir;
    const removal = runtimeRemovalPlan({ engine, definition: ENGINES[engine], file: found.file, destination, platform, env, home });
    return { engine, mode, file: found.file, version: found.version, destination, removal };
  }
  function reinstall(engine, expected) {
    if (changingPaths.has(engine)) return Promise.reject(new Error('Wait for runtime path validation to finish'));
    const plan = reinstallPlan(engine), key = engine + ':' + plan.mode;
    if (pending.has(key)) return Promise.reject(new Error('Wait for the runtime download to finish'));
    const matches = previous => previous.file === plan.file && previous.mode === plan.mode
      && previous.removal.realFile === plan.removal.realFile && previous.removal.signature === plan.removal.signature;
    if (expected && !matches(expected)) {
      return Promise.reject(new Error('The runtime path changed. Retry the reinstall.'));
    }
    const task = Promise.resolve().then(() => downloadOptions(engine, plan.mode)).then(async options => {
      const connection = createDownloadConnection(options);
      const source = path.join(root, 'runtimes', engine), dir = plan.destination;
      const staging = path.join(installRoot, 'runtimes', `.${engine}.staging-${randomUUID()}`);
      const backup = path.join(installRoot, 'runtimes', `.${engine}.old-${randomUUID()}`);
      let moved = false, activated = false, committed = false, pathSaved = false, previousPath;
      report(engine, plan.mode, { status: 'installing', message: 'Reinstalling with Camellia…' });
      try {
        fs.mkdirSync(staging, { recursive: true });
        if (ENGINES[engine].type === 'python') {
          await installAntigravityCli({ source, dir: staging, connection, run: runCommand,
            report: message => report(engine, plan.mode, { status: 'installing', message }) });
        } else {
          if (!node || !npm) throw new Error('Node.js/npm not found. Install Node.js 22.19+ and retry.');
          for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, name), path.join(staging, name));
          const installDir = fs.realpathSync.native(staging);
          const args = [npm, 'ci', '--prefix', installDir, '--no-audit', '--no-fund'];
          if (engine === 'kimi') args.push('--omit=optional', '--ignore-scripts');
          await runCommand(node, args, { cwd: installDir, env: { ...connection.env, PATH: path.dirname(node) + path.delimiter + (env.PATH || env.Path || '') } });
          if (engine === 'dsh') patchDsh(staging);
        }
        const prepared = locateIn(staging, engine, plan.mode);
        if (!prepared) throw new Error('Installation did not produce an executable. Please retry.');
        const checked = await validateRuntimePath({ engine, mode: plan.mode, file: prepared.file, node, locateLocal, platform, probe,
          env: engine === 'antigravity' ? { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : env });
        if (checked.version !== prepared.version) throw new Error('The reinstalled CLI version could not be verified');
        const current = reinstallPlan(engine);
        if (!matches(current)) {
          throw new Error('The runtime path changed. Retry the reinstall.');
        }
        // Keep both the external CLI and any previous managed copy until the
        // staged executable has passed its version probe.
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        if (fs.existsSync(dir)) { fs.renameSync(dir, backup); moved = true; }
        fs.renameSync(ENGINES[engine].type === 'python' ? path.join(staging, 'cli') : staging, dir); activated = true;
        previousPath = customPaths()[engine];
        if (previousPath) {
          const paths = { ...customPaths() }; delete paths[engine]; saveCustomPaths(paths); pathSaved = true;
        }
        const found = locate(engine, plan.mode);
        if (!found || found.external || path.resolve(found.dir) !== path.resolve(installRoot, 'runtimes', engine)) throw new Error('Could not activate the Camellia-managed runtime');
        try {
          await removeRuntime(plan.removal, { node, npm, run: runCommand,
            env: { ...connection.env, PATH: (node ? path.dirname(node) + path.delimiter : '') + (env.PATH || env.Path || '') } });
        } catch (error) {
          // npm can fail after it has already removed files. Keep the verified
          // managed copy if the external executable is no longer usable.
          let originalUsable = false;
          try {
            await validateRuntimePath({ engine, mode: plan.mode, file: plan.file, node, locateLocal, platform, probe,
              env: engine === 'antigravity' ? { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : env });
            originalUsable = true;
          } catch { /* The new installation must remain available. */ }
          if (!originalUsable) {
            committed = true;
            throw new Error(`Reinstalled with Camellia, but the original CLI could not be uninstalled: ${error.message}`, { cause: error });
          }
          throw error;
        }
        committed = true;
        progress.delete(key); onChange(state());
        return found;
      } catch (error) {
        if (!committed) {
          if (pathSaved) saveCustomPaths({ ...customPaths(), [engine]: previousPath });
          if (activated) fs.rmSync(dir, { recursive: true, force: true });
          if (moved) { fs.renameSync(backup, dir); moved = false; }
          report(engine, plan.mode, { status: 'error', message: error.message });
        } else { progress.delete(key); onChange(state()); }
        throw error;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        if (moved && committed) fs.rmSync(backup, { recursive: true, force: true });
        await connection.close();
      }
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  async function setPath(engine, file, mode = runtimeMode(engine)) {
    if (!Object.hasOwn(ENGINES, engine) || !['api', 'subscription'].includes(mode)) throw new Error('Unknown runtime');
    if (!usesCustomPath(engine, mode)) throw new Error('Antigravity API mode uses the shared Python interpreter, not an engine path');
    if (!saveCustomPaths) throw new Error('Custom runtime paths are unavailable');
    if (changingPaths.has(engine)) throw new Error('Wait for runtime path validation to finish');
    if (['api', 'subscription'].some(connection => pending.has(engine + ':' + connection))) throw new Error('Wait for the runtime download to finish');
    if (typeof file !== 'string') throw new Error('Choose an executable path');
    changingPaths.add(engine);
    try {
      const selected = file.trim() ? await validateRuntimePath({ engine, mode, file, node, locateLocal, platform, probe, env }) : null;
      beforePathSave(engine);
      const paths = { ...customPaths() };
      if (selected) paths[engine] = selected;
      else delete paths[engine];
      saveCustomPaths(paths);
      progress.delete(engine + ':' + mode);
      const engines = state();
      onChange(engines);
      return engines;
    } finally { changingPaths.delete(engine); }
  }

  async function setPython(file) {
    if (!saveCustomPaths) throw new Error('Custom runtime paths are unavailable');
    if (changingPaths.has(PYTHON_KEY)) throw new Error('Wait for Python validation to finish');
    if (pending.size) throw new Error('Wait for the runtime download to finish');
    if (typeof file !== 'string') throw new Error('Choose an executable path');
    changingPaths.add(PYTHON_KEY);
    try {
      // A shared interpreter is in use whenever any engine is running, and the
      // Antigravity SDK can also come from the managed package directory.
      beforePathSave(PYTHON_KEY);
      const selected = file.trim() ? await validatePythonPath({ file, platform, probe, env,
        managedPackages: managedPackages() }) : null;
      const paths = { ...customPaths() };
      if (selected) paths[PYTHON_KEY] = selected;
      else delete paths[PYTHON_KEY];
      saveCustomPaths(paths);
      const snapshot = state();
      onChange(snapshot);
      return snapshot;
    } finally { changingPaths.delete(PYTHON_KEY); }
  }
  // Python lives outside the engine list: it is one shared interpreter rather
  // than a per-engine runtime, and it is reported separately to the settings UI.
  function pythonState() {
    const selected = pythonSelection();
    return { ...selected, file: selected?.file || '', packages: managedPackages(),
      configured: Boolean(customPaths()[PYTHON_KEY]?.file) };
  }
  // pythonSelection is handed to engine launchers so the same interpreter
  // serves every harness; pythonState carries it to the settings page.
  return { locate, ensure, reinstallPlan, reinstall, state, setPath, setPython, pythonState, pythonSelection,
    get busy() { return pending.size > 0 || changingPaths.size > 0; } };
}
module.exports = { ENGINES, createRuntimeManager, run };
