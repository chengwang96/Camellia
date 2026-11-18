'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { digestSha256, sha256File } = require('../app-updates');
const { createDownloadConnection } = require('../download-network');
const { writeJson } = require('../../shared/json-store');

const REPOSITORY = 'chengwang96/Camellia';
const RELEASE_API = 'https://api.github.com/repos/' + REPOSITORY + '/releases/latest';
const VERSION = /^v(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2}$/;
const LIMITS = { bin: 80 * 1024 * 1024, txt: 8 * 1024 * 1024 };
const SUPPORTED = new Set(['win32-x64', 'darwin-arm64']);

function compare(left, right) {
  const parts = value => value ? value.slice(1).split('.').map(Number) : [0, 0, 0];
  const [a, b, c] = parts(left);
  const [x, y, z] = parts(right);
  return a - x || b - y || c - z;
}

// v1 identifies the helper's IPC protocol. Change it when the wire contract
// requires a newer desktop app. The Tailscale version is the final token.
function assetStem(platform, arch, version) {
  return ['camellia-tailnet-ipc1', platform, arch, version].join('-');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function releaseAssets(release, platform, arch) {
  if (release?.draft || release?.prerelease || !Array.isArray(release?.assets)
      || !/^[\w.-]+$/.test(release.tag_name || '')) return null;
  const prefix = assetStem(platform, arch, '');
  const assets = new Map(release.assets.filter(asset => typeof asset?.name === 'string').map(asset => [asset.name, asset]));
  function find(stem, ext) {
    const asset = assets.get(stem + '.' + ext);
    const digest = digestSha256(asset);
    if (!digest || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > LIMITS[ext]) return null;
    const url = 'https://github.com/' + REPOSITORY + '/releases/download/' + release.tag_name + '/' + asset.name;
    if (asset.browser_download_url !== url) return null;
    return { url, digest, size: asset.size };
  }
  let latest = null;
  for (const name of assets.keys()) {
    if (!name.startsWith(prefix) || !name.endsWith('.bin')) continue;
    const version = name.slice(prefix.length, -4);
    if (!VERSION.test(version) || latest && compare(version, latest.version) <= 0) continue;
    const stem = assetStem(platform, arch, version);
    const binary = find(stem, 'bin'), notices = find(stem, 'txt');
    if (binary && notices) latest = { version, binary, notices };
  }
  return latest;
}

async function download(connection, asset, file, mode) {
  const response = await connection.fetch(asset.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error('Update download failed (HTTP ' + response.status + ')');
  const descriptor = await fs.promises.open(file, 'wx', mode);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const value of response.body) {
      size += value.length;
      if (size > asset.size) throw new Error('Unexpected update file size');
      hash.update(value);
      await descriptor.writeFile(value);
    }
  } finally { await descriptor.close(); }
  if (size !== asset.size || hash.digest('hex') !== asset.digest) throw new Error('Update file failed verification');
}

