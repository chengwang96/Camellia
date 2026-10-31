'use strict';

// Hidden Windows windows may suspend animation frames despite disabled
// background throttling. Offscreen rendering supplies real compositor frames
// for the settings backdrop handshake without displaying QA windows.
// Tests of native caption geometry intentionally use ordinary windows instead.
module.exports = function hiddenElectronWindows(electron) {
  const hidden = Object.create(electron);
  const NativeBrowserWindow = electron.BrowserWindow;
  Object.defineProperty(hidden, 'BrowserWindow', { value: class BrowserWindow extends NativeBrowserWindow {
    constructor(options) {
      // Callers disable hardware acceleration before app readiness, selecting
      // Electron's software output device rather than a display-backed GPU.
      super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true } });
    }
  } });
  electron.app.on('browser-window-created', (_event, window) => {
    window.show = () => {}; window.showInactive = () => {}; window.focus = () => {};
    window.webContents.setBackgroundThrottling(false);
  });
  return hidden;
};
