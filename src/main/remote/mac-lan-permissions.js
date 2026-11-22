'use strict';

const os = require('node:os');

function createMacLanPermissions({ openExternal, platform = process.platform, release = os.release() } = {}) {
  if (platform !== 'darwin') return null;
  const darwinMajor = Number.parseInt(release, 10);
  const panels = new Map([
    ['firewall', darwinMajor >= 22
      ? 'x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall'
      : 'x-apple.systempreferences:com.apple.preference.security?Firewall'],
  ]);
  if (darwinMajor >= 24) {
    panels.set('privacy', 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork');
  }
  return {
    panels: Array.from(panels.keys()),
    async open(panel) {
      const url = panels.get(panel);
      if (!url) throw new Error('This macOS settings panel is unavailable');
      await openExternal(url);
    },
  };
}

module.exports = { createMacLanPermissions };
