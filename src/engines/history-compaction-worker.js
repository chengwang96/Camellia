'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

async function compactHistoryInWorker(input, signal) {
  signal?.throwIfAborted();
  const worker = new Worker(__filename, { workerData: input, execArgv: [] });
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason || new Error('History compaction canceled'));
  signal?.addEventListener('abort', abort, { once: true });
  const done = new Promise((resolve, reject) => {
    worker.on('message', ({ result, error }) => {
      if (error) reject(Object.assign(new Error(error.message), { code: error.code }));
      else resolve(result);
    });
    worker.on('error', reject);
    worker.on('exit', code => { if (code) reject(new Error('History compaction worker exited early (' + code + ')')); });
  });
  try { return await Promise.race([done, aborted]); }
  finally {
    signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

module.exports = { compactHistoryInWorker };

if (!isMainThread && require.main === module) {
  const { ConversationHistory } = require('./conversation-history');
  const history = new ConversationHistory(workerData.dir);
  try {
    const result = history.compactStreaming(workerData.id);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code } });
  } finally {
    history.close();
  }
}
