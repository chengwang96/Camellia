'use strict';
const fs = require('node:fs');
const { importDataPackage } = require('../src/main/data-migration');
const [file, dataDir, home] = process.argv.slice(2);
const rename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  await rename(from, to);
  if (String(from).includes('.camellia-import-')) process.exit(23);
};
importDataPackage({ file, dataDir, home }).catch(error => { console.error(error); process.exitCode = 1; });
