'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isolatedEnvironment(home, node, inherited = process.env) {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'SHELL']) {
    if (inherited[key]) env[key] = inherited[key];
  }
  delete env.Path;
  env.PATH = path.dirname(node) + path.delimiter + (inherited.PATH || inherited.Path || '');
  for (const name of ['tmp', 'appdata', 'local', 'config', 'cache', 'data']) fs.mkdirSync(path.join(home, name), { recursive: true });
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'local'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
    TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', CI: '1',
    OPENAI_API_KEY: 'proxy-managed', ANTHROPIC_API_KEY: 'proxy-managed' });
  return env;
}

module.exports = { isolatedEnvironment };
