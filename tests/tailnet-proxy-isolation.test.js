'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const root = path.resolve(__dirname, '..');
const workflow = name => YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/' + name + '.yml'), 'utf8'));

test('every embedded-network build omits the system proxy feature', () => {
  const desktop = fs.readFileSync(path.join(root, 'scripts/build-tailnet.cjs'), 'utf8');
  const android = fs.readFileSync(path.join(root, 'android/build-tailnet.ps1'), 'utf8');
  const androidLinux = fs.readFileSync(path.join(root, 'android/build-tailnet.sh'), 'utf8');
  const ios = fs.readFileSync(path.join(root, 'ios/build-tailnet-ios.sh'), 'utf8');
  assert.match(desktop, /-tags=ts_omit_useproxy/);
  assert.match(android, /-tags ts_omit_useproxy/);
  assert.match(androidLinux, /-tags ts_omit_useproxy/);
  assert.match(ios, /-tags ts_omit_useproxy/);
});

test('the embedded network helper receives no inherited proxy settings', () => {
  const { embeddedNetworkEnvironment } = require('../src/main/remote/embedded-network');
  const env = embeddedNetworkEnvironment({ PATH: 'keep', HTTPS_PROXY: 'http://192.0.2.1:1',
    https_proxy: 'http://192.0.2.1:1', TS_AUTHKEY: 'remove' });
  assert.equal(env.PATH, 'keep');
  assert.equal(env.HTTPS_PROXY, '');
  assert.equal(env.https_proxy, '');
  assert.equal(env.NO_PROXY, '*');
  assert.equal(env.TS_DISABLE_FEATURE, 'useproxy');
  assert.equal(env.TS_AUTHKEY, undefined);
});

test('desktop CI verifies proxy isolation before and after packaging', () => {
  for (const job of ['build', 'build-macos']) {
    const steps = workflow('desktop').jobs[job].steps;
    const build = steps.findIndex(step => step.name === 'Build embedded network helper');
    const buildCheck = steps.findIndex(step => step.name === 'Verify embedded network proxy isolation');
    const packaged = steps.findIndex(step => step.name === 'Verify packaged embedded network proxy isolation');
    const pkg = steps.findIndex(step => step.name === 'Verify lightweight package and download manifests');
    assert.ok(build >= 0 && buildCheck > build, job);
    assert.ok(pkg >= 0 && packaged > pkg, job);
    assert.match(steps[buildCheck].run, /verify-tailnet-isolation\.cjs/);
    assert.match(steps[packaged].run, /verify-tailnet-isolation\.cjs/);
  }
});

test('desktop acceptance verifies downloaded and installed release bundles', () => {
  for (const job of ['acceptance', 'acceptance-macos']) {
    const steps = workflow('desktop').jobs[job].steps;
    const downloaded = steps.findIndex(step => step.name === 'Verify downloaded package proxy isolation');
    const installed = steps.findIndex(step => step.name === 'Verify installed package proxy isolation');
    assert.ok(downloaded >= 0, job);
    assert.ok(installed >= 0, job);
    assert.match(steps[downloaded].run, /verify-tailnet-isolation\.cjs/);
    assert.match(steps[installed].run, /verify-tailnet-isolation\.cjs/);
  }
});

test('Android CI verifies the AAR and the packaged APK', () => {
  const steps = workflow('android').jobs.package.steps;
  const check = steps.findIndex(step => step.name === 'Verify embedded network proxy isolation');
  const apk = steps.findIndex(step => step.name === 'Verify embedded network binary in APK');
  const build = steps.findIndex(step => step.name === 'Build embedded networking');
  const assemble = steps.findIndex(step => step.name === 'Android build, unit tests and lint');
  assert.ok(check > build && apk > assemble);
  assert.match(steps[check].run, /tailnet\.aar/);
  assert.match(steps[apk].run, /app-debug\.apk/);
});

test('CI checks actual embedded-network artifacts, not only build arguments', () => {
  const desktop = workflow('desktop').jobs.build.steps;
  const android = workflow('android').jobs.package.steps;
  const ios = workflow('ios').jobs.build.steps;
  const artifactChecks = [...desktop, ...android, ...ios].filter(step => /verify-tailnet-isolation/.test(step.run || ''));
  assert.ok(artifactChecks.length >= 5);
  for (const step of artifactChecks) assert.match(step.run, /verify-tailnet-isolation\.cjs/);
  assert.ok(desktop.some(step => /build[\\/]runtime-assets/.test(step.run || '')));
  assert.ok(android.some(step => /tailnet\.aar/.test(step.run || '')));
  assert.ok(android.some(step => /app-debug\.apk/.test(step.run || '')));
  assert.ok(ios.some(step => /tailnet\.xcframework/.test(step.run || '')));
});

test('iOS CI verifies the embedded framework', () => {
  const steps = workflow('ios').jobs.build.steps;
  const build = steps.findIndex(step => step.name === 'Build embedded iOS network framework');
  const check = steps.findIndex(step => step.name === 'Verify embedded network proxy isolation');
  assert.ok(check > build);
  assert.match(steps[check].run, /tailnet\.xcframework/);
});

test('runtime paths are resolved for both desktop bundle layouts', () => {
  const { runtimeDirectory } = require('../scripts/verify-tailnet-isolation.cjs');
  assert.equal(runtimeDirectory('dist/win-unpacked', 'windows'), path.join('dist/win-unpacked', 'resources', 'runtime'));
  assert.equal(runtimeDirectory('dist/mac-arm64/Camellia.app', 'macos'), path.join('dist/mac-arm64/Camellia.app', 'Contents', 'Resources', 'runtime'));
});

test('the artifact checker fails closed when a build lacks the required isolation', () => {
  const { inspectBinary } = require('../scripts/verify-tailnet-isolation.cjs');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tailnet-isolation-failure-'));
  try {
    const plain = path.join(root, 'camellia-tailnet.txt');
    fs.writeFileSync(plain, 'not a Go binary');
    assert.throws(() => inspectBinary(plain));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the iOS framework checker reads the gomobile main binary and its build tag', async () => {
  const { verifyPath } = require('../scripts/verify-tailnet-isolation.cjs');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tailnet-xcframework-'));
  try {
    const bundle = path.join(root, 'tailnet.xcframework');
    const framework = path.join(bundle, 'ios-arm64', 'tailnet.framework');
    fs.mkdirSync(framework, { recursive: true });
    const binary = path.join(framework, 'tailnet');
    fs.writeFileSync(binary, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
      Buffer.from('-tags=ts_omit_useproxy')]));
    assert.equal((await verifyPath(bundle)).length, 1);
    fs.writeFileSync(binary, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
      Buffer.from('go1.27')]));
    await assert.rejects(verifyPath(bundle), /ts_omit_useproxy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
