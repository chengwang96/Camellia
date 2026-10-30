'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

// Publish a complete derived native module atomically. Its location preserves
// relative imports/assets, and a crash cannot leave a reusable partial file.
function nativeHistoryModule(original, source) {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const extension = path.extname(original);
  const file = path.join(path.dirname(original), 'camellia-history-' + hash + extension);
  if (fs.existsSync(file)) return file;
  const staging = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(staging, source, { flag: 'wx' });
    try { fs.renameSync(staging, file); }
    catch (error) {
      // Concurrent launchers materialize the same content-addressed module.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || !fs.existsSync(file)) throw error;
    }
  } finally { fs.rmSync(staging, { force: true }); }
  return file;
}

module.exports = { nativeHistoryModule };
