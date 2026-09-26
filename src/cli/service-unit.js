'use strict';

const path = require('node:path');

function unitArgument(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid service argument');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => '$$') + '"';
}

function serviceUnit({ node = process.execPath, script = path.resolve(__dirname, '../../scripts/camellia-server.cjs'), dataDir,
  executable, keyFile, hostname = 'camellia-server', restoreNetwork = false }) {
  for (const value of [node, script, dataDir, executable, keyFile].filter(value => value !== undefined)) {
    if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.startsWith('//')) throw new Error('Service paths must be absolute Linux paths');
    unitArgument(value);
  }
  if (!dataDir) throw new Error('Service data directory is required');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw new Error('Invalid Tailscale hostname');
  const args = [node, script, 'serve', '--data-dir', dataDir, '--hostname', hostname];
  if (executable) args.push('--helper', executable);
  if (keyFile) args.push('--key-file', keyFile);
  if (restoreNetwork) args.push('--restore-network');
  return ['[Unit]', 'Description=Camellia server (development preview)', '', '[Service]', 'Type=exec',
    'ExecStart=' + args.map(unitArgument).join(' '), 'UMask=0077', 'KillMode=control-group', 'TimeoutStopSec=60',
    'Restart=no', 'StandardInput=null', 'StandardOutput=journal', 'StandardError=journal', '', '[Install]', 'WantedBy=default.target', ''].join('\n');
}

module.exports = { serviceUnit, unitArgument };
