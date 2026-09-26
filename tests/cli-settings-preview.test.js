'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { PAGES, CAT, initialState, transition, render, width, fit } = require('../src/cli/settings-preview');
const { parseOptions } = require('../scripts/cli-settings-preview.cjs');

test('CLI design contains desktop settings and server-specific categories', () => {
  assert.deepEqual(PAGES.map(page => page.id), ['providers', 'usage', 'general', 'engines', 'runtimes', 'workspaces', 'archived', 'storage', 'network', 'service', 'diagnostics']);
  assert.equal(CAT.length, 5);
  for (const page of PAGES) {
    for (const language of ['zh', 'en']) {
      assert.ok(page.title[language]);
      assert.ok(page.subtitle[language]);
      for (const action of page.actions) {
        assert.ok(action.title[language]);
        assert.ok(action.lines.every(line => line[language]));
      }
    }
  }
});

test('preview navigation does not mutate state and supports keyboard-only operation', () => {
  const original = initialState('network');
  const focused = transition(original, 'tab');
  assert.equal(original.focus, 'nav');
  assert.equal(focused.focus, 'actions');
  const pairing = transition(focused, 'down');
  assert.equal(PAGES[pairing.pageIndex].actions[pairing.actionIndex].id, 'pair');
  const detail = transition(pairing, 'return');
  assert.equal(detail.detail, true);
  assert.equal(transition(detail, 'down').scroll, 1);
  assert.equal(transition(detail, 'escape').detail, false);
  assert.equal(transition(initialState('providers'), 'up').pageIndex, PAGES.length - 1);
  assert.equal(transition(initialState('diagnostics'), 'down').pageIndex, 0);
  assert.equal(transition(initialState('usage'), 'return').detail, false);
  assert.equal(transition(detail, 'ctrl-c').quit, true);
  assert.equal(transition(detail, 'q').quit, true);
  assert.throws(() => initialState('unknown'), /Unknown page/);
});

test('plain previews fit wide, narrow and short terminals in both languages', () => {
  for (const page of PAGES) {
    for (const language of ['zh', 'en']) {
      for (const columns of [1, 24, 40, 60, 78, 96, 104, 120]) {
        for (const rows of [1, 16, 18, 24, 40]) {
          const variants = [initialState(page.id), { ...initialState(page.id), focus: 'actions' },
            ...page.actions.map((entry, actionIndex) => ({ ...initialState(page.id), detail: true, actionIndex, scroll: 3 }))];
          for (const state of variants) {
            const output = render(state, { columns, rows, language });
            const lines = output.split('\n');
            assert.ok(lines.length <= rows, `${page.id}: too many rows for ${columns}x${rows}`);
            assert.ok(lines.every(line => width(line) <= columns), `${page.id}: line overflow for ${columns}x${rows}`);
            assert.doesNotMatch(output, /\x1b/);
          }
        }
      }
    }
  }
});

test('preview makes simulation and destructive-action boundaries explicit', () => {
  assert.match(render(initialState()), /设计预览.*演示数据/);
  assert.match(render(initialState('network')), /未连接网络/);
  const importPreview = render({ ...initialState('providers'), detail: true }, { rows: 50 });
  assert.match(importPreview, /不导入订阅 token/);
  assert.match(importPreview, /没有读取或传输任何密钥/);
  const deletePreview = render({ ...initialState('workspaces'), detail: true, actionIndex: 1 }, { rows: 50 });
  assert.match(deletePreview, /不删除服务器文件/);
  assert.match(deletePreview, /保留工作目录/);
  assert.match(render(initialState(), { language: 'en' }), /DESIGN PREVIEW/);
});

test('ASCII English mode has no unicode or terminal control sequences', () => {
  for (const page of PAGES) {
    const output = render(initialState(page.id), { language: 'en', ascii: true });
    assert.doesNotMatch(output, /[^\x20-\x7e\n]/);
  }
});

test('selected navigation and action remain visible in short terminals', () => {
  const nav = render(initialState('diagnostics'), { columns: 104, rows: 18 });
  assert.match(nav, /› 诊断与关于/);
  const actions = PAGES.find(page => page.id === 'network').actions;
  for (const [actionIndex, action] of actions.entries()) {
    const output = render({ ...initialState('network'), focus: 'actions', actionIndex }, { columns: 40, rows: 18 });
    assert.ok(output.includes(`› ${action.label.zh}`));
  }
});

test('color rendering changes style without changing content or layout', () => {
  const state = initialState('network');
  const styled = render(state, { color: true });
  assert.match(styled, /\x1b\[38;2;103;158;254m/);
  assert.equal(styled.replace(/\x1b\[[0-9;]*m/g, ''), render(state));
});

test('terminal layout handles CJK width and strips control characters', () => {
  assert.equal(width('Camellia 猫'), 11);
  assert.equal(width('e\u0301'), 1);
  assert.equal(fit('工作区', 5), '工作');
  assert.doesNotMatch(fit('\x1b[31m\n\x07Title', 40), /[\x00-\x1f]/);
});

test('preview options validate values and respect no-color terminals', () => {
  assert.equal(parseOptions([], { NO_COLOR: '' }).color, false);
  assert.equal(parseOptions([], { TERM: 'dumb' }).ascii, true);
  assert.equal(parseOptions(['--lang', 'en', '--page', 'network', '--width', '80'], {}).columns, 80);
  assert.equal(parseOptions(['--plain', '--no-color'], {}).plain, true);
  for (const args of [['--page'], ['--page', 'missing'], ['--width', '-2'], ['--height', '501'], ['--width', 'NaN'], ['--lang', 'fr'], ['--unknown']]) {
    assert.throws(() => parseOptions(args, {}));
  }
});

test('preview CLI exits non-interactively with plain output and no Electron', () => {
  const executable = path.resolve(__dirname, '../scripts/cli-settings-preview.cjs');
  const result = execFileSync(process.execPath, [executable, '--lang', 'en', '--ascii', '--page', 'network'], { encoding: 'utf8', timeout: 5000 });
  assert.match(result, /Network & Devices/);
  assert.match(result, /DEMO DATA/);
  assert.doesNotMatch(result, /\x1b|[^\x20-\x7e\n]/);
  const help = execFileSync(process.execPath, [executable, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.match(help, /no live operations/);
  const invalid = spawnSync(process.execPath, [executable, '--page', 'invalid'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown page/);
});
