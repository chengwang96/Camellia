'use strict';

// User-initiated version checks and upgrades for the five harness runtimes.
// npm engines upgrade in place inside the directory locate() resolved (the
// userData copy in production, the repo copy in development). Antigravity in
// API mode upgrades its Python SDK through the bundled uv installer; in
// Google subscription mode the CLI uses Google's SHA-512 release manifest and
// keeps the previous executable available for rollback.

const fs = require('node:fs');
const path = require('node:path');
const patchDsh = require('../../integrations/dsh/patch.cjs');
const { createDownloadConnection } = require('./download-network');
const { upgradePythonRuntime } = require('./python-runtime');
const { latestAntigravityCli, upgradeAntigravityCli, manifestUrl } = require('./antigravity-cli-release');

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

function createRuntimeUpdates({ manager, engines, node, npm, run, downloadSettings = () => undefined, registries = {}, beforeInstall = async () => {}, onChange = () => {}, log = () => {}, cliUpgrade = upgradeAntigravityCli }) {
  const pending = new Map();
  const reinstalling = new Set();
  const uninstalling = new Set();
  let checked = new Map(), checking = null, checkRevision = 0;
  const installation = row => JSON.stringify([row.id, row.status, row.version, row.file, row.mode, Boolean(row.external)]);
  // Both windows read the same completed check. A result belongs to the exact
  // installation checked, so a path, version or connection change invalidates it.
  const state = (rows = manager.state()) => rows.map(row => {
    const cached = checked.get(row.id);
    return { ...row, updating: pending.has(row.id), reinstalling: reinstalling.has(row.id), uninstalling: uninstalling.has(row.id),
      updateInfo: cached?.installation === installation(row) ? cached.info : null };
  });
  const registryUrls = {
    npm: registries.npm || (pkg => `https://registry.npmjs.org/${pkg}/latest`),
    pypi: registries.pypi || (pkg => `https://pypi.org/pypi/${pkg}/json`),
    antigravity: registries.antigravity || manifestUrl,
  };

  async function fetchJson(connection, url) {
    const response = await connection.fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT) });
    if (!response.ok) { await response.body.cancel(); throw new Error(`Registry request failed (HTTP ${response.status})`); }
    return response.json();
  }

  function latestVersion(connection, engine, mode) {
    if (engines[engine].type === 'python') {
      if (mode === 'subscription') return latestAntigravityCli(connection, { url: registryUrls.antigravity() }).then(release => release.version);
      return fetchJson(connection, registryUrls.pypi('google-antigravity')).then(data => data.info?.version || null);
    }
    return fetchJson(connection, registryUrls.npm(engines[engine].package)).then(data => data.version || null);
  }

  function check() {
    const rows = manager.state().map(row => ({ ...row }));
    const signature = JSON.stringify(rows.map(installation));
    if (checking?.signature === signature) return checking.task;
    const revision = ++checkRevision;
    const task = Promise.resolve().then(() => performCheck(rows, revision)).finally(() => {
      if (checking?.task === task) checking = null;
    });
    checking = { signature, task };
    return task;
  }

  async function performCheck(rows, revision) {
    const connection = createDownloadConnection(downloadSettings());
    try {
      const results = await Promise.all(rows.map(async row => {
        const base = { id: row.id, name: row.name, mode: row.mode, external: Boolean(row.external), installed: row.status === 'ready' ? row.version || null : null, latest: null, updateAvailable: false, checkable: true, error: null };
        if (row.external) return { ...base, checkable: false };
        try {
          const latest = await latestVersion(connection, row.id, row.mode);
          return { ...base, latest, updateAvailable: Boolean(base.installed && latest && compareVersions(latest, base.installed) > 0) };
        } catch (error) {
          log(`runtime update check failed for ${row.id}: ${error.message}`);
          return { ...base, error: error.message };
        }
      }));
      // An older in-flight check must not replace a newer installation's check.
      if (revision === checkRevision) {
        checked = new Map(results.map((info, index) => [info.id, { info, installation: installation(rows[index]) }]));
        onChange(state());
      }
      return results;
    } finally {
      await connection.close();
    }
  }

  function schedule(engine, operation, action) {
    if (!engines[engine]) return Promise.reject(new Error('Unknown engine'));
    if (pending.has(engine)) return pending.get(engine).operation === operation ? pending.get(engine).task
      : Promise.reject(new Error('Wait for the runtime update to finish'));
    if (operation === 'reinstall') reinstalling.add(engine);
    if (operation === 'uninstall') uninstalling.add(engine);
    const task = Promise.resolve().then(action).finally(() => {
      pending.delete(engine);
      reinstalling.delete(engine);
      uninstalling.delete(engine);
      onChange(state());
    });
    pending.set(engine, { task, operation });
    onChange(state());
    return task;
  }
  const update = engine => schedule(engine, 'update', () => perform(engine));
  function uninstall(engine, plan) {
    return schedule(engine, 'uninstall', async () => {
      const restore = await beforeInstall(engine, 'uninstall');
      try {
        await manager.uninstall(engine, plan);
        checked.delete(engine);
        return { ok: true, engine, mode: plan.mode };
      } catch (error) {
        let available = false;
        try { available = Boolean(manager.locate(engine, plan.mode)); } catch { /* A partial removal may leave a stale custom path. */ }
        if (available && typeof restore === 'function') {
          try { await restore({ updated: false, error }); }
          catch (restoreError) { throw new AggregateError([error, restoreError], `${error.message}; ${restoreError.message}`); }
        }
        throw error;
      }
    });
  }
  function reinstall(engine, expected) {
    return schedule(engine, 'reinstall', async () => {
      const plan = expected || manager.reinstallPlan(engine);
      const restore = await beforeInstall(engine);
      let result, installError;
      try {
        const runtime = await manager.reinstall(engine, plan);
        result = { ok: true, engine, from: plan.version, to: runtime.version, changed: true, runtime, restartRequired: false, restarting: false };
      } catch (error) { installError = error; }
      try { if (typeof restore === 'function') await restore({ updated: Boolean(result), error: installError }); }
      catch (error) {
        if (installError) throw new AggregateError([installError, error], `${installError.message}; ${engines[engine].name} could not restart: ${error.message}`);
        throw new Error(`${engines[engine].name} reinstalled with Camellia, but could not restart: ${error.message}`, { cause: error });
      }
      if (installError) throw installError;
      return result;
    });
  }

  async function perform(engine) {
    const found = manager.locate(engine);
    if (!found) throw new Error('Download this engine before updating it');
    if (found.external) throw new Error('This CLI is installed outside Camellia. Update it using its original installer.');
    const connection = createDownloadConnection(downloadSettings());
    try {
      const cliRelease = engine === 'antigravity' && found.mode === 'subscription'
        ? await latestAntigravityCli(connection, { url: registryUrls.antigravity() }) : null;
      const latest = cliRelease?.version || await latestVersion(connection, engine, found.mode);
      if (!latest) throw new Error('Could not determine the latest version');
      if (compareVersions(latest, found.version) <= 0) {
        return { ok: true, engine, from: found.version, to: found.version, changed: false, restartRequired: false, restarting: false };
      }
      const restore = await beforeInstall(engine);
      let result, updateError;
      try {
        if (cliRelease) {
          await cliUpgrade({ dir: found.dir, release: cliRelease, connection, run, report: message => log(message) });
        } else if (engines[engine].type === 'python') {
          await upgradePythonRuntime({ dir: found.dir, run, connection, sdk: latest, report: () => {},
            python: manager.pythonSelection?.() });
        }
        else await upgradeNpmRuntime(engine, found.dir, connection, latest);
        const updated = manager.locate(engine);
        if (!updated || compareVersions(updated.version, latest) !== 0) throw new Error(`The update to v${latest} did not complete. Please retry.`);
        result = { ok: true, engine, from: found.version, to: latest, changed: true, restartRequired: false, restarting: false };
      } catch (error) { updateError = error; }
      try { if (typeof restore === 'function') await restore({ updated: Boolean(result), error: updateError }); }
      catch (error) {
        if (updateError) throw new AggregateError([updateError, error], `${updateError.message}; ${engines[engine].name} could not restart: ${error.message}`);
        throw new Error(`${engines[engine].name} updated to v${latest}, but could not restart: ${error.message}`, { cause: error });
      }
      if (updateError) throw updateError;
      return result;
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
    await run(node, args, { cwd: installDir, env: { ...connection.env,
      ...(engine === 'grok' ? { GROK_HOME: path.join(installDir, '.grok') } : {}),
      PATH: path.dirname(node) + path.delimiter + process.env.PATH } });
    if (engine === 'dsh') patchDsh(dir);
  }

  return { check, update, reinstall, uninstall, state, isUpdating: engine => pending.has(engine) };
}

module.exports = { compareVersions, createRuntimeUpdates };
