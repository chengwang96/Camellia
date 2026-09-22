'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const start = source.indexOf('  async function showUsageCard()');
assert.notEqual(start, -1);
const usageSource = source.slice(start, source.indexOf('  async function compactConversation()', start));

async function render(usage) {
  const elements = [];
  const createElement = () => {
    const element = { dataset: {}, append() {}, appendChild() {}, addEventListener() {} };
    elements.push(element);
    return element;
  };
  const clock = new Date(2026, 8, 22, 12).getTime();
  const state = {
    document: { createElement }, chat: { appendChild() {} }, chatScroll: { scrollHeight: 0 },
    Date: class extends Date { static now() { return clock; } }, fmtTokens: String,
    window: { dshDesktop: { apiRouterGetState: async () => ({ usage }) }, CamelliaI18n: { t: text => text } },
  };
  vm.runInNewContext(usageSource, state);
  await state.showUsageCard();
  return elements.find(element => element.className === 'usage-card-body').textContent;
}

test('seven-day usage includes today as well as the preceding six days across keys and models', async () => {
  const text = await render({
    first: { daily: {
      '2026-09-22': { alpha: { requests: 7, inputTokens: 100, outputTokens: 20 } },
      '2026-09-21': { alpha: { requests: 2, inputTokens: 30, outputTokens: 10, failures: 1 } },
      '2026-09-16': { beta: { requests: 3, inputTokens: 40, outputTokens: 5 } },
      '2026-09-15': { alpha: { requests: 1000, inputTokens: 1000 } },
      '2026-09-23': { alpha: { requests: 1000 } },
    } },
    second: { daily: { '2026-09-22': { beta: { requests: 1, inputTokens: 10, outputTokens: 2 } } } },
  });
  assert.match(text, /Today: 8 requests, 110 in, 22 out/);
  assert.match(text, /Last 7 days: 13 requests, 180 in, 37 out, 1 failed/);
});

test('today-only usage appears in both totals and empty usage remains zero', async () => {
  const text = await render({ key: { daily: { '2026-09-22': { model: { requests: 7, inputTokens: 100, outputTokens: 20 } } } } });
  assert.match(text, /Today: 7 requests, 100 in, 20 out/);
  assert.match(text, /Last 7 days: 7 requests, 100 in, 20 out/);
  assert.match(await render({}), /Last 7 days: 0 requests, 0 in, 0 out/);
});
