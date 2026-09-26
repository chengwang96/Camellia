'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { writeJson } = require('../shared/json-store');

// Both probes are shared with the settings UI so an interpreter saved by hand
// and one found on PATH are judged by exactly the same rules.
const PYTHON_PROBE = 'import sys, json; print(json.dumps({"python": "%d.%d.%d" % sys.version_info[:3]}))';
const SDK_PROBE = 'import google.antigravity';

function parsePythonVersion(output) {
  try { return JSON.parse(String(output || '').trim().split(/\r?\n/).pop())?.python || null; }
  catch { return null; }
}

function pythonCandidates({ platform, env, home }) {
  const commands = platform === 'win32'
    ? [{ command: 'python3.exe' }, { command: 'python.exe' }, { command: 'py.exe', prefix: ['-3'] }]
    : [{ command: 'python3' }, { command: 'python' }];
  const separator = platform === 'win32' ? ';' : ':';
  const directories = [...new Set([
    ...(env.PATH || env.Path || '').split(separator).map(dir => dir.replace(/^"|"$/g, '')).filter(Boolean),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
    platform === 'win32' ? '' : path.join(home, '.local', 'bin'),
  ].filter(Boolean))];
  return directories.flatMap(dir => commands.map(({ command, prefix = [] }) => ({ file: path.join(dir, command), prefix })));
}

// One shared interpreter for every harness. Auto-detection deliberately stays
// synchronous because it feeds the synchronous runtime state that the settings
// page and the install prompts read.
function detectSystemPython({ platform = process.platform, env = process.env, home = os.homedir(),
  probe = execFileSync, cache = new Map() } = {}) {
  for (const candidate of pythonCandidates({ platform, env, home })) {
    let key;
    try {
      if (!fs.statSync(candidate.file).isFile()) continue;
      fs.accessSync(candidate.file, platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
      key = `${candidate.file}:${fs.statSync(candidate.file).mtimeMs}:${candidate.prefix.join(' ')}`;
    } catch { continue; }
    if (!cache.has(key)) {
      const options = { timeout: 5000, maxBuffer: 65536, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } };
      let found = null;
      try {
        const version = parsePythonVersion(probe(candidate.file, [...candidate.prefix, '-c', PYTHON_PROBE], options));
        if (version && Number(version.split('.')[0]) >= 3) {
          let antigravitySdk = false;
          try { probe(candidate.file, [...candidate.prefix, '-c', SDK_PROBE], options); antigravitySdk = true; } catch {}
          found = { file: candidate.file, version, antigravitySdk };
        }
      } catch { found = null; }
      cache.set(key, found);
    }
    const found = cache.get(key);
    if (found) return { ...found, source: 'Detected automatically', detected: true };
  }
  return null;
}

// The managed SDK packages can be driven either by the bundled CPython or by a
// user-selected interpreter, so the caller passes whichever is active.
function locatePythonRuntime(dir, shared) {
  const manifest = path.join(dir, 'installed.json');
  if (!fs.existsSync(manifest)) return null;
  const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const platform = config.platforms[process.platform + '-' + process.arch];
  // The manifest records either the bundled CPython version or the marker for a
  // user-selected interpreter, so both are valid records for this SDK version.
  const recorded = installed.python === 'shared' || installed.python === config.python;
  if (!platform || installed.sdk !== config.sdk || !recorded) return null;
  const packages = path.join(dir, 'packages');
  if (!fs.existsSync(path.join(packages, 'google/antigravity/__init__.py'))) return null;
  if (installed.python === 'shared') {
    // A shared interpreter can be removed or uninstalled between launches; a
    // missing file must invalidate the installation rather than report Ready.
    if (!shared?.file || !fs.existsSync(shared.file)) return null;
    return { file: shared.file, dir, version: config.sdk, packages, sharedPython: { ...shared, packages } };
  }
  const file = path.join(dir, 'python', platform.python);
  if (!fs.existsSync(file)) return null;
  return { file, dir, version: config.sdk, packages };
}

// A shared interpreter can replace the bundled CPython when it is new enough
// for the SDK; the lockfile is a single universal resolution, so the same
// pinned packages install on any supported Python 3.
const MIN_SDK_PYTHON = 10; // google-antigravity requires Python 3.10+
function sharedPythonSupportsSdk(python) {
  if (!python?.file || !python.version) return false;
  const [major, minor] = String(python.version).split('.').map(Number);
  return major === 3 && minor >= MIN_SDK_PYTHON;
}

