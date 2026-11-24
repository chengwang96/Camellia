'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { filterStream, isChromiumTlsRetry } = require('../scripts/dev.js');

const noise = (code = 100) =>
  `[314300:1125/035542.931:ERROR:net\\socket\\ssl_client_socket_impl.cc:962] handshake failed; returned -1, SSL error code 1, net_error -${code}`;

test('Chromium TLS handshake retries are recognised as noise', () => {
  assert.equal(isChromiumTlsRetry(noise()), true);
  assert.equal(isChromiumTlsRetry(noise(100)), true);
  assert.equal(isChromiumTlsRetry(noise(101)), true);
  assert.equal(isChromiumTlsRetry(noise() + '\r'), true, 'Windows line endings are handled before matching');
  assert.equal(isChromiumTlsRetry('[314300:1125/035542.931:ERROR:net\\socket\\ssl_client_socket_impl.cc:962] handshake failed; returned -1, SSL error code 1, net_error -104'), false);
  assert.equal(isChromiumTlsRetry('[314300:1125/035542.931:ERROR:net\\socket\\ssl_client_socket_impl.cc:962] handshake failed; returned -1, SSL error code 1.3, net_error -100'), false);
  assert.equal(isChromiumTlsRetry('before ERROR:net\\socket\\ssl_client_socket_impl.cc:962] handshake failed; returned -1, SSL error code 1, net_error -100'), false);
  assert.equal(isChromiumTlsRetry('Some ordinary startup line'), false);
});

test('filtering drops only noise and keeps unrelated output in order', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', chunk => { text += chunk; });
  filterStream(input, output, { endOutput: true });

  input.write('starting\n');
  input.write(noise() + '\n');
  input.write('deepseek load failed: ERR_CONNECTION_CLOSED\n');
  input.write(noise(101) + '\n');
  input.end('ready\n');
  await new Promise(resolve => output.on('end', resolve));

  assert.equal(text, 'starting\ndeepseek load failed: ERR_CONNECTION_CLOSED\nready\n');
});

test('a chunk containing several lines and a partial line is preserved', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', chunk => { text += chunk; });
  filterStream(input, output, { endOutput: true });

  input.write('one\n' + noise() + '\ntwo\npar');
  input.write('tial\n');
  input.end();
  await new Promise(resolve => output.on('end', resolve));

  assert.equal(text, 'one\ntwo\npartial\n');
});

test('verbose mode forwards every byte unchanged', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', chunk => { text += chunk; });
  filterStream(input, output, { verbose: true, endOutput: true });

  input.end('noise\n' + noise() + '\n');
  await new Promise(resolve => output.on('end', resolve));

  assert.equal(text, 'noise\n' + noise() + '\n');
});

test('the launcher filters a real child process and exits with its status', async () => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const { once } = require('node:events');
  const fs = require('node:fs');
  const os = require('node:os');
  const script = path.join(__dirname, '..', 'scripts', 'dev.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-dev-launcher-'));
  const fake = path.join(dir, 'fake-electron.cjs');
  fs.writeFileSync(fake, [
    "'use strict';",
    `process.stdout.write('ready\\n');`,
    `process.stderr.write(${JSON.stringify(noise() + '\n')});`,
    `process.stderr.write('real failure\\n');`,
    `process.exitCode = 3;`,
  ].join('\n'));
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, CAMELLIA_DEV_ELECTRON: process.execPath, CAMELLIA_DEV_ELECTRON_SCRIPT: fake },
    cwd: path.join(__dirname, '..'),
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end();
  const [code] = await once(child, 'exit');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 3, 'the child status is preserved');
  assert.doesNotMatch(stderr, /handshake failed/);
  assert.match(stderr, /real failure/);
  assert.equal(stdout, 'ready\n');
});
