'use strict';

const MIN_WIDTH = 760;
const MIN_HEIGHT = 620;
// The settings layout needs two provider columns but should not keep growing
// on high-DPI or 4K displays. Cap the window at the content's useful width.
const MAX_WIDTH = 1160;
const MAX_HEIGHT = 960;
const SCREEN_GAP = 48;
const FALLBACK_SIZE = { width: 1160, height: 860 };

function settingsWindowSize(workArea = {}) {
  const availableWidth = Math.max(MIN_WIDTH, Number(workArea.width) || MIN_WIDTH);
  const availableHeight = Math.max(MIN_HEIGHT, Number(workArea.height) || MIN_HEIGHT);
  const fittedWidth = Math.max(MIN_WIDTH, availableWidth - SCREEN_GAP);
  const fittedHeight = Math.max(MIN_HEIGHT, availableHeight - SCREEN_GAP);
  return {
    width: Math.min(Math.max(Math.round(availableWidth * 0.88), 1040), MAX_WIDTH, fittedWidth),
    height: Math.min(Math.max(Math.round(availableHeight * 0.9), 720), MAX_HEIGHT, fittedHeight),
  };
}

function createSettingsWindowSizeCache({ screen, fallback = FALLBACK_SIZE, onError = () => {} }) {
  let current = { ...fallback };
  let started = false;
  function refresh() {
    try {
      const workArea = screen.getPrimaryDisplay()?.workArea;
      if (workArea) current = settingsWindowSize(workArea);
    } catch (error) {
      onError(error);
    }
    return { ...current };
  }
  function start() {
    if (started) return;
    started = true;
    refresh();
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, refresh);
  }
  return { start, refresh, get size() { return { ...current }; } };
}

module.exports = { settingsWindowSize, createSettingsWindowSizeCache };
