'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');
const { npmCandidates } = require('../src/main/runtime-paths');

function assertBuildHost(platform, arch, hostPlatform = process.platform, hostArch = process.arch) {
  if (platform !== hostPlatform || arch !== hostArch) {
    throw new Error(`Build ${platform}/${arch} on a matching host. Bundled Node.js and engine native dependencies come from the build machine.`);
  }
}
exports.assertBuildHost = assertBuildHost;
exports.default = async context => {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  assertBuildHost(platform, arch);
  require('./build-tailnet.cjs').buildTailnet({ root: context.packager.projectDir, platform, arch });
  const target = path.join(context.packager.projectDir, 'build/runtime-assets');
  const npmCli = npmCandidates(process.execPath).find(file => fs.existsSync(file));
  if (!npmCli) throw new Error('Packaging requires a complete Node.js/npm installation');
  const npmRoot = path.resolve(path.dirname(fs.realpathSync(npmCli)), '..');
  fs.mkdirSync(target, { recursive: true });
  const nodeTarget = path.join(target, platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(process.execPath, nodeTarget);
  if (platform !== 'win32') fs.chmodSync(nodeTarget, 0o755);
  fs.cpSync(npmRoot, path.join(target, 'npm'), { recursive: true });
  const licenseFile = path.join(target, 'NODE-LICENSE'), versionFile = path.join(target, 'version.json');
  const cachedLicense = fs.existsSync(licenseFile) && fs.existsSync(versionFile)
    && JSON.parse(fs.readFileSync(versionFile, 'utf8')).node === process.version;
  if (!cachedLicense) {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
    if (!response.ok) throw new Error("Could not fetch the bundled Node.js license");
    fs.writeFileSync(licenseFile, await response.text());
  }
  fs.writeFileSync(versionFile, JSON.stringify({ node: process.version, platform, arch }));
};
