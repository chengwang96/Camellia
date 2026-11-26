'use strict';

(() => {
const embedded = Boolean(document.getElementById('mobilePage'));
const root = embedded ? document.getElementById('mobilePage') : document.querySelector('main');
let visible = !embedded;
const copy = {
  zh: { title: '手机访问', intro: '通过 Tailscale 或同一 Wi-Fi 局域网连接手机。', connection: '连接', pair: '配对设备', devices: '已授权设备', connectionHelp: '连接与权限说明',
    network: '已内置 Tailscale，无需另装客户端。也可在家庭 Wi-Fi 使用 6 位 PIN 直连；局域网模式不开放公网端口。首次需要手动开启；有可信设备时，后续启动会自动恢复。',
    generate: '生成配对码',
    pairHint: '在手机输入地址和一次性配对码，再在此确认授权。',
    footer: '授权设备可发送指令、停止任务和处理工具审批。操作在电脑执行，并沿用会话当前权限；仅授权可信设备。', online: '运行中', offline: '已关闭',
    keysImport: '手机可在设置中直接导入电脑端的 API Key 配置；该操作需要设备的全部访问授权。',
    start: '开启手机访问', stop: '关闭手机访问', noAddress: '开启后显示 Tailscale 地址',
    tray: '关闭窗口可驻留托盘；退出应用或电脑休眠会断开连接。', noTray: '请保持窗口打开，或在设置中启用关闭到托盘。退出应用或电脑休眠会断开连接。',
    noDevices: '尚未授权任何设备。', approve: '授权设备', reject: '拒绝', revoke: '撤销',
    expires: '配对码失效时间：', expired: '配对码已过期，请重新生成。',
    tailnetTrustTitle: 'Tailnet 信任', tailnetTrustToggle: '信任我的 Tailnet 设备',
    tailnetTrustHint: '同一 Tailnet 的电脑会出现在手机端；首次连接默认在这里等待确认。',
    tailnetTrustOn: '已启用', tailnetTrustOff: '已关闭', tailnetTrustIdentity: '等待身份',
    tailnetAutoApprove: '自动批准我的设备',
    tailnetAutoApproveHint: '仅建议在完全由你控制的 Tailnet 中开启。关闭时，新手机首次连接会在这里等待确认。',
    tailnetDiscoveryOn: '手机可通过 Tailnet 自动发现这台电脑。',
    tailnetDiscoveryWaiting: '开启手机访问并登录 Tailscale 后，手机会自动发现这台电脑。',
    tailnetDiscoveryOff: '启用信任后，手机无需扫码即可发现这台电脑。',
    tailnetNoIdentity: '等待 Tailnet 身份', tailnetDevice: 'Tailnet' },
  en: { title: 'Mobile access', intro: 'Connect your phone with Tailscale or the same Wi-Fi.', connection: 'Connection', pair: 'Pair a device', devices: 'Authorized devices', connectionHelp: 'Connection and permissions',
    network: 'Tailscale is built in; no separate client needed. On a home Wi-Fi you can also pair with a six-digit PIN. Local mode never opens a public listener. Enable it once; later starts restore access automatically when a trusted device remains.',
    generate: 'Generate pairing code',
    pairHint: 'Enter the address and one-time code on your phone, then approve it here.',
    footer: 'Authorized devices can send instructions, stop tasks and respond to tool approvals. Tasks execute on this computer under the conversation’s existing permissions; authorize trusted devices only.', online: 'Online', offline: 'Off',
    keysImport: 'Your phone can import this computer’s API key configuration from its Settings. That requires full-access authorization for the device.',
    start: 'Enable mobile access', stop: 'Disable mobile access', noAddress: 'Enable to show the Tailscale address',
    tray: 'Closing the window keeps the app in the tray. Quitting or computer sleep disconnects clients.', noTray: 'Keep the window open or enable close to tray in Settings. Quitting or computer sleep disconnects clients.',
    noDevices: 'No authorized devices yet.', approve: 'Authorize device', reject: 'Reject', revoke: 'Revoke',
    expires: 'Pairing code expires at: ', expired: 'The pairing code expired. Generate another.',
    tailnetTrustTitle: 'Tailnet trust', tailnetTrustToggle: 'Trust my Tailnet devices',
    tailnetTrustHint: 'Computers on the same tailnet appear on the phone; first-time connections wait here by default.',
    tailnetTrustOn: 'On', tailnetTrustOff: 'Off', tailnetTrustIdentity: 'Waiting for identity',
    tailnetAutoApprove: 'Automatically approve my devices',
    tailnetAutoApproveHint: 'Use only on a tailnet you fully control. When off, a new phone waits here for approval.',
    tailnetDiscoveryOn: 'Phones can discover this computer over Tailscale.',
    tailnetDiscoveryWaiting: 'Enable mobile access and sign in to Tailscale so phones can discover this computer.',
    tailnetDiscoveryOff: 'Enable trust to let phones discover this computer without scanning a code.',
    tailnetNoIdentity: 'Waiting for Tailnet identity', tailnetDevice: 'Tailnet' },
};
Object.assign(copy.zh, {
  lanTitle: '局域网访问', lanToggleLabel: '允许同一 Wi-Fi 的手机直连',
  lanHint: '手机会自动发现这台电脑。第一次连接时输入相同的 6 位 PIN，之后会自动重连。',
  lanPin: '连接 PIN', lanSavePin: '保存 PIN', lanAllowJoin: '允许新设备加入',
  lanSecurity: 'PIN 不会通过 mDNS 广播。家庭网络之外不建议开启新设备加入。',
  lanOnline: '运行中', lanOffline: '已关闭', lanAddress: '连接地址：',
  lanError: '启动失败',
  lanFirewallRequired: '等待防火墙授权',
  lanFirewallHint: '请在 Windows 确认窗口中允许 Camellia 为本地子网配置入站规则。',
  lanFirewallRetry: '配置防火墙',
  lanFirewallCleanup: '防火墙规则待清理',
  lanFirewallCleanupHint: '局域网访问已关闭。请授权移除 Camellia 创建的入站规则。',
  lanFirewallRemove: '清理防火墙规则',
  lanListening: '正在监听',
  lanMacPermissions: 'macOS 连接权限',
  lanMacPrivacyHint: '首次启用时，如果 macOS 询问局域网权限，请允许 Camellia。此前拒绝过，可以在「局域网」设置中重新开启。',
  lanMacFirewallHint: '如果防火墙询问是否允许 Camellia 接收入站连接，请选择允许。手机仍无法连入时，可在防火墙选项中检查 Camellia 的状态。',
  lanMacPrivacy: '打开局域网权限',
  lanMacFirewall: '打开防火墙设置',
  lanPinNeeded: '还未设置 PIN。保存一个 6 位数字后即可使用。',
  lanPinHidden: 'PIN 已设置。若系统安全存储不可用，输入新的 6 位 PIN 可以替换。',
  lanPinSaved: 'PIN 已保存。', lanPinInvalid: 'PIN 必须是 6 位数字。',
  lanNoNetwork: '未找到可用的私网 IPv4 地址。',
});
Object.assign(copy.en, {
  lanTitle: 'Local network', lanToggleLabel: 'Allow phones on the same Wi-Fi to connect directly',
  lanHint: 'Phones discover this computer automatically. Enter the same six-digit PIN once; later connections resume automatically.',
  lanPin: 'Connection PIN', lanSavePin: 'Save PIN', lanAllowJoin: 'Allow new devices',
  lanSecurity: 'The PIN is never advertised over mDNS. Leave new-device joins off outside a trusted home network.',
  lanOnline: 'Running', lanOffline: 'Off', lanAddress: 'Address: ',
  lanError: 'Start failed',
  lanFirewallRequired: 'Firewall approval needed',
  lanFirewallHint: 'Approve the Windows prompt to let Camellia configure inbound rules for the local subnet.',
  lanFirewallRetry: 'Configure firewall',
  lanFirewallCleanup: 'Firewall cleanup pending',
  lanFirewallCleanupHint: 'Local network access is off. Approve removal of the inbound rules Camellia created.',
  lanFirewallRemove: 'Remove firewall rules',
  lanListening: 'Listening',
  lanMacPermissions: 'macOS connection permissions',
  lanMacPrivacyHint: 'If macOS asks for local network access when you first enable this feature, allow Camellia. You can change a previous denial in Local Network settings.',
  lanMacFirewallHint: 'If the firewall asks whether Camellia may accept incoming connections, choose Allow. If your phone still cannot connect, check Camellia in Firewall Options.',
  lanMacPrivacy: 'Open Local Network settings',
  lanMacFirewall: 'Open Firewall settings',
  lanPinNeeded: 'No PIN yet. Save six digits before using local access.',
  lanPinHidden: 'A PIN is set. If secure storage is unavailable, enter six digits to replace it.',
  lanPinSaved: 'PIN saved.', lanPinInvalid: 'The PIN must contain exactly six digits.',
  lanNoNetwork: 'No private IPv4 address is available.',
});
const element = id => document.getElementById(embedded ? `mobile-${id}` : id);
Object.assign(copy.zh, { login: '登录 Tailscale', openLogin: '打开浏览器授权', logout: '退出 Tailscale 登录', confirmLogout: '退出内置 Tailscale 登录？手机会断开连接。下次使用时需重新登录 Tailscale。',
  connecting: '正在连接内置网络…', needsLogin: '请登录 Tailscale', needsApproval: '请在 Tailscale 管理后台批准此设备', networkError: '内置网络已断开，请重新开启', networkReady: '内置网络已连接', networkOff: '内置网络已关闭', renameSaving: '正在保存名称…' });
Object.assign(copy.en, { login: 'Sign in to Tailscale', openLogin: 'Authorize in browser', logout: 'Sign out of Tailscale', confirmLogout: 'Sign out of embedded Tailscale? Mobile devices will disconnect. Sign in to Tailscale again to reconnect.',
  connecting: 'Connecting to embedded network…', needsLogin: 'Sign in to Tailscale', needsApproval: 'Approve this device in the Tailscale admin console', networkError: 'Embedded network disconnected. Enable it again.', networkReady: 'Embedded network connected', networkOff: 'Embedded network off', renameSaving: 'Saving name…' });
Object.assign(copy.zh, { deviceName: '本机名称', deviceNameHint: '其他已配对设备会自动更新这个名称；Tailscale 网络名会按设置跟随。', deviceNameSave: '保存名称', deviceNameSaved: '已保存本机名称：', deviceNameSynced: '已同步到 Tailscale。', deviceNameLocalSynced: '内置网络已更新；控制台名称尚未确认。', deviceNameSyncSkipped: '已保存；当前名称不是有效的 Tailscale 标签，未同步。', deviceNameSyncOffline: '已保存；连接 Tailscale 后再同步。', deviceNameSyncFailed: '已保存；Tailscale 同步失败：', tailscaleFollow: '跟随本机名称', tailscaleFollowHint: '关闭后保留内置 Tailscale 当前网络名；Camellia 名称仍会更新。', deviceNameFollowOn: '已开启 Tailscale 名称跟随。', deviceNameFollowOff: '已关闭；保留当前 Tailscale 网络名。', deviceNameFollowOffStatus: '未同步；当前未开启 Tailscale 名称跟随。', scanHint: '用手机扫码填入地址和配对码，也可手动输入。', qrLabel: '配对二维码', refreshCode: '刷新二维码', copyAddress: '复制地址', addressCopied: '连接地址已复制', pairWaiting: '等待电脑授权', pairApproved: '电脑已授权，等待手机完成', pairSuccess: '配对成功', continuePair: '继续配对', pairFailed: '配对请求已结束，请重新生成二维码。', lastConnected: '最近连接：', justNow: '刚刚', minutesAgo: '{0} 分钟前', hoursAgo: '{0} 小时前', daysAgo: '{0} 天前', remark: '添加备注', editRemark: '编辑备注', remarkName: '本机备注', remarkSave: '保存', remarkCancel: '取消', remarkSaving: '正在保存备注…', remarkInvalid: '备注最多 80 个字符。', renameSave: '保存', renameCancel: '取消', renameSaving: '正在保存备注…', nameInvalid: '请输入 1–80 个字符的名称。' });
Object.assign(copy.en, { deviceName: 'This computer name', deviceNameHint: 'Paired devices update automatically; the Tailscale network name follows this setting.', deviceNameSave: 'Save name', deviceNameSaved: 'Computer name saved: ', deviceNameSynced: 'Synced to Tailscale.', deviceNameLocalSynced: 'Embedded network updated; the console name is not confirmed yet.', deviceNameSyncSkipped: 'Saved; the current name is not a valid Tailscale label, so it was not synced.', deviceNameSyncOffline: 'Saved; connect to Tailscale to sync it.', deviceNameSyncFailed: 'Saved; Tailscale sync failed: ', tailscaleFollow: 'Follow this computer name', tailscaleFollowHint: 'Turn off to keep the embedded Tailscale network name; the Camellia name still updates.', deviceNameFollowOn: 'Tailscale name following is on.', deviceNameFollowOff: 'Off. The current Tailscale network name is kept.', deviceNameFollowOffStatus: 'Not synced; Tailscale name following is off.', scanHint: 'Scan with your phone to fill in the address and code, or enter them manually.', qrLabel: 'Pairing QR code', refreshCode: 'Refresh QR code', copyAddress: 'Copy address', addressCopied: 'Connection address copied', pairWaiting: 'Waiting for computer approval', pairApproved: 'Computer approved; waiting for the phone', pairSuccess: 'Paired successfully', continuePair: 'Pair another device', pairFailed: 'The pairing request ended. Generate a new code.', lastConnected: 'Last connected: ', justNow: 'Just now', minutesAgo: '{0} min ago', hoursAgo: '{0} hr ago', daysAgo: '{0} days ago', remark: 'Add remark', editRemark: 'Edit remark', remarkName: 'Device remark', remarkSave: 'Save', remarkCancel: 'Cancel', remarkSaving: 'Saving remark…', remarkInvalid: 'Remarks can contain up to 80 characters.', renameSave: 'Save', renameCancel: 'Cancel', renameSaving: 'Saving remark…', nameInvalid: 'Enter a name of 1–80 characters.' });
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
let state = null, language = 'zh', working = false, invitationExpiry = 0, invitationDeviceIds = new Set(), pairingRequestId = '', pairingRequestSeen = false, pairedDeviceId = '', relayError = '', lanPinNotice = '';
Object.assign(copy.zh, {
  tailnetUpdateTitle: '内置 Tailscale', tailnetCheck: '检查更新', tailnetInstall: '升级至 {0}', tailnetApply: '重试启用',
  tailnetChecking: '正在检查更新…', tailnetInstalling: '正在下载、校验并启用…', tailnetApplying: '正在重启手机访问组件…', tailnetCurrent: '已是最新版本。',
  tailnetUpdated: '{0} 已启用。', tailnetUpdateReconnected: '{0} 已启用，手机访问已恢复。', tailnetUnpublished: '尚无适用于本机的组件更新。', tailnetPending: '{0} 已下载并校验。点击“重试启用”完成升级。',
  tailnetFailed: '更新失败。', tailnetHint: '通过 Camellia 官方发布升级。更新只会短暂断开并重连手机访问，不影响正在进行的回复。',
});
Object.assign(copy.en, {
  tailnetUpdateTitle: 'Embedded Tailscale', tailnetCheck: 'Check for updates', tailnetInstall: 'Upgrade to {0}', tailnetApply: 'Retry activation',
  tailnetChecking: 'Checking for updates…', tailnetInstalling: 'Downloading, verifying and activating…', tailnetApplying: 'Restarting the mobile access component…', tailnetCurrent: 'Up to date.',
  tailnetUpdated: '{0} is active.', tailnetUpdateReconnected: '{0} is active and mobile access has been restored.', tailnetUnpublished: 'No component update is published for this computer yet.', tailnetPending: '{0} is downloaded and verified. Select Retry activation to finish.',
  tailnetFailed: 'Update failed.', tailnetHint: 'Updates come from official Camellia releases. Only mobile access briefly reconnects; active replies are not interrupted.',
});
Object.assign(copy.zh, {
  guardTitle: '后台守护', guardToggleLabel: '自动恢复手机访问',
  guardHint: '开启后约占用 5–15 MB 内存，并阻止电脑因空闲而休眠',
  guardOnlyDesktop: '仅桌面版支持。', guardUnavailable: '守护组件缺失，请重新安装 Camellia。',
  guardNeedsAccess: '开启手机访问后可启用。', guardNeedsDevice: '先配对一台可信设备，再开启守护。',
  guardOff: '未开启', guardRunning: '守护中', guardStarting: '守护正在启动…',
  guardRetrying: '守护正在重试…', guardPaused: '手机访问关闭时暂停；重新开启后自动恢复。',
});
Object.assign(copy.en, {
  guardTitle: 'Background guard', guardToggleLabel: 'Recover mobile access automatically',
  guardHint: 'Uses about 5–15 MB of memory and prevents idle sleep.',
  guardOnlyDesktop: 'Available on desktop only.', guardUnavailable: 'The guard component is missing. Reinstall Camellia.',
  guardNeedsAccess: 'Enable mobile access first.', guardNeedsDevice: 'Pair a trusted device before enabling the guard.',
  guardOff: 'Off.', guardRunning: 'Watching', guardStarting: 'Starting the guard…',
  guardRetrying: 'The guard is retrying…', guardPaused: 'Paused while mobile access is off; resumes when it is enabled again.',
});
let tailnetUpdateAction = '', tailnetUpdateNotice = '', tailnetUpdateError = '';
let renameEditor = null;
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
function renderTailnetUpdate() {
  const button = element('tailnetUpdate');
  if (!button) return;
  const info = state?.tailnetUpdate;
  const section = element('tailnetUpdateSection');
  if (section) section.hidden = !info;
  if (!info) return;
  element('tailnetVersion').textContent = info.current || '';
  button.hidden = !info.supported;
  button.disabled = Boolean(info.busy || tailnetUpdateAction);
  button.textContent = info.pending ? translate('tailnetApply')
    : info.available ? translate('tailnetInstall').replace('{0}', info.available) : translate('tailnetCheck');
  const feedback = element('tailnetUpdateStatus');
  feedback.classList.toggle('error', Boolean(tailnetUpdateError));
  if (tailnetUpdateAction) feedback.textContent = translate(tailnetUpdateAction);
  else if (info.updated) feedback.textContent = translate(info.reconnected ? 'tailnetUpdateReconnected' : 'tailnetUpdated').replace('{0}', info.updated);
  else if (info.busy) feedback.textContent = translate(info.available ? 'tailnetInstalling' : 'tailnetChecking');
  else if (tailnetUpdateError) feedback.textContent = translate('tailnetFailed') + ' ' + tailnetUpdateError;
  else if (info.pending) feedback.textContent = translate('tailnetPending').replace('{0}', info.pending);
  else feedback.textContent = translate(info.available ? 'tailnetHint' : tailnetUpdateNotice || 'tailnetHint');
}
function renderGuard() {
  const section = element('guardSection');
  if (!section) return;
  const info = state?.guard;
  section.hidden = !info;
  if (!info) return;
  const toggle = element('guardToggle'), status = element('guardStatus');
  const hasDevice = Array.isArray(state.devices) && state.devices.length > 0;
  toggle.checked = Boolean(info.enabled);
  toggle.disabled = working || !info.supported || !info.available
    || (!info.enabled && (!state.enabled || !hasDevice));
  let label = 'guardOff';
  if (!info.supported) label = 'guardOnlyDesktop';
  else if (!info.available) label = 'guardUnavailable';
  else if (info.enabled && !state.enabled) label = 'guardPaused';
  else if (!info.enabled && !state.enabled) label = 'guardNeedsAccess';
  else if (!hasDevice) label = 'guardNeedsDevice';
  else if (info.enabled && info.retrying) label = 'guardRetrying';
  else if (info.enabled && info.running) label = 'guardRunning';
  else if (info.enabled) label = 'guardStarting';
  status.textContent = translate(label);
  status.classList.toggle('online', Boolean(info.enabled && info.running));
  status.classList.toggle('error', Boolean(!info.supported || !info.available));
}
function renderTailnetTrust() {
  const section = element('tailnetTrust');
  if (!section) return;
  if (!state?.tailnetTrust) { section.hidden = true; return; }
  section.hidden = false;
  const trust = state?.tailnetTrust || {};
  const status = element('tailnetTrustStatus');
  if (status) {
    status.className = 'status device-status';
    if (!trust.enabled) status.textContent = translate('tailnetTrustOff');
    else if (!trust.ready) status.textContent = translate('tailnetTrustIdentity');
    else { status.textContent = translate('tailnetTrustOn'); status.classList.add('online'); }
  }
  const toggle = element('tailnetTrustToggle');
  if (toggle) {
    toggle.checked = Boolean(trust.enabled);
    toggle.disabled = working || !state.enabled;
  }
  const auto = element('tailnetAutoApprove');
  if (auto) {
    auto.checked = Boolean(trust.autoApprove);
    auto.disabled = working || !trust.enabled || !trust.ready;
  }
  if (element('tailnetTrustHint')) element('tailnetTrustHint').textContent = translate('tailnetTrustHint');
  if (element('tailnetAutoApproveHint')) element('tailnetAutoApproveHint').textContent = translate('tailnetAutoApproveHint');
  const scope = element('tailnetTrustScope');
  if (scope) {
    scope.replaceChildren();
    const owner = trust.ownerDisplayName || trust.ownerLogin;
    if (owner) {
      const chip = document.createElement('span'); chip.className = 'tailnet-chip';
      const dot = document.createElement('span'); dot.className = 'tailnet-dot';
      const name = document.createElement('strong'); name.textContent = owner;
      chip.append(dot, name);
      if (trust.ownerLogin && trust.ownerLogin !== owner) chip.append(document.createTextNode(' · ' + trust.ownerLogin));
      scope.append(chip);
    }
    const tailnet = trust.tailnetName || state.network?.tailnet || '';
    if (tailnet) {
      const chip = document.createElement('span'); chip.className = 'tailnet-chip';
      chip.textContent = 'Tailnet · ' + tailnet; scope.append(chip);
    }
    if (!trust.ready) {
      const chip = document.createElement('span'); chip.className = 'tailnet-chip muted';
      chip.textContent = translate('tailnetNoIdentity'); scope.append(chip);
    }
    for (const tag of Array.isArray(trust.allowedTags) ? trust.allowedTags : []) {
      const chip = document.createElement('span'); chip.className = 'tailnet-chip';
      chip.textContent = tag; scope.append(chip);
    }
  }
  const discovery = element('tailnetDiscovery');
  if (discovery) discovery.textContent = !trust.enabled ? translate('tailnetDiscoveryOff')
    : state.running ? translate('tailnetDiscoveryOn') : translate('tailnetDiscoveryWaiting');
}
function renderLan() {
  const info = state?.lan;
  if (!info) return;
  const toggle = element('lanToggle'), allow = element('lanAllowJoin'), pin = element('lanPin');
  if (!toggle || !allow || !pin) return;
  toggle.checked = Boolean(info.enabled);
  toggle.disabled = working;
  const macPanels = info.macPermissionPanels || [];
  const status = element('lanStatus');
  const firewallCleanup = info.firewall === 'cleanup-required';
  const firewallNotice = info.firewall ? translate(firewallCleanup ? 'lanFirewallCleanupHint' : 'lanFirewallHint') : '';
  status.textContent = translate(info.error ? 'lanError' : info.firewall ? (firewallCleanup ? 'lanFirewallCleanup' : 'lanFirewallRequired')
    : info.running ? (macPanels.length ? 'lanListening' : 'lanOnline') : info.enabled ? 'connecting' : 'lanOffline');
  status.classList.toggle('online', Boolean(info.running && !info.firewall && !info.error));
  status.classList.toggle('error', Boolean(info.error || info.firewall));
  const firewallButton = element('lanFirewallRetry');
  firewallButton.hidden = !info.firewall;
  firewallButton.disabled = working;
  firewallButton.textContent = translate(firewallCleanup ? 'lanFirewallRemove' : 'lanFirewallRetry');
  element('lanMacPermissions').hidden = !info.enabled || !macPanels.length;
  element('lanMacPrivacyHint').hidden = !macPanels.includes('privacy');
  element('lanMacPrivacy').hidden = !macPanels.includes('privacy');
  element('lanMacPrivacy').disabled = working;
  element('lanMacFirewall').disabled = working;
  element('lanAddress').textContent = info.address ? translate('lanAddress') + info.address : '';
  if (pin && document.activeElement !== pin) pin.value = info.pin || '';
  pin.disabled = working;
  pin.setAttribute('aria-invalid', pin.value && !/^\d{6}$/.test(pin.value) ? 'true' : 'false');
  const save = element('lanSavePin');
  save.disabled = working || !/^\d{6}$/.test(pin.value);
  allow.checked = info.allowJoin !== false;
  allow.disabled = working || !info.enabled;
  const notice = element('lanPinStatus');
  notice.classList.toggle('error', Boolean(info.error || info.firewall));
  notice.textContent = info.error || firewallNotice || lanPinNotice
    || (!info.hasPin ? translate('lanPinNeeded') : info.pin ? '' : translate('lanPinHidden'));
}
function showError(error) {
  const legacy = embedded && error.message === 'Local remote-access window required';
  element('error').textContent = legacy ? translate('restart') : error.message === 'Mobile access is unavailable' ? translate('loadFailed') : error.message;
  if (embedded) element('openPanel').hidden = !legacy;
}
function disablePageControls() {
  // Inline editors and modal forms own their busy state; background polling must not lock them.
  for (const control of root.querySelectorAll('button, input[type="checkbox"]')) {
    const editorControl = control === renameEditor?.field || control === renameEditor?.save || control === renameEditor?.cancel;
    if (!control.closest('dialog') && !editorControl) control.disabled = true;
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
  if (element('guardSection')) element('guardSection').hidden = true;
  relayError = '';
  renderTailscale();
  renderTailnetUpdate();
  invitationExpiry = 0;
  disablePageControls();
  element('retry').disabled = false;
  element('retry').hidden = false;
  if (embedded) element('openPanel').disabled = false;
  showError(error);
}
function renderDevices(target, entries, pending) {
  if (!pending) {
    for (const button of target.querySelectorAll('.device-rename-start')) button.disabled = working || Boolean(renameEditor);
  }
  if (!pending && renameEditor) {
    // A save in flight owns the row until it settles; replacing it now would
    // discard the editor before its response can close it.
    if (renameEditor.saving) return;
    const row = renameEditor.row;
    const live = entries.find(device => device.id === renameEditor.entry.id);
    if (row?.isConnected && target.contains(row) && live) {
      Object.assign(renameEditor.entry, live);
      // Do not leave the other rows' Rename buttons disabled after a poll:
      // this branch deliberately keeps their DOM instead of rebuilding it.
      for (const button of target.querySelectorAll('.device-rename-start')) button.disabled = working || Boolean(renameEditor);
      row.querySelector('.device-meta small').textContent = translate('lastConnected') + (renameEditor.entry.lastSeenAt ? relativeTime(renameEditor.entry.lastSeenAt) : '—');
      return;
    }
    for (const button of target.querySelectorAll('.device-rename-start')) button.disabled = working;
    closeRenameEditor(renameEditor);
  }
  target.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement('div'), icon = mobileDeviceIcon(), name = document.createElement('div'), title = document.createElement('span'), meta = document.createElement('div'), label = document.createElement('small'), actions = document.createElement('div');
    row.className = 'device device-row'; icon.classList.add('device-icon'); name.className = 'name device-info'; meta.className = 'device-meta'; actions.className = 'actions device-actions';
    title.className = 'device-name-text';
    title.textContent = entry.remark || entry.name;
    const source = entry.auth === 'tailnet'
      ? translate('tailnetDevice') + (entry.tailnet?.login ? ' · ' + entry.tailnet.login : '')
      : entry.auth === 'lan' ? translate('lanTitle') : '';
    label.textContent = pending
      ? `${source || entry.computerName || ''}${(source || entry.computerName) ? ' · ' : ''}${translate(entry.state === 'approved' ? 'pairApproved' : entry.state === 'rejected' ? 'pairingRejected' : 'pairWaiting')}`
      : `${entry.remark ? entry.name + ' · ' : ''}${source ? source + ' · ' : ''}${translate('lastConnected')}${entry.lastSeenAt ? relativeTime(entry.lastSeenAt) : '—'}`;
    meta.append(label);
    name.append(title, meta);
    if (!pending) {
      const rename = document.createElement('button');
      rename.className = 'device-rename-start';
      rename.textContent = translate(entry.remark ? 'editRemark' : 'remark'); rename.disabled = working || Boolean(renameEditor);
      rename.addEventListener('click', () => renameDevice(entry, row, title, name));
      actions.append(rename);
      const saveName = document.createElement('button');
      saveName.className = 'device-rename-save'; saveName.type = 'button';
      saveName.textContent = translate('renameSave'); saveName.hidden = true;
      actions.append(saveName);
      const cancelName = document.createElement('button');
      cancelName.className = 'device-rename-cancel'; cancelName.type = 'button';
      cancelName.textContent = translate('remarkCancel'); cancelName.hidden = true;
      actions.append(cancelName);
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
  if (!config) return;
  const connected = view?.state === 'connected';
  const relays = configuredRelays(view);
  const selected = relays.find(device => device.relaySelected);
  config.hidden = false;
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
function closeRenameEditor(editor) {
  if (!editor || renameEditor !== editor) return;
  renameEditor = null;
  editor.row.classList.remove('device-inline-rename');
  editor.field.disabled = false;
  const wasFocused = editor.field === document.activeElement;
  editor.field.replaceWith(editor.title);
  editor.status.remove();
  editor.start.hidden = false;
  editor.save.hidden = true;
  editor.cancel.hidden = true;
  for (const button of root.querySelectorAll('.device-rename-start')) button.disabled = working;
  if (wasFocused) editor.start.focus();
}
function renameDevice(entry, row, title, name) {
  if (working || renameEditor?.saving) return;
  if (renameEditor) {
    if (renameEditor.entry.id === entry.id) { renameEditor.field.focus(); renameEditor.field.select(); return; }
    closeRenameEditor(renameEditor);
  }
  for (const button of root.querySelectorAll('.device-rename-start')) button.disabled = true;
  const editor = { entry, row, title, name, field: null, status: null, start: null, save: null, cancel: null, saving: false };
  const field = document.createElement('input');
  field.className = 'device-rename-field';
  field.maxLength = 80;
  field.autocomplete = 'off';
  field.value = entry.remark || '';
  field.setAttribute('aria-label', translate('remarkName'));
  const status = document.createElement('p');
  status.className = 'hint device-rename-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const actionButton = actionName => row.querySelector(`.device-rename-${actionName}`);
  editor.start = actionButton('start');
  editor.save = actionButton('save');
  editor.cancel = actionButton('cancel');
  editor.start.hidden = true;
  editor.save.hidden = false;
  editor.cancel.hidden = false;
  editor.save.disabled = editor.cancel.disabled = false;
  row.append(status);
  row.classList.add('device-inline-rename');
  title.replaceWith(field);
  editor.field = field;
  editor.status = status;
  renameEditor = editor;

  let saving = false;
  const unlock = () => {
    saving = false;
    editor.saving = false;
    field.disabled = false;
    editor.save.disabled = false;
    editor.cancel.disabled = false;
  };
  const restore = () => {
    unlock();
    closeRenameEditor(editor);
    return { ok: true };
  };
  const submit = async () => {
    if (saving || working || renameEditor !== editor) return;
    field.setCustomValidity('');
    const value = field.value.trim();
    if (value.length > 80) {
      field.setCustomValidity(translate('remarkInvalid'));
      status.textContent = translate('remarkInvalid');
      status.classList.add('error');
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      return;
    }
    saving = true;
    editor.saving = true;
    const save = editor.save, cancel = editor.cancel;
    field.disabled = save.disabled = cancel.disabled = true;
    status.classList.remove('error');
    status.textContent = translate('remarkSaving');
    try {
      await call(value ? 'rename' : 'clear-remark', { id: entry.id, name: value });
      title.textContent = value || entry.name;
      closeRenameEditor(editor);
      state.devices = (state.devices || []).map(device => device.id === entry.id
        ? { ...device, ...(value ? { remark: value } : { remark: undefined }) } : device);
      render();
      try { await refresh(); } catch { showError(new Error(translate('loadFailed'))); }
      return { ok: true };
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
      unlock();
      return { ok: false };
    }
  };
  editor.submit = submit;
  editor.save.addEventListener('click', () => { void submit(); });
  editor.cancel.addEventListener('click', restore);
  field.addEventListener('input', () => {
    field.setCustomValidity('');
    field.removeAttribute('aria-invalid');
    status.classList.remove('error');
    status.textContent = '';
  });
  field.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); void submit(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); restore(); }
  });
  field.focus();
  field.select();
}
function render() {
  language = state.language === 'en' ? 'en' : 'zh';
  if (renameEditor?.saving) return;
  if (!embedded) {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.documentElement.dataset.theme = state.theme;
  }
  renderCopy();
  element('retry').hidden = true;
  if (embedded) element('openPanel').hidden = true;
  if (element('deviceName') && document.activeElement !== element('deviceName')) element('deviceName').value = state.computerName || '';
  if (element('tailscaleFollow')) {
    element('tailscaleFollow').hidden = Boolean(state.network && !state.network.hostName && state.network.state !== 'Running');
    const followHint = element('tailscaleFollowHint');
    if (followHint) followHint.hidden = element('tailscaleFollow').hidden;
    element('tailscaleFollow').checked = state.tailscaleFollow !== false;
    element('tailscaleFollow').disabled = working;
  }
  if (element('tailscaleFollowHint')) element('tailscaleFollowHint').textContent = translate('tailscaleFollowHint');
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
  renderLan();
  renderTailnetTrust();
  renderGuard();
  renderTailscale();
  renderRelayPath();
  renderTailnetUpdate();
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
    catch (error) {
      // An unsaved inline rename lives inside the device list. Do not replace
      // that list with the unavailable state while the user is still editing.
      if (renameEditor) {
        showError(error);
        element('retry').hidden = false;
        element('retry').disabled = false;
      } else renderUnavailable(error);
    }
  }
}
element('retry').addEventListener('click', () => run(async () => {}));
element('tailnetUpdate')?.addEventListener('click', async () => {
  const info = state?.tailnetUpdate;
  if (!info?.supported || info.busy || tailnetUpdateAction) return;
  const install = Boolean(info.available || info.pending);
  tailnetUpdateAction = info.pending ? 'tailnetApplying' : install ? 'tailnetInstalling' : 'tailnetChecking';
  tailnetUpdateError = '';
  tailnetUpdateNotice = '';
  renderTailnetUpdate();
  try {
    const next = await call(install ? 'tailnet-update-install' : 'tailnet-update-check');
    if (state) state.tailnetUpdate = next;
    if (!next.available && !next.pending) tailnetUpdateNotice = next.unpublished ? 'tailnetUnpublished' : 'tailnetCurrent';
  } catch (error) { tailnetUpdateError = error.message; }
  finally { tailnetUpdateAction = ''; renderTailnetUpdate(); }
});
if (embedded) element('openPanel').addEventListener('click', async () => {
  try {
    const response = await window.dshDesktop.openMobileAccess();
    if (!response.ok) throw new Error(response.error);
  } catch (error) { showError(error); }
});
element('toggle').addEventListener('click', () => run(() => call(state.enabled || state.running ? 'stop' : 'start')));
element('tailnetTrustToggle')?.addEventListener('change', () => run(async () => {
  await call('tailnet-trust', { enabled: element('tailnetTrustToggle').checked });
}));
element('tailnetAutoApprove')?.addEventListener('change', () => run(async () => {
  await call('tailnet-trust', { autoApprove: element('tailnetAutoApprove').checked });
}));
function validateLanPin() {
  const pin = element('lanPin');
  const valid = /^\d{6}$/.test(pin.value);
  pin.setAttribute('aria-invalid', pin.value && !valid ? 'true' : 'false');
  element('lanSavePin').disabled = working || !valid;
  if (pin.value && !valid) {
    lanPinNotice = '';
    element('lanPinStatus').classList.add('error');
    element('lanPinStatus').textContent = translate('lanPinInvalid');
  } else {
    element('lanPinStatus').classList.remove('error');
    element('lanPinStatus').textContent = lanPinNotice;
  }
}
element('lanToggle')?.addEventListener('change', () => {
  const enabled = element('lanToggle').checked;
  lanPinNotice = '';
  void run(() => call(enabled ? 'lan-enable' : 'lan-disable'));
});
element('lanFirewallRetry')?.addEventListener('click', () => {
  void run(() => call(state?.lan?.enabled ? 'lan-enable' : 'lan-disable'));
});
for (const [elementId, panel] of [['lanMacPrivacy', 'privacy'], ['lanMacFirewall', 'firewall']]) {
  element(elementId)?.addEventListener('click', () => {
    void run(() => call('lan-open-mac-settings', { panel }));
  });
}
element('lanSavePin')?.addEventListener('click', () => {
  const pin = element('lanPin').value;
  if (!/^\d{6}$/.test(pin)) { validateLanPin(); return; }
  lanPinNotice = '';
  void run(async () => {
    await call('lan-set-pin', { pin });
    lanPinNotice = translate('lanPinSaved');
  });
});
element('lanAllowJoin')?.addEventListener('change', () => {
  const allowJoin = element('lanAllowJoin').checked;
  void run(() => call('lan-allow-join', { allowJoin }));
});
element('lanPin')?.addEventListener('input', () => {
  lanPinNotice = '';
  validateLanPin();
});
element('guardToggle')?.addEventListener('change', () => {
  const enabled = element('guardToggle').checked;
  void run(() => call(enabled ? 'guard-enable' : 'guard-disable'), showError);
});
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
  cancel.dataset.copy = 'remarkCancel'; cancel.textContent = translate('remarkCancel');
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
  else if (sync.reason === 'not-following') suffix = translate('deviceNameFollowOffStatus');
  else if (sync.reason === 'invalid-name') suffix = translate('deviceNameSyncSkipped');
  else if (sync.reason === 'error' && sync.error) suffix = translate('deviceNameSyncFailed') + sync.error;
  else if (embeddedSync.synced) suffix = translate('deviceNameLocalSynced');
  const message = translate('deviceNameSaved') + result.computerName + ' · ' + suffix;
  element('deviceNameStatus').textContent = message;
}));
element('tailscaleFollow')?.addEventListener('change', () => {
  const follow = element('tailscaleFollow').checked;
  void run(async () => {
    await call('set-name', { name: state.computerName, tailscaleFollow: follow });
    element('deviceNameStatus').textContent = translate(follow ? 'deviceNameFollowOn' : 'deviceNameFollowOff');
  });
});
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
