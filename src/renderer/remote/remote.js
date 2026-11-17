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
Object.assign(copy.zh, { deviceName: '本机名称', deviceNameHint: '此名称会同步到 Tailscale。', deviceNameSave: '保存名称', deviceNameSaved: '已保存本机名称：', deviceNameSynced: '已同步到 Tailscale。', deviceNameLocalSynced: '已更新内置网络；控制台名称未同步。', deviceNameSyncSkipped: '已保存；Tailscale 名称需要字母、数字或连字符，未同步。', deviceNameSyncOffline: '已保存；连接 Tailscale 后再同步。', deviceNameSyncFailed: '已保存；Tailscale 同步失败：', scanHint: '用手机扫码填入地址和配对码，也可手动输入。', qrLabel: '配对二维码', refreshCode: '刷新二维码', copyAddress: '复制地址', addressCopied: '连接地址已复制', pairWaiting: '等待电脑授权', pairApproved: '电脑已授权，等待手机完成', pairSuccess: '配对成功', continuePair: '继续配对', pairFailed: '配对请求已结束，请重新生成二维码。', lastConnected: '最近连接：', justNow: '刚刚', minutesAgo: '{0} 分钟前', hoursAgo: '{0} 小时前', daysAgo: '{0} 天前', rename: '重命名', renameTitle: '重命名移动设备', renameName: '移动设备名称', renameHint: '仅修改显示名称，访问权限不变。', renameSave: '保存', renameCancel: '取消', nameInvalid: '请输入 1–80 个字符的名称。' });
Object.assign(copy.en, { deviceName: 'This computer name', deviceNameHint: 'Also updates the Tailscale device name.', deviceNameSave: 'Save name', deviceNameSaved: 'Computer name saved: ', deviceNameSynced: 'Synced to Tailscale.', deviceNameLocalSynced: 'Embedded network updated; the console name was not synced.', deviceNameSyncSkipped: 'Saved; Tailscale names allow letters, digits and hyphens only, so it was not synced.', deviceNameSyncOffline: 'Saved; connect to Tailscale to sync it.', deviceNameSyncFailed: 'Saved; Tailscale sync failed: ', scanHint: 'Scan with your phone to fill in the address and code, or enter them manually.', qrLabel: 'Pairing QR code', refreshCode: 'Refresh QR code', copyAddress: 'Copy address', addressCopied: 'Connection address copied', pairWaiting: 'Waiting for computer approval', pairApproved: 'Computer approved; waiting for the phone', pairSuccess: 'Paired successfully', continuePair: 'Pair another device', pairFailed: 'The pairing request ended. Generate a new code.', lastConnected: 'Last connected: ', justNow: 'Just now', minutesAgo: '{0} min ago', hoursAgo: '{0} hr ago', daysAgo: '{0} days ago', rename: 'Rename', renameTitle: 'Rename mobile device', renameName: 'Mobile device name', renameHint: 'Changes the display name; access permissions stay the same.', renameSave: 'Save', renameCancel: 'Cancel', nameInvalid: 'Enter a name of 1–80 characters.' });
Object.assign(copy.zh, { unavailable: '状态加载失败', loading: '正在加载…', retry: '重试', openPanel: '打开独立手机访问面板',
  restart: '手机访问页面已更新，但桌面主进程仍是旧版。请保存工作后完全退出 Camellia（包括托盘）并重新启动；刷新页面不会更新主进程。也可先打开独立面板管理连接。',
  loadFailed: '无法加载手机访问状态，请重试。', loadDevices: '暂时无法加载已授权设备，请重试。' });
Object.assign(copy.en, { unavailable: 'Status unavailable', loading: 'Loading…', retry: 'Retry', openPanel: 'Open mobile access panel',
  restart: 'The mobile access page has been updated, but the desktop process is still an older version. Save your work, fully quit Camellia (including the tray), and restart it. Refreshing the page does not update the desktop process. You can use the separate panel in the meantime.',
  loadFailed: 'Unable to load mobile access status. Please retry.', loadDevices: 'Unable to load authorized devices. Please retry.' });
