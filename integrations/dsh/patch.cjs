'use strict';
const fs = require('node:fs');
const path = require('node:path');
const patchClientPerformance = require('./client-performance.cjs');
module.exports = function patchDsh(runtimeDir) {
  const plugin = path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh-client-ui-settings-general');
  const version = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'))).version;
  if (version !== '0.1.5-rc.2') throw new Error(`The DSH settings integration does not support ${version}. Use the runtime version pinned by this project.`);
  const file = path.join(plugin, 'lib/client.js');
  const original = file + '.workbench-original';
  if (!fs.existsSync(original)) fs.copyFileSync(file, original);
  const source = fs.readFileSync(original, 'utf8');
  const register = '}, SettingsRoot));';
  const marker = '\t\texports.SettingsDocumentStore = SettingsDocumentStore;';
  if (source.split(register).length !== 2 || !source.includes(marker)) throw new Error("The DSH settings extension entry point changed");
  const component = fs.readFileSync(path.join(__dirname, 'settings-root.js'), 'utf8');
  const injection = `\nconst WorkbenchSettingsRoot = (() => { const module = { exports: {} };\n${component}\nreturn module.exports; })();\n`;
  fs.writeFileSync(file, source.replace(register, '}, WorkbenchSettingsRoot));').replace(marker, injection + marker));

  const modules = path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh-client-modules');
  if (JSON.parse(fs.readFileSync(path.join(modules, 'package.json'))).version !== '0.1.5-rc.2') throw new Error("The DSH frontend optimization does not support this version");
  const modulesFile = path.join(modules, 'lib/index.js');
  const modulesOriginal = modulesFile + '.workbench-original';
  if (!fs.existsSync(modulesOriginal)) fs.copyFileSync(modulesFile, modulesOriginal);
  fs.writeFileSync(modulesFile, patchClientPerformance(fs.readFileSync(modulesOriginal, 'utf8')));

  const locale = path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh-client-locale');
  if (JSON.parse(fs.readFileSync(path.join(locale, 'package.json'))).version !== '0.1.5-rc.2') throw new Error('The DSH locale integration does not support this version');
  const localeFile = path.join(locale, 'lib/client.js');
  const localeOriginal = localeFile + '.workbench-original';
  if (!fs.existsSync(localeOriginal)) fs.copyFileSync(localeFile, localeOriginal);
  const localeSource = fs.readFileSync(localeOriginal, 'utf8');
  const browserDefault = 'return detectBrowserLocale(locales) ?? "en";';
  if (localeSource.split(browserDefault).length !== 2) throw new Error('The DSH default locale entry point changed');
  // Keep an explicit native preference, but use English for new profiles on every OS.
  fs.writeFileSync(localeFile, localeSource.replace(browserDefault, 'return "en"; // Camellia default; explicit preferences still take precedence.'));
};
