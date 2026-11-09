'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_DIFF_CHARS = 4 * 1024 * 1024;
const MAX_UNTRACKED_STAT_BYTES = 2 * 1024 * 1024;

class GitError extends Error {
  constructor(message, code = 'GIT_ERROR') {
    super(message);
    this.code = code;
  }
}

function runGit(cwd, args, { input, timeout = 20000, maxChars = 8 * 1024 * 1024, allowExitCodes = [], truncate = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) { reject(new GitError(error.message, 'GIT_UNAVAILABLE')); return; }
    let stdout = '', stderr = '', settled = false, truncated = false;
    const finish = callback => { if (!settled) { settled = true; clearTimeout(timer); callback(); } };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new GitError(`git ${args[0]} timed out.`, 'GIT_TIMEOUT')));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (truncate && stdout.length + chunk.length > maxChars) {
        stdout += chunk.slice(0, Math.max(0, maxChars - stdout.length));
        truncated = true;
        child.kill();
      } else stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 1024 * 1024) stderr += chunk.slice(0, 1024 * 1024 - stderr.length);
    });
    child.on('error', error => finish(() => reject(new GitError(error.message, error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_ERROR'))));
    child.on('close', code => finish(() => {
      if (truncated && truncate) { resolve({ stdout, stderr, code, truncated }); return; }
      if (code !== 0 && !allowExitCodes.includes(code)) {
        reject(new GitError((stderr || stdout || `git ${args[0]} failed with exit code ${code}.`).trim()));
        return;
      }
      resolve({ stdout, stderr, code, truncated });
    }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function parseNumstat(output) {
  const stats = new Map();
  const tokens = String(output || '').split('\0');
  for (let index = 0; index < tokens.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index]);
    if (!match) continue;
    let filePath = match[3];
    if (!filePath) {
      index++;
      filePath = tokens[index + 1] || '';
      index++;
    }
    if (!filePath) continue;
    const additions = match[1] === '-' ? null : Number(match[1]);
    const deletions = match[2] === '-' ? null : Number(match[2]);
    const previous = stats.get(filePath);
    stats.set(filePath, previous ? {
      additions: previous.additions == null || additions == null ? null : previous.additions + additions,
      deletions: previous.deletions == null || deletions == null ? null : previous.deletions + deletions,
    } : { additions, deletions });
  }
  return stats;
}

function parseStatus(output) {
  const branch = { oid: '', head: '', upstream: null, ahead: 0, behind: 0 };
  const files = [];
  const records = String(output || '').split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.')) {
      const match = /^# branch\.(oid|head|upstream|ab) (.*)$/.exec(record);
      if (!match) continue;
      if (match[1] === 'ab') {
        const counts = /^\+(\d+) -(\d+)$/.exec(match[2]);
        if (counts) { branch.ahead = Number(counts[1]); branch.behind = Number(counts[2]); }
      } else branch[match[1]] = match[2];
      continue;
    }
    const kind = record[0];
    if (kind === '?') {
      const filePath = record.slice(2);
      files.push({ path: filePath, oldPath: null, index: '?', worktree: '?', status: 'A', staged: false, unstaged: true, untracked: true,
        directory: filePath.endsWith('/') });
      continue;
    }
    if (kind === '!') continue;
    if (kind === '1' || kind === '2' || kind === 'u') {
      const parts = record.split(' ');
      const xy = parts[1] || '..';
      const pathStart = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const filePath = parts.slice(pathStart).join(' ');
      const oldPath = kind === '2' ? records[++index] || null : null;
      const unmerged = kind === 'u';
      const staged = unmerged || !['.', '?'].includes(xy[0]);
      const unstaged = unmerged || !['.', '?'].includes(xy[1]);
      const status = unmerged ? 'U' : xy.includes('R') ? 'R' : xy.includes('C') ? 'C'
        : (unmerged ? 'U' : (!staged && xy[1] === 'A') || (staged && xy[0] === 'A') ? 'A'
          : xy.includes('D') ? 'D' : 'M');
      files.push({ path: filePath, oldPath, index: xy[0], worktree: xy[1], status, staged, unstaged, untracked: false });
    }
  }
  return { branch, files };
}

async function mapLimit(items, limit, iteratee) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await iteratee(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function untrackedStats(root, filePath) {
  const absolute = path.resolve(root, ...filePath.split('/'));
  try {
    const stat = await fs.promises.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_STAT_BYTES) return { additions: null, deletions: null };
    const buffer = await fs.promises.readFile(absolute);
    if (buffer.subarray(0, 8000).includes(0)) return { additions: null, deletions: null };
    if (!buffer.length) return { additions: 0, deletions: 0 };
    let lines = 0;
    for (const byte of buffer) if (byte === 10) lines++;
    if (buffer[buffer.length - 1] !== 10) lines++;
    return { additions: lines, deletions: 0 };
  } catch { return { additions: null, deletions: null }; }
}

function repoFile(root, filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || path.isAbsolute(filePath)) throw new GitError('A repository-relative file path is required.', 'INVALID_PATH');
  const absolute = path.resolve(root, ...filePath.split('/'));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new GitError('The file must be inside the repository.', 'INVALID_PATH');
  return { absolute, relative: relative.split(path.sep).join('/') };
}

function totalStats(files) {
  return files.reduce((total, file) => ({
    additions: total.additions + (file.stats?.additions || 0),
    deletions: total.deletions + (file.stats?.deletions || 0),
  }), { additions: 0, deletions: 0 });
}

function createGitService() {
  const operationRoots = new Set(), repositoryCache = new Map();

  async function repository(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new GitError('An absolute workspace path is required.', 'INVALID_WORKSPACE');
    const key = path.resolve(cwd), cached = repositoryCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    let stat;
    try { stat = await fs.promises.stat(cwd); } catch { throw new GitError('The workspace folder does not exist.', 'INVALID_WORKSPACE'); }
    if (!stat.isDirectory()) throw new GitError('The workspace path is not a folder.', 'INVALID_WORKSPACE');
    const promise = (async () => {
      let result;
      try { result = await runGit(cwd, ['rev-parse', '--show-toplevel']); }
      catch (error) {
        if (error.code === 'GIT_UNAVAILABLE' || error.code === 'GIT_TIMEOUT') throw error;
        throw new GitError('This folder is not a Git repository.', 'NOT_REPOSITORY');
      }
      return path.resolve(result.stdout.trim());
    })();
    const entry = { promise, expires: Date.now() + 10000 };
    repositoryCache.set(key, entry);
    try {
      const root = await promise;
      repositoryCache.set(root, entry);
      return root;
    } catch (error) { repositoryCache.delete(key); throw error; }
  }

  async function status(cwd) {
    const root = await repository(cwd);
    const { stdout } = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
    const parsed = parseStatus(stdout);
    const hasHead = Boolean(parsed.branch.oid && parsed.branch.oid !== '(initial)' && !/^0+$/.test(parsed.branch.oid));
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const commands = [
      runGit(root, ['diff', '--numstat', '-z', '--']),
      runGit(root, ['diff', '--cached', '--numstat', '-z', ...(hasHead ? [] : [emptyTree]), '--']),
      runGit(root, ['diff', '--numstat', '-z', ...(hasHead ? ['HEAD'] : []), '--']),
      runGit(root, ['remote']),
    ];
    if (!hasHead) commands[2] = runGit(root, ['diff', '--cached', '--numstat', '-z', emptyTree, '--']);
    const [unstaged, staged, combined, remotes] = await Promise.all(commands);
    const unstagedStats = parseNumstat(unstaged.stdout), stagedStats = parseNumstat(staged.stdout), combinedStats = parseNumstat(combined.stdout);
    const statFiles = parsed.files.filter(file => file.untracked && !file.directory);
    const untracked = await mapLimit(statFiles, 6, file => untrackedStats(root, file.path));
    let untrackedIndex = 0;
    const files = parsed.files.map(file => {
      const extra = file.untracked && !file.directory ? untracked[untrackedIndex++] : null;
      const stats = file.directory ? null : file.untracked ? extra : combinedStats.get(file.path) || { additions: 0, deletions: 0 };
      return { ...file, stats, stagedStats: stagedStats.get(file.path) || null,
        unstagedStats: file.untracked ? extra : unstagedStats.get(file.path) || null };
    });
    return {
      root, name: path.basename(root) || root, branch: parsed.branch.head === '(detached)' ? parsed.branch.oid.slice(0, 7) : parsed.branch.head,
      detached: parsed.branch.head === '(detached)', upstream: parsed.branch.upstream, ahead: parsed.branch.ahead, behind: parsed.branch.behind,
      hasHead, files, ...totalStats(files), statsTruncated: parsed.files.some(file => file.directory),
      remotes: remotes.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
    };
  }

  async function untracked(cwd, { filePath, limit = 200 } = {}) {
    const root = await repository(cwd), directory = repoFile(root, filePath);
    const stat = await fs.promises.stat(directory.absolute).catch(() => null);
    if (!stat?.isDirectory()) throw new GitError('The untracked directory does not exist.', 'INVALID_PATH');
    const { stdout } = await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', directory.relative]);
    const paths = stdout.split('\0').filter(Boolean), cap = Math.max(1, Math.min(500, Number(limit) || 200));
    const selected = paths.slice(0, cap);
    const stats = await mapLimit(selected, 6, filePath => untrackedStats(root, filePath));
    const files = selected.map((filePath, index) => ({ path: filePath, oldPath: null, index: '?', worktree: '?', status: 'A',
      staged: false, unstaged: true, untracked: true, directory: false, stats: stats[index], stagedStats: null, unstagedStats: stats[index] }));
    return { root, directory: filePath, files, total: paths.length, truncated: paths.length > files.length };
  }

  async function diff(cwd, { filePath, scope = 'unstaged' } = {}) {
    const root = await repository(cwd);
    const file = repoFile(root, filePath);
    let args, allowExitCodes = [];
    if (scope === 'staged') {
      const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'], { allowExitCodes: [1, 128] });
      const base = head.code === 0 ? [] : ['4b825dc642cb6eb9a060e54bf8d69288fbee4904'];
      args = ['diff', '--cached', '--no-color', '--no-ext-diff', '--unified=3', ...base, '--', file.relative];
    } else if (scope === 'untracked') {
      args = ['diff', '--no-index', '--no-color', '--no-ext-diff', '--unified=3', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file.absolute];
      allowExitCodes = [1];
    } else if (scope === 'unstaged') args = ['diff', '--no-color', '--no-ext-diff', '--unified=3', '--', file.relative];
    else throw new GitError('Unknown diff scope.', 'INVALID_DIFF_SCOPE');
    const result = await runGit(root, args, { maxChars: MAX_DIFF_CHARS, allowExitCodes, truncate: true, timeout: 30000 });
    return { root, path: file.relative, scope, patch: result.stdout, truncated: result.truncated, binary: /^Binary files /m.test(result.stdout) };
  }

  async function locked(cwd, action) {
    const root = await repository(cwd);
    if (operationRoots.has(root)) throw new GitError('Another Git operation is already running in this repository.', 'GIT_BUSY');
    operationRoots.add(root);
    try { return await action(root); } finally { operationRoots.delete(root); }
  }

  function paths(root, values) {
    if (!Array.isArray(values) || !values.length || values.length > 5000) throw new GitError('Choose at least one file.', 'INVALID_PATHS');
    return values.map(value => repoFile(root, value).relative);
  }

  async function stage(cwd, values, unstage = false) {
    return locked(cwd, async root => {
      const files = paths(root, values);
      let result;
      if (!unstage) result = await runGit(root, ['add', '-A', '--', ...files]);
      else {
        const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'], { allowExitCodes: [1, 128] });
        result = head.code === 0 ? await runGit(root, ['reset', '-q', 'HEAD', '--', ...files])
          : await runGit(root, ['rm', '--cached', '-r', '-q', '--', ...files]);
      }
      return { output: (result.stdout || result.stderr).trim() };
    });
  }

  async function action(cwd, name, payload = {}) {
    if (name === 'stage') return stage(cwd, payload.paths, false);
    if (name === 'unstage') return stage(cwd, payload.paths, true);
    return locked(cwd, async root => {
      if (name === 'commit') {
        const message = typeof payload.message === 'string' ? payload.message.trim() : '';
        if (!message || message.length > 10000 || message.includes('\0')) throw new GitError('Enter a valid commit message.', 'INVALID_COMMIT_MESSAGE');
        const result = await runGit(root, ['commit', '-m', message]);
        const hash = await runGit(root, ['rev-parse', '--short', 'HEAD']);
        return { output: (result.stdout || result.stderr).trim(), hash: hash.stdout.trim() };
      }
      if (name === 'push') {
        const args = ['push', '--porcelain'];
        if (payload.setUpstream) {
          const remote = typeof payload.remote === 'string' ? payload.remote : '';
          if (!remote || remote.startsWith('-') || /[\s\0]/.test(remote)) throw new GitError('Choose a valid remote.', 'INVALID_REMOTE');
          const branch = (await runGit(root, ['branch', '--show-current'])).stdout.trim();
          if (!branch) throw new GitError('A detached HEAD cannot set an upstream branch.', 'DETACHED_HEAD');
          args.push('--set-upstream', remote, branch);
        }
        const result = await runGit(root, args, { timeout: 90000 });
        return { output: (result.stdout || result.stderr).trim() };
      }
      if (name === 'fetch') {
        const result = await runGit(root, ['fetch', '--all', '--prune'], { timeout: 90000 });
        return { output: (result.stdout || result.stderr).trim() };
      }
      if (name === 'pull') {
        const result = await runGit(root, ['pull', '--ff-only'], { timeout: 90000 });
        return { output: (result.stdout || result.stderr).trim() };
      }
      throw new GitError('Unsupported Git operation.', 'INVALID_GIT_OPERATION');
    });
  }

  return { status, diff, untracked, action };
}

module.exports = { createGitService, parseNumstat, parseStatus, GitError };
