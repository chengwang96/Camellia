'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Console } = require('node:console');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { installDiagnosticOutput } = require('../src/main/diagnostic-output');
const tick = () => new Promise(setImmediate);
const pipeError = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

test('a synchronous broken console pipe preserves the original IPC error and subsequent diagnostics', () => {
  const runtime = new EventEmitter(), records = [];
  let writes = 0;
  runtime.stderr = Object.assign(new EventEmitter(), { write() { writes++; throw pipeError(); } });
  const targetConsole = { error(...args) { runtime.stderr.write(args.join(' ')); } };
  const output = installDiagnosticOutput({ runtime, targetConsole });
  try {
    // This occurs before main.js has selected the profile and opened its log.
    assert.doesNotThrow(() => targetConsole.error('Error invoking handler for fixture:', new Error('original IPC failure')));
    output.setLogger(message => records.push(message));
    assert.doesNotThrow(() => targetConsole.error('A second rejected IPC handler'));
    assert.equal(writes, 1, 'A disconnected diagnostic pipe is not written repeatedly');
    assert.match(records.join('\n'), /original IPC failure/);
    assert.match(records.join('\n'), /A second rejected IPC handler/);
    assert.equal(records.filter(line => line.startsWith('Diagnostic stderr closed')).length, 1);
  } finally { output.dispose(); }
});

test('asynchronous stdout and stderr EPIPE events do not become uncaught exceptions', async () => {
  const runtime = new EventEmitter(), records = [];
  runtime.stdout = new Writable({ write(_data, _encoding, done) { done(pipeError()); } });
  runtime.stderr = new Writable({ write(_data, _encoding, done) { done(pipeError()); } });
  const targetConsole = new Console({ stdout: runtime.stdout, stderr: runtime.stderr, ignoreErrors: false });
  const output = installDiagnosticOutput({ runtime, targetConsole });
  try {
    output.setLogger(message => records.push(message));
    targetConsole.log('first output'); targetConsole.error(new Error('first IPC rejection'));
    await tick();
    targetConsole.log('still responsive'); targetConsole.error(new Error('second IPC rejection'));
    await new Promise(resolve => runtime.stderr.write('diagnostic with callback', resolve));
    assert.match(records.join('\n'), /first IPC rejection/);
    assert.match(records.join('\n'), /second IPC rejection/);
    assert.match(records.join('\n'), /still responsive/);
    assert.equal(records.filter(line => /^Diagnostic (stdout|stderr) closed/.test(line)).length, 2);
  } finally { output.dispose(); }
});

test('healthy output keeps console formatting, return values, callbacks and receiver', async () => {
  const runtime = new EventEmitter(), chunks = [], records = [];
  runtime.stdout = new Writable({ write(data, _encoding, done) { chunks.push(String(data)); done(); } });
  runtime.stderr = runtime.stdout;
  const targetConsole = new Console({ stdout: runtime.stdout, stderr: runtime.stderr });
  const original = runtime.stdout.write;
  const output = installDiagnosticOutput({ runtime, targetConsole });
  output.setLogger(message => records.push(message));
  assert.equal(installDiagnosticOutput({ runtime, targetConsole }), output);
  targetConsole.log('response %d: %s', 200, 'ready');
  assert.equal(runtime.stdout.write('direct output', () => {}), true);
  await tick();
  assert.match(chunks.join(''), /response 200: ready\ndirect output/);
  assert.match(records.join('\n'), /response 200: ready/);
  output.dispose();
  assert.equal(runtime.stdout.write, original);
  runtime.stdout.destroy();
});

test('unrelated output faults still propagate and an unwritable file sink cannot mask the original error', () => {
  const runtime = new EventEmitter(), failure = Object.assign(new Error('disk denied'), { code: 'EACCES' });
  runtime.stderr = Object.assign(new EventEmitter(), { write() { throw failure; } });
  const targetConsole = { error() { runtime.stderr.write('error'); } };
  const output = installDiagnosticOutput({ runtime, targetConsole });
  try {
    output.setLogger(() => { throw new Error('Log unavailable'); });
    assert.throws(() => targetConsole.error('original failure'), error => error === failure);
    assert.throws(() => runtime.stderr.emit('error', failure), error => error === failure);
  } finally { output.dispose(); }
});

test('startup buffering stays bounded and errors in inspected objects cannot escape logging', () => {
  const runtime = new EventEmitter(), records = [];
  const targetConsole = { error() {} };
  const output = installDiagnosticOutput({ runtime, targetConsole });
  try {
    for (let i = 0; i < 100; i++) targetConsole.error(i + ': ' + 'x'.repeat(100000));
    output.setLogger(message => records.push(message));
    assert.ok(records.length < 100, 'Startup diagnostics do not retain every oversized message');
    assert.match(records[0], /Dropped \d+ console diagnostics/);
    assert.ok(records.every(record => record.length < 100000));
    assert.match(records.at(-1), /99: /, 'The latest startup context is retained');
    const count = records.length;
    const invalid = new Proxy({}, { ownKeys() { throw new Error('inspection failed'); } });
    assert.doesNotThrow(() => targetConsole.error(invalid));
    assert.equal(records.length, count + 1);
  } finally { output.dispose(); }
});
