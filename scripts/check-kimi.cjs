'use strict';
const fs = require('node:fs');
const path = require('node:path');

exports.default = context => {
  const runtime = path.join(context.packager.projectDir, 'runtimes/kimi/node_modules/@moonshot-ai/kimi-code/dist/main.mjs');
  if (!fs.existsSync(runtime)) throw new Error('Kimi runtime is required for packaging. Run npm run setup:kimi first.');
};
