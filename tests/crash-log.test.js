'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { removeTree } = require('./test-fs.cjs');
const { RotatingLog } = require('../src/main/rotating-log');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const start = main.indexOf('function describe(');
const handlers = main.slice(start, main.indexOf('installCrashHandlers();', start) + 'installCrashHandlers();'.length);

test('an uncaught exception is on disk before Electron exits', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-crash-log-'));
  context.after(() => removeTree(root));
  const file = path.join(root, 'logs', 'dsh-desktop-fatal.log');
  const writer = new RotatingLog({ directory: path.dirname(file) });
  const app = new EventEmitter(), runtime = new EventEmitter();
  let exitCode;
  app.exit = code => {
    exitCode = code;
    assert.match(fs.readFileSync(file, 'utf8'), /FATAL uncaughtException:.*fixture failure/s);
  };
  vm.runInNewContext(handlers, { app, process: runtime, Error, getLogWriter: () => writer, log() {} });
  runtime.emit('uncaughtException', new Error('fixture failure'));
  assert.equal(runtime.exitCode, 1);
  assert.equal(exitCode, 1);
});

test('crash reporting survives unreadable error objects and an unwritable log', () => {
  const app = new EventEmitter(), runtime = new EventEmitter();
  const exits = [];
  app.exit = code => exits.push(code);
  const denied = () => { throw new Error('Permission denied'); };
  runtime.stderr = { write: denied };
  vm.runInNewContext(handlers, { app, process: runtime, Error, getLogWriter: denied, log() {} });
  const reason = { toJSON: denied, toString: denied };
  assert.doesNotThrow(() => runtime.emit('uncaughtException', reason));
  assert.deepEqual(exits, [1]);
});
