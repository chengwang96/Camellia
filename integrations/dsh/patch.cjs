'use strict';
const fs = require('node:fs');
const path = require('node:path');
const patchClientPerformance = require('./client-performance.cjs');
module.exports = function patchDsh(runtimeDir) {
  const plugin = path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh-client-ui-settings-general');
  const version = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'))).version;
  if (!['0.1.5-rc.2', '0.2.0-rc.2'].includes(version)) throw new Error(`The DSH settings integration does not support ${version}. Use the runtime version pinned by this project.`);
  const file = path.join(plugin, 'lib/client.js');
  const original = file + '.workbench-original';
  if (!fs.existsSync(original)) fs.copyFileSync(file, original);
  const source = fs.readFileSync(original, 'utf8');
  const register = version === '0.2.0-rc.2' ? '}, SettingsRoot);' : '}, SettingsRoot));';
  const marker = '\t\texports.SettingsDocumentStore = SettingsDocumentStore;';
  if (source.split(register).length !== 2 || !source.includes(marker)) throw new Error("The DSH settings extension entry point changed");
  const component = fs.readFileSync(path.join(__dirname, 'settings-root.js'), 'utf8');
  const injection = `\nconst WorkbenchSettingsRoot = (() => { const module = { exports: {} };\n${component}\nreturn module.exports; })();\n`;
  const generalComponent = 'function GeneralSection({ renderSlot }) {';
  const generalRegistration = 'id: "general",';
  if (source.split(generalComponent).length !== 2 || source.split(generalRegistration).length !== 2) throw new Error('The DSH General settings entry point changed');
  // Subscribe to the public slot ledger so additional plugin controls retain
  // their own stores, handlers and ordering, including after a plugin reload.
  const generalItems = `inject: (() => {
      let version = -1, entries = [];
      return () => ({ hooks: { generalItems: {
        getSnapshot: () => {
          const next = ctx.slots.getVersion("settings.general.item");
          if (next !== version) {
            version = next;
            entries = ctx.slots.entries("settings.general.item").map(e => ({ id: e.options.id, order: e.options.order ?? 0 })).sort((a, b) => a.order - b.order);
          }
          return entries;
        },
        subscribe: listener => ctx.slots.subscribe("settings.general.item", listener)
      } } });
    })(),`;
  fs.writeFileSync(file, source.replace(register, register.replace('SettingsRoot', 'WorkbenchSettingsRoot'))
    .replace(generalComponent, `function GeneralSection({ renderSlot, useGeneralItems }) {
      if (window.dshDesktop?.settingsEmbedded === true || window.name === 'workbench-settings' || new URLSearchParams(location.search).has('workbench-settings')) {
        return require('react').createElement(WorkbenchSettingsRoot.General, { renderSlot, useGeneralItems });
      }`)
    .replace(generalRegistration, generalRegistration + '\n' + generalItems)
    .replace(marker, injection + marker));

  const modules = path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh-client-modules');
  if (JSON.parse(fs.readFileSync(path.join(modules, 'package.json'))).version !== version) throw new Error("The DSH frontend optimization does not support this version");
  const modulesFile = path.join(modules, 'lib/index.js');
  const modulesOriginal = modulesFile + '.workbench-original';
  if (!fs.existsSync(modulesOriginal)) fs.copyFileSync(modulesFile, modulesOriginal);
  fs.writeFileSync(modulesFile, patchClientPerformance(fs.readFileSync(modulesOriginal, 'utf8'), version));

  const locale = path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh-client-locale');
  if (JSON.parse(fs.readFileSync(path.join(locale, 'package.json'))).version !== version) throw new Error('The DSH locale integration does not support this version');
  const localeFile = path.join(locale, 'lib/client.js');
  const localeOriginal = localeFile + '.workbench-original';
  if (!fs.existsSync(localeOriginal)) fs.copyFileSync(localeFile, localeOriginal);
  const localeSource = fs.readFileSync(localeOriginal, 'utf8');
  const browserDefault = version === '0.2.0-rc.2' ? 'return detectBrowserLocale(locales, languages) ?? "en";' : 'return detectBrowserLocale(locales) ?? "en";';
  if (localeSource.split(browserDefault).length !== 2) throw new Error('The DSH default locale entry point changed');
  // Camellia owns the display language. Standalone DSH keeps its native preference.
  const localeConstructor = version === '0.2.0-rc.2' ? 'new LocaleRuntime(ctx, ctx.configForms.get(LOCALE_SETTINGS_NAMESPACE), bootstrap)'
    : 'new LocaleRuntime(ctx, ctx.settingsScope.bind({ namespace: LOCALE_SETTINGS_NAMESPACE }))';
  const camelliaLocale = version === '0.2.0-rc.2' ? 'new LocaleRuntime(ctx, window.dshDesktop ? undefined : ctx.configForms.get(LOCALE_SETTINGS_NAMESPACE), bootstrap)'
    : 'new LocaleRuntime(ctx, window.dshDesktop ? undefined : ctx.settingsScope.bind({ namespace: LOCALE_SETTINGS_NAMESPACE }))';
  const installLocale = 'ctx.slots.installLocale(locale);';
  const languageRow = 'ctx.slots.inject("settings.general.item", () => ctx.slots.register({';
  for (const marker of [localeConstructor, installLocale, languageRow]) {
    if (localeSource.split(marker).length !== 2) throw new Error('The DSH locale integration entry point changed');
  }
  fs.writeFileSync(localeFile, localeSource
    .replace(browserDefault, 'return "en"; // Camellia default')
    .replace(localeConstructor, camelliaLocale)
    .replace(installLocale, `${installLocale}
      if (window.dshDesktop) {
        const setLanguage = language => locale.setLocale(language === 'zh-CN' ? 'zh' : 'en');
        window.dshDesktop.workbenchSettings().then(settings => { if (settings.ok) setLanguage(settings.language); });
        ctx.effect(() => window.dshDesktop.onLanguageChanged(setLanguage), 'locale: Camellia language');
      }`)
    .replace(languageRow, 'if (!window.dshDesktop) ' + languageRow));
};
