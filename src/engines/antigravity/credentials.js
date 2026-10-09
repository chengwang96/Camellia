'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Matches NewCLITokenStorage("antigravity") in the official CLI: go-keyring
// service "gemini", account "antigravity", with this one file fallback.
async function clearGoogleCredentials({ cliSettingsFile, env = process.env, platform = process.platform,
  execute = promisify(execFile) }) {
  const tokenFile = path.join(path.dirname(cliSettingsFile), 'antigravity-oauth-token');
  fs.rmSync(tokenFile, { force: true });
  const options = { env, windowsHide: true, timeout: 10000, encoding: 'utf8', maxBuffer: 16384 };
  try {
    if (platform === 'win32') {
      const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const script = path.join(__dirname, 'clear-credentials.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], options);
    } else if (platform === 'darwin') {
      await execute('/usr/bin/security', ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity'], options);
    } else {
      await execute('secret-tool', ['clear', 'service', 'gemini', 'username', 'antigravity'], options);
    }
  } catch (error) {
    if (platform === 'darwin' && error.code === 44) return;
    // Headless Linux stores its token in the file instead of a system keyring.
    if (platform === 'linux' && error.code === 'ENOENT' && !env.DBUS_SESSION_BUS_ADDRESS) return;
    throw new Error('Could not clear Google credentials from the system keyring. Try signing out again.', { cause: error });
  }
  // A process finishing during keyring cleanup must not leave a file fallback.
  fs.rmSync(tokenFile, { force: true });
}

module.exports = { clearGoogleCredentials };
