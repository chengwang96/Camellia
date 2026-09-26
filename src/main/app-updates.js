'use strict';

// User-initiated checks and in-place updates for Camellia itself. Releases are
// read from the public GitHub release feed; the packaged platform artifact is
// downloaded, checksum-verified, then applied over the running installation.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { compareVersions } = require('./runtime-updates');
const { createDownloadConnection } = require('./download-network');

const DEFAULT_REPOSITORY = 'chengwang96/Camellia';
const RELEASES_API = 'https://api.github.com/repos';
const REQUEST_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'Camellia-Updater' };

function parseVersion(value) {
  const match = String(value ?? '').trim().match(/v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/);
  return match ? match[1] : null;
}

function digestSha256(asset) {
  const match = String(asset?.digest ?? '').trim().match(/^sha256:([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

// Only artifacts Camellia can apply in place are offered. Windows NSIS
// installers overwrite the existing installation; macOS ZIP archives replace
// the .app bundle. DMG and Linux packages are downloaded for the user instead.
function selectAsset(assets, platform, arch) {
  // The name comes from a remote release and is reused for a local file, so
  // keep only the basename to prevent it from escaping the temp directory.
  const usable = (assets || []).filter(asset => asset && asset.name && asset.browser_download_url)
    .map(asset => ({ ...asset, name: path.basename(asset.name) }));
  const pick = patterns => {
    for (const pattern of patterns) {
      const found = usable.find(asset => pattern.test(asset.name));
      if (found) return found;
    }
    return null;
  };
  if (platform === 'win32') {
    const asset = pick([/setup.*win.*(?:x64|amd64).*\.exe$/i, /win.*(?:x64|amd64).*\.exe$/i, /\.exe$/i]);
    return asset ? { asset, kind: 'installer' } : null;
  }
  if (platform === 'darwin') {
    const archive = pick([/macos.*arm64.*\.zip$/i, /arm64.*\.zip$/i, /darwin.*\.zip$/i]);
    if (archive) return { asset: archive, kind: 'archive' };
    const image = pick([/macos.*arm64.*\.dmg$/i, /\.dmg$/i]);
    return image ? { asset: image, kind: 'disk-image' } : null;
  }
  return null;
}

function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`${path.basename(exe)} failed (${code}): ${output.trim()}`)));
  });
}

// Detached so the installer (or the extracted app) keeps running after this
// process exits to make way for it.
function launchDetached(exe, args = []) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child;
}

async function writeResponse(response, target, onProgress) {
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
  const total = Number(response.headers?.get?.('content-length')) || 0;
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const data = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(target, data);
    onProgress(data.length, total || data.length);
    return;
  }
  const handle = await fs.promises.open(target, 'w');
  let received = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      received += value.length;
      onProgress(received, total);
    }
  } finally { await handle.close(); }
}

function sha256File(file) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function createAppUpdates({
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  repository = DEFAULT_REPOSITORY,
  appPath,
  connection = () => createDownloadConnection(),
  runCommand = run,
  launch = launchDetached,
  reveal = async () => {},
  relaunch = () => {},
  quit = () => {},
  log = () => {},
  platformSupported = false,
} = {}) {
  let installing = false;

  async function fetchRelease(connectionHandle) {
    const response = await connectionHandle.fetch(`${RELEASES_API}/${repository}/releases/latest`, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(30000) });
    if (response.status === 404) throw new Error('This project has no published releases yet');
    if (!response.ok) throw new Error(`Update check failed (HTTP ${response.status})`);
    return response.json();
  }

  function describe(release) {
    const latest = parseVersion(release.tag_name) || parseVersion(release.name);
    if (!latest) throw new Error('The latest release does not report a version');
    const selected = selectAsset(release.assets, platform, arch);
    return {
      current: currentVersion, latest, updateAvailable: compareVersions(latest, currentVersion) > 0,
      supported: Boolean(selected) && (platformSupported || selected.kind === 'disk-image'),
      kind: selected?.kind || null, name: selected?.asset.name || null, size: Number(selected?.asset.size) || 0,
      sha256: digestSha256(selected?.asset), url: selected?.asset.browser_download_url || null,
      notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
      releaseUrl: release.html_url || null, publishedAt: release.published_at || null,
    };
  }

  async function check() {
    const handle = connection();
    try { return describe(await fetchRelease(handle)); }
    finally { await handle.close(); }
  }

  async function applyInstaller(file) {
    // The NSIS installer overwrites the existing installation in place. Launch
    // it first so the wizard survives this process exiting.
    launch(file, []);
  }

  async function applyArchive(file) {
    if (!appPath) throw new Error('The application location is unknown');
    const staging = path.join(os.tmpdir(), `camellia-update-${randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      await runCommand('ditto', ['-x', '-k', file, staging]);
      const bundled = fs.readdirSync(staging).map(name => path.join(staging, name))
        .find(candidate => candidate.endsWith('.app') && fs.statSync(candidate).isDirectory());
      if (!bundled) throw new Error('The downloaded archive does not contain Camellia.app');
      // Copy the new bundle over the running one so the next launch is updated.
      await runCommand('ditto', [bundled, appPath]);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  async function install(onState = () => {}, known) {
    if (installing) throw new Error('An update is already in progress');
    const available = known || await check();
    if (!available.updateAvailable) throw new Error('Camellia is already up to date');
    if (!available.name || !available.url) throw new Error('This release has no package for this platform');
    if (!available.supported) throw new Error('This release has no in-place package for this platform');
    installing = true;
    const handle = connection();
    const target = path.join(os.tmpdir(), `camellia-update-${randomUUID()}-${available.name}`);
    // A launched installer owns its file, and a downloaded disk image must stay
    // for the user to open, so only failed attempts are cleaned up.
    let keepFile = false;
    try {
      onState({ status: 'downloading', percent: 0, name: available.name, size: available.size });
      log(`app update: downloading ${available.name}`);
      const response = await handle.fetch(available.url, { signal: AbortSignal.timeout(30 * 60000) });
      await writeResponse(response, target, (received, total) => {
        onState({ status: 'downloading', percent: total ? Math.round(received / total * 100) : null, received, total: total || available.size });
      });
      if (available.sha256 && sha256File(target) !== available.sha256) throw new Error('The downloaded package failed its checksum');
      onState({ status: 'applying', percent: 100 });
      if (available.kind === 'installer') {
        await applyInstaller(target);
        keepFile = true;
        onState({ status: 'restarting', percent: 100 });
        // The installer replaces the application and offers to start it again,
        // so hand over and exit instead of racing it with a relaunch.
        quit();
        return { ok: true, version: available.latest, restarting: true, kind: available.kind };
      }
      if (available.kind === 'archive') {
        await applyArchive(target);
        onState({ status: 'restarting', percent: 100 });
        relaunch();
        return { ok: true, version: available.latest, restarting: true, kind: available.kind };
      }
      await reveal(target);
      keepFile = true;
      return { ok: true, version: available.latest, restarting: false, kind: available.kind, file: target };
    } catch (error) {
      log(`app update failed: ${error.message}`);
      onState({ status: 'error', error: error.message });
      throw error;
    } finally {
      installing = false;
      if (!keepFile) { try { fs.unlinkSync(target); } catch {} }
      await handle.close();
    }
  }

  return { check, install, state: () => ({ installing }) };
}

module.exports = { createAppUpdates, selectAsset, parseVersion, digestSha256, sha256File };
