'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { previewKind } = require('./file-preview');

function attachImageContextMenu(contents, { Menu, dialog, BrowserWindow, uiText }) {
  contents.on('context-menu', (_event, params) => {
    if (params.isEditable || params.mediaType !== 'image') return;
    let sourcePath;
    try { sourcePath = fileURLToPath(params.srcURL); }
    catch { return; }
    if (previewKind(sourcePath) !== 'image') return;

    const reportError = error => dialog.showErrorBox(uiText('Image action failed'), error?.message || String(error));
    const menu = Menu.buildFromTemplate([
      {
        label: uiText('Copy image to clipboard'),
        enabled: params.hasImageContents,
        click: () => {
          try {
            if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
          } catch (error) { reportError(error); }
        },
      },
      {
        label: uiText('Save image as…'),
        click: async () => {
          try {
            if (contents.isDestroyed()) return;
            const extension = path.extname(sourcePath).slice(1);
            const options = {
              title: uiText('Save image as…'),
              defaultPath: path.basename(sourcePath),
              filters: [
                { name: extension.toUpperCase(), extensions: [extension] },
                { name: uiText('All files'), extensions: ['*'] },
              ],
            };
            const owner = BrowserWindow.fromWebContents(contents);
            const result = await (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options));
            if (result.canceled || !result.filePath) return;
            if (path.resolve(result.filePath) === path.resolve(sourcePath)) return;
            await fs.copyFile(sourcePath, result.filePath);
          } catch (error) { reportError(error); }
        },
      },
    ]);
    menu.popup({ frame: params.frame });
  });
}

module.exports = { attachImageContextMenu };
