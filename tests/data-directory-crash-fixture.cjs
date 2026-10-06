'use strict';

// Only isolated test profiles are accepted. Exit without catch/finally so the
// next process exercises the on-disk recovery journal, not in-memory rollback.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { completeDirectoryMigration } = require('../src/main/data-directory');
const root = process.argv[2], crash = process.argv[3];
assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
assert.ok(path.basename(root).startsWith('camellia-rename-test-'));
if (crash === 'swap') {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).includes(path.sep + 'updated' + path.sep) && String(to).startsWith(path.join(root, 'camellia') + path.sep)) process.exit(23);
    return rename(from, to);
  };
} else if (crash === 'committed') {
  const rm = fs.rmSync;
  fs.rmSync = (file, options) => {
    if (path.basename(file).startsWith('.camellia-migration-work-')) process.exit(23);
    return rm(file, options);
  };
}
const result = completeDirectoryMigration({ appData: root, dataDir: path.join(root, 'dsh-desktop'),
  activate: () => { if (crash === 'activation') process.exit(23); },
  onProgress: state => {
    if ((crash === 'prepare' && state.stage === 'prepare' && state.processedEntries === 1)
      || (crash === 'root' && state.stage === 'move' && state.processedEntries === 1)
      || (crash === 'moved' && state.stage === 'move' && state.processedEntries === 2)) process.exit(23);
  } });
console.error('Expected an abrupt exit, got:', result);
process.exit(1);
