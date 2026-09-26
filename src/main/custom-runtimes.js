'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function checkRuntimeFile(file, platform = process.platform) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Choose an absolute executable path');
  if (!fs.existsSync(file)) throw new Error('The selected runtime file no longer exists');
  if (!fs.statSync(file).isFile()) throw new Error('Choose a file, not a folder');
  fs.accessSync(file, platform === 'win32' || /\.(?:m?js|cjs)$/i.test(file) ? fs.constants.R_OK : fs.constants.X_OK);
}

async function validateRuntimePath({ engine, mode, file, node, locateLocal, platform = process.platform, probe = promisify(execFile), env = process.env }) {
  file = typeof file === 'string' ? file.trim() : '';
  checkRuntimeFile(file, platform);
  if (/\.(?:cmd|bat|ps1)$/i.test(file)) {
    const found = locateLocal.packageRuntime(engine, path.join(path.dirname(file), 'node_modules'));
    if (!found) throw new Error('Choose the CLI executable or JavaScript entry file, not a shell wrapper');
    file = found.file;
  }
  checkRuntimeFile(file, platform);
  const script = /\.(?:m?js|cjs)$/i.test(file);
  if (script !== ['dsh', 'kimi'].includes(engine)) throw new Error(['dsh', 'kimi'].includes(engine)
    ? 'Choose the JavaScript entry file of this CLI' : 'Choose a native executable, not a script');
  const args = ['--version'];
  const executable = script ? (typeof node === 'function' ? node() : node) : file;
  if (!executable) throw new Error('Node.js is required for this CLI');
  let output;
  try {
    output = await probe(executable, script ? [file, ...args] : args, { timeout: 10000, maxBuffer: 65536, windowsHide: true, env });
  } catch (error) {
    throw new Error(`Could not run this CLI: ${error.message}`);
  }
  const version = `${output.stdout || ''}\n${output.stderr || ''}`.match(/(?:^|[^\w])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1];
  if (!version) throw new Error('Could not read a version from this executable');
  return { file, version };
}

const PYTHON_PROBE = 'import sys, json; print(json.dumps({"python": "%d.%d.%d" % sys.version_info[:3]}))';
const SDK_PROBE = 'import google.antigravity';

// Python is a single shared interpreter for every harness, not an engine
// runtime. Validation therefore only requires a working Python 3 and reports
// separately whether it can serve Antigravity API mode.
async function validatePythonPath({ file, platform = process.platform, probe = promisify(execFile), env = process.env, managedPackages }) {
  file = typeof file === 'string' ? file.trim() : '';
  checkRuntimeFile(file, platform);
  const options = { timeout: 15000, maxBuffer: 65536, windowsHide: true,
    env: { ...env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } };
  let pythonVersion;
  let output;
  try {
    output = await probe(file, ['-c', PYTHON_PROBE], options);
  } catch (error) {
    throw new Error(`Could not run this Python: ${error.message}`);
  }
  // An executable that runs but does not answer the probe is not Python; the
  // JSON error alone would be confusing, so report what actually went wrong.
  try { pythonVersion = JSON.parse(String(output.stdout || '').trim().split(/\r?\n/).pop())?.python; }
  catch { pythonVersion = null; }
  if (!/^\d+\.\d+\.\d+$/.test(pythonVersion || '')) throw new Error('Could not read a Python version from this executable');
  const [major] = pythonVersion.split('.').map(Number);
  if (major < 3) throw new Error('Choose Python 3; Camellia does not support Python 2');
  // The SDK can also come from Camellia's managed packages, so both the
  // interpreter's own site-packages and that directory are checked.
  const sdkProbe = env2 => probe(file, ['-c', SDK_PROBE], { ...options, env: env2 }).then(() => true).catch(() => false);
  const antigravitySdk = await sdkProbe(options.env) || Boolean(managedPackages) && await sdkProbe({ ...options.env, PYTHONPATH: managedPackages });
  return { file, version: pythonVersion, pythonVersion, antigravitySdk };
}

module.exports = { checkRuntimeFile, validateRuntimePath, validatePythonPath };
