'use strict';

// Keep Codex's native model lookup from selecting a code-mode-only profile
// for API routes. The router removes this private prefix before route lookup.
const PREFIX = 'camellia-tool-profile:';
const toolModelId = model => PREFIX + model;
const routedModelId = model => model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model;

module.exports = { toolModelId, routedModelId };
