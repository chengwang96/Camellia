'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHash, randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../shared/json-store');

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_RESOURCE_CHARS = 32000;
const MAX_BUNDLE_FILES = 256;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const BUILTINS = {
  review: {
    name: 'review',
    description: 'Review a bounded code change without modifying the workspace.',
    version: 1,
    readOnly: true,
    hosts: ['claude', 'codex', 'kimi', 'grok', 'antigravity', 'dsh'],
    triggers: ['code review', 'inspect this diff', '审查这段改动'],
    body: `# Review

Review the supplied change as a code reviewer. Inspect the packet and the
workspace with read-only tools only.

Report concrete defects first: correctness, regressions, security, data loss,
race conditions, and missing tests. Prefer findings with file, line, evidence,
and a focused recommendation. Do not edit files, run destructive commands,
commit, push, or change settings.

Return a structured review report when the review is complete. If no issue is
found, return a pass report and state which files and tests were reviewed.
`,
  },
  'adversarial-review': {
    name: 'adversarial-review',
    description: 'Challenge a design or implementation before shipping.',
    version: 1,
    readOnly: true,
    hosts: ['claude', 'codex', 'kimi', 'grok', 'antigravity', 'dsh'],
    triggers: ['adversarial review', 'challenge this design', '对抗性审查'],
    body: `# Adversarial review

Challenge the implementation and the assumptions behind it. Look for unsafe
defaults, hidden failure modes, data loss, rollback gaps, race conditions,
security boundaries, and simpler alternatives.

The supplied focus text tells you which assumptions to pressure-test. Do not
edit files, run destructive commands, commit, push, or change settings. Report
only actionable findings with evidence and a recommendation. If the design is
sound, say so explicitly and list the residual risks.
`,
  },
};

const HOSTS = {
  claude: { id: 'claude', name: 'Claude Code', mode: 'native-plugin', verified: true },
  codex: { id: 'codex', name: 'Codex', mode: 'native-plugin', verified: true },
  kimi: { id: 'kimi', name: 'Kimi Code', mode: 'portable-bridge', verified: false },
  grok: { id: 'grok', name: 'Grok Build', mode: 'portable-bridge', verified: false },
  antigravity: { id: 'antigravity', name: 'Antigravity', mode: 'native-skills-path', verified: true },
  dsh: { id: 'dsh', name: 'DSH', mode: 'portable-bridge', verified: false },
};

function clip(value, max = 280) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeName(value) {
  const name = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error('Invalid skill name');
  return name;
}

function safePath(root, relative) {
  const target = path.resolve(root, String(relative || ''));
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path must stay inside the skill or destination');
  return { target, relative: rel };
}

function parseFrontmatter(text) {
  const input = String(text || '');
  if (!input.startsWith('---')) return { data: {}, body: input };
  const end = input.indexOf('\n---', 3);
  if (end < 0) throw new Error('Skill frontmatter is not terminated');
  let data;
  try { data = YAML.parse(input.slice(4, end)) || {}; }
  catch (error) { throw new Error('Invalid skill frontmatter: ' + error.message); }
  return { data: data && typeof data === 'object' ? data : {}, body: input.slice(end + 4).replace(/^\r?\n/, '') };
}

function validateManifest(manifest, body, file = 'SKILL.md') {
  const name = safeName(manifest.name);
  if (!String(manifest.description || '').trim()) throw new Error(file + ': description is required');
  if (Buffer.byteLength(body) > MAX_SKILL_BYTES) throw new Error(file + ': skill text is too large');
  return {
    name,
    description: String(manifest.description).trim(),
    version: Number.isSafeInteger(manifest.version) ? manifest.version : 1,
    license: typeof manifest.license === 'string' ? manifest.license.slice(0, 128) : '',
    allowedTools: Array.isArray(manifest['allowed-tools']) ? manifest['allowed-tools'].map(String).slice(0, 64) : [],
    readOnly: manifest.metadata?.camellia?.['read-only'] === true || manifest.readOnly === true,
    hosts: Array.isArray(manifest.metadata?.camellia?.hosts) ? manifest.metadata.camellia.hosts.map(String) : [],
    triggers: Array.isArray(manifest.metadata?.camellia?.triggers) ? manifest.metadata.camellia.triggers.map(String) : [],
    body,
  };
}

