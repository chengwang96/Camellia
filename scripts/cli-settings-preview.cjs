#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { PAGES, initialState, transition, render, clean } = require('../src/cli/settings-preview');

function parseOptions(args, env = process.env) {
  const options = { language: 'zh', page: 'general', ascii: env.TERM === 'dumb', plain: false, help: false, color: !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--plain') options.plain = true;
    else if (argument === '--ascii') options.ascii = true;
    else if (argument === '--no-color') options.color = false;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--lang' || argument === '--page' || argument === '--width' || argument === '--height') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      if (argument === '--lang') {
        if (!['en', 'zh', 'zh-CN'].includes(value)) throw new Error('Language must be en or zh-CN');
        options.language = value === 'en' ? 'en' : 'zh';
      } else if (argument === '--page') {
        if (!PAGES.some(page => page.id === value)) throw new Error(`Unknown page: ${clean(value)}`);
        options.page = value;
      } else {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500) throw new Error(`${argument} must be between 1 and 500`);
        options[argument === '--width' ? 'columns' : 'rows'] = Number(value);
      }
    } else throw new Error(`Unknown option: ${clean(argument)}`);
  }
  return options;
}

function run(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    process.stdout.write('Camellia CLI settings DESIGN PREVIEW (no live operations)\n\n'
      + 'node scripts/cli-settings-preview.cjs [--plain] [--ascii] [--no-color]\n'
      + '  [--lang zh-CN|en] [--page PAGE] [--width 104] [--height 40]\n\n'
      + `Pages: ${PAGES.map(page => page.id).join(', ')}\n`
      + 'Navigation: Up/Down or j/k, Tab, Enter, Esc, q.\n'
      + 'Piped output is plain text. NO_COLOR disables colors.\n');
    return;
  }
  let state = initialState(options.page);
  const interactive = process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb' && !options.plain;
  const dimensions = () => ({ ...options, color: interactive && options.color,
    columns: options.columns || process.stdout.columns || 104, rows: options.rows || process.stdout.rows || 40 });
  if (!interactive) {
    process.stdout.write(render(state, dimensions()) + '\n');
    return;
  }
  const wasRaw = Boolean(process.stdin.isRaw);
  let closed = false;
  const draw = () => {
    const current = dimensions();
    current.columns = Math.min(current.columns, process.stdout.columns || current.columns);
    current.rows = Math.max(1, Math.min(current.rows, process.stdout.rows || current.rows) - 1);
    process.stdout.write('\x1b[H\x1b[2J' + render(state, current));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    process.stdin.off('keypress', onKey);
    process.stdout.off('resize', draw);
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    process.off('exit', close);
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  const onKey = (input, key = {}) => {
    const name = key.ctrl && key.name === 'c' ? 'ctrl-c' : key.name || input;
    state = transition(state, name);
    if (state.quit) close();
    else draw();
  };
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', onKey);
  process.stdout.on('resize', draw);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  process.on('exit', close);
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  try { draw(); }
  catch (error) { close(); throw error; }
}

if (require.main === module) {
  try { run(); }
  catch (error) { process.stderr.write(`Camellia preview: ${clean(error.message)}\n`); process.exitCode = 1; }
}

module.exports = { parseOptions, run };
