'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

async function runFileSearch(type, payload, signal = null) {
  if (signal?.aborted) throw signal.reason || new Error('File search was cancelled');
  const worker = new Worker(__filename, { workerData: { type, payload }, execArgv: [] });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason || new Error('File search was cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  const done = new Promise((resolve, reject) => {
    worker.on('message', ({ result, error }) => {
      if (error) reject(Object.assign(new Error(error.message), { code: error.code }));
      else resolve(result);
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code) reject(new Error('File search worker exited early (' + code + ')'));
    });
  });
  try { return await Promise.race([done, aborted]); }
  finally {
    signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

function searchFilesAsync(options, signal) {
  return runFileSearch('name', options, signal);
}

function searchContentsAsync(options, signal) {
  return runFileSearch('content', options, signal);
}

module.exports = { searchFilesAsync, searchContentsAsync };

if (!isMainThread && require.main === module) {
  (async () => {
    try {
      const { searchFiles, searchContents } = require('./file-search');
      const result = workerData.type === 'name' ? searchFiles(workerData.payload)
        : workerData.type === 'content' ? await searchContents(workerData.payload)
          : (() => { throw new Error('Unsupported file search operation'); })();
      parentPort.postMessage({ result });
    } catch (error) { parentPort.postMessage({ error: { message: error.message, code: error.code } }); }
  })();
}
