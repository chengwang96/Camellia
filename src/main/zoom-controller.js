'use strict';

const { readJson } = require('../shared/json-store');
const keyboardShortcuts = require('../shared/shortcuts.js');
const MIN_LEVEL = Math.log(0.5) / Math.log(1.2);
const MAX_LEVEL = Math.log(3) / Math.log(1.2);
const valid = value => typeof value === 'number' && Number.isFinite(value);
const clamp = value => Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, value));

// Electron's built-in zoom is stored per origin/URL. Adopt the last selected
// page's existing value once, then keep one app preference for every surface.
function readLegacyZoom(file, urls) {
  try {
    const partitions = readJson(file, {}).partition?.per_host_zoom_levels || {};
    for (const url of urls) for (const hosts of Object.values(partitions)) {
      if (valid(hosts?.[url])) return clamp(hosts[url]);
    }
  } catch { /* Chromium preferences are optional; never rewrite them. */ }
  return undefined;
}

function createZoomController({ loadConfig, saveConfig, legacyLevel, log = () => {} }) {
  const saved = loadConfig().zoomLevel;
  let level = valid(saved) ? clamp(saved) : 0;
  // Parse shortcut preferences once, not on every keydown. Settings refreshes
  // the cache after saving; imported preferences take effect on restart.
  let shortcuts = keyboardShortcuts.resolve(loadConfig().shortcuts);
  const refreshShortcuts = () => { shortcuts = keyboardShortcuts.resolve(loadConfig().shortcuts); };
  if (!valid(saved) && valid(legacyLevel)) {
    level = clamp(legacyLevel);
    saveConfig({ zoomLevel: level });
  }
  const contents = new Map();
  function apply(wc) {
    const target = clamp(level + (contents.get(wc) || 0));
    if (!wc.isDestroyed() && Math.abs(wc.getZoomLevel() - target) > 0.000001) wc.setZoomLevel(target);
    return 1.2 ** target;
  }
  function set(value) {
    if (!valid(value)) throw new Error('Invalid zoom level');
    const next = clamp(value);
    saveConfig({ zoomLevel: next });
    level = next;
    for (const wc of contents.keys()) {
      const zoomFactor = apply(wc);
      if (!wc.isDestroyed()) wc.send('dsh:zoom-changed', { zoomFactor });
    }
    return { ok: true, zoomLevel: level, zoomFactor: 1.2 ** level };
  }
  function adjust(direction) {
    if (direction !== 1 && direction !== -1) throw new Error('Invalid zoom direction');
    return set(level + direction * 0.5);
  }
  function attach(wc, offset = 0) {
    if (contents.has(wc)) return;
    contents.set(wc, offset);
    apply(wc);
    // history.replaceState (including discussion/group switches) also restores
    // Chromium's per-URL zoom without reloading the document.
    for (const event of ['did-navigate', 'did-navigate-in-page', 'dom-ready', 'did-finish-load']) wc.on(event, () => apply(wc));
    wc.once('destroyed', () => contents.delete(wc));
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      // Zoom follows the same editable bindings as the menu, so clearing one
      // in Settings also stops this key from changing the interface size.
      const keyEvent = { key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta,
        altKey: input.alt, shiftKey: input.shift };
      // The default bindings historically also accept the shifted character
      // (Ctrl + + / Ctrl + _) and the numpad. A custom or cleared binding is
      // matched exactly, so those variants stop working with it.
      const primary = process.platform === 'darwin' ? input.meta : input.control;
      const legacyModifiers = primary && !input.alt;
      let action;
      if (keyboardShortcuts.matches(keyEvent, shortcuts.zoomIn, process.platform)
        || (legacyModifiers && shortcuts.zoomIn === 'CommandOrControl+=' && (input.key === '+' || input.code === 'NumpadAdd'))) action = () => adjust(1);
      else if (keyboardShortcuts.matches(keyEvent, shortcuts.zoomOut, process.platform)
        || (legacyModifiers && shortcuts.zoomOut === 'CommandOrControl+-' && (input.key === '_' || input.code === 'NumpadSubtract'))) action = () => adjust(-1);
      else if (keyboardShortcuts.matches(keyEvent, shortcuts.zoomReset, process.platform)) action = () => set(0);
      if (!action) return;
      // Prevent Chromium/menu handling from applying the shortcut a second time.
      event.preventDefault();
      try { action(); } catch (error) { log('Could not save zoom: ' + error.message); }
    });
  }
  return { attach, set, adjust, refreshShortcuts, get level() { return level; }, get factor() { return 1.2 ** level; },
    factorAt(offset) { return 1.2 ** clamp(level + offset); } };
}

module.exports = { createZoomController, readLegacyZoom };
