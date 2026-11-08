'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EDITIONS = [
  { id: 'stable', name: 'Visual Studio Code', directory: 'Microsoft VS Code', executable: 'Code.exe', command: 'code' },
  { id: 'insiders', name: 'Visual Studio Code Insiders', directory: 'Microsoft VS Code Insiders', executable: 'Code - Insiders.exe', command: 'code-insiders' },
  { id: 'codium', name: 'VSCodium', directory: 'VSCodium', executable: 'VSCodium.exe', command: 'codium' },
];

function platformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function detectVSCodeInstallations({ platform = process.platform, env = process.env, home = os.homedir(), fileSystem = fs } = {}) {
  const p = platformPath(platform);
  const candidates = [];
  const add = (edition, executable, scope) => {
    if (executable) candidates.push({ id: edition.id, name: edition.name, path: p.normalize(executable), scope });
  };
  if (platform === 'win32') {
    const roots = [
      ['user', env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs')],
      ['system', env.ProgramFiles],
      ['system', env['ProgramFiles(x86)']],
    ];
    for (const edition of EDITIONS) {
      for (const [scope, root] of roots) add(edition, root && p.join(root, edition.directory, edition.executable), scope);
      add(edition, home && p.join(home, 'scoop', 'apps', edition.id === 'stable' ? 'vscode' : edition.id === 'insiders' ? 'vscode-insiders' : 'vscodium', 'current', edition.executable), 'scoop');
    }
  } else if (platform === 'darwin') {
    for (const edition of EDITIONS.slice(0, 2)) {
      const app = edition.id === 'stable' ? 'Visual Studio Code.app' : 'Visual Studio Code - Insiders.app';
      add(edition, p.join('/Applications', app, 'Contents/Resources/app/bin/code'), 'system');
      if (home) add(edition, p.join(home, 'Applications', app, 'Contents/Resources/app/bin/code'), 'user');
    }
  } else {
    for (const edition of EDITIONS) {
      for (const root of ['/usr/bin', '/usr/local/bin', '/snap/bin']) add(edition, p.join(root, edition.command), 'system');
    }
  }
  const pathEntries = String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const edition of EDITIONS) {
    for (const directory of pathEntries) {
      add(edition, p.join(directory, platform === 'win32' ? edition.executable : edition.command), 'PATH');
      if (platform === 'win32') add(edition, p.join(directory, edition.command + '.exe'), 'PATH');
    }
  }
  const seen = new Set(), priority = new Map(EDITIONS.map((edition, index) => [edition.id, index]));
  return candidates.filter(candidate => {
    const key = platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) return false;
    try {
      if (!fileSystem.statSync(candidate.path).isFile()) return false;
    } catch { return false; }
    seen.add(key);
    return true;
  }).sort((a, b) => priority.get(a.id) - priority.get(b.id));
}

function validateVSCodeExecutable(value, { platform = process.platform, fileSystem = fs } = {}) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/u.test(value))
    throw new Error('Choose a VS Code executable.');
  const executable = value.trim();
  if (!executable) return '';
  const p = platformPath(platform);
  if (!p.isAbsolute(executable)) throw new Error('Use an absolute path for the VS Code executable.');
  try {
    if (!fileSystem.statSync(executable).isFile()) throw new Error('Not a file');
    fileSystem.accessSync(executable, (fileSystem.constants || fs.constants).R_OK);
  } catch { throw new Error('The VS Code executable does not exist or cannot be read.'); }
  return p.normalize(executable);
}

function validateWorkspaceDirectory(value, { platform = process.platform, fileSystem = fs } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/u.test(value))
    throw new Error('Choose a workspace folder.');
  const directory = value.trim();
  const p = platformPath(platform);
  if (!p.isAbsolute(directory)) throw new Error('Use an absolute path for the workspace folder.');
  try {
    if (!fileSystem.statSync(directory).isDirectory()) throw new Error('Not a directory');
    fileSystem.accessSync(directory, (fileSystem.constants || fs.constants).R_OK);
  } catch { throw new Error('The workspace folder does not exist or cannot be read.'); }
  return p.normalize(directory);
}

async function openWorkspaceInVSCode(workspacePath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const directory = validateWorkspaceDirectory(workspacePath, { ...options, fileSystem });
  const configured = validateVSCodeExecutable(options.vscodePath || '', { ...options, fileSystem });
  const installation = configured
    ? { name: path.basename(configured), path: configured }
    : detectVSCodeInstallations({ ...options, fileSystem })[0];
  if (!installation) throw new Error('No VS Code installation was found. Choose an executable in Settings → General.');
  const spawnProcess = options.spawnProcess || spawn;
  const child = spawnProcess(installation.path, [directory], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  return { executable: installation.path, name: installation.name };
}

module.exports = { detectVSCodeInstallations, validateVSCodeExecutable, validateWorkspaceDirectory, openWorkspaceInVSCode };
