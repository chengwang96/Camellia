'use strict';

// A pasted block this large is easier for every engine to read as a file.
// The composer turns it into a .txt attachment instead of inserting the text.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaLongPaste = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const LONG_PASTE_CHARS = 5000;
  function shouldAttach(text) {
    const value = typeof text === 'string' ? text : '';
    if (!value.trim()) return false;
    return value.length >= LONG_PASTE_CHARS;
  }
  return { LONG_PASTE_CHARS, shouldAttach };
});
