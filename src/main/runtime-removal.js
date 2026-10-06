'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function manifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return null; }
}

function physicalPath(file) {
  const tail = [];
  let current = path.resolve(file);
  while (!fs.existsSync(current)) {
    if (current === path.dirname(current)) throw new Error('The Camellia runtime directory is unavailable');
    tail.unshift(path.basename(current)); current = path.dirname(current);
  }
  return path.join(fs.realpathSync.native(current), ...tail);
}

// Identify the package that owns the selected entry, rather than treating its
// containing directory (which may be a shared npm prefix) as disposable.
function runtimeRemovalPlan({ engine, definition, file, destination, platform = process.platform, env = process.env, home = os.homedir() }) {
  const realFile = fs.realpathSync.native(file);
  const stat = fs.statSync(realFile);
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const managed = physicalPath(destination);
  const relative = path.relative(managed, realFile);
  if (relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
    return { kind: 'replacement', file, realFile, signature };
  }
  let packageDir, modules;
  for (let dir = path.dirname(realFile); definition.package && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const info = manifest(dir);
    const ownsCodex = engine === 'codex' && /^@openai\/codex-(win32|darwin|linux)-(x64|arm64)$/.test(info?.name || '');
    if (info?.name !== definition.package && !ownsCodex) continue;
    let parent = path.dirname(dir);
    if (path.basename(parent).startsWith('@')) parent = path.dirname(parent);
    if (path.basename(parent) !== 'node_modules') continue;
    if (manifest(path.join(parent, definition.package))?.name !== definition.package) continue;
    packageDir = dir; modules = parent;
    break;
  }
  if (packageDir) {
    const overlap = path.relative(packageDir, managed);
    if (!overlap || overlap && !overlap.startsWith('..' + path.sep) && !path.isAbsolute(overlap)) {
      throw new Error('The Camellia runtime directory overlaps the original installation');
    }
    const localPrefix = path.dirname(modules), local = manifest(localPrefix);
    const project = Boolean(local || fs.existsSync(path.join(localPrefix, 'package-lock.json'))
      || path.basename(path.dirname(localPrefix)) === '_npx');
    const prefix = !project && path.basename(localPrefix) === 'lib' ? path.dirname(localPrefix) : localPrefix;
    return { kind: 'npm', file, realFile, signature, prefix: fs.realpathSync.native(prefix), modules,
      global: !project, package: definition.package };
  }
  // Standalone native installers have no npm receipt. Remove the executable
  // and links pointing to it, never a bin directory or a user/config directory.
  if (!['claude', 'codex', 'antigravity'].includes(engine) || /\.(?:m?js|cjs)$/i.test(realFile)) {
    throw new Error('Could not identify this CLI installation. Choose its installed npm entry file before reinstalling.');
  }
  // Resolve directory aliases while preserving launcher symlinks themselves.
  // A regular entry reached through /var or a junction is the same file as
  // realFile and must not be unlinked twice.
  const files = new Map();
  const addFile = candidate => {
    const entry = path.join(fs.realpathSync.native(path.dirname(candidate)), path.basename(candidate));
    files.set(platform === 'win32' ? entry.toLowerCase() : entry, entry);
  };
  addFile(realFile);
  if (fs.lstatSync(file).isSymbolicLink()) addFile(file);
  const command = engine === 'antigravity' ? 'agy' : engine;
  const directories = [...(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':'),
    ...(home ? [path.join(home, '.local', 'bin')] : [])];
  for (let directory of directories) {
    directory = directory.replace(/^"|"$/g, '');
    if (!path.isAbsolute(directory)) continue;
    const link = path.join(directory, command + (platform === 'win32' ? '.exe' : ''));
    try {
      if (fs.lstatSync(link).isSymbolicLink() && fs.realpathSync.native(link) === realFile) addFile(link);
    } catch { /* Not a link to this installation. */ }
  }
  return { kind: 'native', file, realFile, signature, files: [...files.values()] };
}

async function removeRuntime(plan, { node, npm, run, env }) {
  if (plan.kind === 'replacement') return;
  if (fs.realpathSync.native(plan.file) !== plan.realFile) throw new Error('The runtime path changed. Retry the reinstall.');
  const stat = fs.statSync(plan.realFile);
  if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` !== plan.signature) throw new Error('The runtime path changed. Retry the reinstall.');
  if (plan.kind === 'npm') {
    if (!node || !npm) throw new Error('Node.js/npm not found. Install Node.js 22.19+ and retry.');
    const args = [npm, 'uninstall', '--prefix', plan.prefix, plan.global ? '--global' : '--global=false',
      plan.package, '--ignore-scripts', '--no-audit', '--no-fund'];
    await run(node, args, { cwd: plan.prefix, env });
    if (fs.existsSync(plan.file) || fs.existsSync(path.join(plan.modules, plan.package, 'package.json'))) {
      throw new Error('The original CLI could not be uninstalled. Retry the reinstall.');
    }
  } else {
    // Each target is an already inspected file/link, not a computed tree.
    for (const file of plan.files) {
      if (fs.realpathSync.native(file) !== plan.realFile) throw new Error('The runtime path changed. Retry the reinstall.');
    }
    for (const file of plan.files) fs.unlinkSync(file);
  }
}

module.exports = { runtimeRemovalPlan, removeRuntime };
