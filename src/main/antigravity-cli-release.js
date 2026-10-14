'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { writeJson } = require('../shared/json-store');
const { checkedAntigravityCliVersion } = require('./antigravity-cli-runtime');

// The endpoint used by Google's own cli/install.ps1 and cli/install.sh.
const MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/';
const PLATFORMS = Object.freeze({ 'win32-x64': 'windows_amd64', 'win32-arm64': 'windows_arm64',
  'darwin-x64': 'darwin_amd64', 'darwin-arm64': 'darwin_arm64', 'linux-x64': 'linux_amd64', 'linux-arm64': 'linux_arm64' });

function manifestUrl(platform = process.platform, arch = process.arch) {
  const name = PLATFORMS[platform + '-' + arch];
  if (!name) throw new Error('Antigravity CLI is unavailable for this platform');
  return MANIFEST_BASE + name + '.json';
}

function validateRelease(value) {
  let url;
  try { url = new URL(value?.url); } catch { throw new Error('Invalid Antigravity CLI release URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com' || url.username || url.password
    || !url.pathname.startsWith('/antigravity-public/antigravity-cli/') || url.search || url.hash)
    throw new Error('Antigravity CLI release must come from the official Google download bucket');
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value?.version || '') || !/^[a-f0-9]{128}$/i.test(value?.sha512 || ''))
    throw new Error('Invalid Antigravity CLI release version or SHA-512 checksum');
  if (!/\.(?:exe|tar\.gz)$/.test(url.pathname)) throw new Error('Unsupported Antigravity CLI release archive');
  return { version: value.version, url: url.href, sha512: value.sha512.toLowerCase() };
}

async function releaseResponse(connection, url, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await connection.fetch(url, { signal });
      if (response.ok) return response;
      await response.body?.cancel();
      const error = new Error(`Antigravity CLI release request failed (HTTP ${response.status})`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    } catch (error) {
      if (attempt >= 2 || signal.aborted || error.retryable === false) throw error;
      await delay(250 * (attempt + 1), null, { signal });
    }
  }
}

async function latestAntigravityCli(connection, { url = manifestUrl(), signal = AbortSignal.timeout(30000) } = {}) {
  const response = await releaseResponse(connection, url, signal);
  return validateRelease(await response.json());
}

async function upgradeAntigravityCli({ dir, release, connection, run, report = () => {},
  probe = checkedAntigravityCliVersion, platform = process.platform }) {
  release = validateRelease(release);
  const cliDir = path.resolve(dir, 'cli');
  const file = path.join(cliDir, platform === 'win32' ? 'agy.exe' : 'agy');
  if (!fs.existsSync(file)) throw new Error('Download the Antigravity CLI before updating it');
  const marker = path.join(cliDir, 'installed.json');
  const previousMarker = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
  const staging = fs.mkdtempSync(path.join(cliDir, '.update-'));
  const candidate = path.join(staging, path.basename(file));
  const backup = path.join(cliDir, 'agy.previous' + (platform === 'win32' ? '.exe' : ''));
  let moved = false, promoted = false;
  try {
    const archive = platform === 'win32' ? candidate : path.join(staging, 'download.tar.gz');
    const response = await releaseResponse(connection, release.url, AbortSignal.timeout(600000));
    const hash = createHash('sha512');
    let bytes = 0, lastReport = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
      hash.update(chunk); bytes += chunk.length;
      if (Date.now() - lastReport > 1000) { lastReport = Date.now(); report(`Downloading Antigravity CLI… ${Math.round(bytes / 1048576)} MB`); }
      callback(null, chunk);
    } }), fs.createWriteStream(archive));
    if (hash.digest('hex') !== release.sha512) throw new Error('Antigravity CLI checksum mismatch; the installed version was kept');
    if (platform !== 'win32') {
      // Extract only the known executable; archive paths cannot escape staging.
      await run('tar', ['-xzf', archive, '-C', staging, 'antigravity']);
      fs.renameSync(path.join(staging, 'antigravity'), candidate);
      fs.chmodSync(candidate, 0o755);
    }
    const version = await probe(candidate, connection.env);
    if (version !== release.version) throw new Error(`Antigravity CLI version mismatch: expected ${release.version}, received ${version}`);
    // A prior rollback copy may still be running in an external terminal. Fail
    // before moving the current executable if Windows cannot release that copy.
    fs.rmSync(backup, { force: true });
    fs.renameSync(file, backup); moved = true;
    fs.renameSync(candidate, file); promoted = true;
    writeJson(marker, { version, url: release.url, sha512: release.sha512 });
    return { file, dir, version, mode: 'subscription', backup };
  } catch (error) {
    if (moved) {
      try {
        if (promoted) fs.rmSync(file, { force: true });
        fs.renameSync(backup, file);
        if (previousMarker) fs.writeFileSync(marker, previousMarker);
        else fs.rmSync(marker, { force: true });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `${error.message}; restore the previous CLI from ${backup}`);
      }
    }
    if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code))
      throw new Error('Close external Antigravity CLI windows and retry the update. The previous version was kept.', { cause: error });
    throw error;
  } finally {
    // This directory is created by mkdtemp under the exact managed CLI folder.
    if (path.dirname(staging) === cliDir) fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { manifestUrl, validateRelease, latestAntigravityCli, upgradeAntigravityCli };
