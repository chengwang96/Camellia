'use strict';

function errorText(error) {
  return String(error?.message || error || 'Unknown error');
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function restartNetworkEngines({ engines, isBusy, stop, defer = () => {}, log = () => {}, timeoutMs = 10000 }) {
  const deferred = [];
  const idle = [];
  for (const engine of engines) {
    if (isBusy(engine)) {
      defer(engine, 'network change');
      deferred.push(engine);
    } else {
      idle.push(engine);
    }
  }
  const outcomes = await Promise.all(idle.map(async engine => {
    try {
      await withTimeout(Promise.resolve().then(() => stop(engine)), timeoutMs, `${engine} did not stop`);
      return { engine, error: '' };
    } catch (error) {
      return { engine, error: errorText(error) };
    }
  }));
  const restarted = [];
  const failed = [];
  for (const outcome of outcomes) {
    if (!outcome.error) {
      restarted.push(outcome.engine);
      continue;
    }
    failed.push(outcome);
    log(`${outcome.engine}: network change restart failed: ${outcome.error}`);
  }
  return { restarted, deferred, failed };
}

function networkChangeSummary(engines, verification) {
  const deferred = engines?.deferred || [];
  const failed = engines?.failed || [];
  const environmentConsistent = verification?.consistent === true;
  return {
    engineRestart: deferred.length === 0 && failed.length === 0,
    deferred: [...deferred],
    failed: [...failed],
    environmentConsistent,
    restartRequired: failed.length > 0 || !environmentConsistent,
  };
}

async function reapplyNetwork({ networkSettings, restartEngines, log = () => {} }) {
  try {
    const state = await networkSettings.reapply();
    const engines = await restartEngines();
    const verification = networkSettings.verify();
    return { ok: true, ...state, ...networkChangeSummary(engines, verification), verification };
  } catch (error) {
    const message = errorText(error);
    log(`network reapply failed: ${message}`);
    return { ok: false, error: message, restartRequired: true };
  }
}

module.exports = { restartNetworkEngines, networkChangeSummary, reapplyNetwork };
