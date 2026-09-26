'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { npmCandidates } = require('../src/main/runtime-paths');
const { buildTailnet } = require('./build-tailnet.cjs');

function packageManifest(source) {
  return { name: source.name, version: source.version, private: true, description: 'Camellia Linux server', license: source.license,
    engines: source.engines, dependencies: source.dependencies,
    scripts: { server: 'node scripts/camellia-server.cjs', 'preview:cli': 'node scripts/cli-settings-preview.cjs' } };
}
function packServer({ root = path.resolve(__dirname, '..'), output = path.resolve(root, 'dist') } = {}) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Build this package natively on Linux x64 or arm64');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const npm = npmCandidates(process.execPath).find(file => fs.existsSync(file));
  if (!npm) throw new Error('Node.js with npm is required for packaging');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-package-'));
  const directory = path.join(temporary, 'camellia-server');
  const run = (executable, args, options = {}) => execFileSync(executable, args, { stdio: 'inherit', ...options });
  try {
    fs.mkdirSync(directory);
    for (const entry of ['src', 'integrations/dsh']) fs.cpSync(path.join(root, entry), path.join(directory, entry), { recursive: true,
      filter: source => !source.split(path.sep).includes('node_modules') && !fs.lstatSync(source).isSymbolicLink() });
    for (const entry of ['scripts/camellia-server.cjs', 'scripts/cli-settings-preview.cjs', 'docs/linux-server-preview.md', 'package-lock.json']) {
      fs.mkdirSync(path.dirname(path.join(directory, entry)), { recursive: true }); fs.copyFileSync(path.join(root, entry), path.join(directory, entry));
    }
    for (const engine of ['claude', 'codex', 'dsh', 'kimi', 'antigravity']) {
      fs.mkdirSync(path.join(directory, 'runtimes', engine), { recursive: true });
      for (const name of ['package.json', 'package-lock.json', 'runtime.json', 'requirements.lock']) {
        const source = path.join(root, 'runtimes', engine, name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(directory, 'runtimes', engine, name));
      }
    }
    for (const name of ['LICENSE', 'LICENSE.md']) if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(directory, name));
    fs.mkdirSync(path.join(directory, 'runtime/npm'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(directory, 'runtime/node'));
    fs.chmodSync(path.join(directory, 'runtime/node'), 0o755);
    fs.cpSync(path.resolve(path.dirname(fs.realpathSync(npm)), '..'), path.join(directory, 'runtime/npm'), { recursive: true });
    const license = [path.resolve(path.dirname(process.execPath), '../LICENSE'), path.resolve(path.dirname(process.execPath), '../share/doc/node/LICENSE')].find(file => fs.existsSync(file));
    if (!license) throw new Error('Node distribution LICENSE must be present beside the installation for redistribution');
    fs.copyFileSync(license, path.join(directory, 'runtime/NODE-LICENSE'));
    fs.writeFileSync(path.join(directory, 'camellia'), '#!/bin/sh\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nexec "$ROOT/runtime/node" "$ROOT/scripts/camellia-server.cjs" "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(packageManifest(manifest), null, 2) + '\n');
    run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory });
    if (fs.existsSync(path.join(directory, 'node_modules/electron'))) throw new Error('Electron must not be included in server package');
    buildTailnet({ root, target: path.join(directory, 'build/runtime-assets') });
    run(process.execPath, [path.join(directory, 'scripts/camellia-server.cjs'), '--help']);
    fs.mkdirSync(output, { recursive: true });
    const archive = path.join(output, `Camellia-${manifest.version}-linux-${process.arch}-server.tar.gz`);
    if (fs.existsSync(archive) || fs.existsSync(archive + '.sha256')) throw new Error('Server package already exists; choose a new output directory');
    run('tar', ['-czf', archive, '-C', temporary, 'camellia-server']);
    const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(archive + '.sha256', `${digest}  ${path.basename(archive)}\n`, { flag: 'wx' });
    return archive;
  } finally {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('camellia-package-')) throw new Error('Unsafe packaging cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try { console.log(packServer({ output: process.argv[2] ? path.resolve(process.argv[2]) : undefined })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packServer, packageManifest };
