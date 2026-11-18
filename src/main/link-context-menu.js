'use strict';

function webLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

// Electron reports the link under the pointer, so the menu works even when the
// label itself is selected. Only web links get these actions: local document
// links keep their preview behaviour and mail links are not opened in a browser.
function attachLinkContextMenu(contents, { Menu, clipboard, openExternal, uiText, onError = () => {} }) {
  contents.on('context-menu', (_event, params) => {
    if (params.isEditable || params.mediaType === 'image') return;
    const href = webLink(params.linkURL);
    if (!href) return;
    const menu = Menu.buildFromTemplate([
      {
        label: uiText('Open in browser'),
        click: () => {
          try { Promise.resolve(openExternal(href)).catch(onError); }
          catch (error) { onError(error); }
        },
      },
      {
        label: uiText('Copy text'),
        enabled: Boolean(params.linkText),
        click: () => clipboard.writeText(params.linkText),
      },
      {
        label: uiText('Copy link'),
        click: () => clipboard.writeText(href),
      },
    ]);
    menu.popup({ frame: params.frame });
  });
}

module.exports = { attachLinkContextMenu, webLink };