Object.assign(copy.zh, { diagnose: '连接诊断' });
Object.assign(copy.en, { diagnose: 'Connection diagnostics' });
Object.assign(copy.zh, { pathTitle: '网络路径', pathHint: '关闭时由 Tailscale 自动选路。',
  relayDevice: '中继设备', relayUse: '使用中继',
  relayRenameHint: '修改 Tailscale 设备名，MagicDNS 地址会随之更新。',
  relayRenameInvalid: '请输入 1–63 个字母、数字或连字符；首尾不能是连字符。',
  relayRenameSaving: '正在保存名称…', relayRenamed: '中继名称已保存。', relayRenamePending: '名称已保存，暂时无法刷新设备信息。',
  relayRenameTimeout: '重命名尚未确认，请稍后重试。',
  relayChecking: '正在检查 Peer Relay 配置…', relayReady: 'Peer Relay 已配置。', relayMissing: '尚未配置 Peer Relay。',
  relayNoDevices: '没有可用的 Peer Relay 设备', relayAdded: '中继设置已保存。', relayAddFailed: '无法保存中继设置。',
  relayListEmpty: '请选择一台已启用 Peer Relay 的设备。',
  relayNoCandidates: '没有可用的 Peer Relay 设备。请先在 VPS 上开启 Peer Relay，并确认其在线。',
  relayApplied: 'Peer Relay 配置已应用。', relayAlready: 'Peer Relay 已配置，无需修改。', relayNeedsCredentials: '请先在高级设置中配置 Tailscale 管理 API。',
  relaySelectDevice: '先选择一个中继设备。',
  relayEnableUnavailable: '没有已启用 Peer Relay 的设备；请先在 Tailscale 管理后台为一台 VPS 开启 Peer Relay。',
  relayDisableUnavailable: '当前无法更改：Tailscale 管理 API 尚未连接。',
  relayOnShort: 'VPS 中继', relayOffShort: '自动选路',
  tailscaleRetryHint: '请检查网络后点击“刷新状态”重试。',
  relayRetry: '重新检查',
  relayDeviceMissing: '没有可用的在线 VPS 设备。', relaySaving: '正在验证并应用…', relayLoadFailed: '无法读取 Peer Relay 状态。', relayAclChanged: 'ACL 已被其他操作修改，请刷新后重试。',
  tailscaleTitle: 'Tailscale 管理 API', tailscaleHint: '验证凭证，并为本机启用 VPS 中继。',
  tailscaleClientId: 'OAuth Client ID', tailscaleClientSecret: 'OAuth Client Secret',
  tailscaleScopeHint: '创建 OAuth Client 时选择 policy_file: write 和 devices:core: write，可加 tag:camellia-desktop。',
  tailscaleOpen: '打开 Tailscale 凭据页', tailscaleSave: '验证并保存', tailscaleRefresh: '刷新状态', tailscaleRemove: '移除凭证',
  tailscaleUnconfigured: '未配置', tailscaleConnected: '已连接', tailscaleScope: '缺少 scope', tailscaleInvalid: '凭证无效',
  tailscaleError: '连接失败', tailscaleDevices: '设备', tailscaleOnline: '在线', tailscaleTagged: '已加标签',
  tailscaleRelay: '已包含 Peer Relay 授权', tailscaleNoRelay: '尚未包含 Peer Relay 授权', tailscaleNoChange: '尚未修改 ACL',
  tailscaleSaved: '验证通过，凭证已加密保存。', tailscaleRemoved: '凭证已移除。', tailscaleOpened: '已在浏览器打开 Tailscale 凭据页。',
  tailscaleReady: '管理 API 已连接', tailscaleNeedsSetup: '管理 API 未配置',
  tailscaleUnlock: '系统安全存储不可用，请先解锁系统钥匙串。' });
