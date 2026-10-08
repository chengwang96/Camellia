'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { readNodeVersion } = require('./node-version.cjs');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function bundleNode({ target, platform, arch, root = path.resolve(__dirname, '..'), version = readNodeVersion(root),
  cacheDir = path.join(root, 'build/node-cache'), fetchImpl = fetch, run = execFileSync }) {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch) || !/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Unsupported official Node.js release: ${version}/${platform}/${arch}`);
  }
  const windows = platform === 'win32';
  const name = `node-${version}-${windows ? 'win' : platform}-${arch}`;
  const archiveName = name + (windows ? '.zip' : '.tar.gz');
  const base = `https://nodejs.org/download/release/${version}/`;
  const get = async file => {
    const response = await fetchImpl(base + file, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Could not download official Node.js ${file}: HTTP ${response.status}`);
    return response;
  };
  const cachedArchive = cacheDir && path.join(cacheDir, archiveName);
  const cachedSum = cachedArchive && cachedArchive + '.sha256';
  let checksum, archive;
  if (cachedArchive && fs.existsSync(cachedArchive) && fs.existsSync(cachedSum)) {
    const cachedChecksum = fs.readFileSync(cachedSum, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(cachedChecksum) && await sha256(cachedArchive) === cachedChecksum.toLowerCase()) {
      archive = cachedArchive;
      checksum = cachedChecksum.toLowerCase();
    }
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-node-dist-'));
  try {
    if (!archive) {
      const sums = await (await get('SHASUMS256.txt')).text();
      checksum = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/))
        .find(parts => parts[1] === archiveName)?.[0];
      if (!/^[a-f0-9]{64}$/i.test(checksum || '')) throw new Error(`Missing official Node.js checksum for ${archiveName}`);
      checksum = checksum.toLowerCase();
      archive = path.join(temp, archiveName);
      await pipeline(Readable.fromWeb((await get(archiveName)).body), fs.createWriteStream(archive));
      if (await sha256(archive) !== checksum) throw new Error(`Official Node.js checksum mismatch for ${archiveName}`);
    }
    const nodeEntry = windows ? 'node.exe' : 'bin/node';
    const npmEntry = windows ? 'node_modules/npm' : 'lib/node_modules/npm';
    run('tar', [windows ? '-xf' : '-xzf', archive, '-C', temp, `${name}/${nodeEntry}`, `${name}/${npmEntry}`, `${name}/LICENSE`],
      { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    const source = path.join(temp, name);
    const npm = path.join(source, npmEntry);
    for (const file of [path.join(source, nodeEntry), path.join(npm, 'bin/npm-cli.js'), path.join(npm, 'package.json'), path.join(source, 'LICENSE')]) {
      if (!fs.statSync(file).isFile()) throw new Error(`Missing official Node.js runtime file: ${file}`);
    }
    if (cachedArchive && archive !== cachedArchive) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.copyFileSync(archive, cachedArchive);
      fs.writeFileSync(cachedSum, checksum + '\n');
    }
    const destination = path.resolve(target);
    fs.mkdirSync(destination, { recursive: true });
    const node = path.join(destination, windows ? 'node.exe' : 'node');
    fs.copyFileSync(path.join(source, nodeEntry), node);
    if (!windows) fs.chmodSync(node, 0o755);
    const npmTarget = path.join(destination, 'npm');
    if (path.dirname(npmTarget) !== destination) throw new Error('Unsafe npm packaging path');
    fs.rmSync(npmTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.cpSync(npm, npmTarget, { recursive: true, verbatimSymlinks: true });
    fs.copyFileSync(path.join(source, 'LICENSE'), path.join(destination, 'NODE-LICENSE'));
    const info = { node: version, platform, arch, source: 'nodejs.org', sha256: checksum };
    fs.writeFileSync(path.join(destination, 'version.json'), JSON.stringify(info));
    return info;
  } finally {
    if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('camellia-node-dist-')) {
      throw new Error('Unsafe Node.js packaging cleanup path');
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function verifyNode({ node, platform, arch, version, run = execFileSync, env = process.env }) {
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^DYLD_|^NODE_OPTIONS$|^NODE_PATH$|^PATH$/i.test(key)));
  cleanEnv.PATH = platform === 'win32'
    ? [path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32'), env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'].join(';')
    : '/usr/bin:/bin:/usr/sbin:/sbin';
  const options = { env: cleanEnv, cwd: path.dirname(node), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  const info = JSON.parse(run(node, ['-p', "JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,sqlite:typeof require('node:sqlite').DatabaseSync})"], options));
  if (info.node !== version || info.platform !== platform || info.arch !== arch || info.sqlite !== 'function') {
    throw new Error('Bundled Node.js failed its platform/version/SQLite check: ' + JSON.stringify(info));
  }
  const npm = path.join(path.dirname(node), 'npm');
  const npmVersion = JSON.parse(fs.readFileSync(path.join(npm, 'package.json'), 'utf8')).version;
  if (run(node, [path.join(npm, 'bin/npm-cli.js'), '--version'], options).trim() !== npmVersion) {
    throw new Error('Bundled npm failed its version check');
  }
  return info;
}

module.exports = { bundleNode, verifyNode };
