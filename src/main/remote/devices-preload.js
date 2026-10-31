'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('camelliaWindowChrome', {
  getState: () => ipcRenderer.invoke('camellia:window-chrome-state'),
  openMenu: payload => ipcRenderer.invoke('camellia:window-chrome-menu', payload),
  onState: callback => { ipcRenderer.on('camellia:window-chrome', (_event, state) => callback(state)); },
  onFocus: callback => { ipcRenderer.on('camellia:window-chrome-focus', () => callback()); },
});
contextBridge.exposeInMainWorld('camelliaDevices', {
  openSettings: () => ipcRenderer.invoke('camellia:open-devices'),
  call: (action, payload) => ipcRenderer.invoke('camellia:devices', { action, payload }),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('camellia:device-event', listener);
    return () => ipcRenderer.removeListener('camellia:device-event', listener);
  },
  onTransfer: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('camellia:device-transfer', listener);
    return () => ipcRenderer.removeListener('camellia:device-transfer', listener);
  },
  onVisible: callback => {
    const listener = () => callback();
    ipcRenderer.on('camellia:device-visible', listener);
    return () => ipcRenderer.removeListener('camellia:device-visible', listener);
  },
});
