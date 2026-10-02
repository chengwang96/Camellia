'use strict';

const { pathToFileURL } = require('node:url');
function registerDiscussionIpc({ ipcMain, service, page, getWindow }) {
  const expected = pathToFileURL(page).href;
  ipcMain.handle('dsh:discussion', async (event, request) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split(/[?#]/)[0] !== expected) {
      return { ok: false, error: 'Discussion requests must come from the local discussion page.' };
    }
    try {
      if (!request || typeof request.action !== 'string') throw new Error('Invalid discussion action');
      return { ok: true, ...await service.call(request.action, request.payload) };
    } catch (error) {
      return { ok: false, error: error.message, ...(error.code === 'DISCUSSION_ACTION_UNSUPPORTED' ? { code: error.code } : {}),
        ...(typeof request?.action === 'string' ? { action: request.action } : {}) };
    }
  });
}
module.exports = { registerDiscussionIpc };
