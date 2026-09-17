'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { kimiEnvironment } = require('./kimi-session');

// Query the official CLI's local account API. It owns OAuth refresh and
// provider requests; neither OAuth credentials nor the local token reach IPC.
async function readKimiQuota({ home, file, node, environment, signal, spawnProcess = spawn, fetchImpl = fetch, timeoutMs = 20000 }) {
  const cwd = fs.realpathSync.native(home);
  const proc = spawnProcess(node, [file, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open', '--log-level', 'error'], {
    cwd, env: kimiEnvironment(home, environment), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => proc.once('close', resolve));
  let timer, abort;
  try {
    const url = await new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8'); let output = '';
      abort = () => reject(new Error('Kimi quota query cancelled'));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error('Kimi quota query timed out')), timeoutMs);
      proc.once('error', () => reject(new Error('Could not start Kimi quota query')));
      proc.once('close', () => reject(new Error('Kimi quota query exited before it was ready')));
      proc.stderr.on('data', () => {});
      proc.stdout.on('data', chunk => {
        output = (output + decoder.write(chunk)).slice(-8192);
        const ready = output.match(/Kimi server: (http:\/\/127\.0\.0\.1:\d+\/#token=[^\s]+)\r?\n/);
        if (ready) resolve(new URL(ready[1]));
      });
    });
    clearTimeout(timer);
    const response = await fetchImpl(`${url.origin}/api/v1/oauth/usage`, {
      headers: { Authorization: `Bearer ${url.hash.slice('#token='.length)}`, Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Kimi quota query failed (HTTP ${response.status})`);
    const result = (await response.json()).data;
    if (result?.kind !== 'ok') throw new Error('Could not load Kimi quota. Check your connection or refresh your account.');
    return normalizeKimiQuota(result);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    proc.kill();
    const force = setTimeout(() => proc.kill('SIGKILL'), 2000);
    await closed; clearTimeout(force);
  }
}

function normalizeKimiQuota(result) {
  const windows = [], balances = [];
  // 0.43 reports absolute limits; newer CLIs expose named usage ratios.
  if (result.quota) {
    const labels = { limit5h: '5-hour', limit7d: 'Weekly', monthTotal: 'Monthly total', monthCode: 'Monthly coding' };
    for (const [id, row] of Object.entries(result.quota.usages || {})) {
      if (typeof row?.usedRatio === 'number' && Number.isFinite(row.usedRatio)) windows.push({ id, label: labels[id] || id,
        usedPercent: Math.max(0, row.usedRatio * 100), resetsAt: row.resetAt || null });
    }
  } else {
    const rows = [{ ...result.summary, id: 'weekly', label: 'Weekly' }, ...(result.limits || []).map((row, i) => ({ ...row, id: 'limit-' + i }))];
    for (const row of rows) {
      if (!Number.isFinite(row.used) || !Number.isFinite(row.limit) || row.limit <= 0) continue;
      const label = row.name || row.label || (row.window ? `${row.window.duration} ${row.window.unit}${row.window.duration === 1 ? '' : 's'}` : 'Subscription quota');
      windows.push({ id: row.id, label, usedPercent: Math.max(0, row.used / row.limit * 100), resetsAt: row.reset_at || null });
    }
  }
  const wallet = result.quota?.extraUsage || result.extra_usage;
  if (wallet) {
    const cents = wallet.balanceCents ?? wallet.balance_cents;
    if (Number.isFinite(cents) && wallet.currency) balances.push({ id: 'extra-usage', label: 'Extra usage balance', value: cents / 100, currency: wallet.currency });
  }
  if (!windows.length && !balances.length) throw new Error('Kimi did not return quota or balance information.');
  return { balances, windows, modelUsage: [] };
}

module.exports = { readKimiQuota, normalizeKimiQuota };
