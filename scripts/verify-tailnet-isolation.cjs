'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REQUIRED_TAG = '-tags=ts_omit_useproxy';
const FORBIDDEN_SYMBOLS = ['tailscale.com/feature/useproxy', 'tailscale.com/net/tshttpproxy', 'WinHttpGetProxyForUrl'];
const BINARY_MAGIC = [0x4d5a, 0x7f454c46, 0xcafebabe, 0xfeedfacf, 0xcffaedfe, 0xcefaedfe, 0xfecaedfe, 0x213c6172];

function go(args, options = {}) {
  try {
    return execFileSync(process.env.CAMELLIA_GO || 'go', args, {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options,
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`go ${args[0]} failed: ${detail}`);
  }
}

function goBuildInfo(file) {
  const available = spawnSync(process.env.CAMELLIA_GO || 'go', ['version'],
    { windowsHide: true, encoding: 'utf8' });
  if (available.error) return null;
  try {
    return go(['version', '-m', file]);
  } catch (error) {
    // `go version -m` rejects binaries whose build info Go cannot parse.
    // The framework's exported binary is checked by its embedded tag below.
    return null;
  }
}

function isBinary(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(4);
    const read = fs.readSync(handle, header, 0, 4, 0);
    if (read < 2) return false;
    return BINARY_MAGIC.some(magic => {
      if (magic <= 0xffff) return header.readUInt16LE(0) === magic;
      return header.readUInt32BE(0) === magic >>> 0;
    });
  } finally {
    fs.closeSync(handle);
  }
}

function inspectBinary(file) {
  const info = goBuildInfo(file);
  const bytes = fs.readFileSync(file);
  // Release acceptance machines verify downloaded and installed packages and
  // do not carry a Go toolchain. The tag is part of the build info Go writes
  // into the binary, so its absence still fails closed without `go version`.
  if (info == null ? !bytes.includes(Buffer.from(REQUIRED_TAG)) : !info.includes(REQUIRED_TAG))
    throw new Error(`${file} was not built with ${REQUIRED_TAG}`);
  for (const symbol of FORBIDDEN_SYMBOLS) {
    if (bytes.includes(Buffer.from(symbol))) throw new Error(`${file} still contains ${symbol}`);
  }
  return { file, bytes: bytes.length };
}

function zipEntries(zipFile) {
  const JSZip = require('jszip');
  return JSZip.loadAsync(fs.readFileSync(zipFile));
}

async function extractEntry(zipFile, entry, directory) {
  const target = path.join(directory, entry.replace(/[\\/]/g, '__'));
  const archive = await zipEntries(zipFile);
  const data = await archive.file(entry)?.async('nodebuffer');
  if (!data) throw new Error(`Cannot read ${entry} from ${zipFile}`);
  fs.writeFileSync(target, data);
  return target;
}

function findFiles(root) {
  if (!fs.existsSync(root)) throw new Error(`Missing artifact: ${root}`);
  if (!fs.statSync(root).isDirectory()) return [root];
  const files = [];
  const walk = directory => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  walk(root);
  return files;
}

function runtimeDirectory(bundle, platform) {
  return path.join(bundle, platform === 'macos' ? 'Contents/Resources/runtime' : 'resources/runtime');
}

function verifyExecutable(file) {
  if (!fs.statSync(file).isFile()) throw new Error(`Missing executable: ${file}`);
  return inspectBinary(file);
}

async function verifyAar(file) {
  const archive = await zipEntries(file);
  const entries = Object.keys(archive.files).filter(entry => /(^|\/)jni\/[^/]+\/libgojni\.so$/.test(entry));
  if (!entries.length) throw new Error(`${file} contains no libgojni.so`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tailnet-aar-'));
  const results = [];
  try {
    for (const entry of entries) {
      const binary = await extractEntry(file, entry, directory);
      results.push(inspectBinary(binary));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return results;
}

async function verifyApk(file) {
  const archive = await zipEntries(file);
  const entries = Object.keys(archive.files).filter(entry => /^lib\/[^/]+\/libgojni\.so$/.test(entry));
  if (!entries.length) throw new Error(`${file} contains no libgojni.so`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tailnet-apk-'));
  const results = [];
  try {
    for (const entry of entries) {
      const binary = await extractEntry(file, entry, directory);
      results.push(inspectBinary(binary));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return results;
}

async function verifyDirectory(root) {
  if (/\.xcframework$/.test(root)) return verifyXcframework(root);
  const files = findFiles(root);
  const executables = files.filter(file => /(^|[\\/])camellia-tailnet(?:\.exe)?$/.test(file));
  const archives = files.filter(file => /\.aar$/.test(file));
  const results = [];
  for (const file of executables) results.push(verifyExecutable(file));
  for (const file of archives) results.push(...await verifyAar(file));
  const frameworks = fs.readdirSync(root, { recursive: true })
    .map(name => path.join(root, name)).filter(file => file.endsWith('.xcframework') && fs.statSync(file).isDirectory());
  for (const file of frameworks) results.push(...await verifyXcframework(file));
  if (!results.length) throw new Error(`No embedded network artifact found in ${root}`);
  return results;
}

async function verifyXcframework(file) {
  const frameworks = fs.readdirSync(file, { recursive: true })
    .map(name => path.join(file, name))
    .filter(candidate => candidate.endsWith('.framework') && fs.statSync(candidate).isDirectory());
  if (!frameworks.length) throw new Error(`No framework found in ${file}`);
  const results = [];
  for (const framework of frameworks) {
    const binary = path.join(framework, path.basename(framework, '.framework'));
    if (!fs.existsSync(binary) || !isBinary(binary))
      throw new Error(`Missing framework binary: ${binary}`);
    results.push(inspectBinary(binary));
  }
  if (!results.length) throw new Error(`No Go binary found in ${file}`);
  return results;
}

async function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) throw new Error('Usage: node scripts/verify-tailnet-isolation.cjs <path>...');
  const results = [];
  for (const input of inputs) {
    const file = path.resolve(input);
    if (!fs.existsSync(file)) throw new Error(`Missing artifact: ${file}`);
    results.push(...await verifyPath(file));
  }
  for (const result of results) console.log(`PASS: ${result.file} includes ${REQUIRED_TAG}`);
}

async function verifyPath(file) {
  // XCFramework is a directory, so its extension must be checked before the
  // generic bundle/directory walker. Otherwise the framework is scanned for
  // nested `.xcframework` folders and incorrectly reported as absent.
  if (/\.xcframework$/.test(file)) return verifyXcframework(file);
  if (/\.aar$/.test(file)) return verifyAar(file);
  if (/\.apk$/.test(file)) return verifyApk(file);
  if (fs.statSync(file).isDirectory()) return verifyDirectory(file);
  return [verifyExecutable(file)];
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { REQUIRED_TAG, FORBIDDEN_SYMBOLS, goBuildInfo, inspectBinary, verifyAar, verifyApk, verifyXcframework, verifyPath, runtimeDirectory };
