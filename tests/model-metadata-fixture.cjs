'use strict';

// Inference fixtures do not advertise model capabilities. Background catalog
// requests must stay separate from their inference counts and response scripts.
module.exports = function modelMetadata(req, res) {
  if (req.method !== 'GET' || !/\/v1\/models(?:\/|\?|$)/.test(req.url)) return false;
  const listing = req.url.split('?')[0].endsWith('/v1/models');
  res.writeHead(listing ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(listing ? { data: [] } : { error: 'No model metadata in this fixture' }));
  return true;
};
