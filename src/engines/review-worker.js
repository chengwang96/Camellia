'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

async function runReviewJob(type, payload, signal = null) {
  if (signal?.aborted) throw signal.reason || new Error('Review preparation was cancelled');
  const worker = new Worker(__filename, { workerData: { type, payload }, execArgv: [] });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason || new Error('Review preparation was cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  const done = new Promise((resolve, reject) => {
    worker.on('message', ({ result, error }) => {
      if (error) reject(Object.assign(new Error(error.message), { code: error.code }));
      else resolve(result);
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code) reject(new Error('Review worker exited early (' + code + ')'));
    });
  });
  try { return await Promise.race([done, aborted]); }
  finally {
    signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

function execute(type, payload) {
  const { captureTarget, createWorkspaceSnapshot, changeSummary } = require('./review-control');
  if (type === 'capture') return captureTarget(payload.cwd, payload.options);
  if (type === 'snapshot') return createWorkspaceSnapshot(payload.cwd, payload.destination);
  if (type === 'summary') return changeSummary(payload.cwd);
  throw new Error('Unsupported review operation');
}

module.exports = { runReviewJob };

if (!isMainThread && require.main === module) {
  try { parentPort.postMessage({ result: execute(workerData.type, workerData.payload) }); }
  catch (error) { parentPort.postMessage({ error: { message: error.message, code: error.code } }); }
}
