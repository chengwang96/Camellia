'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function runtimePathKey(engine, mode) {
  return engine === 'antigravity' && mode !== 'subscription' ? 'python' : engine;
}

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
  const python = runtimePathKey(engine, mode) === 'python';
  const args = python ? ['-c', 'from google.antigravity import Agent, LocalOpenAIAgentConfig; from importlib.metadata import version; print(version("google-antigravity"))'] : ['--version'];
  const executable = script ? (typeof node === 'function' ? node() : node) : file;
  if (!executable) throw new Error('Node.js is required for this CLI');
  let output;
  try {
    output = await probe(executable, script ? [file, ...args] : args, { timeout: 10000, maxBuffer: 65536, windowsHide: true,
      env: python ? { ...env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } : env });
  } catch (error) {
    throw new Error(python ? 'This Python must have the Antigravity SDK installed (google.antigravity).' : `Could not run this CLI: ${error.message}`);
  }
  const version = `${output.stdout || ''}\n${output.stderr || ''}`.match(/(?:^|[^\w])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1];
  if (!version) throw new Error('Could not read a version from this executable');
  return { file, version };
}

module.exports = { runtimePathKey, checkRuntimeFile, validateRuntimePath };