Object.assign(copy.en, { pathTitle: 'Network path', pathHint: 'Off selects paths automatically in Tailscale.',
  relayDevice: 'Relay device', relayUse: 'Use relay',
  relayRenameHint: 'Changes the Tailscale device name and its MagicDNS address.',
  relayRenameInvalid: 'Use 1–63 letters, digits or hyphens; start and end with a letter or digit.',
  relayRenameSaving: 'Saving name…', relayRenamed: 'Relay name saved.', relayRenamePending: 'Name saved; device details could not be refreshed.',
  relayRenameTimeout: 'The rename could not be confirmed. Try again shortly.',
  relayChecking: 'Checking Peer Relay setup…', relayReady: 'Peer Relay is configured.', relayMissing: 'Peer Relay is not configured.',
  relayNoDevices: 'No Peer Relay device is available', relayAdded: 'Relay setting saved.', relayAddFailed: 'Could not save the relay setting.',
  relayListEmpty: 'Choose a device that already has Peer Relay enabled.',
  relayNoCandidates: 'No Peer Relay device is available. Enable Peer Relay on the VPS and make sure it is online.',
  relayApplied: 'Peer Relay setup applied.', relayAlready: 'Peer Relay is already configured.', relayNeedsCredentials: 'Configure Tailscale Admin API under Advanced settings first.',
  relaySelectDevice: 'Select a relay device first.',
  relayEnableUnavailable: 'No Peer Relay device is available. Enable Peer Relay on a VPS in the Tailscale admin console first.',
  relayDisableUnavailable: 'Cannot change this while the Tailscale Admin API is not connected.',
  relayOnShort: 'VPS relay', relayOffShort: 'Automatic',
  tailscaleRetryHint: 'Check the network and choose Refresh status to retry.',
  relayRetry: 'Check again',
  relayDeviceMissing: 'No online VPS device is available.', relaySaving: 'Validating and applying…', relayLoadFailed: 'Could not read Peer Relay state.', relayAclChanged: 'The ACL changed elsewhere; refresh and retry.',
  tailscaleTitle: 'Tailscale Admin API', tailscaleHint: 'Verify credentials and enable VPS relay for this computer.',
  tailscaleClientId: 'OAuth Client ID', tailscaleClientSecret: 'OAuth Client Secret',
  tailscaleScopeHint: 'When creating the OAuth client, select policy_file: write and devices:core: write; tag:camellia-desktop is optional.',
  tailscaleOpen: 'Open Tailscale credentials page', tailscaleSave: 'Verify and save', tailscaleRefresh: 'Refresh status', tailscaleRemove: 'Remove credentials',
  tailscaleUnconfigured: 'Not configured', tailscaleConnected: 'Connected', tailscaleScope: 'Missing scope', tailscaleInvalid: 'Invalid credentials',
  tailscaleError: 'Connection failed', tailscaleDevices: 'Devices', tailscaleOnline: 'online', tailscaleTagged: 'tagged',
  tailscaleRelay: 'Peer Relay access is present', tailscaleNoRelay: 'Peer Relay access is not present', tailscaleNoChange: 'ACL was not changed',
  tailscaleSaved: 'Verified and saved with encrypted storage.', tailscaleRemoved: 'Credentials removed.', tailscaleOpened: 'Opened the Tailscale credentials page in the browser.',
  tailscaleReady: 'Admin API connected', tailscaleNeedsSetup: 'Admin API not configured',
  tailscaleUnlock: 'Secure system storage is unavailable. Unlock your system keychain first.' });
