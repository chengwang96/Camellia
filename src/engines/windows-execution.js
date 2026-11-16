'use strict';

const path = require('node:path');

function windowsExecutionInstructions(platform = process.platform) {
  if (platform !== 'win32') return '';
  const launcher = path.join(__dirname, 'background-process.cjs').replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1');
  return 'Camellia Windows process execution: Use native PowerShell; avoid Bash/CMD nesting. '
    + 'Never use cmd /c start or .bat files to detach helpers (bad quoting opens Windows dialogs). '
    + 'Write JSON with absolute file (.exe), cwd, logFile paths, args as a string array, optional env string map. '
    + 'Run node ' + JSON.stringify(launcher) + ' <absolute-spec.json> with separate arguments; it launches hidden without a shell and logs both streams. '
    + 'Fix errors before retrying; no start/Start-Process fallback. After a PID, check the log or service readiness.\n\n';
}

module.exports = { windowsExecutionInstructions };
