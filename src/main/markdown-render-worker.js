'use strict';

const { renderChunked } = require('../renderer/chat/markdown-preview');

process.parentPort.on('message', async ({ data }) => {
  const { source, options } = data;
  try {
    await renderChunked(source, {
      ...options,
      onChunk(html) {
        process.parentPort.postMessage({ chunk: html });
      },
    });
    process.parentPort.postMessage({ done: true });
  } catch (error) {
    process.parentPort.postMessage({ error: error?.message || String(error) });
  }
});
