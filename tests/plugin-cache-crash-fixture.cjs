'use strict';
const { maintainPluginCaches } = require('../src/main/plugin-cache-maintenance');
maintainPluginCaches(process.argv[2], { apply: true, onStep(step) { if (step === process.argv[3]) process.exit(73); } });
process.exit(1);
