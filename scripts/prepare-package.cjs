'use strict';
const path = require('node:path');
const { Arch } = require('builder-util');
const { readNodeVersion } = require('./node-version.cjs');
const { bundleNode, verifyNode } = require('./bundle-node.cjs');
const { verifyMacNode } = require('./bundle-macos-node.cjs');

function assertBuildHost(platform, arch, hostPlatform = process.platform, hostArch = process.arch) {
  if (platform !== hostPlatform || arch !== hostArch) {
    throw new Error(`Build ${platform}/${arch} on a matching host. Native build tools must match the package target.`);
  }
}
exports.assertBuildHost = assertBuildHost;
exports.default = async context => {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  assertBuildHost(platform, arch);
  const root = context.packager.projectDir;
  const version = readNodeVersion(root);
  require('./build-tailnet.cjs').buildTailnet({ root, platform, arch });
  const target = path.join(root, 'build/runtime-assets');
  await bundleNode({ root, target, platform, arch, version });
  const node = path.join(target, platform === 'win32' ? 'node.exe' : 'node');
  if (platform === 'darwin') {
    require('./build-discussion-helper.cjs').buildDiscussionHelper({ root, platform, arch });
    verifyMacNode({ node, arch, version });
  } else {
    verifyNode({ node, platform, arch, version });
  }
};
