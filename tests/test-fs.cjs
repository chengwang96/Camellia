'use strict';

// Shared test-file teardown. Windows CI keeps file locks alive briefly after
// child processes exit, and Defender scans fresh temp files, so a plain
// rmSync can die with EPERM even with its own retries. Retry longer, and if
// the tree still resists, warn instead of failing the suite: an orphaned
// temp directory is harmless next to a false-negative CI run.
const fs = require('node:fs');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeTree(target, { rounds = 10, delayMs = 1000 } = {}) {
  for (let round = 1; ; round++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      return true;
    } catch (error) {
      if (round >= rounds) { console.warn(`warn: temp cleanup skipped for ${target}: ${error.message}`); return false; }
      sleep(delayMs);
    }
  }
}

module.exports = { removeTree };
