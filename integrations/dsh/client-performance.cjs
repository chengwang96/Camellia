'use strict';

// Keep the pinned upstream's emitted scripts, revisions and source maps intact.
// Only replace the hot line scan and reuse unchanged per-plugin artifacts.
module.exports = function patchClientPerformance(source) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error("The DSH frontend integration entry point changed");
    source = source.replace(before, after);
  }
  replace('for (const char of value) if (char === "\\n") count += 1;',
    'for (let index = value.indexOf("\\n"); index !== -1; index = value.indexOf("\\n", index + 1)) count += 1;');
  replace('function buildCombo(records, revision) {', `const workbenchComboCache = new WeakMap();
function buildCombo(records, revision) {
  if (records.length !== 1 || revision === undefined) return buildComboUncached(records, revision);
  const record = records[0];
  const cached = workbenchComboCache.get(record);
  if (cached && cached.bundle === record.bundle && cached.sourceMap === record.sourceMap && cached.revision === revision) return cached.artifact;
  const artifact = buildComboUncached(records, revision);
  workbenchComboCache.set(record, { bundle: record.bundle, sourceMap: record.sourceMap, revision, artifact });
  return artifact;
}
function buildComboUncached(records, revision) {`);
  return source;
};
