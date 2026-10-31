'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('camelliaWindowChrome', {
  getState: () => ipcRenderer.invoke('camellia:window-chrome-state'),
  openMenu: payload => ipcRenderer.invoke('camellia:window-chrome-menu', payload),
  onState: callback => { ipcRenderer.on('camellia:window-chrome', (_event, state) => callback(state)); },
  onFocus: callback => { ipcRenderer.on('camellia:window-chrome-focus', () => callback()); },
});

contextBridge.exposeInMainWorld('camelliaRemote', {
  control: (action, payload) => ipcRenderer.invoke('dsh:remote-control', { action, payload }),
});
