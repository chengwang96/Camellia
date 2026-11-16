'use strict';

// Run with: node background-process.cjs <absolute JSON spec path>
// A JSON spec keeps Windows arguments out of Bash/CMD quoting layers. Never
// fall back to a shell or ShellExecute: missing executables must fail in text.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function absolutePath(value, name) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/u.test(value) || !path.isAbsolute(value))
    throw new Error(name + ' must be an absolute path');
  return value;
}

async function startBackgroundProcess(spec, { spawnProcess = spawn, platform = process.platform } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Expected a process specification');
  const file = absolutePath(spec.file, 'file');
  const cwd = absolutePath(spec.cwd, 'cwd');
  const logFile = absolutePath(spec.logFile, 'logFile');
  if (platform === 'win32' && !/\.exe$/iu.test(file))
    throw new Error('Use a native .exe; pass scripts as arguments to their interpreter');
  if (!fs.statSync(file).isFile()) throw new Error('Executable is not a file');
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd is not a directory');
  if (!Array.isArray(spec.args) || spec.args.some(value => typeof value !== 'string' || value.includes('\0')))
    throw new Error('args must be an array of strings without NUL characters');
  if (spec.env !== undefined && (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)
      || Object.entries(spec.env).some(([key, value]) => !key || /[=\0]/u.test(key) || typeof value !== 'string' || value.includes('\0'))))
    throw new Error('env must contain string environment variables');
  // Do not turn the executable or a script being launched into its own log.
  const logPath = path.resolve(logFile), inputs = [file, ...spec.args].map(value => path.resolve(cwd, value));
  const pathKey = value => platform === 'win32' ? value.toLowerCase() : value;
  if (inputs.some(value => pathKey(value) === pathKey(logPath))) throw new Error('logFile must differ from process inputs');
  const fd = fs.openSync(logFile, 'a');
  try {
    const child = spawnProcess(file, spec.args, { cwd, env: { ...process.env, ...spec.env },
      shell: false, windowsVerbatimArguments: false, windowsHide: true,
      detached: true, stdio: ['ignore', fd, fd] });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
    return { pid: child.pid, logFile };
  } finally { fs.closeSync(fd); }
}

if (require.main === module) {
  void (async () => {
    if (process.argv.length !== 3) throw new Error('Usage: node background-process.cjs <absolute JSON spec path>');
    const specFile = absolutePath(process.argv[2], 'spec');
    const result = await startBackgroundProcess(JSON.parse(fs.readFileSync(specFile, 'utf8')));
    console.log(JSON.stringify(result));
  })().catch(error => { console.error('Background process failed: ' + error.message); process.exitCode = 1; });
}

module.exports = { startBackgroundProcess };
