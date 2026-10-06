'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('camelliaMigration', {
  cancel: () => ipcRenderer.send('camellia:directory-migration-cancel'),
});
