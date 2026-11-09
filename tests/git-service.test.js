'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');
const { createGitService, parseNumstat, parseStatus } = require('../src/main/git-service');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function temporaryDirectory(t, prefix = 'camellia-git-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTree(directory));
  return directory;
}

function repository(t) {
  const root = temporaryDirectory(t);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Camellia Test');
  git(root, 'config', 'user.email', 'camellia@example.invalid');
  return root;
}

function commitAll(root, message = 'Initial commit') {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
}

test('porcelain v2 and numstat parsers preserve rename paths and binary counters', () => {
  const status = parseStatus(['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 M. N 100644 100644 100644 aaa bbb tracked file.txt',
    '2 R. N 100644 100644 100644 aaa bbb R100 new name.txt', 'old name.txt', '? untracked.txt', ''].join('\0'));
  assert.equal(status.branch.ahead, 2);
  assert.equal(status.branch.behind, 1);
  assert.equal(status.files[0].path, 'tracked file.txt');
  assert.equal(status.files[0].staged, true);
  assert.equal(status.files[0].unstaged, false);
  assert.equal(status.files[1].path, 'new name.txt');
  assert.equal(status.files[1].oldPath, 'old name.txt');
  assert.equal(status.files[2].untracked, true);
  const stats = parseNumstat(['2\t1\ttracked.txt', '-\t-\tbinary.dat', '1\t0\t', 'old.txt', 'new.txt', ''].join('\0'));
  assert.deepEqual(stats.get('tracked.txt'), { additions: 2, deletions: 1 });
  assert.deepEqual(stats.get('binary.dat'), { additions: null, deletions: null });
  assert.deepEqual(stats.get('new.txt'), { additions: 1, deletions: 0 });
});

test('status and diffs cover modified, renamed, staged and untracked files', async t => {
  const root = repository(t);
  const service = createGitService();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'old name.txt'), 'renamed\n');
  commitAll(root);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\nchanged\nthree\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
  git(root, 'add', 'staged.txt');
  git(root, 'mv', 'old name.txt', 'new name.txt');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\nfile\n');

  const status = await service.status(root);
  assert.equal(status.branch, 'main');
  assert.equal(status.files.length, 4);
  assert.equal(status.files.find(file => file.path === 'tracked.txt').unstaged, true);
  assert.equal(status.files.find(file => file.path === 'new name.txt').oldPath, 'old name.txt');
  assert.deepEqual(status.files.find(file => file.path === 'untracked.txt').stats, { additions: 2, deletions: 0 });
  assert.equal(status.additions, 5);
  assert.ok(status.deletions >= 1);

  const unstaged = await service.diff(root, { filePath: 'tracked.txt', scope: 'unstaged' });
  assert.match(unstaged.patch, /-two/);
  assert.match(unstaged.patch, /\+changed/);
  const staged = await service.diff(root, { filePath: 'staged.txt', scope: 'staged' });
  assert.match(staged.patch, /\+staged/);
  const untracked = await service.diff(root, { filePath: 'untracked.txt', scope: 'untracked' });
  assert.match(untracked.patch, /\+new/);
  assert.match(untracked.patch, /\+file/);

  await service.action(root, 'stage', { paths: ['tracked.txt'] });
  assert.equal((await service.status(root)).files.find(file => file.path === 'tracked.txt').staged, true);
  await service.action(root, 'unstage', { paths: ['tracked.txt'] });
  assert.equal((await service.status(root)).files.find(file => file.path === 'tracked.txt').unstaged, true);
});

