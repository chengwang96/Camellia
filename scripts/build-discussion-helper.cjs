'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildDiscussionHelper({ root = path.resolve(__dirname, '..'), platform = process.platform, arch = process.arch,
  target } = {}) {
  if (!['darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Unix discussion helper target');
  root = path.resolve(root);
  target = target ? path.resolve(root, target) : path.join(root, 'build/runtime-assets');
  fs.mkdirSync(target, { recursive: true });
  const executable = path.join(target, 'camellia-discussion-job');
  execFileSync(process.env.CAMELLIA_GO || 'go', ['build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', executable, '.'], {
    cwd: path.join(root, 'integrations/discussion-job'), windowsHide: true, encoding: 'utf8',
    env: { ...process.env, GOOS: platform, GOARCH: { x64: 'amd64', arm64: 'arm64' }[arch], CGO_ENABLED: '0' },
  });
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(target, 'discussion-job-version.json'), JSON.stringify({ protocol: 1, platform, arch }));
  const goRoot = execFileSync(process.env.CAMELLIA_GO || 'go', ['env', 'GOROOT'], { encoding: 'utf8', windowsHide: true }).trim();
  // Homebrew keeps the license beside libexec rather than inside GOROOT.
  const license = [path.join(goRoot, 'LICENSE'), path.join(goRoot, '..', 'LICENSE')]
    .find(file => fs.existsSync(file));
  if (!license) throw new Error('Go license is missing from the build toolchain');
  fs.writeFileSync(path.join(target, 'DISCUSSION-JOB-NOTICES.txt'), 'Camellia discussion supervision\n\nGo runtime and standard library:\n\n'
    + fs.readFileSync(license, 'utf8'));
  return executable;
}
module.exports = { buildDiscussionHelper };
if (require.main === module) console.log(buildDiscussionHelper());
