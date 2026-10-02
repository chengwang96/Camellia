'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { writeJson } = require('../shared/json-store');
const { execFileSync } = require('node:child_process');
const versions = new Map();
const SUPPORTED_CLI_VERSIONS = Object.freeze(['1.2.3', '1.2.14']);

function locateAntigravityCli(dir) {
  const marker = path.join(dir, 'cli/installed.json');
  if (!fs.existsSync(marker)) return null;
  const installed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const file = path.join(dir, 'cli', process.platform === 'win32' ? 'agy.exe' : 'agy');
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file), signature = stat.mtimeMs + ':' + stat.size;
  if (versions.get(file)?.signature !== signature) {
    let version = installed.version;
    // The official CLI can update itself outside the installer. Do not bind
    // discussion capability evidence to the stale download marker.
    try {
      const output = execFileSync(file, ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8',
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
      version = output.match(/\b\d+\.\d+\.\d+\b/)?.[0] || version;
    } catch { /* Incomplete installations are reported by the runtime launcher. */ }
    versions.set(file, { signature, version });
  }
  return { file, dir, version: versions.get(file).version, mode: 'subscription' };
}

async function installAntigravityCli({ source, dir, connection, run, report }) {
  const config = JSON.parse(fs.readFileSync(path.join(source, 'runtime.json'), 'utf8')).cli;
  const platform = config.platforms[process.platform + '-' + process.arch];
  if (!platform) throw new Error('Antigravity CLI is unavailable for this platform');
  const cliDir = path.join(dir, 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  const staging = path.join(cliDir, 'download');
  const response = await connection.fetch(platform.url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok) { await response.body.cancel(); throw new Error(`Could not download Antigravity CLI (HTTP ${response.status})`); }
  const hash = createHash('sha512');
  let bytes = 0, lastReport = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
    hash.update(chunk); bytes += chunk.length;
    if (Date.now() - lastReport > 1000) { lastReport = Date.now(); report(`Downloading Antigravity CLI… ${Math.round(bytes / 1048576)} MB`); }
    callback(null, chunk);
  } }), fs.createWriteStream(staging));
  if (hash.digest('hex') !== platform.sha512) throw new Error('Antigravity CLI checksum mismatch');
  const file = path.join(cliDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
  if (process.platform === 'win32') fs.renameSync(staging, file);
  else {
    await run('tar', ['-xzf', staging, '-C', cliDir, 'antigravity']);
    fs.renameSync(path.join(cliDir, 'antigravity'), file);
    fs.chmodSync(file, 0o755);
    fs.unlinkSync(staging);
  }
  writeJson(path.join(cliDir, 'installed.json'), { version: platform.version || config.version });
  return locateAntigravityCli(dir);
}

module.exports = { locateAntigravityCli, installAntigravityCli, SUPPORTED_CLI_VERSIONS };
