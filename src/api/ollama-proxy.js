'use strict';
// Historical entry point, now backed by the shared multi-provider router.
const router = require('./api-router');
const config = require('./api-router-config');
module.exports = { ...router, loadConfig: config.loadConfig, maskKey: config.maskKey };
