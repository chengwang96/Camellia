/* Workbench settings shell, using DeepSeek Harness's public settings slots.
 * The registered sections, stores and controls remain provided by DSH plugins.
 * Compatible with @deepseek-ai/dsh-client-ui-settings-general 0.1.5-rc.2.
 */
'use strict';
const React = require('react');
const h = React.createElement;
const embedded = window.dshDesktop?.settingsEmbedded === true || window.name === 'workbench-settings' || new URLSearchParams(location.search).has('workbench-settings');
function openWorkbench(page = 'engines') {
  const target = { page, engine: 'dsh' };
  if (window.dshDesktop) window.dshDesktop.openSettingsWindow(target);
  else parent.postMessage({ type: 'workbench:settings', ...target }, '*');
}
function EmbeddedSettings({ useSections, renderSlot }) {
  const rows = useSections(s => s).filter(row => row.id !== 'models');
  const [selected, select] = React.useState('general');
  const active = rows.find(row => row.id === selected)?.id || rows[0]?.id;
  React.useEffect(() => {
    if (window.dshDesktop) window.dshDesktop.nativeSettingsReady();
    else parent.postMessage({ type: 'workbench:settings-ready' }, '*');
  }, []);
  return h('section', { className: 'workbench-native-settings', 'aria-label': "DSH settings" },
    h('style', null, `
      .workbench-native-settings {position:fixed;inset:0;z-index:9999;display:flex;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#191b1f);font:14px/1.6 system-ui,sans-serif}
      .workbench-native-nav {flex:0 0 158px;padding:16px 12px;border-right:1px solid var(--dsw-alias-border-weak,#eceef1);overflow:auto}
      .workbench-native-nav button {display:block;width:100%;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;padding:9px 12px;margin-bottom:4px;cursor:pointer}
      .workbench-native-nav button:hover,.workbench-native-nav [aria-current=true] {background:var(--dsw-specific-sidebar-nav-item-active,#eef0f3)}
      .workbench-native-content {flex:1;min-width:0;padding:20px 24px;overflow:auto}
      .workbench-native-settings button:focus-visible {outline:2px solid #749bd4;outline-offset:2px}
      @media(max-width:650px){.workbench-native-nav{flex-basis:128px;padding:10px 6px}.workbench-native-content{padding:16px}}
    `),
    h('nav', { className: 'workbench-native-nav', 'aria-label': "DSH settings categories" },
      ...rows.map(row => h('button', { key: row.id, 'aria-current': row.id === active ? 'true' : 'false', onClick: () => select(row.id) }, row.label)),
      h('button', { onClick: () => openWorkbench('providers') }, "Providers & Keys ↗")),
    h('div', { className: 'workbench-native-content' }, active && renderSlot('settings.section', { close: () => {} }, { only: active })));
}
module.exports = function WorkbenchSettingsRoot(props) {
  if (embedded) return h(EmbeddedSettings, props);
  if (!window.dshDesktop) return h(SettingsRoot, props);
  return h('button', { type: 'button', 'aria-label': props.t('trigger'), onClick: () => openWorkbench(),
    style: { width: '100%', padding: '10px 8px', border: 0, borderRadius: 12, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 } },
    props.renderSlot('settings.trigger', { wide: props.wide }));
};
