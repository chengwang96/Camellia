'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Reveal and select a file in the platform's file manager. Electron's
// shell.showItemInFolder cannot report failure and does nothing without the
// org.freedesktop.FileManager1 service, so every platform runs its own command:
// Finder selects the file with `open -R`, Explorer uses `/select,`, and Linux
// has no portable selection API, so xdg-open opens the containing folder.
function revealCommand(platform, filePath) {
  if (platform === 'darwin') return { command: 'open', args: ['-R', filePath] };
  if (platform === 'win32') return { command: 'explorer.exe', args: ['/select,' + filePath] };
  return { command: 'xdg-open', args: [path.dirname(filePath)] };
}

// `openPath` is injected so a Linux host without xdg-open still reveals the
// folder through the desktop's own file-manager association.
async function revealInFileManager(filePath, { platform = process.platform, spawnProcess = spawn, openPath } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A file path is required.');
  const resolvedPath = path.resolve(filePath);
  fs.statSync(resolvedPath);
  const { command, args } = revealCommand(platform, resolvedPath);
  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch (error) {
    if (platform === 'linux' && error.code === 'ENOENT' && openPath) {
      const failure = await openPath(path.dirname(resolvedPath));
      if (failure) throw new Error(failure);
      return { command: 'openPath', args: [path.dirname(resolvedPath)] };
    }
    throw error;
  }
  return { command, args };
}

module.exports = { revealCommand, revealInFileManager };