function createTailnetUpdates({ bundle, dataDir, platform = process.platform, arch = process.arch, connection = createDownloadConnection }) {
  const executableName = platform === 'win32' ? 'camellia-tailnet.exe' : 'camellia-tailnet';
  const recordName = 'tailnet-version.json', noticesName = 'TAILNET-NOTICES.txt';
  const root = path.join(dataDir, 'remote', 'tailnet-updates', assetStem(platform, arch, ''));
  const bundled = readJson(path.join(bundle, recordName));
  const bundledVersion = bundled?.platform === platform && bundled.arch === arch && VERSION.test(bundled.tailscale)
    ? bundled.tailscale : null;
  const supported = SUPPORTED.has(platform + '-' + arch);
  let current = bundledVersion, executable = null, pending = null, candidate = null, busy = false;
  function readInstallation(version) {
    const directory = path.join(root, version);
    const binary = path.join(directory, executableName);
    const manifest = path.join(directory, recordName);
    const record = readJson(manifest);
    if (record?.version !== version
        || sha256File(binary) !== record.binary || sha256File(path.join(directory, noticesName)) !== record.notices) {
      throw new Error('Embedded network update failed verification');
    }
    return { version, executable: binary, manifest, record };
  }
  if (supported) {
    let directories = [];
    try { directories = fs.readdirSync(root, { withFileTypes: true }); } catch { /* First startup has no cache. */ }
    for (const item of directories.filter(item => item.isDirectory() && VERSION.test(item.name))
      .sort((a, b) => compare(b.name, a.name))) {
      if (compare(item.name, current) <= 0) break;
      try {
        const installed = readInstallation(item.name);
        if (installed.record.active !== true) {
          pending ||= installed.version;
          continue;
        }
        current = installed.version;
        executable = installed.executable;
        break;
      } catch { /* An incomplete local install falls back to the bundled helper. */ }
    }
  }

  const status = () => ({ supported, current, pending, busy, available: candidate?.version || null });
  function pendingInstallation() {
    if (!pending) throw new Error('Download an embedded network update first');
    try { return readInstallation(pending); }
    catch (error) {
      pending = null;
      throw error;
    }
  }
  function activate() {
    const installed = pendingInstallation();
    // A verified download can still fail to start. Persist only activations
    // that succeeded so a restart keeps using the last working helper.
    writeJson(installed.manifest, { ...installed.record, active: true });
    current = installed.version;
    executable = installed.executable;
    pending = null;
    candidate = null;
    return status();
  }
  async function operate(action) {
    if (action === 'tailnet-update-status') return status();
    if (!['tailnet-update-check', 'tailnet-update-install'].includes(action)) throw new Error('Unknown embedded network update action');
    if (!supported) throw new Error('Embedded network updates are unavailable on this platform');
    if (busy) throw new Error('An embedded network update is already in progress');
    if (pending) return status();
    busy = true;
    let handle;
    try {
      if (action === 'tailnet-update-check') candidate = null;
      else if (!candidate) throw new Error('Check for an embedded network update first');
      handle = connection();
      if (action === 'tailnet-update-check') {
        const response = await handle.fetch(RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Camellia-Updater' },
          signal: AbortSignal.timeout(20_000) });
        if (response.status === 404) return { ...status(), busy: false, unpublished: true };
        if (!response.ok) throw new Error('Update check failed (HTTP ' + response.status + ')');
        const latest = releaseAssets(await response.json(), platform, arch);
        if (!latest) return { ...status(), busy: false, unpublished: true };
        if (compare(latest.version, current) > 0) candidate = latest;
      } else {
        const { version, binary, notices } = candidate;
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const temporary = fs.mkdtempSync(path.join(root, '.download-'));
        try {
          await download(handle, binary, path.join(temporary, executableName), 0o700);
          await download(handle, notices, path.join(temporary, noticesName), 0o600);
          fs.writeFileSync(path.join(temporary, recordName), JSON.stringify({ version, binary: binary.digest, notices: notices.digest }), { flag: 'wx', mode: 0o600 });
          // Only complete, verified versions appear under their final name.
          // A previously damaged copy of this version can be retried.
          const target = path.join(root, version);
          if (fs.existsSync(target)) {
            if (!fs.lstatSync(target).isDirectory()) throw new Error('Invalid embedded network update folder');
            for (const name of [recordName, executableName, noticesName]) fs.rmSync(path.join(target, name), { force: true });
            fs.rmdirSync(target);
          }
          fs.renameSync(temporary, target);
          pending = version;
          candidate = null;
        } finally {
          if (fs.existsSync(temporary)) {
            for (const name of [recordName, executableName, noticesName]) fs.rmSync(path.join(temporary, name), { force: true });
            fs.rmdirSync(temporary);
          }
        }
      }
    } finally {
      busy = false;
      await handle?.close();
    }
    return status();
  }

  return { get executable() { return executable; }, operate, pendingInstallation, activate };
}

module.exports = { assetStem, createTailnetUpdates };
