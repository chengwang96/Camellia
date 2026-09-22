'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildTailnet({ root = path.resolve(__dirname, '..'), platform = process.platform, arch = process.arch } = {}) {
  const target = path.join(root, 'build/runtime-assets');
  const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const goarch = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!goos || !goarch) throw new Error(`Unsupported embedded network platform: ${platform}/${arch}`);
  fs.mkdirSync(target, { recursive: true });
  const options = { cwd: path.join(root, 'integrations/tailnet'), windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' } };
  const go = process.env.CAMELLIA_GO || 'go';
  const run = args => execFileSync(go, args, options);
  const executable = path.join(target, platform === 'win32' ? 'camellia-tailnet.exe' : 'camellia-tailnet');
  run(['build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', executable, '.']);
  const modules = JSON.parse('[' + run(['list', '-m', '-json', 'all']).trim().replace(/}\s*{/g, '},{') + ']');
  const notices = ['Camellia embedded networking — third-party notices', 'Tailscale is a separate service. Camellia is not an official Tailscale application.'];
  for (const entry of modules) {
    if (entry.Main || !entry.Dir) continue;
    for (const name of fs.readdirSync(entry.Dir).filter(name => /^(LICENSE|COPYING|NOTICE)(\..*)?$/i.test(name))) {
      const file = path.join(entry.Dir, name);
      if (fs.statSync(file).isFile()) notices.push(`\n=== ${entry.Path} ${entry.Version} / ${name} ===\n`, fs.readFileSync(file, 'utf8'));
    }
  }
  if (!notices.some(text => text.includes('tailscale.com'))) throw new Error('Missing Tailscale license');
  fs.writeFileSync(path.join(target, 'TAILNET-NOTICES.txt'), notices.join('\n'));
  fs.writeFileSync(path.join(target, 'tailnet-version.json'), JSON.stringify({ platform, arch, tailscale: modules.find(entry => entry.Path === 'tailscale.com').Version }));
  return executable;
}

if (require.main === module) console.log(buildTailnet());
module.exports = { buildTailnet };
