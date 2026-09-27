'use strict';

function liveWebContents(surface) {
  if (!surface || surface.isDestroyed?.()) return null;
  try {
    const contents = surface.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  } catch (error) {
    if (/Object has been destroyed/i.test(error.message)) return null;
    throw error;
  }
}

module.exports = { liveWebContents };
