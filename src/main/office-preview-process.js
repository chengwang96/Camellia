'use strict';

const fs = require('node:fs');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

async function renderOfficePreview(payload, signal = null) {
  if (signal?.aborted) throw signal.reason || new Error('Office preview was cancelled');
  const worker = new Worker(__filename, { workerData: payload, execArgv: [] });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason || new Error('Office preview was cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  const done = new Promise((resolve, reject) => {
    worker.on('message', ({ result, error }) => {
      if (error) reject(new Error(error));
      else resolve(result);
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code) reject(new Error('Office renderer exited early (' + code + ')'));
    });
  });
  try { return await Promise.race([done, aborted]); }
  finally {
    signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

async function execute(payload) {
  const { readOfficePreview } = require('./office-preview');
  if (payload.type === 'office') return readOfficePreview(payload.filePath, payload.kind, payload.language);
  if (payload.type === 'word') {
    if ((await fs.promises.stat(payload.filePath)).size > 100 * 1024 * 1024) throw new Error('This Office file is too large to preview.');
    const source = await fs.promises.readFile(payload.filePath), wordSource = {};
    const office = await readOfficePreview(payload.filePath, 'word', payload.language, { source, wordSource });
    const { readDocxEdit } = require('./docx-edit');
    try { return { office, snapshot: await readDocxEdit(payload.filePath, { source, content: wordSource.content }), editError: '' }; }
    catch (error) { return { office, snapshot: null, editError: error?.message || String(error) }; }
  }
  if (payload.type === 'legacy') {
    const { isWordDocument, readDocPreview } = require('./doc-preview');
    return { office: isWordDocument(payload.filePath) ? readDocPreview(payload.filePath) : null };
  }
  const { saveDocxEdit, saveDocxStructure, readDocxCellPreview } = require('./docx-edit');
  if (payload.type === 'save') return saveDocxEdit(payload.snapshot, payload.paragraphs);
  if (payload.type === 'structure') return saveDocxStructure(payload.snapshot, payload.operation);
  if (payload.type === 'cell') return { html: await readDocxCellPreview(payload.snapshot, payload.index) };
  throw new Error('Unsupported Office preview operation');
}

module.exports = { renderOfficePreview };

if (!isMainThread && require.main === module) {
  execute(workerData).then(
    result => parentPort.postMessage({ result }),
    error => parentPort.postMessage({ error: error?.message || String(error) }),
  );
}
