'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/chat.js'), 'utf8');
const start = source.indexOf('  const SLASH_COMMANDS = [');
const end = source.indexOf('  function closeSlash()', start);
assert.ok(start >= 0 && end > start);

function matches(value) {
  const context = { input: { value } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.matches = slashMatches().map(command => command.id);', context);
  return [...context.matches];
}

test('slash commands accept hyphens and prefer an exact command over prefix matches', () => {
  assert.deepEqual(matches('/compact-storage'), ['compact-storage']);
  assert.deepEqual(matches('/compact'), ['compact']);
  assert.deepEqual(matches('/goal'), ['goal']);
  assert.deepEqual(matches('/not-a-command'), []);
});
