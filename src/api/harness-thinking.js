'use strict';

const { thinkingFor, levelsFor } = require('../shared/model-levels');

const PREFIX = '/harness-thinking/';
const validEffort = value => typeof value === 'string' && (value === '' || /^[a-z][a-z0-9_-]{0,63}$/i.test(value));

// A per-process route carries the composer's selection independently of a
// CLI's control vocabulary and defaults. It nests inside provider scopes and
// is stripped locally; neither the path nor native fallback efforts go upstream.
function harnessThinkingRoute(route, effort = '') {
  if (!validEffort(effort)) throw new Error('Invalid API thinking level');
  return { ...route, baseUrl: route.baseUrl.replace(/\/$/, '') + PREFIX + (effort === 'off' ? 'none' : effort || '_default') };
}

function parseHarnessThinkingPath(pathname) {
  if (!pathname.startsWith(PREFIX)) return { pathname };
  const match = /^\/harness-thinking\/([^/]+)(\/.*)?$/.exec(pathname);
  const effort = match?.[1] === '_default' ? '' : match?.[1];
  if (!validEffort(effort)) return { error: 'Invalid API thinking level' };
  return { pathname: match[2] || '/', effort: effort === 'off' ? 'none' : effort };
}

function validateHarnessThinking(effort, model, catalog) {
  if (effort === undefined || effort === '') return;
  const thinking = thinkingFor(model, catalog);
  if (thinking && !levelsFor(model, catalog).some(level => (level === 'off' ? 'none' : level) === effort))
    throw new Error(`Thinking level "${effort}" is not supported by "${model}". Select Default or a supported level.`);
}

function applyHarnessThinking(payload, protocol, effort, thinking) {
  if (effort === undefined) return;
  // Default means omission, even if a harness inserts High or disabled. Keep
  // unrelated output configuration (for example a structured response format).
  delete payload.thinking;
  delete payload.reasoning_effort;
  if (payload.output_config) {
    delete payload.output_config.effort;
    if (!Object.keys(payload.output_config).length) delete payload.output_config;
  }
  if (!effort) return;
  // Some custom catalogs spell the native off effort literally as "off".
  // Preserve that wire value while accepting the composer's canonical none.
  const values = thinking?.values || [];
  if (effort === 'none' && values.includes('off') && !values.includes('none') && !values.includes(false)) effort = 'off';
  if (protocol === 'anthropic') {
    if (['none', 'off'].includes(effort)) payload.thinking = { type: 'disabled' };
    else {
      payload.output_config = { ...payload.output_config, effort };
      payload.thinking = { type: 'adaptive' };
    }
  } else payload.reasoning_effort = effort;
}

module.exports = { harnessThinkingRoute, parseHarnessThinkingPath, validateHarnessThinking, applyHarnessThinking };
