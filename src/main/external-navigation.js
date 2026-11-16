'use strict';

function webURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {}
  return null;
}

// PDF annotations can navigate the current frame instead of requesting a new
// window. Keep application windows and document previews in place in both cases.
// Application navigation uses loadFile/loadURL, which do not emit these events.
function attachExternalNavigation(contents, { openExternal, onError = () => {} }) {
  function open(value) {
    const url = webURL(value);
    if (!url) return;
    try { Promise.resolve(openExternal(url)).catch(onError); }
    catch (error) { onError(error); }
  }

  contents.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    open(event.url || url);
  });
  contents.on('will-frame-navigate', event => {
    // Main-frame attempts also emit will-navigate. Handle them only there so
    // one click does not open the browser twice. Local PDF/srcdoc loads and
    // in-document anchors must remain inside the preview.
    if (event.isMainFrame !== false || !webURL(event.url)) return;
    event.preventDefault();
    open(event.url);
  });
}

module.exports = { attachExternalNavigation };
