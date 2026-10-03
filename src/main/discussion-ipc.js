'use strict';

const { pathToFileURL } = require('node:url');
const { readFile } = require('node:fs/promises');
function registerDiscussionIpc({ ipcMain, service, page, chatPage, navigate, getWindow }) {
  const expected = pathToFileURL(page).href;
  const chat = chatPage && pathToFileURL(chatPage).href;
  ipcMain.handle('dsh:discussion', async (event, request) => {
    const window = getWindow();
    const source = event.senderFrame?.url.split(/[?#]/)[0];
    const workbench = chat && source === chat;
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== event.sender.mainFrame || source !== expected && !workbench) {
      return { ok: false, error: 'Discussion requests must come from the local discussion page.' };
    }
    try {
      if (!request || typeof request.action !== 'string') throw new Error('Invalid discussion action');
      // The integrated workbench mounts this fixed local template. Paths and
      // executable content cannot be supplied by a discussion or a renderer.
      if (request.action === 'template') return { ok: true, html: await readFile(page, 'utf8') };
      if (request.action === 'open' && navigate) {
        const { id, intent } = request.payload || {};
        if (id !== undefined && (typeof id !== 'string' || !id || id.length > 128)) throw new Error('Invalid discussion id');
        if (intent !== undefined && !['create', 'rename', 'delete'].includes(intent)) throw new Error('Invalid discussion navigation');
        if (id && !(await service.call('list')).groups.some(group => group.id === id)) throw new Error('Discussion not found');
        return await navigate({ ...(id ? { group: id } : {}), ...(intent ? { intent } : {}) });
      }
      return { ok: true, ...await service.call(request.action, request.payload) };
    } catch (error) {
      return { ok: false, error: error.message, ...(error.code === 'DISCUSSION_ACTION_UNSUPPORTED' ? { code: error.code } : {}),
        ...(typeof request?.action === 'string' ? { action: request.action } : {}) };
    }
  });
}
module.exports = { registerDiscussionIpc };
