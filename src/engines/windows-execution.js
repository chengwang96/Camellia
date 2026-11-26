'use strict';

const path = require('node:path');

function windowsExecutionInstructions(platform = process.platform) {
  if (platform !== 'win32') return '';
  const launcher = path.join(__dirname, 'background-process.cjs').replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1');
  return 'Camellia Windows process execution: Use native PowerShell; avoid Bash/CMD nesting. '
    + 'Never use cmd /c start or .bat files to detach helpers (bad quoting opens Windows dialogs). '
    + 'Write JSON with absolute file (.exe), cwd, logFile paths, args as a string array, optional env string map. '
    + 'Run node ' + JSON.stringify(launcher) + ' <absolute-spec.json> with separate arguments; it launches hidden without a shell and logs both streams. '
    + 'On Windows it keeps a hidden worker for console inheritance so emulator/QEMU/netsimd descendants do not open a terminal; the returned PID is the target process. '
    + 'Fix errors before retrying; no start/Start-Process fallback. After a PID, check the log or service readiness. '
    + 'If the current turn owes the user a finished result, set waitForExit: true in the JSON and set the calling tool timeout long enough. '
    + 'This keeps the executable hidden and returns the exit code after both output streams close. Check the log and validate the deliverables before replying. '
    + 'A detached launch without waitForExit only acknowledges startup and does not wake a finished conversation.\n\n';
}

module.exports = { windowsExecutionInstructions };