function pythonEnvironment(dir, env = process.env) {
  // Run against the app's relocatable package directory, not user site packages.
  const { PYTHONHOME, PYTHONPATH, VIRTUAL_ENV, PATH, Path, ...clean } = env;
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const pythonDir = path.dirname(path.join(dir, 'python', config.platforms[process.platform + '-' + process.arch].python));
  return { ...clean, PATH: pythonDir + path.delimiter + (PATH || Path || ''),
    PYTHONPATH: path.join(dir, 'packages'), PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
}

async function installPythonRuntime({ source, dir, run, report, connection, python }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['runtime.json', 'requirements.lock']) {
    if (path.resolve(source) !== path.resolve(dir)) fs.copyFileSync(path.join(source, name), path.join(dir, name));
  }
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const platform = config.platforms[process.platform + '-' + process.arch];
  if (!platform) throw new Error('Antigravity Python runtime is unavailable for this platform');
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
    if (process.platform === 'linux') await require('unzipper').Open.file(archive).then(opened => opened.extract({ path: installer }));
    else await run('tar', ['-xf', archive, '-C', installer]);
    if (process.platform !== 'win32') fs.chmodSync(uv, 0o755);
  }
  const env = { ...connection.env, UV_NO_CONFIG: '1', UV_PYTHON_INSTALL_DIR: path.join(dir, 'python'), UV_CACHE_DIR: path.join(installer, 'cache') };
  const downloadProgress = chunk => {
    for (const line of chunk.split(/\r?\n/)) if (/^\s*(Downloading|Downloaded|Prepared|Installed)\b/.test(line)) report(line.trim());
  };
  // A configured or auto-detected interpreter is reused instead of downloading
  // another CPython; uv still resolves and installs the pinned SDK packages.
  const reuse = sharedPythonSupportsSdk(python) ? python : null;
  let interpreter;
  if (reuse) {
    report(`Using the shared Python ${reuse.version} for the Antigravity SDK…`);
    interpreter = reuse.file;
  } else {
    report('Preparing Python in the application directory…');
    await run(uv, ['python', 'install', config.python, '--install-dir', env.UV_PYTHON_INSTALL_DIR, '--no-bin'], { env, cwd: dir }, downloadProgress);
    interpreter = path.join(dir, 'python', platform.python);
  }
  report('Installing the official Antigravity SDK…');
  await run(uv, ['pip', 'install', '--python', interpreter, '--target', path.join(dir, 'packages'), '--require-hashes', '--only-binary', ':all:', '-r', path.join(dir, 'requirements.lock')], { env, cwd: dir }, downloadProgress);
  const verifyEnv = reuse ? globalPythonEnvironment({ ...reuse, packages: path.join(dir, 'packages') }) : pythonEnvironment(dir);
  await run(interpreter, ['-c', 'from google.antigravity import Agent, LocalOpenAIAgentConfig'], { env: verifyEnv, cwd: dir });
  // The manifest records which interpreter was used, so a later launch reuses it
  // and a missing path invalidates the installation instead of silently drifting.
  writeJson(path.join(dir, 'installed.json'), { sdk: config.sdk, python: reuse ? 'shared' : config.python,
    sharedPython: reuse ? reuse.file : undefined });
  return locatePythonRuntime(dir, reuse);
}

async function upgradePythonRuntime({ dir, run, connection, report = () => {}, sdk, python }) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const platform = config.platforms[process.platform + '-' + process.arch];
  if (!platform) throw new Error('Antigravity Python runtime is unavailable for this platform');
  const uv = path.join(dir, 'installer', platform.uv);
  if (!fs.existsSync(uv)) throw new Error('The bundled installer is missing. Reinstall the engine instead.');
  // An installation created with a shared interpreter keeps using it, so an
  // upgrade never switches the SDK back to a bundled CPython on its own.
  const installed = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8')); } catch { return null; } })();
  const reuse = installed?.python === 'shared' && sharedPythonSupportsSdk(python) ? python : null;
  const interpreter = reuse ? reuse.file : path.join(dir, 'python', platform.python);
  const env = { ...connection.env, UV_NO_CONFIG: '1', UV_PYTHON_INSTALL_DIR: path.join(dir, 'python'), UV_CACHE_DIR: path.join(dir, 'installer', 'cache') };
  const requirements = path.join(dir, 'requirements.in'), lock = path.join(dir, 'requirements.lock');
  fs.writeFileSync(requirements, `google-antigravity==${sdk}
`);
  report('Resolving the official Antigravity SDK…');
  await run(uv, ['pip', 'compile', requirements, '--python-version', '3.13', '--universal', '--generate-hashes', '--output-file', lock], { env, cwd: dir });
  report('Installing the official Antigravity SDK…');
  await run(uv, ['pip', 'install', '--python', interpreter, '--target', path.join(dir, 'packages'), '--require-hashes', '--only-binary', ':all:', '-r', lock], { env, cwd: dir });
  const verifyEnv = reuse ? globalPythonEnvironment({ ...reuse, packages: path.join(dir, 'packages') }) : pythonEnvironment(dir);
  await run(interpreter, ['-c', 'from google.antigravity import Agent, LocalOpenAIAgentConfig'], { env: verifyEnv, cwd: dir });
  writeJson(path.join(dir, 'runtime.json'), { ...config, sdk });
  writeJson(path.join(dir, 'installed.json'), { sdk, python: reuse ? 'shared' : config.python,
    sharedPython: reuse ? reuse.file : undefined });
  return locatePythonRuntime(dir, reuse);
}

// A user-selected interpreter is shared by every harness. Camellia keeps the
// managed SDK packages importable and avoids reading a system-wide Python
// configuration, exactly as it does for the bundled interpreter.
function globalPythonEnvironment(python, env = process.env) {
  if (!python?.file) throw new Error('Choose a Python interpreter first');
  const { PYTHONHOME, PYTHONPATH, VIRTUAL_ENV, PATH, Path, ...clean } = env;
  const value = { ...clean, PATH: path.dirname(python.file) + path.delimiter + (PATH || Path || ''),
    PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
  // Only fall back to the managed packages when the chosen interpreter cannot
  // import the SDK on its own; a matching interpreter keeps its own install.
  return python.antigravitySdk ? { ...value, PYTHONPATH: undefined } : { ...value, PYTHONPATH: python.packages };
}

module.exports = { locatePythonRuntime, installPythonRuntime, upgradePythonRuntime, pythonEnvironment,
  globalPythonEnvironment, detectSystemPython, sharedPythonSupportsSdk, pythonCandidates };
