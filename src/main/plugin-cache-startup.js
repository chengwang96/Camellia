'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readJson, writeJson } = require('../shared/json-store');
const { maintainPluginCaches, OPERATION } = require('./plugin-cache-maintenance');

const REQUEST = '.camellia-plugin-cache-maintenance.json';
const RESULT = '.camellia-plugin-cache-maintenance-result.json';

function statePath(dataDir, name) {
  const root = path.resolve(dataDir), file = path.join(root, name);
  try { if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Linked maintenance path'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Linked maintenance state'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}

function pluginCacheMaintenanceStatus(dataDir) {
  return { pending: fs.existsSync(statePath(dataDir, REQUEST)), result: readJson(statePath(dataDir, RESULT), null) };
}

function requestPluginCacheMaintenance(dataDir) {
  const file = statePath(dataDir, REQUEST);
  if (fs.existsSync(file)) throw new Error('Plugin cache maintenance is already scheduled');
  writeJson(file, { version: 1, requestedAt: Date.now() });
  return { pending: true };
}

function cancelPluginCacheMaintenance(dataDir) {
  const file = statePath(dataDir, REQUEST);
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function assertPluginCachesOffline(dataDir) {
  if (dataDir && fs.existsSync(statePath(dataDir, 'server.lock'))) throw new Error('Stop the Camellia server before plugin cache maintenance');
  // CODEX_HOME is an environment variable, absent from the command line. A
  // surviving app-server cannot be attributed safely to a different home.
  // Ignore unrelated Electron windows; only native app-server processes block.
  let listing;
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process -Filter "Name LIKE \'%codex%\'" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const output = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    const records = output.trim() ? JSON.parse(output) : [];
    listing = (Array.isArray(records) ? records : [records]).filter(record => record.ProcessId !== process.pid);
    if (listing.some(record => !record.CommandLine || /(?:^|\s)app-server(?:\s|$)/.test(record.CommandLine))) throw new Error('Close running Codex app-server processes before plugin cache maintenance');
  } else {
    listing = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 15_000 });
    if (listing.split('\n').some(line => /\bcodex\b.*\bapp-server\b/.test(line) && Number(line.trim().split(/\s+/)[0]) !== process.pid)) throw new Error('Close running Codex app-server processes before plugin cache maintenance');
  }
}

function completePluginCacheMaintenance({ dataDir, app, assertOffline = assertPluginCachesOffline, onProgress, onStep } = {}) {
  const request = statePath(dataDir, REQUEST), operation = path.join(dataDir, 'codex', OPERATION);
  if (!fs.existsSync(request) && !fs.existsSync(operation)) return null;
  let progress, result;
  try {
    const pending = readJson(request, null);
    if (pending && (pending.version !== 1 || !Number.isFinite(pending.requestedAt))) throw new Error('Invalid plugin cache maintenance request');
    assertOffline(dataDir);
    if (app) progress = require('./data-directory-progress').createDirectoryMigrationProgress({ app, dataDir, kind: 'plugins' });
    result = maintainPluginCaches(dataDir, { apply: true, onProgress: state => { onProgress?.(state); progress?.onProgress(state); }, onStep });
  } catch (error) {
    result = { ...error.result, error: error.message, canceled: error.code === 'CAMELLIA_CACHE_CANCELLED', recoveryRequired: fs.existsSync(operation) };
  }
  result.finishedAt = Date.now();
  // A completed or canceled request is consumed. Merely running Camellia later
  // must never silently launch a second expensive maintenance pass.
  writeJson(statePath(dataDir, RESULT), result);
  if (!result.recoveryRequired) cancelPluginCacheMaintenance(dataDir);
  progress?.finish(result);
  return result;
}

module.exports = { REQUEST, RESULT, pluginCacheMaintenanceStatus, requestPluginCacheMaintenance, cancelPluginCacheMaintenance,
  completePluginCacheMaintenance, assertPluginCachesOffline };
