'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// Keep the file identities in the worker between the scan and the final
// check. The main process still owns draft snapshots and authorizes removal.
async function inspectInWorker(input, signal, use) {
  signal?.throwIfAborted();
  const worker = new Worker(__filename, { workerData: input, execArgv: [] });
  let pending, failure;
  const fail = error => {
    failure ||= error;
    pending?.reject(failure);
    pending = null;
  };
  const abort = () => { fail(signal.reason); };
  worker.on('error', fail);
  worker.on('exit', code => fail(new Error('Storage worker exited early (' + code + ')')));
  worker.on('message', ({ result, error }) => {
    if (error) fail(error);
    else {
      pending?.resolve(result);
      pending = null;
    }
  });
  signal?.addEventListener('abort', abort, { once: true });
  const receive = () => failure ? Promise.reject(failure) : new Promise((resolve, reject) => { pending = { resolve, reject }; });
  try {
    const result = await receive();
    return await use(result, () => {
      const reply = receive();
      if (!failure) worker.postMessage('verify');
      return reply;
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

module.exports = { inspectInWorker };

if (!isMainThread && require.main === module) {
  async function prepare() {
    const { StorageCleanup } = require('./storage-cleanup');
    const { operation, references, options, dataDir, histories, conversations, liveOwners, active, now, maxVisited } = workerData;
    const cleanup = new StorageCleanup({ dataDir, histories, conversations: { items: new Map(conversations) },
      liveOwners: () => liveOwners, isActive: () => active, now: () => now, maxVisited });
    const { verification, ...result } = operation === 'retention'
      ? await cleanup.retentionInventory() : await cleanup.inventory(references, options);
    parentPort.on('message', () => {
      try {
        cleanup.verify(verification || []);
        parentPort.postMessage({ result: true });
      } catch (error) { parentPort.postMessage({ error }); }
    });
    parentPort.postMessage({ result });
  }
  prepare().catch(error => parentPort.postMessage({ error }));
}
