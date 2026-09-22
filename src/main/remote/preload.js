'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('camelliaRemote', {
  control: (action, payload) => ipcRenderer.invoke('dsh:remote-control', { action, payload }),
});
