'use strict';

const { webFrame } = require('electron');

// Provider navigation stays hidden unless the layout runtime explicitly
// enables the site-sidebar fallback. Deciding this from the first frame, rather
// than only after the first extraction, keeps a sidebar from painting and then
// disappearing while the provider application boots.
const BOOT_CSS = `
  html:not([data-camellia-web-site-sidebar-visible]) .dc04ec1d,
  html:not([data-camellia-web-site-sidebar-visible]) ._4cbcd96,
  html:not([data-camellia-web-site-sidebar-visible]) .sidebar-slot {
    display: none !important;
  }
`;

try {
  webFrame.insertCSS(BOOT_CSS);
} catch {
  const install = () => {
    const style = document.createElement('style');
    style.textContent = BOOT_CSS;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.documentElement) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
}
