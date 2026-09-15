'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const patchDsh = require('../../integrations/dsh/patch.cjs');

const ENGINES = {
  dsh: { name: 'DeepSeek Harness', package: '@deepseek-ai/dsh', entry: 'lib/bin.js' },
  // The official wrapper installs the native binary at this path on every OS.
  claude: { name: 'Claude Code', package: '@anthropic-ai/claude-code', entry: 'bin/claude.exe' },
  kimi: { name: 'Kimi Code', package: '@moonshot-ai/kimi-code', entry: 'dist/main.mjs' },
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
function createRuntimeManager({ root, installRoot, node, npm, onChange = () => {}, runCommand = run }) {
  const pending = new Map(), progress = new Map();
  const entry = (dir, engine) => path.join(dir, 'node_modules', ENGINES[engine].package, ENGINES[engine].entry);
  function locate(engine) {
    if (!ENGINES[engine]) throw new Error("Unknown engine");
    for (const [base, source] of [[root, "Bundled with application"], [installRoot, "Installed by Camellia"]]) {
      const dir = path.join(base, 'runtimes', engine), file = entry(dir, engine);
      if (fs.existsSync(file)) return { file, dir, source, version: JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ENGINES[engine].package, 'package.json'))).version };
    }
    return null;
  }
  function state() {
    return Object.entries(ENGINES).map(([id, engine]) => {
      const found = locate(id);
      return { id, name: engine.name, ...found, status: found ? 'ready' : 'missing', ...progress.get(id) };
    });
  }
  function report(engine, value) { progress.set(engine, value); onChange(state()); }
  async function install(engine) {
    if (!ENGINES[engine]) throw new Error("Unknown engine");
    const source = path.join(root, 'runtimes', engine);
    const dir = path.join(installRoot, 'runtimes', engine);
    report(engine, { status: 'installing', message: "Preparing runtime from the official npm package…" });
    try {
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
      await runCommand(node, args, { cwd: installDir, env: { ...process.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH } });
      if (engine === 'dsh') patchDsh(dir);
      const found = locate(engine);
      if (!found) throw new Error("Installation did not produce an executable. Please retry.");
      report(engine, { status: 'ready', message: "Ready" });
      return found;
    } catch (e) { report(engine, { status: 'error', message: e.message }); throw e; }
  }
  function ensure(engine) {
    if (pending.has(engine)) return pending.get(engine);
    const found = locate(engine);
    if (found) return Promise.resolve(found);
    const task = install(engine).finally(() => pending.delete(engine));
    pending.set(engine, task);
    return task;
  }
  return { locate, ensure, state };
}
module.exports = { ENGINES, createRuntimeManager, run };