function readSkill(directory) {
  const file = path.join(directory, 'SKILL.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error(file + ': skill is too large');
  const parsed = parseFrontmatter(text);
  let sidecar = {};
  try {
    const sidecarFile = path.join(directory, 'skill.json');
    if (fs.existsSync(sidecarFile) && fs.statSync(sidecarFile).size <= MAX_SKILL_BYTES) sidecar = readJson(sidecarFile, {});
  } catch { sidecar = {}; }
  return { ...validateManifest({ ...sidecar, ...parsed.data }, parsed.body, file), directory, file };
}

function skillDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => path.join(root, entry.name))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function readSkillFiles(directory) {
  const files = new Map();
  let bytes = 0;
  const visit = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'skill.json') continue;
      const full = path.join(current, entry.name);
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Skill bundles cannot contain symbolic links: ' + relative);
      if (entry.isDirectory()) { visit(full, relative); continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(full).size;
      bytes += size;
      if (files.size >= MAX_BUNDLE_FILES) throw new Error('Skill bundle has too many files');
      if (bytes > MAX_BUNDLE_BYTES) throw new Error('Skill bundle is too large');
      files.set(relative, fs.readFileSync(full));
    }
  };
  visit(directory);
  if (!files.has('SKILL.md')) throw new Error('Skill bundle is missing SKILL.md');
  return files;
}