test('untracked folders collapse by default and expand with bounded stats on demand', async t => {
  const root = repository(t);
  const service = createGitService();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  commitAll(root);
  fs.mkdirSync(path.join(root, 'nested/deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nested/a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'nested/b.txt'), 'three\n');
  fs.writeFileSync(path.join(root, 'nested/deep/c.txt'), 'four\n');

  const status = await service.status(root);
  assert.equal(status.files.length, 1);
  assert.equal(status.files[0].path, 'nested/');
  assert.equal(status.files[0].directory, true);
  assert.equal(status.files[0].stats, null);
  assert.equal(status.statsTruncated, true);
  const expanded = await service.untracked(root, { filePath: 'nested/', limit: 2 });
  assert.equal(expanded.total, 3);
  assert.equal(expanded.files.length, 2);
  assert.equal(expanded.truncated, true);
  assert.deepEqual(expanded.files[0].stats, { additions: 2, deletions: 0 });
  const diff = await service.diff(root, { filePath: expanded.files[0].path, scope: 'untracked' });
  assert.match(diff.patch, /\+one/);
  await service.action(root, 'stage', { paths: ['nested/'] });
  const staged = await service.status(root);
  assert.equal(staged.files.length, 3);
  assert.ok(staged.files.every(file => file.staged));
});

test('commit includes the staged snapshot while preserving later worktree edits', async t => {
  const root = repository(t);
  const service = createGitService();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  commitAll(root);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\nstaged\n');
  await service.action(root, 'stage', { paths: ['tracked.txt'] });
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\nstaged\nunstaged\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'not committed\n');

  const result = await service.action(root, 'commit', { message: 'Add the staged line' });
  assert.match(result.hash, /^[0-9a-f]+$/);
  assert.equal(git(root, 'show', 'HEAD:tracked.txt'), 'base\nstaged');
  const status = await service.status(root);
  assert.equal(status.files.find(file => file.path === 'tracked.txt').unstaged, true);
  assert.equal(status.files.find(file => file.path === 'other.txt').untracked, true);
  assert.equal(status.ahead, 0);
});

test('staging and unstaging works before the first commit', async t => {
  const root = repository(t);
  const service = createGitService();
  fs.writeFileSync(path.join(root, 'first.txt'), 'first\n');
  await service.action(root, 'stage', { paths: ['first.txt'] });
  assert.equal((await service.status(root)).files[0].staged, true);
  await service.action(root, 'unstage', { paths: ['first.txt'] });
  const status = await service.status(root);
  assert.equal(status.hasHead, false);
  assert.equal(status.files[0].untracked, true);
});

test('push, fetch and fast-forward pull work against a local remote', async t => {
  const directory = temporaryDirectory(t);
  const remote = path.join(directory, 'remote.git');
  const root = path.join(directory, 'first');
  const other = path.join(directory, 'other');
  fs.mkdirSync(root);
  git(directory, 'init', '--bare', remote);
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Camellia Test');
  git(root, 'config', 'user.email', 'camellia@example.invalid');
  const service = createGitService();
  fs.writeFileSync(path.join(root, 'shared.txt'), 'first\n');
  commitAll(root);
  git(root, 'remote', 'add', 'origin', remote);

  await service.action(root, 'push', { setUpstream: true, remote: 'origin' });
  assert.equal((await service.status(root)).upstream, 'origin/main');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'first\nsecond\n');
  commitAll(root, 'Add second line');
  await service.action(root, 'push');
  assert.equal(git(remote, 'rev-parse', 'main'), git(root, 'rev-parse', 'HEAD'));

  git(directory, 'clone', '--branch', 'main', remote, other);
  git(other, 'config', 'user.name', 'Other Test');
  git(other, 'config', 'user.email', 'other@example.invalid');
  fs.writeFileSync(path.join(other, 'remote.txt'), 'remote\n');
  commitAll(other, 'Add remote file');
  git(other, 'push');
  await service.action(root, 'fetch');
  assert.equal((await service.status(root)).behind, 1);
  await service.action(root, 'pull');
  assert.equal(fs.readFileSync(path.join(root, 'remote.txt'), 'utf8').replace(/\r\n/g, '\n'), 'remote\n');
  assert.equal((await service.status(root)).behind, 0);
});

test('invalid repositories, paths, messages and operations are rejected', async t => {
  const root = repository(t);
  const service = createGitService();
  await assert.rejects(service.diff(root, { filePath: '../outside.txt' }), error => error.code === 'INVALID_PATH');
  await assert.rejects(service.action(root, 'commit', { message: ' ' }), error => error.code === 'INVALID_COMMIT_MESSAGE');
  await assert.rejects(service.action(root, 'unknown'), error => error.code === 'INVALID_GIT_OPERATION');
  const plain = temporaryDirectory(t);
  await assert.rejects(service.status(plain), error => error.code === 'NOT_REPOSITORY');
  await assert.rejects(service.status('relative/path'), error => error.code === 'INVALID_WORKSPACE');
});
