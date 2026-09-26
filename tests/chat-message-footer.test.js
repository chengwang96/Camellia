'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

// The user bubble and the agent turn share one footer: a timestamp and a copy
// button. Only the user side had them, so an agent reply could not be copied
// with the same control or identified by time.
function fixture() {
  const statuses = [];
  const element = tagName => ({
    tagName, className: '', textContent: '', innerHTML: '', children: [], dataset: {},
    type: '', title: '', dateTime: undefined,
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this[name] = value; },
  });
  const context = {
    navigator: { clipboard: { written: [], async writeText(text) { this.written.push(text); } } },
    setStatus: text => statuses.push(text),
    window: { CamelliaI18n: { t: text => text } },
    document: { createElement: element },
    statuses,
  };
  vm.createContext(context);
  vm.runInContext([extract('  function messageActions(', '  function addUser(')].join('\n'), context);
  return context;
}

test('an agent footer carries a timestamp and copies the reply text', async () => {
  const context = fixture();
  const actions = context.messageActions(1_700_000_000_000, () => 'Agent answer');
  assert.equal(actions.className, 'message-actions');
  const time = actions.children[0];
  assert.equal(time.tagName, 'time');
  assert.equal(time.dateTime, new Date(1_700_000_000_000).toISOString());
  assert.ok(time.textContent.length > 0);
  const copy = actions.children[1];
  assert.equal(copy.className, 'message-copy');
  assert.equal(copy.title, 'Copy message');
  assert.equal(copy.dataset.i18nAttrs, 'title aria-label');
  await copy.onclick();
  assert.deepEqual(context.navigator.clipboard.written, ['Agent answer']);
  assert.deepEqual(context.statuses, ['Message copied']);
});

test('the copy button reads the current stream and ignores an empty reply', async () => {
  const context = fixture();
  let text = '';
  const actions = context.messageActions(0, () => text);
  const time = actions.children[0], copy = actions.children[1];
  assert.equal(time.dateTime, undefined);
  assert.equal(time.textContent, '');
  await copy.onclick();
  assert.deepEqual(context.navigator.clipboard.written, []);
  text = 'Final answer';
  await copy.onclick();
  assert.deepEqual(context.navigator.clipboard.written, ['Final answer']);
});

test('a clipboard failure is reported without claiming the reply was copied', async () => {
  const context = fixture();
  context.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  const actions = context.messageActions(Date.now(), () => 'Agent answer');
  await actions.children[1].onclick();
  assert.deepEqual(context.statuses, ['Could not copy the message']);
});

test('the user bubble reuses the same footer instead of a duplicate implementation', () => {
  const shared = extract('  function messageActions(', '  function addUser(');
  const user = extract('  function addUser(', '  function updateMessageActions()');
  assert.match(user, /messageActions\(meta\.at, \(\) => div\.messageData\.text\)/);
  assert.doesNotMatch(user, /navigator\.clipboard/);
  // Only two clipboard writers may exist: this shared footer and the per-code
  // block copier. A third inline handler is what let the sides drift apart.
  assert.equal([...source.matchAll(/navigator\.clipboard\.writeText\(/g)].length, 2);
  assert.match(shared, /message-actions/);
});

test('agent turns place the footer after their content and keep copy text raw', () => {
  const turn = extract('  function turnCopyText(turn)', '  function ensureTurn()');
  // A folded execution process must not leak into the copied answer.
  assert.match(turn, /!el\.closest\('\.execution-process'\)/);
  assert.match(turn, /el\.artifactText \?\? el\.textContent/);
  assert.match(source, /turnFooter\(div, Date\.now\(\), \(\) => turnCopyText\(div\)\);/);
  assert.match(source, /turnFooter\(div, m\.at, \(\) => turnCopyText\(div\)\);/);
});

test('result chips and artifact cards stay above the footer', () => {
  assert.match(source, /\(turnEl \|\| chat\)\.appendChild\(chip\);\n\s+moveTurnFooter\(turnEl\);/);
  assert.match(source, /if \(resultChip\) resultChip\.before\(list\); else turn\.appendChild\(list\);\n\s+moveTurnFooter\(turn\);/);
});

test('an empty turn is removable even though it owns a footer', () => {
  const context = {
    turn: { querySelector: selector => (selector === '.turn-body' ? { childElementCount: 0 } : null) },
  };
  vm.createContext(context);
  vm.runInContext(extract('  function turnIsEmpty(turn)', '  function ensureTurn()')
    .replace(/turn\?\.querySelector/g, 'turn.querySelector'), context);
  assert.equal(context.turnIsEmpty(context.turn), true);
  context.turn = { querySelector: selector => (selector === '.turn-body' ? { childElementCount: 1 } : null) };
  assert.equal(context.turnIsEmpty(context.turn), false);
});
