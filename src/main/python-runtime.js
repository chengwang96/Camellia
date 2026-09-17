'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJson } = require('../shared/json-store');

function locatePythonRuntime(dir) {
  const manifest = path.join(dir, 'installed.json');
  if (!fs.existsSync(manifest)) return null;
  const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const platform = config.platforms[process.platform + '-' + process.arch];
  if (!platform || installed.sdk !== config.sdk || installed.python !== config.python) return null;
  const file = path.join(dir, 'python', platform.python);
  if (!fs.existsSync(file) || !fs.existsSync(path.join(dir, 'packages/google/antigravity/__init__.py'))) return null;
  return { file, dir, version: config.sdk };
}

function pythonEnvironment(dir, env = process.env) {
  // Run against the app's relocatable package directory, not user site packages.
  const { PYTHONHOME, PYTHONPATH, VIRTUAL_ENV, PATH, Path, ...clean } = env;
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const pythonDir = path.dirname(path.join(dir, 'python', config.platforms[process.platform + '-' + process.arch].python));
  return { ...clean, PATH: pythonDir + path.delimiter + (PATH || Path || ''),
    PYTHONPATH: path.join(dir, 'packages'), PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
}

async function installPythonRuntime({ source, dir, run, report, connection }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['runtime.json', 'requirements.lock']) {
    if (path.resolve(source) !== path.resolve(dir)) fs.copyFileSync(path.join(source, name), path.join(dir, name));
  }
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const platform = config.platforms[process.platform + '-' + process.arch];
  if (!platform) throw new Error('Antigravity supports Windows x64 and macOS ARM64');
  const installer = path.join(dir, 'installer');
  fs.mkdirSync(installer, { recursive: true });
  const uv = path.join(installer, platform.uv);
  if (!fs.existsSync(uv)) {
    report('Downloading the Python installer…');
    const response = await connection.fetch(platform.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) { await response.body.cancel(); throw new Error(`Could not download uv (HTTP ${response.status})`); }
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== platform.sha256) throw new Error('Python installer checksum mismatch');
    const archive = path.join(installer, platform.archive);
    fs.writeFileSync(archive, data);
    await run('tar', ['-xf', archive, '-C', installer]);
    if (process.platform !== 'win32') fs.chmodSync(uv, 0o755);
  }
  const env = { ...connection.env, UV_NO_CONFIG: '1', UV_PYTHON_INSTALL_DIR: path.join(dir, 'python'), UV_CACHE_DIR: path.join(installer, 'cache') };
  const downloadProgress = chunk => {
    for (const line of chunk.split(/\r?\n/)) if (/^\s*(Downloading|Downloaded|Prepared|Installed)\b/.test(line)) report(line.trim());
  };
  report('Preparing Python in the application directory…');
  await run(uv, ['python', 'install', config.python, '--install-dir', env.UV_PYTHON_INSTALL_DIR, '--no-bin'], { env, cwd: dir }, downloadProgress);
  const python = path.join(dir, 'python', platform.python);
  report('Installing the official Antigravity SDK…');
  await run(uv, ['pip', 'install', '--python', python, '--target', path.join(dir, 'packages'), '--require-hashes', '--only-binary', ':all:', '-r', path.join(dir, 'requirements.lock')], { env, cwd: dir }, downloadProgress);
  await run(python, ['-c', 'from google.antigravity import Agent, LocalOpenAIAgentConfig'], { env: pythonEnvironment(dir), cwd: dir });
  writeJson(path.join(dir, 'installed.json'), { sdk: config.sdk, python: config.python });
  return locatePythonRuntime(dir);
}

async function upgradePythonRuntime({ dir, run, connection, report = () => {}, sdk }) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const platform = config.platforms[process.platform + '-' + process.arch];
  if (!platform) throw new Error('Antigravity supports Windows x64 and macOS ARM64');
  const uv = path.join(dir, 'installer', platform.uv);
  if (!fs.existsSync(uv)) throw new Error('The bundled installer is missing. Reinstall the engine instead.');
  const python = path.join(dir, 'python', platform.python);
  const env = { ...connection.env, UV_NO_CONFIG: '1', UV_PYTHON_INSTALL_DIR: path.join(dir, 'python'), UV_CACHE_DIR: path.join(dir, 'installer', 'cache') };
  const requirements = path.join(dir, 'requirements.in'), lock = path.join(dir, 'requirements.lock');
  fs.writeFileSync(requirements, `google-antigravity==${sdk}
`);
  report('Resolving the official Antigravity SDK…');
  await run(uv, ['pip', 'compile', requirements, '--python-version', '3.13', '--universal', '--generate-hashes', '--output-file', lock], { env, cwd: dir });
  report('Installing the official Antigravity SDK…');
  await run(uv, ['pip', 'install', '--python', python, '--target', path.join(dir, 'packages'), '--require-hashes', '--only-binary', ':all:', '-r', lock], { env, cwd: dir });
  await run(python, ['-c', 'from google.antigravity import Agent, LocalOpenAIAgentConfig'], { env: pythonEnvironment(dir), cwd: dir });
  writeJson(path.join(dir, 'runtime.json'), { ...config, sdk });
  writeJson(path.join(dir, 'installed.json'), { sdk, python: config.python });
  return locatePythonRuntime(dir);
}

module.exports = { locatePythonRuntime, installPythonRuntime, upgradePythonRuntime, pythonEnvironment };
