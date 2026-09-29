'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { maintainPluginCaches } = require('../src/main/plugin-cache-maintenance');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const directory = args.find(arg => !arg.startsWith('--'));
if (!directory || args.some(arg => arg.startsWith('--') && arg !== '--apply')) throw new Error('Usage: node scripts/maintain-plugin-cache.cjs <app-data-directory> [--apply]');
if (apply) {
  const listing = process.platform === 'win32'
    ? execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' })
    : execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' });
  if (/(?:codex|camellia|electron|dsh-desktop)(?:-[\w-]+)?(?:\.exe)?(?:"|\s|$)/im.test(listing)) throw new Error('Exit Camellia, Electron and all Codex processes before applying cache maintenance');
}
console.log(JSON.stringify(maintainPluginCaches(directory, { apply, onProgress: id => console.error('Verifying cache: ' + id) }), null, 2));
