'use strict';

// User-initiated version checks and upgrades for the five harness runtimes.
// npm engines upgrade in place inside the directory locate() resolved (the
// userData copy in production, the repo copy in development). Antigravity in
// API mode upgrades its Python SDK through the bundled uv installer; in
// Google subscription mode the CLI is pinned to the app and only changes with
// app releases.

const fs = require('node:fs');
const path = require('node:path');
const patchDsh = require('../../integrations/dsh/patch.cjs');
const { createDownloadConnection } = require('./download-network');
const { upgradePythonRuntime } = require('./python-runtime');

const REGISTRY_TIMEOUT = 30000;

// Semver-ish comparison: numeric core first, then release-outranks-prerelease.
function compareVersions(a, b) {
  const parts = value => {
    const [core, ...rest] = String(value ?? '').trim().replace(/^v/i, '').split('-');
    return { nums: core.split('.').map(part => parseInt(part, 10) || 0), pre: rest.join('-') };
  };
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const delta = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function createRuntimeUpdates({ manager, engines, node, npm, run, downloadSettings = () => undefined, registries = {}, promptRestart = async () => false, log = () => {} }) {
  const pending = new Map();
  const registryUrls = {
    npm: registries.npm || (pkg => `https://registry.npmjs.org/${pkg}/latest`),
    pypi: registries.pypi || (pkg => `https://pypi.org/pypi/${pkg}/json`),
  };

  async function fetchJson(connection, url) {
    const response = await connection.fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT) });
    if (!response.ok) { await response.body.cancel(); throw new Error(`Registry request failed (HTTP ${response.status})`); }
    return response.json();
  }

  function latestVersion(connection, engine, mode) {
    if (engines[engine].type === 'python') {
      if (mode === 'subscription') return Promise.resolve(null);
      return fetchJson(connection, registryUrls.pypi('google-antigravity')).then(data => data.info?.version || null);
    }
    return fetchJson(connection, registryUrls.npm(engines[engine].package)).then(data => data.version || null);
  }

  async function check() {
    const connection = createDownloadConnection(downloadSettings());
    try {
      return await Promise.all(manager.state().map(async row => {
        const base = { id: row.id, name: row.name, installed: row.status === 'ready' ? row.version || null : null, latest: null, updateAvailable: false, checkable: true, error: null };
        if (engines[row.id].type === 'python' && row.mode === 'subscription') return { ...base, checkable: false };
        try {
          const latest = await latestVersion(connection, row.id, row.mode);
          return { ...base, latest, updateAvailable: Boolean(base.installed && latest && compareVersions(latest, base.installed) > 0) };
        } catch (error) {
          log(`runtime update check failed for ${row.id}: ${error.message}`);
          return { ...base, error: error.message };
        }
      }));
    } finally {
      await connection.close();
    }
  }

  function update(engine) {
    if (!engines[engine]) return Promise.reject(new Error('Unknown engine'));
    if (pending.has(engine)) return pending.get(engine);
    const task = perform(engine).finally(() => pending.delete(engine));
    pending.set(engine, task);
    return task;
  }

  async function perform(engine) {
    const found = manager.locate(engine);
    if (!found) throw new Error('Download this engine before updating it');
    if (found.mode === 'subscription') throw new Error('This runtime ships with the app and cannot be updated here');
    const connection = createDownloadConnection(downloadSettings());
    try {
      const latest = await latestVersion(connection, engine, found.mode);
      if (!latest) throw new Error('Could not determine the latest version');
      if (compareVersions(latest, found.version) <= 0) {
        return { ok: true, engine, from: found.version, to: found.version, changed: false, restartRequired: false, restarting: false };
      }
      if (engines[engine].type === 'python') await upgradePythonRuntime({ dir: found.dir, run, connection, sdk: latest, report: () => {} });
      else await upgradeNpmRuntime(engine, found.dir, connection, latest);
      const updated = manager.locate(engine);
      if (!updated || compareVersions(updated.version, latest) !== 0) throw new Error(`The update to v${latest} did not complete. Please retry.`);
      const restarting = await promptRestart(engines[engine].name, found.version, latest);
      return { ok: true, engine, from: found.version, to: latest, changed: true, restartRequired: true, restarting };
    } finally {
      await connection.close();
    }
  }

  async function upgradeNpmRuntime(engine, dir, connection, latest) {
    if (!node || !npm) throw new Error('Node.js/npm not found. Install Node.js 22.19+ and retry.');
    // npm 11 can reject a valid prefix containing a symlink (including macOS
    // /var -> /private/var). Install from the physical path, as the initial
    // runtime installation does.
    const installDir = fs.realpathSync.native(dir);
    const args = [npm, 'install', '--prefix', installDir, '--save-exact', `${engines[engine].package}@${latest}`, '--no-audit', '--no-fund'];
    if (engine === 'kimi') args.push('--omit=optional', '--ignore-scripts');
    await run(node, args, { cwd: installDir, env: { ...connection.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH } });
    if (engine === 'dsh') patchDsh(dir);
  }

  return { check, update };
}

module.exports = { compareVersions, createRuntimeUpdates };
