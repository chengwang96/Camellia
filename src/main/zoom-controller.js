'use strict';

const { readJson } = require('../shared/json-store');
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
  if (!valid(saved) && valid(legacyLevel)) {
    level = clamp(legacyLevel);
    saveConfig({ zoomLevel: level });
  }
  const contents = new Map();
  function apply(wc) {
    const target = clamp(level + (contents.get(wc) || 0));
    if (!wc.isDestroyed() && Math.abs(wc.getZoomLevel() - target) > 0.000001) wc.setZoomLevel(target);
  }
  function set(value) {
    if (!valid(value)) throw new Error('Invalid zoom level');
    const next = clamp(value);
    saveConfig({ zoomLevel: next });
    level = next;
    for (const wc of contents.keys()) apply(wc);
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
    for (const event of ['did-navigate', 'dom-ready', 'did-finish-load']) wc.on(event, () => apply(wc));
    wc.once('destroyed', () => contents.delete(wc));
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
      let action;
      if (['+', '='].includes(input.key) || input.code === 'NumpadAdd') action = () => adjust(1);
      else if (['-', '_'].includes(input.key) || input.code === 'NumpadSubtract') action = () => adjust(-1);
      else if (input.key === '0' || input.code === 'Numpad0') action = () => set(0);
      if (!action) return;
      // Prevent Chromium/menu handling from applying the shortcut a second time.
      event.preventDefault();
      try { action(); } catch (error) { log('Could not save zoom: ' + error.message); }
    });
  }
  return { attach, set, adjust, get level() { return level; }, get factor() { return 1.2 ** level; },
    factorAt(offset) { return 1.2 ** clamp(level + offset); } };
}

module.exports = { createZoomController, readLegacyZoom };
