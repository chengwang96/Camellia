'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataPackage, importDataPackage } = require('../src/main/data-migration');
const { removeTree } = require('./test-fs.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-import-memory-'));
  const source = { dataDir: path.join(root, 'source'), home: path.join(root, 'source-home') };
  const target = name => ({ dataDir: path.join(root, name), home: path.join(root, name + '-home') });
  const history = path.join(source.dataDir, 'conversations', 'large.jsonl');
  const createWriteStream = fs.createWriteStream;
  try {
    fs.mkdirSync(path.dirname(history), { recursive: true });
    const chunk = Buffer.alloc(1024 * 1024, 7), fd = fs.openSync(history, 'w');
    try { for (let i = 0; i < 256; i++) fs.writeSync(fd, chunk); }
    finally { fs.closeSync(fd); }
    const config = '{"language":"zh-CN"}';
    fs.writeFileSync(path.join(source.dataDir, 'desktop-config.json'), config);
    const file = path.join(root, 'profile.zip');
    await createDataPackage({ ...source, destination: file });
    const measurements = {};
    for (const scope of ['settings', 'all']) {
      global.gc?.();
      const baseline = process.memoryUsage().rss;
      let peak = baseline, stagedPeak = 0;
      const staged = new Set();
      const measureDisk = () => {
        let bytes = 0;
        for (const file of staged) { try { bytes += fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        stagedPeak = Math.max(stagedPeak, bytes);
      };
      fs.createWriteStream = (name, ...args) => {
        const rel = path.relative(os.tmpdir(), path.resolve(String(name)));
        if (/^camellia-migration-[0-9a-f-]{36}[\\/]/.test(rel)) staged.add(String(name));
        else measureDisk(); // Transaction copy starts after all staging is validated.
        return createWriteStream(name, ...args);
      };
      const result = await importDataPackage({ ...target(scope), file, scope,
        onProgress() { peak = Math.max(peak, process.memoryUsage().rss); } });
      peak = Math.max(peak, process.memoryUsage().rss);
      fs.createWriteStream = createWriteStream;
      measurements[scope] = { rssGrowth: peak - baseline, stagingPeakBytes: stagedPeak, restored: result.restored };
    }
    measurements.historyBytes = fs.statSync(history).size;
    measurements.restoredBytes = fs.statSync(path.join(target('all').dataDir, 'conversations', 'large.jsonl')).size;
    process.stdout.write(JSON.stringify(measurements));
  } finally { fs.createWriteStream = createWriteStream; removeTree(root); }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