let state = null, language = 'zh', working = false, invitationExpiry = 0, invitationDeviceIds = new Set(), pairingRequestId = '', pairingRequestSeen = false, pairedDeviceId = '', relayError = '';
let relayRenameDraft = null, relayRenameSaving = false, relayFeedback = '';
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
  if (element('relayConfig')) element('relayConfig').hidden = true;
  relayError = '';
  renderTailscale();
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
    row.className = 'device device-row'; icon.classList.add('device-icon'); name.className = 'name device-info'; meta.className = 'device-meta'; actions.className = 'actions device-actions';
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
      if (state.diagnosticsAvailable && window.CamelliaNetworkDiagnostics) {
        const diagnose = document.createElement('button');
        diagnose.textContent = translate('diagnose'); diagnose.disabled = working || !state.running;
        diagnose.addEventListener('click', () => window.CamelliaNetworkDiagnostics.open({ root, device: entry,
          computerName: state.computerName, language, probe: () => call('diagnose', { id: entry.id }) }));
        actions.append(diagnose);
      }
    }
    for (const action of pending ? (entry.state === 'pending' ? ['approve', 'reject'] : entry.state === 'approved' ? ['reject'] : []) : ['revoke']) {
      const button = document.createElement('button');
      if (action === 'reject' || action === 'revoke') button.className = 'danger';
      button.textContent = translate(action);
      button.addEventListener('click', () => run(async () => { await call(action, { id: entry.id }); }));
      actions.append(button);
    }
    row.append(icon, name, actions); target.append(row);
  }
  if (!entries.length && !pending) target.textContent = translate('noDevices');
}
function tailscaleStatusLabel(value) {
  return translate({ unconfigured: 'tailscaleUnconfigured', connected: 'tailscaleConnected', scope: 'tailscaleScope',
    invalid: 'tailscaleInvalid', error: 'tailscaleError', checking: 'loading' }[value] || 'tailscaleError');
}
function tailscaleAdminLabel(value) {
  return value?.state === 'connected' ? translate('tailscaleReady')
    : value?.configured ? translate('tailscaleError') : translate('tailscaleNeedsSetup');
}
function renderTailscale() {
  const view = state?.tailscale;
  const status = element('tailscaleStatus'), details = element('tailscaleDetails'), form = element('tailscaleForm');
  if (!status || !details || !form) return;
  status.className = 'status';
  status.textContent = tailscaleStatusLabel(view?.state);
  if (view?.state === 'connected') status.classList.add('connected');
  else if (['invalid', 'error', 'scope'].includes(view?.state)) status.classList.add('error');
  details.replaceChildren();
  details.hidden = !view || view.state === 'unconfigured';
  form.hidden = Boolean(view && view.state === 'connected');
  if (view?.clientId) {
    const client = document.createElement('p'); client.textContent = `Client ID: ${view.clientId}`; details.append(client);
  }
  if (view?.tailnet) {
    const summary = document.createElement('p');
    summary.textContent = `${translate('tailscaleDevices')}: ${view.tailnet.deviceCount} · ${translate('tailscaleOnline')}: ${view.tailnet.onlineCount} · ${translate('tailscaleTagged')}: ${view.tailnet.taggedCount}`;
    details.append(summary);
  }
  if (view?.state === 'connected') {
    const acl = document.createElement('p'); acl.textContent = view.acl?.hasRelayGrant ? translate('tailscaleRelay') : translate('tailscaleNoRelay'); details.append(acl);
    if (view.acl?.hasRelayGrant) {
      const unchanged = document.createElement('p'); unchanged.className = 'hint'; unchanged.textContent = translate('tailscaleNoChange'); details.append(unchanged);
    }
  } else if (view?.error) {
    const error = document.createElement('p'); error.className = 'hint error'; error.textContent = view.error; details.append(error);
  }
  if (view?.missingScopes?.length) {
    const missing = document.createElement('p'); missing.className = 'hint error';
    missing.textContent = `${translate('tailscaleScope')}: ${view.missingScopes.join(', ')}`; details.append(missing);
  }
  const policy = document.createElement('p'); policy.className = 'hint';
  policy.textContent = translate('tailscaleScopeHint'); details.append(policy);
  const remove = element('tailscaleRemove');
  if (remove) {
    remove.hidden = !view?.configured;
    remove.disabled = working;
  }
  for (const id of ['tailscaleSave', 'tailscaleRefresh', 'tailscaleOpen', 'tailscaleClientId', 'tailscaleClientSecret']) if (element(id)) element(id).disabled = working;
}
function configuredRelays(view) {
  const devices = Array.isArray(view?.devices) ? view.devices : [];
  const targets = Array.isArray(view?.acl?.relayTargets) ? view.acl.relayTargets : [];
  // Older desktop processes only expose ACL relay targets. Recover the same
  // candidates from device addresses so the switch keeps working after an
  // in-place UI update, before the main process is restarted.
  return devices.filter(device => device.relayGranted
    || (targets.length && Array.isArray(device.addresses)
      && device.addresses.some(address => targets.includes(address))));
}
function relayDeviceLabel(device) {
  const name = (device.name || device.hostname || '').split('.')[0] || device.addresses?.[0] || device.id;
  const address = Array.isArray(device.addresses) ? device.addresses.find(value => value.includes('.')) : '';
  return `${name}${address ? ` · ${address}` : ''}${device.online ? '' : ` (${translate('offline')})`}`;
}
function replaceSelectOptions(select, entries, emptyLabel) {
  const signature = entries.map(device => `${device.id}\u0000${relayDeviceLabel(device)}`).join('\u0001');
  if (select.dataset.signature === signature) return;
  const previous = select.value;
  select.replaceChildren();
  if (entries.length) for (const device of entries) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = relayDeviceLabel(device);
    select.append(option);
  } else {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.append(option);
  }
  if (entries.some(device => device.id === previous)) select.value = previous;
  select.dataset.signature = signature;
}
function renderRelayPath() {
  const view = state?.tailscale;
  const config = element('relayConfig'), select = element('relayDevice'), status = element('relayStatus');
  const toggle = element('relayUse'), choice = element('relayChoice');
  const summary = element('pathSummary');
  if (!config) return;
  const connected = view?.state === 'connected';
  const relays = configuredRelays(view);
  const selected = relays.find(device => device.relaySelected);
  config.hidden = false;
  if (summary) summary.textContent = connected ? (selected ? translate('relayOnShort') : translate('relayOffShort'))
    : view?.state === 'checking' ? translate('relayChecking')
      : view?.state === 'scope' ? translate('tailscaleScope')
        : view?.state === 'invalid' ? translate('tailscaleInvalid')
        : view?.configured ? translate('tailscaleError') : translate('tailscaleUnconfigured');
  if (summary) summary.classList.toggle('error', Boolean(view?.configured && !connected && view?.state !== 'checking'));
  const pathError = element('relayPathError');
  if (pathError) {
    pathError.textContent = !connected && view?.configured && view?.state !== 'checking'
      ? (view.error || translate('tailscaleRetryHint')) : '';
    pathError.hidden = !pathError.textContent;
  }
  if (toggle) {
    toggle.checked = Boolean(selected);
    toggle.disabled = working || Boolean(relayRenameDraft) || !connected || !relays.length;
    toggle.title = !connected ? translate('relayDisableUnavailable')
      : !relays.length ? translate('relayEnableUnavailable') : '';
  }
  if (choice) choice.hidden = !relayRenameDraft && !selected && !(toggle?.checked && relays.length);
  renderRelayEditor();
  if (!connected) {
    if (select) select.dataset.signature = '';
    if (status) { status.textContent = ''; status.hidden = true; }
    if (element('relayRename')) element('relayRename').disabled = true;
    return;
  }
  replaceSelectOptions(select, relays, translate('relayNoDevices'));
  if (selected) select.value = selected.id;
  if (status) {
    status.textContent = relayError || (relayRenameSaving ? translate('relayRenameSaving') : relayFeedback)
      || (!relays.length ? translate('relayNoCandidates') : '');
    status.classList.toggle('error', Boolean(relayError));
    status.hidden = !status.textContent;
  }
  if (select) select.disabled = working || Boolean(relayRenameDraft) || !relays.length;
  if (element('relayRename')) element('relayRename').disabled = working || !select?.value;
}
function toggleRelayChoice() {
  const use = element('relayUse'), choice = element('relayChoice');
  if (choice) choice.hidden = !use?.checked;
}
function renderRelayEditor() {
  const editing = Boolean(relayRenameDraft);
  const select = element('relayDevice'), input = element('relayName');
  if (!input) return;
  select.hidden = editing;
  input.hidden = !editing;
  input.disabled = relayRenameSaving;
  input.setAttribute('aria-invalid', String(Boolean(editing && relayError)));
  const label = element('relayChoice')?.querySelector('label');
  if (label) label.htmlFor = editing ? input.id : select.id;
  element('relayRename').hidden = editing;
  element('relayRenameSave').hidden = !editing;
  element('relayRenameCancel').hidden = !editing;
  element('relayRenameSave').disabled = working || relayRenameSaving || state?.tailscale?.state !== 'connected';
  element('relayRenameCancel').disabled = relayRenameSaving;
  element('relayRenameHint').hidden = !editing;
}
function renameRelay() {
  if (working) return;
  const entry = configuredRelays(state?.tailscale).find(device => device.id === element('relayDevice')?.value);
  if (!entry) { relayError = translate('relaySelectDevice'); renderRelayPath(); return; }
  // Tailscale's canonical name can differ from the unchanged OS hostname.
  const original = String(entry.name || entry.hostname || '').split('.')[0];
  relayRenameDraft = { deviceId: entry.id, original };
  relayError = relayFeedback = '';
  element('relayName').value = original;
  renderRelayPath();
  element('relayName').focus();
  element('relayName').select();
}
function cancelRelayRename() {
  if (relayRenameSaving) return;
  relayRenameDraft = null;
  relayError = relayFeedback = '';
  renderRelayPath();
  element('relayRename').focus();
}
async function saveRelayRename() {
  if (working || relayRenameSaving || !relayRenameDraft) return;
  const input = element('relayName'), value = input.value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value)) {
    relayError = translate('relayRenameInvalid');
    renderRelayPath();
    input.focus();
    return;
  }
  if (value === relayRenameDraft.original) { cancelRelayRename(); return; }
  const deviceId = relayRenameDraft.deviceId;
  relayRenameSaving = true;
  relayError = relayFeedback = '';
  renderRelayPath();
  try {
    await run(async () => {
      const result = await call('tailscale-rename-device', { deviceId, name: value });
      if (!result.renamed) throw new Error(result.error || translate('relayRenameTimeout'));
      state = { ...state, tailscale: result };
      relayRenameDraft = null;
      relayFeedback = translate(result.renameVerified === false ? 'relayRenamePending' : 'relayRenamed');
    }, failure => {
      relayError = /timed out|timeout/i.test(failure.message) ? translate('relayRenameTimeout') : failure.message;
    });
  } finally {
    relayRenameSaving = false;
    renderRelayPath();
    (relayRenameDraft ? input : element('relayRename')).focus();
  }
}
let relaySelectionTimer = 0;
function applyRelay() {
  if (working) return;
  const enabled = Boolean(element('relayUse').checked);
  const deviceId = element('relayDevice').value;
  const status = element('relayStatus');
  if (enabled && !deviceId) { relayError = translate('relaySelectDevice'); renderRelayPath(); return; }
  if (state?.tailscale?.state !== 'connected') { relayError = translate('relayNeedsCredentials'); renderRelayPath(); return; }
  relayError = '';
  relayFeedback = '';
  status.hidden = false;
  status.textContent = translate('relaySaving');
  void run(async () => {
    await call('tailscale-apply-peer-relay', { deviceId: enabled ? deviceId : undefined, enabled });
    relayError = '';
  }, error => {
    relayError = /ACL changed/i.test(error.message) ? translate('relayAclChanged') : error.message;
  });
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
  const connectionSummary = element('connectionSummary');
  if (connectionSummary) {
    connectionSummary.textContent = translate(state.running ? 'online' : state.enabled ? 'connecting' : 'offline');
    connectionSummary.classList.toggle('online', state.running);
  }
  const devicesSummary = element('devicesSummary');
  if (devicesSummary) devicesSummary.textContent = String(state.devices.length);
  const pairSummary = element('pairSummary');
  if (pairSummary) pairSummary.textContent = pairedDeviceId ? translate('pairSuccess') : '';
  renderDevices(element('pending'), state.pending, true);
  renderDevices(element('devices'), state.devices, false);
  renderTailscale();
  renderRelayPath();
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
    // Render once with the fresh state so operation-specific feedback and
    // errors survive; only a failed state read replaces the whole page.
    try { await refresh(); }
    catch (error) { renderUnavailable(error); }
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
  if (working || root.querySelector('dialog.mobile-logout')) return;
  const dialog = document.createElement('dialog'); dialog.className = 'mobile-logout';
  const title = document.createElement('h2'); title.id = embedded ? 'mobile-logoutTitle' : 'logoutTitle';
  title.dataset.copy = 'logout'; title.textContent = translate('logout');
  const description = document.createElement('p'); description.id = embedded ? 'mobile-logoutDescription' : 'logoutDescription';
  description.dataset.copy = 'confirmLogout'; description.textContent = translate('confirmLogout');
  dialog.setAttribute('aria-labelledby', title.id); dialog.setAttribute('aria-describedby', description.id);
  const actions = document.createElement('form'); actions.method = 'dialog'; actions.className = 'mobile-logout-actions';
  const cancel = document.createElement('button'); cancel.type = 'submit'; cancel.value = 'cancel'; cancel.autofocus = true;
  cancel.dataset.copy = 'renameCancel'; cancel.textContent = translate('renameCancel');
  const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.value = 'logout'; confirm.className = 'danger';
  confirm.dataset.copy = 'logout'; confirm.textContent = translate('logout');
  actions.append(cancel, confirm); dialog.append(title, description, actions);
  dialog.addEventListener('close', () => {
    const confirmed = dialog.returnValue === 'logout'; dialog.remove();
    if (confirmed) void run(() => call('logout'));
  });
  root.append(dialog); dialog.showModal();
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
  const sync = result.tailscaleSync || {};
  const embeddedSync = result.embeddedNetworkSync || {};
  let suffix = translate('deviceNameSyncOffline');
  // The management API result determines whether the console name was synced,
  // independently of whether the embedded helper could update its hostname.
  if (sync.synced) suffix = translate('deviceNameSynced');
  else if (sync.reason === 'invalid-name') suffix = translate('deviceNameSyncSkipped');
  else if (sync.reason === 'error' && sync.error) suffix = translate('deviceNameSyncFailed') + sync.error;
  else if (embeddedSync.synced) suffix = translate('deviceNameLocalSynced');
  const message = translate('deviceNameSaved') + result.computerName + ' · ' + suffix;
  element('deviceNameStatus').textContent = message;
}));
element('tailscaleOpen')?.addEventListener('click', () => run(async () => {
  await call('tailscale-open-credentials');
  element('tailscaleFeedback').textContent = translate('tailscaleOpened');
}, showError));
element('tailscaleSave')?.addEventListener('click', () => {
  if (working) return;
  const clientId = element('tailscaleClientId').value.trim(), clientSecret = element('tailscaleClientSecret').value.trim();
  if (!clientId || !clientSecret) {
    element('tailscaleFeedback').textContent = language === 'en' ? 'Enter both the OAuth Client ID and Client Secret.' : '请填写 OAuth Client ID 和 Client Secret。';
    element('tailscaleClientId').focus(); return;
  }
  void run(async () => {
    const result = await call('tailscale-save', { clientId, clientSecret });
    element('tailscaleClientSecret').value = '';
    element('tailscaleFeedback').textContent = result.saved ? translate('tailscaleSaved')
      : result.state === 'scope' ? `${translate('tailscaleScope')}: ${(result.missingScopes || []).join(', ')}`
        : result.error || translate('tailscaleInvalid');
  }, error => {
    element('tailscaleClientSecret').value = '';
    element('tailscaleFeedback').textContent = /secure system storage/i.test(error.message) ? translate('tailscaleUnlock') : error.message;
  });
});
element('tailscaleRefresh')?.addEventListener('click', () => run(async () => {
  state = { ...state, tailscale: await call('tailscale-status') };
  element('tailscaleFeedback').textContent = '';
  relayError = '';
}, showError));
element('relayRetry')?.addEventListener('click', () => run(async () => {
  relayError = '';
  state = { ...state, tailscale: await call('tailscale-status') };
}, showError));
element('relayUse')?.addEventListener('change', () => {
  toggleRelayChoice();
  clearTimeout(relaySelectionTimer);
  if (element('relayUse').checked && !element('relayDevice').value) return;
  applyRelay();
});
element('relayRename')?.addEventListener('click', renameRelay);
element('relayRenameSave')?.addEventListener('click', saveRelayRename);
element('relayRenameCancel')?.addEventListener('click', cancelRelayRename);
element('relayName')?.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Enter') { event.preventDefault(); void saveRelayRename(); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRelayRename(); }
});
element('relayName')?.addEventListener('input', () => {
  if (!relayError) return;
  relayError = '';
  renderRelayPath();
});
element('relayDevice')?.addEventListener('change', () => {
  if (!element('relayUse')?.checked) return;
  clearTimeout(relaySelectionTimer);
  relaySelectionTimer = setTimeout(applyRelay, 0);
});
element('tailscaleRemove')?.addEventListener('click', () => {
  if (working) return;
  void run(async () => {
    await call('tailscale-remove');
    element('tailscaleFeedback').textContent = translate('tailscaleRemoved');
    relayError = '';
  }, showError);
});
renderCopy();
element('toggle').textContent = translate('loading');
window.mobileAccessUI = {
  setVisible(value) { visible = value; if (visible) { renderCopy(); void run(async () => {}); } else window.CamelliaNetworkDiagnostics?.close(); },
  refresh() { return run(async () => {}); },
};
if (!embedded) void run(async () => {});
const timer = setInterval(() => { if (visible && !working && !document.hidden) void run(async () => {}); }, 5000);
window.addEventListener('beforeunload', () => clearInterval(timer));
})();
