'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('camelliaDevices', {
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
