'use strict';

(() => {
const embedded = Boolean(document.getElementById('mobilePage'));
const root = embedded ? document.getElementById('mobilePage') : document.querySelector('main');
let visible = !embedded;
const copy = {
  zh: { title: '手机访问', intro: '通过 Tailscale 连接手机。', connection: '连接', pair: '配对设备', devices: '已授权设备', connectionHelp: '连接与权限说明',
    network: '已内置 Tailscale，无需另装客户端。首次开启后登录与手机相同的 Tailnet；不开放局域网或公网端口。每次启动 Camellia 后需要手动开启。',
    scope: '可查看和操作全部现有及未来会话，仅授权可信设备。', generate: '生成配对码',
    pairHint: '在手机输入地址和一次性配对码，再在此确认授权。',
    footer: '授权设备可发送指令、停止任务和处理工具审批。操作在电脑执行，并沿用会话当前权限；仅授权可信设备。', online: '运行中', offline: '已关闭',
    start: '开启手机访问', stop: '关闭手机访问', noAddress: '开启后显示 Tailscale 地址',
    tray: '关闭窗口可驻留托盘；退出应用或电脑休眠会断开连接。', noTray: '请保持窗口打开，或在设置中启用关闭到托盘。退出应用或电脑休眠会断开连接。',
    noDevices: '尚未授权任何设备。', approve: '授权设备', reject: '拒绝', revoke: '撤销',
    expires: '配对码失效时间：', expired: '配对码已过期，请重新生成。' },
  en: { title: 'Mobile access', intro: 'Connect your phone with Tailscale.', connection: 'Connection', pair: 'Pair a device', devices: 'Authorized devices', connectionHelp: 'Connection and permissions',
    network: 'Tailscale is built in; no separate client needed. Sign in to the same tailnet as your phone. No LAN or public listener. Enable manually after each Camellia restart.',
    scope: 'Allows viewing and controlling all current and future conversations. Trust this device before authorizing.', generate: 'Generate pairing code',
    pairHint: 'Enter the address and one-time code on your phone, then approve it here.',
    footer: 'Authorized devices can send instructions, stop tasks and respond to tool approvals. Tasks execute on this computer under the conversation’s existing permissions; authorize trusted devices only.', online: 'Online', offline: 'Off',
    start: 'Enable mobile access', stop: 'Disable mobile access', noAddress: 'Enable to show the Tailscale address',
    tray: 'Closing the window keeps the app in the tray. Quitting or computer sleep disconnects clients.', noTray: 'Keep the window open or enable close to tray in Settings. Quitting or computer sleep disconnects clients.',
    noDevices: 'No authorized devices yet.', approve: 'Authorize device', reject: 'Reject', revoke: 'Revoke',
    expires: 'Pairing code expires at: ', expired: 'The pairing code expired. Generate another.' },
};
const element = id => document.getElementById(embedded ? `mobile-${id}` : id);
Object.assign(copy.zh, { login: '登录 Tailscale', openLogin: '打开浏览器授权', logout: '退出 Tailscale 登录', confirmLogout: '退出内置网络登录并断开手机访问？下次需要重新授权，已有 Camellia 设备权限保留。',
  connecting: '正在连接内置网络…', needsLogin: '请登录 Tailscale', needsApproval: '请在 Tailscale 管理后台批准此设备', networkError: '内置网络已断开，请重新开启', networkReady: '内置网络已连接', networkOff: '内置网络已关闭' });
Object.assign(copy.en, { login: 'Sign in to Tailscale', openLogin: 'Authorize in browser', logout: 'Sign out of Tailscale', confirmLogout: 'Sign out of embedded networking and disconnect mobile access? You will need to authorize again. Camellia device permissions are retained.',
  connecting: 'Connecting to embedded network…', needsLogin: 'Sign in to Tailscale', needsApproval: 'Approve this device in the Tailscale admin console', networkError: 'Embedded network disconnected. Enable it again.', networkReady: 'Embedded network connected', networkOff: 'Embedded network off' });
Object.assign(copy.zh, { unassigned: '独立会话', allScope: '全部工作区（含今后新增）及独立会话', applyScope: '授权全部访问', confirmScope: '允许此设备查看和操作当前及今后新增的全部工作区和独立会话？' });
Object.assign(copy.en, { unassigned: 'Independent conversations', allScope: 'All workspaces (including future ones) and independent conversations', applyScope: 'Authorize full access', confirmScope: 'Allow this device to read and control all current and future workspaces and independent conversations?' });
Object.assign(copy.zh, { unavailable: '状态加载失败', loading: '正在加载…', retry: '重试', openPanel: '打开独立手机访问面板',
  restart: '手机访问页面已更新，但桌面主进程仍是旧版。请保存工作后完全退出 Camellia（包括托盘）并重新启动；刷新页面不会更新主进程。也可先打开独立面板管理连接。',
  loadFailed: '无法加载手机访问状态，请重试。', loadDevices: '暂时无法加载已授权设备，请重试。' });
Object.assign(copy.en, { unavailable: 'Status unavailable', loading: 'Loading…', retry: 'Retry', openPanel: 'Open mobile access panel',
  restart: 'The mobile access page has been updated, but the desktop process is still an older version. Save your work, fully quit Camellia (including the tray), and restart it. Refreshing the page does not update the desktop process. You can use the separate panel in the meantime.',
  loadFailed: 'Unable to load mobile access status. Please retry.', loadDevices: 'Unable to load authorized devices. Please retry.' });
let state = null, language = 'zh', working = false, invitationExpiry = 0;
const translate = key => copy[language][key];
const scope = () => ({ workspaceIds: [], allWorkspaces: true, includeUnassigned: true });

async function call(action, payload) {
  const response = embedded ? await window.dshDesktop.remoteControl(action, payload) : await window.camelliaRemote.control(action, payload);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
function renderCopy() {
  language = (embedded ? window.CamelliaI18n?.language || document.documentElement.lang : state?.language || document.documentElement.lang) === 'en' ? 'en' : 'zh';
  for (const node of root.querySelectorAll('[data-copy]')) node.textContent = translate(node.dataset.copy);
}
function showError(error) {
  const legacy = embedded && error.message === 'Local remote-access window required';
  element('error').textContent = legacy ? translate('restart') : error.message === 'Mobile access is unavailable' ? translate('loadFailed') : error.message;
  if (embedded) element('openPanel').hidden = !legacy;
}
function renderUnavailable(error) {
  state = null;
  renderCopy();
  element('status').textContent = translate('unavailable');
  element('status').classList.remove('online');
  element('address').textContent = translate('loadFailed');
  element('toggle').textContent = translate('start');
  element('lifetime').textContent = '';
  element('devices').textContent = translate('loadDevices');
  element('pending').replaceChildren();
  element('invitation').hidden = true;
  element('code').textContent = '';
  invitationExpiry = 0;
  for (const control of root.querySelectorAll('button, input[type="checkbox"]')) control.disabled = true;
  element('retry').disabled = false;
  element('retry').hidden = false;
  if (embedded) element('openPanel').disabled = false;
  showError(error);
}
function renderDevices(target, entries, pending) {
  target.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement('div'), name = document.createElement('div'), label = document.createElement('small'), actions = document.createElement('div');
    row.className = 'device'; name.className = 'name'; actions.className = 'actions';
    name.textContent = entry.name;
    const names = entry.workspaceIds.map(id => state.workspaces.find(workspace => workspace.id === id)?.name || id);
    if (entry.includeUnassigned) names.push(translate('unassigned'));
    label.textContent = entry.allWorkspaces ? translate('allScope') : names.join(', ');
    name.append(label);
    if (!pending) {
      if (!entry.allWorkspaces) {
        const apply = document.createElement('button');
        apply.textContent = translate('applyScope'); apply.disabled = working;
        apply.addEventListener('click', () => {
          if (window.confirm(translate('confirmScope'))) void run(() => call('scope', { id: entry.id, ...scope() }));
        });
        actions.append(apply);
      }
    }
    for (const action of pending ? ['approve', 'reject'] : ['revoke']) {
      const button = document.createElement('button');
      button.textContent = translate(action);
      button.addEventListener('click', () => run(async () => { await call(action, { id: entry.id }); }));
      actions.append(button);
    }
    row.append(name, actions); target.append(row);
  }
  if (!entries.length && !pending) target.textContent = translate('noDevices');
}
function render() {
  language = state.language === 'en' ? 'en' : 'zh';
  if (!embedded) {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.documentElement.dataset.theme = state.theme;
  }
  renderCopy();
  element('retry').hidden = true;
  if (embedded) element('openPanel').hidden = true;
  element('status').textContent = translate(state.running ? 'online' : state.enabled ? 'connecting' : 'offline');
  element('status').classList.toggle('online', state.running);
  element('address').textContent = state.address || translate(state.enabled ? 'connecting' : 'noAddress');
  element('toggle').textContent = translate(state.enabled || state.running ? 'stop' : 'start');
  element('toggle').disabled = working;
  const network = state.network;
  element('networkControls').hidden = !network;
  if (network) {
    const label = { Stopped: 'networkOff', Error: 'networkError', NeedsLogin: 'needsLogin', NeedsMachineAuth: 'needsApproval', Running: 'networkReady' }[network.state] || 'connecting';
    element('networkState').textContent = translate(label);
    element('networkState').hidden = state.running || network.state === 'Stopped';
    element('login').hidden = !state.enabled || state.running || network.state === 'NeedsMachineAuth';
    element('login').textContent = translate(network.loginUrl ? 'openLogin' : 'login');
    element('login').disabled = working;
    element('logout').hidden = !state.enabled;
    element('logout').disabled = working;
  }
  element('lifetime').textContent = translate(state.closeToTray ? 'tray' : 'noTray');
  element('invite').disabled = working || !state.running;
  if (!state.running) { element('invitation').hidden = true; element('code').textContent = ''; invitationExpiry = 0; }
  if (invitationExpiry && invitationExpiry <= Date.now()) { element('code').textContent = translate('expired'); element('expires').textContent = ''; }
  renderDevices(element('pending'), state.pending, true);
  renderDevices(element('devices'), state.devices, false);
}
async function refresh() { state = await call('state'); render(); }
async function run(operation) {
  if (working) return;
  working = true; element('error').textContent = '';
  for (const button of root.querySelectorAll('button')) button.disabled = true;
  for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) checkbox.disabled = true;
  try { await operation(); }
  catch (error) { showError(error); }
  finally {
    working = false;
    try { await refresh(); } catch (error) { renderUnavailable(error); }
  }
}
element('retry').addEventListener('click', () => run(async () => {}));
if (embedded) element('openPanel').addEventListener('click', async () => {
  try {
    const response = await window.dshDesktop.openMobileAccess();
    if (!response.ok) throw new Error(response.error);
  } catch (error) { showError(error); }
});
element('toggle').addEventListener('click', () => run(() => call(state.enabled || state.running ? 'stop' : 'start')));
element('login').addEventListener('click', () => run(() => call(state.network?.loginUrl ? 'open-login' : 'login')));
element('logout').addEventListener('click', () => {
  if (window.confirm(translate('confirmLogout'))) void run(() => call('logout'));
});
element('invite').addEventListener('click', () => run(async () => {
  const invitation = await call('invite', scope());
  invitationExpiry = invitation.expiresAt;
  element('invitation').hidden = false;
  element('code').textContent = invitation.code;
  element('expires').textContent = translate('expires') + new Date(invitation.expiresAt).toLocaleTimeString();
}));
renderCopy();
element('toggle').textContent = translate('loading');
if (embedded) window.mobileAccessUI = {
  setVisible(value) { visible = value; if (visible) { renderCopy(); void run(async () => {}); } },
  refresh() { return run(async () => {}); },
};
else void run(async () => {});
const timer = setInterval(() => { if (visible && !working && !document.hidden) void run(async () => {}); }, 5000);
window.addEventListener('beforeunload', () => clearInterval(timer));
})();
