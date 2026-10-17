'use strict';

const fs = require('node:fs');
const transient = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// Retry only a failed open, before any bytes could have been written. Retrying
// a whole write after a partial I/O failure can duplicate a JSONL record.
function retryOpen(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (error.syscall !== 'open' || !transient.has(error.code) || attempt >= 5) throw error;
      Atomics.wait(sleeper, 0, 0, 10 * (attempt + 1));
    }
  }
}

const openSync = (...args) => retryOpen(() => fs.openSync(...args));
const appendText = (file, text) => retryOpen(() => fs.appendFileSync(file, text));

module.exports = { openSync, appendText, retryOpen };
