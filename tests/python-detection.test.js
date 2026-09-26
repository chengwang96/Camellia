'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { detectSystemPython, sharedPythonSupportsSdk, pythonCandidates } = require('../src/main/python-runtime');

function scratch(context, name = 'python3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-python-'));
  context.after(() => removeTree(root));
  const file = path.join(root, process.platform === 'win32' ? name + '.exe' : name);
  fs.writeFileSync(file, '', { mode: 0o755 });
  return { root, file };
}

// The probe answers the version question and only then the SDK import, exactly
// like a real interpreter.
function probeFor(version, { hasSdk = false, log = [] } = {}) {
  return (exe, args) => {
    log.push({ exe, args });
    // args is ['-c', '<script>'], so the script is the last element.
    const script = String(args[args.length - 1]);
    if (script.startsWith('import sys')) return `{"python": "${version}"}\n`;
    if (script.startsWith('import google')) {
      if (!hasSdk) throw new Error('ModuleNotFoundError');
      return '';
    }
    throw new Error('unexpected probe: ' + args.join(' '));
  };
}

test('auto-detection finds a usable Python 3 on PATH and reports whether the SDK is importable', context => {
  const { root, file } = scratch(context);
  const calls = [];
  const found = detectSystemPython({ platform: process.platform, env: { PATH: root }, home: root,
    probe: probeFor('3.12.4', { log: calls }) });
  assert.equal(found.file, file);
  assert.equal(found.version, '3.12.4');
  assert.equal(found.antigravitySdk, false);
  assert.equal(found.source, 'Detected automatically');
  assert.equal(found.detected, true);
  assert.equal(calls.length, 2, 'version and SDK are probed separately');
});

test('auto-detection skips Python 2, unreadable entries and missing directories', context => {
  const first = scratch(context, 'python3');
  const second = path.join(first.root, 'bin');
  fs.mkdirSync(second, { recursive: true });
  const py2 = path.join(second, process.platform === 'win32' ? 'python.exe' : 'python');
  fs.writeFileSync(py2, '', { mode: 0o755 });
  const probe = (exe, args) => String(args[args.length - 1]).startsWith('import sys')
    ? (exe === py2 ? '{"python": "2.7.18"}\n' : '{"python": "3.11.9"}\n')
    : '';
  // The Python 3 entry comes first, so the rejected Python 2 never wins.
  const found = detectSystemPython({ platform: process.platform,
    env: { PATH: [second, 'relative-dir', first.root].join(path.delimiter) }, home: first.root, probe });
  assert.equal(found.version, '3.11.9');
  assert.equal(detectSystemPython({ platform: process.platform, env: { PATH: 'not-a-directory' }, home: first.root, probe }), null);
});

test('a Python that cannot be executed is ignored rather than reported', context => {
  const { root } = scratch(context);
  const found = detectSystemPython({ platform: process.platform, env: { PATH: root }, home: root,
    probe: () => { throw new Error('not executable'); } });
  assert.equal(found, null);
});

test('detection results are cached per file so repeated state reads stay cheap', context => {
  const { root } = scratch(context);
  const calls = [];
  const cache = new Map();
  const options = { platform: process.platform, env: { PATH: root }, home: root, cache, probe: probeFor('3.13.2', { hasSdk: true, log: calls }) };
  assert.equal(detectSystemPython(options).antigravitySdk, true);
  const afterFirst = calls.length;
  detectSystemPython(options);
  detectSystemPython(options);
  assert.equal(calls.length, afterFirst, 'a cached interpreter is not probed again');
});

test('the SDK minimum follows the published requirement', () => {
  assert.equal(sharedPythonSupportsSdk({ file: 'x', version: '3.10.0' }), true);
  assert.equal(sharedPythonSupportsSdk({ file: 'x', version: '3.13.14' }), true);
  assert.equal(sharedPythonSupportsSdk({ file: 'x', version: '3.9.18' }), false);
  assert.equal(sharedPythonSupportsSdk({ file: 'x', version: '2.7.18' }), false);
  assert.equal(sharedPythonSupportsSdk({ file: 'x' }), false);
  assert.equal(sharedPythonSupportsSdk(null), false);
});

test('Windows also offers the py launcher while POSIX prefers python3', () => {
  const windows = pythonCandidates({ platform: 'win32', env: { PATH: 'C:\\bin' }, home: 'C:\\Users\\x' });
  assert.ok(windows.some(entry => path.basename(entry.file) === 'py.exe' && entry.prefix.join(' ') === '-3'));
  assert.ok(windows.some(entry => path.basename(entry.file) === 'python3.exe'));
  const posix = pythonCandidates({ platform: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/x' });
  // path.join honours the host separator, so compare resolved components.
  assert.ok(posix.some(entry => entry.file === path.join('/usr/bin', 'python3')));
  assert.ok(posix.some(entry => entry.file === path.join('/usr/bin', 'python')));
  assert.ok(posix.every(entry => !entry.file.includes('py.exe')), 'POSIX never offers the Windows launcher');
});
