'use strict';

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

function isTailscaleIPv4(address) {
  const parts = String(address).split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}

async function tailscaleAddress({ run = promisify(execFile), interfaces = os.networkInterfaces } = {}) {
  const executable = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe') : 'tailscale';
  let status;
  try {
    const result = await run(executable, ['status', '--json'], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    status = JSON.parse(result.stdout);
  } catch { throw new Error('Tailscale is unavailable. Start Tailscale and sign in first.'); }
  if (status.BackendState !== 'Running' || status.Self?.Online !== true) throw new Error('Tailscale is not online.');
  const local = Object.values(interfaces()).flat().filter(Boolean).map(entry => entry.address);
  const address = status.TailscaleIPs?.find(address => isTailscaleIPv4(address) && local.includes(address));
  if (!address) throw new Error('No local Tailscale IPv4 address is available.');
  return address;
}

module.exports = { tailscaleAddress, isTailscaleIPv4 };