function filesHash(files) {
  const hash = createHash('sha256');
  for (const [relative, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(relative.replace(/\\/g, '/')).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

function directoryFilesHash(directory) {
  const files = new Map();
  let bytes = 0;
  const visit = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Installed skill contains a symbolic link: ' + relative);
      if (entry.isDirectory()) { visit(full, relative); continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(full).size;
      bytes += size;
      if (files.size >= MAX_BUNDLE_FILES || bytes > MAX_BUNDLE_BYTES) throw new Error('Installed skill is too large to verify');
      files.set(relative, fs.readFileSync(full));
    }
  };
  visit(directory);
  return filesHash(files);
}

function writeFiles(destination, files) {
  const staging = destination + '.camellia-staging-' + randomUUID();
  const backup = destination + '.camellia-backup';
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const [relative, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const { target } = safePath(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
    }
    const written = new Map();
    for (const relative of files.keys()) {
      const { target } = safePath(staging, relative);
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Generated skill target cannot be a symbolic link');
      written.set(relative, fs.readFileSync(target));
    }
    if (filesHash(written) !== filesHash(files)) throw new Error('Generated skill bundle failed validation');
    const previous = fs.existsSync(destination);
    if (previous) {
      fs.rmSync(backup, { recursive: true, force: true });
      fs.renameSync(destination, backup);
    }
    try { fs.renameSync(staging, destination); }
    catch (error) {
      if (previous && fs.existsSync(backup) && !fs.existsSync(destination)) fs.renameSync(backup, destination);
      throw error;
    }
    return { destination, backup: previous ? backup : '', hash: filesHash(files) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function restoreDirectory(destination, backup) {
  try { fs.rmSync(destination, { recursive: true, force: true }); } catch { /* preserve original error */ }
  if (backup && fs.existsSync(backup)) {
    try { fs.renameSync(backup, destination); } catch { /* recovery path is reported by the installation record */ }
  }
}

function compileFiles(skill, host) {
  if (!HOSTS[host]) throw new Error('Unsupported skill host: ' + host);
  if (!HOSTS[host].verified) throw new Error(HOSTS[host].name + ' uses the portable Camellia bridge; a native layout is not verified');
  const source = readSkillFiles(skill.directory);
  const files = new Map();
  for (const [relative, content] of source) files.set(path.join('skills', skill.name, relative), content);
  if (host === 'claude') {
    files.set('.claude-plugin/plugin.json', Buffer.from(JSON.stringify({
      name: skill.name, description: skill.description, version: String(skill.version),
      author: { name: 'Camellia' }, license: skill.license || 'MIT', skills: './skills/',
    }, null, 2) + '\n'));
  } else if (host === 'codex') {
    files.set('.codex-plugin/plugin.json', Buffer.from(JSON.stringify({
      name: skill.name, description: skill.description, version: String(skill.version),
      author: { name: 'Camellia' }, license: skill.license || 'MIT', skills: './skills/',
    }, null, 2) + '\n'));
  }
  return { host, mode: HOSTS[host].mode, files, hash: filesHash(files) };
}

function createSkillRegistry({ root } = {}) {
  if (!root) throw new Error('A skill directory is required');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const appRoot = path.dirname(root);
  const stateFile = path.join(root, '.registry.json');
  let diagnostics = [];

  function ensureBuiltins() {
    for (const [name, skill] of Object.entries(BUILTINS)) {
      const directory = path.join(root, name), file = path.join(directory, 'SKILL.md');
      if (fs.existsSync(file)) continue;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const text = [
        '---',
        'name: ' + name,
        'description: ' + JSON.stringify(skill.description),
        'version: ' + skill.version,
        'license: MIT',
        'allowed-tools:',
        '  - Read',
        '  - Grep',
        'metadata:',
        '  camellia:',
        '    read-only: true',
        '    hosts:',
        ...skill.hosts.map(host => '      - ' + host),
        '    triggers:',
        ...skill.triggers.map(trigger => '      - ' + JSON.stringify(trigger)),
        '---',
        '',
        skill.body.trim(),
        '',
      ].join('\n');
      fs.writeFileSync(file, text, { mode: 0o600 });
    }
  }

  function readState() {
    let value;
    try { value = readJson(stateFile, { version: 1, skills: {} }); }
    catch (error) {
      try { fs.renameSync(stateFile, stateFile + '.invalid-' + randomUUID()); } catch { /* retain readable state failure */ }
      diagnostics.push({ level: 'error', code: 'registry-state', detail: error.message });
      return { version: 1, skills: {} };
    }
    if (!value || value.version !== 1 || !value.skills || typeof value.skills !== 'object') return { version: 1, skills: {} };
    return value;
  }

  function writeState(value) { writeJson(stateFile, value); }

  function syncSkillState(skill) {
    const state = readState();
    const previous = state.skills[skill.name] || {};
    state.skills[skill.name] = {
      sourceHash: filesHash(readSkillFiles(skill.directory)),
      version: skill.version,
      enabled: previous.enabled !== false,
      trust: Object.hasOwn(BUILTINS, skill.name) ? 'builtin' : previous.trust || 'local',
      targets: previous.targets && typeof previous.targets === 'object' ? previous.targets : {},
    };
    writeState(state);
    return state.skills[skill.name];
  }

  function scan() {
    ensureBuiltins();
    diagnostics = [];
    const byName = new Map(), skills = [];
    for (const directory of skillDirs(root)) {
      try {
        const skill = readSkill(directory);
        if (!skill) continue;
        const key = skill.name.toLowerCase();
        const previous = byName.get(key);
        if (previous) {
          diagnostics.push({ level: 'error', code: 'duplicate-name', name: skill.name,
            detail: 'Duplicate skill name in ' + previous.directory + ' and ' + directory });
          continue;
        }
        byName.set(key, skill);
        skills.push(skill);
      } catch (error) {
        diagnostics.push({ level: 'error', code: 'invalid-skill', path: path.relative(root, directory),
          detail: error.message });
      }
    }
    return skills.sort((first, second) => first.name.localeCompare(second.name));
  }

  function list() { return scan(); }

  function find(name) {
    return list().find(skill => skill.name === safeName(name)) || null;
  }

  function load(name) {
    const skill = find(name);
    if (!skill) throw new Error('Unknown skill: ' + name);
    return skill;
  }

  function resource(name, relative = '', maxChars = 12000) {
    const skill = load(name);
    const requested = String(relative || '');
    if (!requested || requested.includes('\0')) throw new Error('Skill resource path is required');
    const { target } = safePath(skill.directory, requested);
    let stat;
    try { stat = fs.lstatSync(target); } catch { throw new Error('Skill resource not found'); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Skill resource not found');
    const realRoot = fs.realpathSync(skill.directory);
    const realTarget = fs.realpathSync(target);
    const realRelative = path.relative(realRoot, realTarget);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative))
      throw new Error('Skill resource must stay inside the skill directory');
    if (stat.size > MAX_RESOURCE_BYTES) throw new Error('Skill resource is too large');
    const cap = Math.min(MAX_RESOURCE_CHARS, Math.max(256, Number(maxChars) || 12000));
    const text = fs.readFileSync(realTarget, 'utf8');
    return { name: skill.name, path: path.relative(skill.directory, target), text: clip(text, cap), truncated: text.length > cap };
  }

  function installations(name) {
    const state = readState();
    const targets = state.skills[name]?.targets || {};
    return Object.entries(targets).map(([key, record]) => ({ key, ...record }))
      .sort((first, second) => second.installedAt - first.installedAt);
  }

  function targetsForHost(host) {
    const state = readState();
    return Object.values(state.skills).flatMap(skill => Object.values(skill.targets || {}))
      .filter(record => record.host === host && fs.existsSync(record.path))
      .sort((first, second) => second.installedAt - first.installedAt);
  }

  function catalog() {
    return list().map(skill => {
      const sourceHash = filesHash(readSkillFiles(skill.directory));
      return {
        name: skill.name, description: skill.description, version: skill.version,
        readOnly: skill.readOnly, triggers: skill.triggers, hosts: skill.hosts,
        trust: Object.hasOwn(BUILTINS, skill.name) ? 'builtin' : readState().skills[skill.name]?.trust || 'local',
        sourceHash, targets: installations(skill.name),
      };
    });
  }

  function hosts() {
    return Object.values(HOSTS).map(host => ({ ...host,
      available: host.verified, fallback: host.verified ? '' : 'portable-bridge' }));
  }

  function marketplaceManifest(host) {
    if (host !== 'codex') return null;
    const root = path.join(appRoot, 'codex-skill-marketplace');
    const pluginsDir = path.join(root, 'plugins');
    const plugins = targetsForHost('codex').filter(record => {
      const relative = path.relative(pluginsDir, record.path);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }).map(record => ({
      name: path.basename(record.path), source: { source: 'local', path: './plugins/' + path.basename(record.path) },
      policy: { installation: 'AVAILABLE' }, category: 'Development',
    }));
    const file = path.join(root, '.agents', 'plugins', 'marketplace.json');
    writeJson(file, { name: 'camellia-skills', interface: { displayName: 'Camellia Skills' }, plugins });
    return { name: 'camellia-skills', root, file, plugins };
  }

  function preview(name, host = 'claude') {
    const skill = load(name);
    const sourceFiles = readSkillFiles(skill.directory);
    let compiled = null, error = '';
    try { compiled = compileFiles(skill, host); }
    catch (reason) { error = reason.message; }
    return { skill: { name: skill.name, description: skill.description, version: skill.version,
      readOnly: skill.readOnly, body: skill.body, allowedTools: skill.allowedTools, license: skill.license },
      host: HOSTS[host] || { id: host }, supported: Boolean(compiled), error,
      files: compiled ? [...compiled.files.keys()] : [...sourceFiles.keys()].map(file => path.join('skills', skill.name, file)),
      hash: compiled?.hash || filesHash(sourceFiles) };
  }

  function exportBundle(name, host, destination) {
    const skill = load(name);
    const compiled = compileFiles(skill, host);
    const target = path.resolve(destination);
    const written = writeFiles(target, compiled.files);
    return { name, host, directory: target, files: [...compiled.files.keys()], hash: written.hash,
      backupDir: written.backup };
  }

  function install(name, host, payload = {}) {
    const skill = load(name);
    const scope = ['app', 'custom', 'global'].includes(payload.scope) ? payload.scope : payload.destination ? 'custom' : 'app';
    if (scope === 'global' && payload.allowGlobal !== true)
      throw new Error('Global skill installation requires explicit confirmation');
    const destination = scope === 'app'
      ? host === 'codex'
        ? path.join(appRoot, 'codex-skill-marketplace', 'plugins', name)
        : path.join(appRoot, 'skill-targets', host, name)
      : path.resolve(String(payload.destination || ''));
    if (!destination) throw new Error('Choose an installation destination');
    if (scope === 'custom' && !fs.existsSync(path.dirname(destination)))
      throw new Error('The destination parent folder does not exist');
    const compiled = compileFiles(skill, host);
    const written = writeFiles(destination, compiled.files);
    const state = readState();
    const skillState = state.skills[name] ||= { sourceHash: filesHash(readSkillFiles(skill.directory)),
      version: skill.version, enabled: true, trust: Object.hasOwn(BUILTINS, name) ? 'builtin' : 'local', targets: {} };
    const key = host + ':' + destination;
    const record = { host, mode: compiled.mode, path: destination, scope, hash: written.hash,
      version: skill.version, installedAt: Date.now(), backupDir: written.backup };
    const previous = skillState.targets[key];
    for (const [otherName, other] of Object.entries(state.skills)) {
      for (const [otherKey, otherRecord] of Object.entries(other.targets || {})) {
        if (otherName !== name && path.resolve(otherRecord.path) === path.resolve(destination)) delete other.targets[otherKey];
      }
    }
    skillState.targets[key] = record;
    try { writeState(state); }
    catch (error) {
      if (previous) skillState.targets[key] = previous; else delete skillState.targets[key];
      restoreDirectory(destination, written.backup);
      throw error;
    }
    if (host === 'codex') marketplaceManifest('codex');
    return { ok: true, name, target: { key, ...record } };
  }

  function uninstall(name, { host = '', destination = '' } = {}) {
    const skill = load(name);
    const state = readState();
    const targets = state.skills[name]?.targets || {};
    const matches = Object.entries(targets).filter(([, record]) =>
      (!host || record.host === host) && (!destination || path.resolve(record.path) === path.resolve(destination)));
    if (!matches.length) throw new Error('Skill is not installed for the requested target');
    const removed = [];
    for (const [key, record] of matches) {
      const actual = fs.existsSync(record.path) ? directoryFilesHash(record.path) : '';
      if (actual && actual !== record.hash) throw new Error('The installed skill was changed outside Camellia; remove it manually');
      const recovery = path.join(appRoot, 'skill-backups', host || record.host,
        path.basename(record.path) + '-' + Date.now() + '-' + randomUUID().slice(0, 8));
      if (fs.existsSync(record.path)) {
        fs.mkdirSync(path.dirname(recovery), { recursive: true, mode: 0o700 });
        fs.renameSync(record.path, recovery);
      }
      delete targets[key];
      removed.push({ key, ...record, recoveryPath: fs.existsSync(recovery) ? recovery : '' });
    }
    try { writeState(state); }
    catch (error) {
      for (const record of removed) {
        if (record.recoveryPath && fs.existsSync(record.recoveryPath)) {
          try { fs.renameSync(record.recoveryPath, record.path); } catch { /* reported by caller */ }
        }
      }
      throw error;
    }
    if (removed.some(record => record.host === 'codex')) marketplaceManifest('codex');
    return { ok: true, name, removed };
  }

  function doctor() {
    scan();
    const state = readState();
    for (const [name, skillState] of Object.entries(state.skills)) {
      for (const record of Object.values(skillState.targets || {})) {
        if (!fs.existsSync(record.path)) {
          diagnostics.push({ level: 'error', code: 'missing-installation', name, path: record.path,
            detail: 'Installed skill directory is missing' });
          continue;
        }
        try {
          if (directoryFilesHash(record.path) !== record.hash)
            diagnostics.push({ level: 'warn', code: 'modified-installation', name, path: record.path,
              detail: 'Installed skill differs from the recorded hash' });
        } catch (error) {
          diagnostics.push({ level: 'error', code: 'unreadable-installation', name, path: record.path,
            detail: error.message });
        }
      }
    }
    return { root, diagnostics: [...diagnostics], hosts: hosts(), stateFile };
  }

  ensureBuiltins();
  return { root, list, find, catalog, load, resource, hosts, preview, exportBundle,
    install, uninstall, doctor, targetsForHost, marketplaceManifest, ensureBuiltins };
}

module.exports = { BUILTINS, HOSTS, MAX_SKILL_BYTES, MAX_RESOURCE_BYTES, MAX_BUNDLE_BYTES,
  createSkillRegistry, parseFrontmatter, readSkillFiles };
