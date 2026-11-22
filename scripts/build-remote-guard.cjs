'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildRemoteGuard({ root = path.resolve(__dirname, '..'), platform = process.platform, arch = process.arch,
  target = path.join(root, 'build/runtime-assets') } = {}) {
  if (!['win32', 'darwin'].includes(platform)) throw new Error(`Unsupported remote guard platform: ${platform}`);
  const goos = platform === 'win32' ? 'windows' : 'darwin';
  const goarch = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!goarch) throw new Error(`Unsupported remote guard architecture: ${arch}`);
  fs.mkdirSync(target, { recursive: true });
  const go = process.env.CAMELLIA_GO || 'go';
  const executable = path.join(target, platform === 'win32' ? 'camellia-remote-guard.exe' : 'camellia-remote-guard');
  execFileSync(go, ['build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', executable, '.'], {
    cwd: path.join(root, 'integrations/remote-guard'), windowsHide: true, encoding: 'utf8',
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
  });
  if (platform !== 'win32') fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(target, 'remote-guard-version.json'),
    JSON.stringify({ protocol: 1, platform, arch }));
  const goRoot = execFileSync(go, ['env', 'GOROOT'], { encoding: 'utf8', windowsHide: true }).trim();
  const license = [path.join(goRoot, 'LICENSE'), path.join(goRoot, '..', 'LICENSE')]
    .find(file => fs.existsSync(file));
  if (!license) throw new Error('Go license is missing from the build toolchain');
  fs.writeFileSync(path.join(target, 'REMOTE-GUARD-NOTICES.txt'),
    'Camellia remote guard\n\nGo runtime and standard library:\n\n' + fs.readFileSync(license, 'utf8'));
  return executable;
}

module.exports = { buildRemoteGuard };
if (require.main === module) console.log(buildRemoteGuard());
