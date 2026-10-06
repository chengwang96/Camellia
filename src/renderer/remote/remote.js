'use strict';

(() => {
const embedded = Boolean(document.getElementById('mobilePage'));
const root = embedded ? document.getElementById('mobilePage') : document.querySelector('main');
let visible = !embedded;
const copy = {
  zh: { title: '手机访问', intro: '通过 Tailscale 连接手机。', connection: '连接', pair: '配对设备', devices: '已授权设备', connectionHelp: '连接与权限说明',
    network: '已内置 Tailscale，无需另装客户端。首次开启后登录与手机相同的 Tailnet；不开放局域网或公网端口。每次启动 Camellia 后需要手动开启。',
    generate: '生成配对码',
    pairHint: '在手机输入地址和一次性配对码，再在此确认授权。',
    footer: '授权设备可发送指令、停止任务和处理工具审批。操作在电脑执行，并沿用会话当前权限；仅授权可信设备。', online: '运行中', offline: '已关闭',
    keysImport: '手机可在设置中直接导入电脑端的 API Key 配置；该操作需要设备的全部访问授权。',
    start: '开启手机访问', stop: '关闭手机访问', noAddress: '开启后显示 Tailscale 地址',
    tray: '关闭窗口可驻留托盘；退出应用或电脑休眠会断开连接。', noTray: '请保持窗口打开，或在设置中启用关闭到托盘。退出应用或电脑休眠会断开连接。',
    noDevices: '尚未授权任何设备。', approve: '授权设备', reject: '拒绝', revoke: '撤销',
    expires: '配对码失效时间：', expired: '配对码已过期，请重新生成。' },
  en: { title: 'Mobile access', intro: 'Connect your phone with Tailscale.', connection: 'Connection', pair: 'Pair a device', devices: 'Authorized devices', connectionHelp: 'Connection and permissions',
    network: 'Tailscale is built in; no separate client needed. Sign in to the same tailnet as your phone. No LAN or public listener. Enable manually after each Camellia restart.',
    generate: 'Generate pairing code',
    pairHint: 'Enter the address and one-time code on your phone, then approve it here.',
    footer: 'Authorized devices can send instructions, stop tasks and respond to tool approvals. Tasks execute on this computer under the conversation’s existing permissions; authorize trusted devices only.', online: 'Online', offline: 'Off',
    keysImport: 'Your phone can import this computer’s API key configuration from its Settings. That requires full-access authorization for the device.',
    start: 'Enable mobile access', stop: 'Disable mobile access', noAddress: 'Enable to show the Tailscale address',
    tray: 'Closing the window keeps the app in the tray. Quitting or computer sleep disconnects clients.', noTray: 'Keep the window open or enable close to tray in Settings. Quitting or computer sleep disconnects clients.',
    noDevices: 'No authorized devices yet.', approve: 'Authorize device', reject: 'Reject', revoke: 'Revoke',
    expires: 'Pairing code expires at: ', expired: 'The pairing code expired. Generate another.' },
};
const element = id => document.getElementById(embedded ? `mobile-${id}` : id);
Object.assign(copy.zh, { login: '登录 Tailscale', openLogin: '打开浏览器授权', logout: '退出 Tailscale 登录', confirmLogout: '退出共用内置网络的登录？手机访问和 CLI 设备会同时断开，下次需要重新授权；已有 Camellia 设备权限保留。',
  connecting: '正在连接内置网络…', needsLogin: '请登录 Tailscale', needsApproval: '请在 Tailscale 管理后台批准此设备', networkError: '内置网络已断开，请重新开启', networkReady: '内置网络已连接', networkOff: '内置网络已关闭' });
Object.assign(copy.en, { login: 'Sign in to Tailscale', openLogin: 'Authorize in browser', logout: 'Sign out of Tailscale', confirmLogout: 'Sign out of the shared embedded network? Mobile access and CLI device connections will both disconnect. You will need to authorize again. Camellia device permissions are retained.',
  connecting: 'Connecting to embedded network…', needsLogin: 'Sign in to Tailscale', needsApproval: 'Approve this device in the Tailscale admin console', networkError: 'Embedded network disconnected. Enable it again.', networkReady: 'Embedded network connected', networkOff: 'Embedded network off' });
Object.assign(copy.zh, { deviceName: '本机名称', deviceNameHint: '手机配对后会显示这个名字，最多 80 个字符。', deviceNameSave: '保存名称', deviceNameSaved: '已保存本机名称：', scanHint: '用手机扫描二维码即可自动填入地址和配对码，无需手动输入 IP。', scanFallback: '也可手动输入地址和一次性配对码。', qrLabel: '配对二维码', refreshCode: '刷新二维码', copyAddress: '复制地址', addressCopied: '连接地址已复制', pairWaiting: '等待电脑授权', pairApproved: '电脑已授权，等待手机完成', pairSuccess: '配对成功', continuePair: '继续配对', pairFailed: '配对请求已结束，请重新生成二维码。', lastConnected: '最近连接：', justNow: '刚刚', minutesAgo: '{0} 分钟前', hoursAgo: '{0} 小时前', daysAgo: '{0} 天前', rename: '重命名', renameTitle: '重命名移动设备', renameName: '移动设备名称', renameHint: '修改此移动设备在已授权设备列表中的显示名称，不影响访问权限。', renameSave: '保存', renameCancel: '取消', nameInvalid: '请输入 1–80 个字符的名称。' });
Object.assign(copy.en, { deviceName: 'This computer name', deviceNameHint: 'Paired phones show this name. Up to 80 characters.', deviceNameSave: 'Save name', deviceNameSaved: 'Computer name saved: ', scanHint: 'Scan this QR code with your phone to fill in the address and pairing code automatically.', scanFallback: 'You can also enter the address and one-time code manually.', qrLabel: 'Pairing QR code', refreshCode: 'Refresh QR code', copyAddress: 'Copy address', addressCopied: 'Connection address copied', pairWaiting: 'Waiting for computer approval', pairApproved: 'Computer approved; waiting for the phone', pairSuccess: 'Paired successfully', continuePair: 'Pair another device', pairFailed: 'The pairing request ended. Generate a new code.', lastConnected: 'Last connected: ', justNow: 'Just now', minutesAgo: '{0} min ago', hoursAgo: '{0} hr ago', daysAgo: '{0} days ago', rename: 'Rename', renameTitle: 'Rename mobile device', renameName: 'Mobile device name', renameHint: 'Change this mobile device’s display name in the authorized devices list. Access permissions stay the same.', renameSave: 'Save', renameCancel: 'Cancel', nameInvalid: 'Enter a name of 1–80 characters.' });
Object.assign(copy.zh, { unavailable: '状态加载失败', loading: '正在加载…', retry: '重试', openPanel: '打开独立手机访问面板',
  restart: '手机访问页面已更新，但桌面主进程仍是旧版。请保存工作后完全退出 Camellia（包括托盘）并重新启动；刷新页面不会更新主进程。也可先打开独立面板管理连接。',
  loadFailed: '无法加载手机访问状态，请重试。', loadDevices: '暂时无法加载已授权设备，请重试。' });
Object.assign(copy.en, { unavailable: 'Status unavailable', loading: 'Loading…', retry: 'Retry', openPanel: 'Open mobile access panel',
  restart: 'The mobile access page has been updated, but the desktop process is still an older version. Save your work, fully quit Camellia (including the tray), and restart it. Refreshing the page does not update the desktop process. You can use the separate panel in the meantime.',
  loadFailed: 'Unable to load mobile access status. Please retry.', loadDevices: 'Unable to load authorized devices. Please retry.' });
let state = null, language = 'zh', working = false, invitationExpiry = 0, invitationDeviceIds = new Set(), pairingRequestId = '', pairingRequestSeen = false, pairedDeviceId = '';
const translate = key => copy[language][key];
const scope = () => ({ workspaceIds: [], allWorkspaces: true, includeUnassigned: true });
// The pairing payload is deliberately tiny: the phone only needs the address and
// the one-time code, then it registers its own name with /v1/pair/request. The
// computer name is not embedded, so a long localized name cannot oversize the QR.
const pairingPayload = invitation => JSON.stringify({ v: 1, type: 'camellia-pair', address: invitation.address, code: invitation.code });

function renderQr(container, text) {
  if (!container) return;
  container.replaceChildren();
  if (!text || !window.CamelliaQr) return;
  try {
    const image = document.createElement('img');
    image.className = 'pairing-qr';
    image.alt = translate('qrLabel');
    image.width = 220;
    image.height = 220;
    image.src = `data:image/svg+xml;utf8,${encodeURIComponent(window.CamelliaQr.qrSvg(text, { margin: 4, label: translate('qrLabel') }))}`;
    container.append(image);
  } catch { container.replaceChildren(); }
}

function relativeTime(timestamp) {
  const elapsed = Math.max(0, Date.now() - Number(timestamp));
  if (elapsed < 60_000) return translate('justNow');
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return translate('minutesAgo').replace('{0}', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate('hoursAgo').replace('{0}', hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return translate('daysAgo').replace('{0}', days);
  return new Date(timestamp).toLocaleString(language === 'en' ? 'en' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function mobileDeviceIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(icon.namespaceURI, 'rect');
  body.setAttribute('x', '6.5'); body.setAttribute('y', '2'); body.setAttribute('width', '11'); body.setAttribute('height', '20'); body.setAttribute('rx', '2.5');
  const speaker = document.createElementNS(icon.namespaceURI, 'path');
  speaker.setAttribute('d', 'M10 5h4m-3 13.5h2');
  icon.append(body, speaker);
  return icon;
}

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
function disablePageControls() {
  // Modal forms own their busy state; background polling must not lock them.
  for (const control of root.querySelectorAll('button, input[type="checkbox"]')) {
    if (!control.closest('dialog')) control.disabled = true;
  }
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
  if (element('pairPending')) element('pairPending').hidden = true;
  if (element('pair-success')) element('pair-success').hidden = true;
  if (element('pairFailed')) element('pairFailed').hidden = true;
  if (element('refreshInvite')) element('refreshInvite').hidden = true;
  if (element('copyStatus')) element('copyStatus').textContent = '';
  element('code').textContent = '';
  renderQr(element('qr'), '');
  if (element('deviceName')) element('deviceName').value = '';
  invitationExpiry = 0;
  disablePageControls();
  element('retry').disabled = false;
  element('retry').hidden = false;
  if (embedded) element('openPanel').disabled = false;
  showError(error);
}
function renderDevices(target, entries, pending) {
  target.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement('div'), icon = mobileDeviceIcon(), name = document.createElement('div'), meta = document.createElement('div'), label = document.createElement('small'), actions = document.createElement('div');
    row.className = 'device'; icon.classList.add('device-icon'); name.className = 'name'; meta.className = 'device-meta'; actions.className = 'actions';
    name.textContent = entry.name;
    label.textContent = pending
      ? `${entry.computerName || ''}${entry.computerName ? ' · ' : ''}${translate(entry.state === 'approved' ? 'pairApproved' : entry.state === 'rejected' ? 'pairingRejected' : 'pairWaiting')}`
      : translate('lastConnected') + (entry.lastSeenAt ? relativeTime(entry.lastSeenAt) : '—');
    meta.append(label);
    name.append(meta);
    if (!pending) {
      const rename = document.createElement('button');
      rename.textContent = translate('rename'); rename.disabled = working;
      rename.addEventListener('click', () => renameDevice(entry));
      actions.append(rename);
    }
    for (const action of pending ? (entry.state === 'pending' ? ['approve', 'reject'] : entry.state === 'approved' ? ['reject'] : []) : ['revoke']) {
      const button = document.createElement('button');
      button.textContent = translate(action);
      button.addEventListener('click', () => run(async () => { await call(action, { id: entry.id }); }));
      actions.append(button);
    }
    row.append(icon, name, actions); target.append(row);
  }
  if (!entries.length && !pending) target.textContent = translate('noDevices');
}
let renameDialog = null;
function renameDevice(entry) {
  if (working) return;
  const dialog = document.createElement('dialog'); renameDialog = dialog; dialog.className = 'device-rename';
  const form = document.createElement('form'); form.method = 'dialog';
  const heading = document.createElement('h2'); heading.textContent = translate('renameTitle');
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = translate('renameHint');
  const label = document.createElement('label'); label.textContent = translate('renameName');
  const input = document.createElement('input'); input.maxLength = 80; input.required = true; input.value = entry.name;
  label.append(input);
  const error = document.createElement('p'); error.className = 'hint rename-error error'; error.setAttribute('role', 'alert');
  const actions = document.createElement('div'); actions.className = 'actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = translate('renameCancel');
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary'; save.textContent = translate('renameSave');
  let saving = false;
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || working) return;
    const value = input.value.trim();
    if (!value || value.length > 80) { error.textContent = translate('nameInvalid'); input.focus(); return; }
    saving = true;
    error.textContent = '';
    input.disabled = cancel.disabled = save.disabled = true;
    try {
      await run(async () => { await call('rename', { id: entry.id, name: value }); dialog.close(); }, failure => { error.textContent = failure.message; });
    } finally {
      saving = false;
      input.disabled = cancel.disabled = save.disabled = false;
      if (dialog.open) input.focus();
    }
  });
  actions.append(cancel, save);
  form.append(heading, hint, label, error, actions);
  dialog.append(form);
  dialog.addEventListener('close', () => { dialog.remove(); if (renameDialog === dialog) renameDialog = null; });
  root.append(dialog);
  dialog.showModal();
  input.focus(); input.select();
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
  if (element('deviceName') && document.activeElement !== element('deviceName')) element('deviceName').value = state.computerName || '';
  // run() disables page buttons up front, so each control must restore its own
  // enabled state here; otherwise this one stays disabled after the first load.
  if (element('saveDeviceName')) element('saveDeviceName').disabled = working;
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
  if (!state.running) {
    element('invitation').hidden = true; element('code').textContent = ''; renderQr(element('qr'), ''); invitationExpiry = 0;
    pairingRequestId = ''; pairingRequestSeen = false; pairedDeviceId = '';
    if (element('pairPending')) element('pairPending').hidden = true;
    if (element('pair-success')) element('pair-success').hidden = true;
    if (element('pairFailed')) element('pairFailed').hidden = true;
    if (element('refreshInvite')) element('refreshInvite').hidden = true;
  }
  if (invitationExpiry && invitationExpiry <= Date.now()) {
    element('code').textContent = translate('expired'); renderQr(element('qr'), ''); element('expires').textContent = '';
    element('invitation').hidden = false;
  }
  if (invitationExpiry && state.running && !pairedDeviceId) {
    const paired = state.devices.find(entry => pairingRequestId && entry.id === pairingRequestId)
      || state.devices.find(entry => !invitationDeviceIds.has(entry.id));
    if (paired) {
      pairedDeviceId = paired.id; invitationExpiry = 0; pairingRequestId = ''; pairingRequestSeen = false;
      element('invitation').hidden = true; element('code').textContent = ''; renderQr(element('qr'), '');
      element('pairPending').hidden = true; element('pairFailed').hidden = true;
      element('pair-success').hidden = false; element('pairedName').textContent = paired.name;
    } else {
      const pending = state.pending.find(entry => !pairingRequestId || entry.id === pairingRequestId);
      if (pending) {
        pairingRequestId = pending.id; pairingRequestSeen = true;
        element('invitation').hidden = true;
        element('pairPending').hidden = pending.state === 'rejected';
        element('pairFailed').hidden = pending.state !== 'rejected';
        element('pendingName').textContent = pending.name;
        element('pairPendingLabel').textContent = translate(pending.state === 'approved' ? 'pairApproved' : pending.state === 'rejected' ? 'pairingRejected' : 'pairWaiting');
        element('code').textContent = ''; renderQr(element('qr'), '');
      } else if (pairingRequestId && pairingRequestSeen) {
        element('pairPending').hidden = true;
        element('pairFailed').hidden = false;
      }
    }
  }
  if (element('refreshInvite')) {
    element('refreshInvite').hidden = !invitationExpiry || Boolean(pairedDeviceId);
    element('refreshInvite').disabled = working || !state.running || !invitationExpiry;
  }
  element('invite').hidden = Boolean(invitationExpiry || pairedDeviceId);
  if (element('copyAddress')) element('copyAddress').disabled = working || !state.address;
  if (element('continuePair')) element('continuePair').disabled = working || !state.running;
  if (element('pair-success')) element('pair-success').hidden = !pairedDeviceId;
  renderDevices(element('pending'), state.pending, true);
  renderDevices(element('devices'), state.devices, false);
}
async function refresh() { state = await call('state'); render(); }
async function run(operation, onError = showError) {
  if (working) return;
  working = true; element('error').textContent = '';
  disablePageControls();
  try { await operation(); }
  catch (error) { onError(error); }
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
async function generateInvitation() {
  invitationDeviceIds = new Set((state?.devices || []).map(entry => entry.id));
  const invitation = await call('invite', scope());
  pairingRequestId = ''; pairingRequestSeen = false; pairedDeviceId = '';
  element('pairPending').hidden = true; element('pair-success').hidden = true; element('pairFailed').hidden = true;
  element('refreshInvite').hidden = false;
  if (element('pendingName')) element('pendingName').textContent = '';
  if (element('pairedName')) element('pairedName').textContent = '';
  invitationExpiry = invitation.expiresAt;
  element('invitation').hidden = false;
  element('code').textContent = invitation.code;
  renderQr(element('qr'), pairingPayload(invitation));
  element('expires').textContent = translate('expires') + new Date(invitation.expiresAt).toLocaleTimeString();
}
element('invite').addEventListener('click', () => run(generateInvitation));
element('refreshInvite')?.addEventListener('click', () => run(generateInvitation));
element('continuePair')?.addEventListener('click', () => run(generateInvitation));
element('copyAddress')?.addEventListener('click', async () => {
  if (!state?.address) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(state.address);
    else {
      const field = document.createElement('textarea'); field.value = state.address; field.setAttribute('readonly', '');
      field.style.position = 'fixed'; field.style.opacity = '0'; root.append(field); field.select();
      const copied = document.execCommand('copy'); field.remove();
      if (!copied) throw new Error('Clipboard is unavailable');
    }
    if (element('copyStatus')) element('copyStatus').textContent = translate('addressCopied');
    setTimeout(() => { if (element('copyStatus')) element('copyStatus').textContent = ''; }, 1800);
  } catch (error) { showError(error); }
});
element('saveDeviceName')?.addEventListener('click', () => run(async () => {
  const input = element('deviceName');
  const value = input.value.trim();
  if (!value || value.length > 80) { element('deviceNameStatus').textContent = translate('nameInvalid'); input.focus(); return; }
  const result = await call('set-name', { name: value });
  element('deviceName').value = result.computerName;
  element('deviceNameStatus').textContent = translate('deviceNameSaved') + result.computerName;
}));
renderCopy();
element('toggle').textContent = translate('loading');
window.mobileAccessUI = {
  setVisible(value) { visible = value; if (visible) { renderCopy(); void run(async () => {}); } },
  refresh() { return run(async () => {}); },
};
if (!embedded) void run(async () => {});
const timer = setInterval(() => { if (visible && !working && !document.hidden) void run(async () => {}); }, 5000);
window.addEventListener('beforeunload', () => clearInterval(timer));
})();
