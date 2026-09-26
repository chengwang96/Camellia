'use strict';

// The settings document loads several classic scripts into one global scope, so
// everything here stays inside this closure; only window.cliDevicesUI is shared.
(function () {
const embedded = Boolean(document.getElementById('devicesPage'));
const root = document.getElementById('cliDevicesRoot');
const bridge = window.camelliaDevices || window.dshDesktop?.camelliaDevices;
const elements = {};
for (const child of root.querySelectorAll('[id]')) {
  const id = child.id.startsWith('cli-') ? child.id.slice(4) : child.id;
  if (!(id in elements)) elements[id] = child;
}
const english = { devices: 'CLI devices', target: 'Target device', choose: 'Choose a CLI device', add: '+ Add CLI device', network: 'Local Tailscale connection', networkHint: 'Separate controller identity. Does not enable remote access to this computer.', login: 'Start / Sign in', browser: 'Open sign-in link', refresh: 'Refresh', disconnect: 'Disconnect network', newWorkspace: 'New workspace', newChat: 'New conversation', more: 'Load more conversations', forget: 'Forget device', localHint: 'Local conversations stay in the original workbench.', remote: 'Remote workbench · Development preview', offline: 'Offline · Writes disabled', reconnect: 'Connect / Refresh', emptyTitle: 'Bring your server work here', emptyBody: 'Sign into Tailscale, add a CLI device, then approve pairing on the server.', boundary: 'Files, conversations and engines live on the server. Sign into subscriptions on that server.', rename: 'Rename', archive: 'Archive', delete: 'Delete conversation', message: 'Send to the selected server', configure: 'Model & permissions', stop: 'Stop response', send: 'Send', cancel: 'Cancel', confirm: 'Confirm', independent: 'Independent conversations', online: 'Connected', remove: 'Remove workspace', pending: 'Waiting for server approval. Check again after approving in the CLI.', check: 'Check approval', address: 'Tailscale address (http://100.x.y.z:43127)', deviceName: 'Server display name', clientName: 'This computer name', code: 'One-time pairing code', name: 'Name', path: 'Existing absolute server folder', workspace: 'Workspace', engine: 'Engine', model: 'Model', permission: 'Permission', allow: 'Allow once', deny: 'Deny', history: 'Showing recent history only. Earlier messages remain on the server.', uncertain: 'Operation outcome is uncertain. Refresh and inspect server state; do not blindly repeat.', removeHint: 'Remove only the workspace record. Keep server files and conversations; conversations become independent.', deleteHint: 'Permanently remove this conversation from the server. Project files are not deleted.', forgetHint: 'Remove local credentials only. Server authorization is not revoked.', noModels: 'No models configured on the server.', process: 'Process', noEngine: 'This server does not advertise available engines. Update the server.', connectedAt: 'Last refreshed', ask: 'Ask', auto: 'Auto', full: 'Full access' };
const chinese = { independent: '独立会话', online: '已连接', remove: '移除工作区', pending: '等待服务器批准。请在 CLI 批准后检查。', check: '检查授权', address: 'Tailscale 地址（http://100.x.y.z:43127）', deviceName: '服务器显示名称', clientName: '本机名称', code: '一次性配对码', name: '名称', path: '服务器已有目录的绝对路径', workspace: '工作区', engine: '引擎', model: '模型', permission: '权限', allow: '允许一次', deny: '拒绝', history: '仅显示近期历史；更早消息仍保存在服务器。', uncertain: '操作结果待核实。请刷新并检查服务器状态，不要直接重复操作。', removeHint: '只移除工作区记录，保留服务器文件和会话；会话转为独立会话。', deleteHint: '永久删除服务器上的此会话，不删除项目文件。', forgetHint: '仅移除本机凭据，不撤销服务器端授权。', noModels: '服务器尚未配置模型。', process: '过程', noEngine: '服务器未声明可用引擎，请更新服务端。', connectedAt: '上次刷新', ask: '询问', auto: '自动', full: '完全访问' };
for (const element of root.querySelectorAll('[data-copy]')) chinese[element.dataset.copy] = element.textContent;
Object.assign(english, { selectChats: 'Select conversations', deleteSelected: 'Delete selected', archived: 'Archived', pin: 'Pin', unpin: 'Unpin', older: 'Earlier messages', artifacts: 'Artifacts', refreshFiles: 'Refresh files', moreFiles: 'More files', attach: 'Attach files', restore: 'Restore', download: 'Download', attachments: 'Attachments', downloading: 'Downloading', complete: 'Complete', cancelled: 'Cancelled', failed: 'Failed', attachmentLimit: 'Select up to 9 files, 8 MiB total', chooseChat: 'Choose a server conversation', chooseChatBody: 'Choose a conversation on the left, or create one in a workspace or independently.', thinking: 'Thinking', default: 'Default' });
Object.assign(chinese, { unpin: '取消置顶', restore: '恢复', download: '下载', attachments: '附件', downloading: '下载中', complete: '已完成', cancelled: '已取消', failed: '失败', attachmentLimit: '最多 9 个附件，总计不超过 8 MiB', chooseChat: '选择服务器会话', chooseChatBody: '从左侧选择会话，或在工作区中新建会话，也可新建独立会话。', thinking: '思考级别', default: '默认' });
Object.assign(english, { importApi: 'Import local API settings', importHint: 'Source: this desktop. Target: {target}. Transfer {providers} providers and {keys} API keys. Skip {skipped} local-only providers. Existing server providers are kept unchanged, including conflicts. Subscription credentials, usage and ports are never transferred. Server routing enable/disable state is preserved.', importDone: 'API settings imported. Added providers: {added}; added keys: {keys}; conflicting providers kept: {skipped}.', importFailed: 'Import failed and the previous configuration was restored.', importUnknown: 'Import outcome is uncertain. Inspect server settings before starting another import.', importDisabled: 'Server API routing is disabled; enable it on the server before sending.' });
Object.assign(chinese, { importHint: '来源：这台 GUI 电脑。目标：{target}。传输 {providers} 个服务商、{keys} 个 API 密钥；跳过 {skipped} 个本地专用服务商。已有服务商及冲突项保留服务器设置。订阅凭据、用量和端口不会迁移，服务器路由启用状态保持不变。', importDone: 'API 设置导入完成：新增 {added} 个服务商、{keys} 个密钥；保留 {skipped} 个冲突服务商。', importFailed: '导入失败，已恢复服务器原配置。', importUnknown: '导入结果待核实，请检查服务器配置后再发起新的导入。', importDisabled: '服务器 API 路由未启用，发送前需在服务器启用。' });
let language = 'zh-CN', devices = [], selected = '', chats = [], info = null, snapshot = null, conversationId = null;
let online = false, busy = false, version = 0, watchId = '', pendingPair = null, dialogAction = null, nextOffset = null, refreshTimer = null, refreshedAt = '';
let olderMessages = [], olderCursor;
let attachments = [], selecting = false, selectedChats = new Set(), artifactOffset = null;
let archivedOffset = null;
const transfers = new Map();
let nativeView = null, nativeTarget = null, nativeRevision = 0;
let nativeDocumentId = null;
const nativeDrafts = new Map(), messageCache = new Map();
let networkState = 'Stopped';
Object.assign(english, { nativeSettings: 'Server native settings', document: 'Configuration document', save: 'Save', nativeConfirm: 'I confirm changes on this server. Commands, MCP and hooks can execute code.', nativeWarning: 'Edits affect the selected server, not this computer. Account credentials and API routes are excluded. Native config/MCP may contain sensitive values: do not paste subscription tokens. Existing conversations retain their connection/model/permission overrides; native edits take effect at the next engine process.', nativeSaved: 'Native configuration saved; it applies at the next engine process. Existing conversation overrides remain.', copyCode: 'Copy code', wrapCode: 'Word wrap', copied: 'Copied', copyFailed: 'Copy failed', openLink: 'Open external link?', openLinkWarning: 'This URL came from remote output. Open it in your local browser only if you trust it.' });
Object.assign(chinese, { nativeWarning: '修改的是选中的服务器，而非本机。订阅凭据和 API 路由不在此编辑；原生配置/MCP 可能包含敏感值，不要粘贴订阅 token。已有会话保留连接、模型和权限覆盖；原生修改在下次引擎进程启动时生效。', nativeSaved: '已保存原生配置，下次引擎进程启动时生效；已有会话覆盖设置保留。', copyCode: '复制代码', wrapCode: '自动换行', copied: '已复制', copyFailed: '复制失败', openLink: '打开外部链接？', openLinkWarning: '此链接来自远程输出，请确认可信后再在本机浏览器打开。' });
Object.assign(english, { networkFirst: 'Adding a CLI device takes two steps. 1) Expand "Local Tailscale connection", click "Start / Sign in" and authorize in the browser. 2) Then click "+ Add CLI device" and enter its address and pairing code.', networkLoginHint: 'A Tailscale sign-in link is ready. Click "Open sign-in link" to authorize in the browser, then click "Refresh".', networkReadyHint: 'Local Tailscale is connected. You can add a CLI device now.' });
Object.assign(chinese, { networkFirst: '添加 CLI 设备需要两步。1）先展开「本机 Tailscale 连接」，点击「启动 / 登录」并在浏览器完成授权；2）授权成功后，再点击「＋ 添加 CLI 设备」填写地址和配对码。', networkLoginHint: '已生成 Tailscale 登录链接：点击「打开登录链接」在浏览器完成授权，然后点「刷新」。', networkReadyHint: '本机 Tailscale 已连接，现在可以添加 CLI 设备。' });
const NETWORK_LABELS = { Running: { zh: '已连接', en: 'Connected' }, NeedsLogin: { zh: '需要登录', en: 'Sign-in required' }, Starting: { zh: '启动中', en: 'Starting' }, Stopped: { zh: '未启动', en: 'Not started' }, Error: { zh: '出错', en: 'Error' } };
const embeddedNetworkError = error => /embedded networking|embedded network/i.test(error.message) ? copy('networkFirst') : error.message;
const copy = key => (language === 'en' ? english : chinese)[key] || english[key] || key;
Object.assign(english, { networkHint: 'Shares the same embedded Tailscale identity as Mobile access: sign in once and both features work. Starting the network here does not open remote access to this computer; disconnect or sign out from the Mobile access page.' });
const currentDevice = () => devices.find(device => device.id === selected);
async function call(action, payload) { const reply = await bridge.call(action, payload); if (!reply.ok) throw new Error(reply.error); return reply.result; }
function buttons() {
  for (const button of root.querySelectorAll('button')) button.disabled = busy;
  for (const button of root.querySelectorAll('[data-write]')) button.disabled = busy || !online;
  elements.device.disabled = busy;
  elements.newWorkspace.disabled ||= !info?.capabilities?.includes('create-workspace');
  elements.newChat.disabled ||= !info?.engines?.length;
  elements.importApi.disabled ||= !info?.capabilities?.includes('api-import');
  elements.nativeSettings.disabled = busy || !online || !info?.capabilities?.includes('native-settings');
  elements.nativeSave.disabled = busy || !online || !nativeView?.editable;
  elements.nativeDocument.disabled = busy;
  elements.nativeText.disabled = busy || !nativeView?.editable;
  elements.forget.disabled = busy || !selected;
  elements.send.disabled ||= !snapshot || Boolean(snapshot.conversation.activity);
  elements.stop.disabled ||= !snapshot?.live;
  elements.configure.disabled ||= !snapshot?.settings?.editable;
  elements.older.disabled = busy || !online;
  elements.attach.disabled = busy || !online || !snapshot || !info?.capabilities?.includes('attachments') || attachments.length >= 9;
  elements.deleteSelected.disabled = busy || !online || !selectedChats.size;
  elements.loadArtifacts.disabled = busy || !online || !snapshot;
  elements.moreArtifacts.disabled = busy || !online;
  elements.loadArchived.disabled = busy || !online || !info?.capabilities?.includes('restore');
  elements.moreArchived.disabled = busy || !online;
  for (const box of root.querySelectorAll('.conversation-row input')) box.disabled = busy;
  for (const button of root.querySelectorAll('[data-online]')) button.disabled = busy || !online;
  for (const button of root.querySelectorAll('[data-cancel-transfer]')) button.disabled = false;
}
async function run(operation) {
  if (busy) return;
  busy = true; elements.error.textContent = ''; buttons();
  try { await operation(); }
  catch (error) { elements.error.textContent = error.message; }
  finally { busy = false; buttons(); }
}
function offline() { version++; online = false; elements.connection.textContent = copy('offline'); buttons(); }
function renderConnection() {
  elements.targetName.textContent = currentDevice()?.name || copy('choose');
  elements.connection.textContent = online ? `${copy('online')} · ${currentDevice()?.address} · ${copy('connectedAt')} ${refreshedAt}` : copy('offline');
}
function translate() {
  if (!embedded) document.documentElement.lang = language;
  for (const element of root.querySelectorAll('[data-copy]')) element.textContent = copy(element.dataset.copy);
}
async function state() {
  const result = await call('state'); devices = result.devices; language = result.language; translate();
  if (!embedded) document.documentElement.dataset.theme = result.theme;
  networkState = result.network.state;
  elements.networkState.textContent = (NETWORK_LABELS[networkState]?.[language === 'en' ? 'en' : 'zh'] || networkState) + ' · ' + networkState;
  elements.openLogin.hidden = !result.network.loginUrl;
  elements.cancelPair.hidden = !pendingPair;
  if (pendingPair) elements.add.textContent = copy('check');
  elements.device.replaceChildren(new Option(copy('choose'), ''), ...devices.map(device => new Option(device.name, device.id)));
  elements.device.value = selected;
  renderConnection();
}
function renderTree() {
  elements.tree.replaceChildren();
  const groups = [...(info?.workspaces || []), { id: null, name: copy('independent') }];
  for (const group of groups) {
    const section = document.createElement('section'); section.className = 'group';
    const heading = document.createElement('div'); heading.className = 'group-head';
    const title = document.createElement('span'); title.textContent = group.name; heading.append(title);
    if (group.id && info.capabilities.includes('rename-workspace')) {
      const rename = document.createElement('button'); rename.textContent = '…'; rename.title = copy('rename'); rename.dataset.write = '';
      rename.onclick = () => showDialog(`${copy('rename')} · ${currentDevice().name}`, group.name, [{ key: 'name', value: group.name }], values => command(null, { action: 'rename-workspace', workspaceId: group.id, expectedName: group.name, name: values.name }));
      heading.append(rename);
    }
    if (group.id && info.capabilities.includes('delete-workspace')) {
      const remove = document.createElement('button'); remove.textContent = '−'; remove.title = copy('remove'); remove.setAttribute('aria-label', `${copy('remove')} ${group.name}`); remove.dataset.write = '';
      remove.onclick = () => showDialog(`${copy('remove')} · ${currentDevice().name} · ${group.name}`, copy('removeHint'), [], async () => command(null, { action: 'delete-workspace', workspaceId: group.id, expectedName: group.name }));
      heading.append(remove);
    }
    section.append(heading);
    for (const conversation of chats.filter(chat => chat.workspaceId === group.id)) {
      const button = document.createElement('button'); button.className = 'conversation'; button.textContent = `${conversation.activity ? '● ' : ''}${conversation.title}`;
      button.setAttribute('aria-current', String(conversation.id === conversationId));
      button.onclick = () => run(async () => { await clearAttachments(); conversationId = conversation.id; clearArtifacts(); olderMessages = []; olderCursor = undefined; elements.prompt.value = ''; snapshot = null; await refresh(); await watch(); });
      if (selecting) {
        const row = document.createElement('div'); row.className = 'conversation-row';
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = selectedChats.has(conversation.id); box.setAttribute('aria-label', `Select ${conversation.title}`);
        box.onchange = () => { if (box.checked && selectedChats.size >= 100) { box.checked = false; return; } if (box.checked) selectedChats.add(conversation.id); else selectedChats.delete(conversation.id); buttons(); };
        row.append(box, button); section.append(row);
      } else section.append(button);
    }
    elements.tree.append(section);
  }
  elements.more.hidden = nextOffset === null; buttons();
}
async function clearAttachments() {
  const ids = attachments.map(file => file.id); attachments = []; renderAttachments();
  if (ids.length) await call('attachments-remove', { ids });
}
function clearArtifacts() { artifactOffset = null; elements.artifacts.replaceChildren(); elements.moreArtifacts.hidden = true; }
function clearArchived() { archivedOffset = null; elements.archived.replaceChildren(); elements.moreArchived.hidden = true; }
async function loadArchived(append = false) {
  if (!online) return;
  const revision = version;
  const result = await call('archived', { deviceId: selected, offset: append ? archivedOffset : 0 });
  if (revision !== version || result.instanceId !== info.instanceId) throw new Error(copy('uncertain'));
  if (!append) elements.archived.replaceChildren();
  for (const conversation of result.conversations) {
    const row = document.createElement('div'); row.className = 'artifact';
    const title = document.createElement('span'); title.textContent = conversation.title;
    const restore = document.createElement('button'); restore.textContent = copy('restore'); restore.dataset.write = '';
    restore.onclick = () => showDialog(`${copy('restore')} · ${currentDevice().name}`, conversation.title, [], async () => {
      await command(null, { action: 'restore', conversationId: conversation.id, expectedSeq: conversation.seq }); await loadArchived();
    });
    row.append(title, restore); elements.archived.append(row);
  }
  archivedOffset = result.nextOffset; elements.moreArchived.hidden = archivedOffset == null; buttons();
}
function renderAttachments() {
  elements.attachmentTray.replaceChildren();
  for (const file of attachments) {
    const row = document.createElement('div'); row.className = 'attachment';
    const title = document.createElement('span'); title.textContent = `${file.isImage ? '▧ ' : ''}${file.name} · ${(file.size / 1024).toFixed(1)} KiB`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.onclick = () => run(async () => { await call('attachments-remove', { ids: [file.id] }); attachments = attachments.filter(entry => entry.id !== file.id); renderAttachments(); });
    row.append(title, remove); elements.attachmentTray.append(row);
  }
  buttons();
}
async function loadArtifacts(append = false) {
  if (!online || !snapshot) return;
  const revision = version, id = conversationId, offset = append ? artifactOffset : 0;
  const result = await call('artifacts', { deviceId: selected, conversationId: id, offset });
  if (revision !== version || conversationId !== id) return;
  if (!append) elements.artifacts.replaceChildren();
  for (const artifact of result.artifacts) {
    const row = document.createElement('div'); row.className = 'artifact';
    const title = document.createElement('span'); title.textContent = `${artifact.name} · ${(artifact.size / 1024).toFixed(1)} KiB`;
    const download = document.createElement('button'); download.textContent = copy('download'); download.dataset.online = '';
    download.onclick = () => run(async () => {
      const result = await call('download', { deviceId: selected, conversationId: id, artifactId: artifact.id, offset });
      if (!result.canceled && !transfers.has(result.id)) updateTransfer({ ...result, deviceId: selected, state: 'downloading', received: 0, total: result.size });
    });
    row.append(title, download); elements.artifacts.append(row);
  }
  artifactOffset = result.nextOffset; elements.moreArtifacts.hidden = artifactOffset == null; buttons();
}
function updateTransfer(event) {
  transfers.set(event.id, event);
  elements.transfers.replaceChildren();
  for (const [id, transfer] of transfers) {
    const row = document.createElement('div'); row.className = 'transfer';
    const label = document.createElement('span'); label.textContent = `${devices.find(device => device.id === transfer.deviceId)?.name || 'CLI'} · ${transfer.name} · ${copy(transfer.state)} ${transfer.total ? Math.floor((transfer.received || 0) * 100 / transfer.total) + '%' : ''}`;
    const button = document.createElement('button'); button.textContent = transfer.state === 'downloading' ? copy('cancel') : '×'; button.dataset.cancelTransfer = '';
    button.onclick = () => { if (transfer.state === 'downloading') void call('download-cancel', { id }).catch(error => { elements.error.textContent = error.message; }); else { transfers.delete(id); row.remove(); } };
    row.append(label, button); elements.transfers.append(row);
  }
}
function renderChat() {
  elements.chat.hidden = !snapshot; elements.empty.hidden = Boolean(snapshot);
  root.querySelector('[data-copy="emptyTitle"]').textContent = copy(online ? 'chooseChat' : 'emptyTitle');
  root.querySelector('[data-copy="emptyBody"]').textContent = copy(online ? 'chooseChatBody' : 'emptyBody');
  if (!snapshot) { messageCache.clear(); return; }
  elements.chatTitle.textContent = snapshot.conversation.title;
  elements.pin.textContent = copy(snapshot.conversation.pinned ? 'unpin' : 'pin');
  const fragment = document.createDocumentFragment(), used = new Set();
  const rows = [...olderMessages.filter(row => !snapshot.messages.some(message => message.seq === row.seq)), ...snapshot.messages];
  if (snapshot.live) rows.push({ role: 'assistant · live', text: snapshot.live.text, process: snapshot.live.process });
  for (const row of rows) {
    const key = `${selected}:${conversationId}:${row.seq ?? 'live'}`;
    const signature = JSON.stringify([language, row]);
    used.add(key);
    const cached = messageCache.get(key);
    if (cached?.signature === signature) { fragment.append(cached.article); continue; }
    const article = document.createElement('article'); article.className = 'message'; article.classList.toggle('user', row.role === 'user');
    const role = document.createElement('strong'); role.textContent = row.role;
    const text = document.createElement('div'); text.className = 'message-body';
    text.append(window.CamelliaMarkdown.render(document, row.text, { copyLabel: copy('copyCode'), wrapLabel: copy('wrapCode'), copiedLabel: copy('copied'), failedLabel: copy('copyFailed') }));
    article.append(role, text);
    if (row.attachedFiles?.length) {
      const files = document.createElement('p'); files.className = 'hint'; files.textContent = copy('attachments') + ': ' + row.attachedFiles.map(file => file.name).join(', '); article.append(files);
    }
    if (row.process?.length) {
      const details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('div');
      content.className = 'message-body'; summary.textContent = copy('process');
      content.append(window.CamelliaMarkdown.render(document, row.process.map(item => item.text || item.title || item.type).join('\n'), { copyLabel: copy('copyCode'), wrapLabel: copy('wrapCode') }));
      details.append(summary, content); article.append(details);
    }
    fragment.append(article); messageCache.set(key, { signature, article });
  }
  for (const key of messageCache.keys()) if (!used.has(key)) messageCache.delete(key);
  elements.messages.replaceChildren(fragment);
  elements.historyHint.textContent = snapshot.nextBefore !== null ? copy('history') : '';
  elements.older.hidden = (olderCursor === undefined ? snapshot.nextBefore : olderCursor) == null;
  elements.older.disabled = busy || !online;
  elements.approvals.replaceChildren();
  for (const approval of snapshot.live?.approvals || []) {
    const panel = document.createElement('section'); panel.className = 'approval';
    const title = document.createElement('strong'), detail = document.createElement('pre'); title.textContent = approval.toolName; detail.textContent = approval.details; panel.append(title, detail);
    for (const allow of [true, false]) {
      const button = document.createElement('button'); button.textContent = copy(allow ? 'allow' : 'deny'); button.dataset.write = '';
      button.onclick = () => run(() => command(conversationId, { action: 'approve', approvalId: approval.requestId, fingerprint: approval.fingerprint, allow, runId: snapshot.live.runId }));
      if (approval.actionable) panel.append(button);
    }
    elements.approvals.append(panel);
  }
  buttons();
}
async function refresh(append = false) {
  if (!selected) return;
  const deviceId = selected, revision = version;
  try {
    const result = await call('conversations', { deviceId, offset: append ? nextOffset : 0 });
    if (revision !== version) return;
    if (info && info.instanceId !== result.instanceId) { snapshot = null; olderMessages = []; olderCursor = undefined; }
    info = result; chats = append ? [...chats, ...result.conversations.filter(chat => !chats.some(existing => existing.id === chat.id))] : result.conversations;
    nextOffset = result.nextOffset ?? null;
    if (conversationId) {
      const result = await call('snapshot', { deviceId, conversationId });
      if (revision !== version) return;
      if (result.instanceId !== info.instanceId) throw new Error(copy('uncertain'));
      snapshot = result;
    }
    online = true; refreshedAt = new Date().toLocaleTimeString(); renderConnection();
    renderTree(); renderChat();
  } catch (error) { offline(); throw error; }
}
async function watch() { watchId = crypto.randomUUID(); await call('watch', { deviceId: selected, conversationId, watchId }); }
async function command(target, fields, attachmentIds = []) {
  if (!online || !info) throw new Error(copy('offline'));
  const deviceId = selected, revision = version;
  const payload = { ...fields, requestId: crypto.randomUUID(), instanceId: info.instanceId };
  let result;
  try { result = await call('command', { deviceId, conversationId: target, command: payload, ...(attachmentIds.length ? { attachmentIds } : {}) }); }
  catch (error) { offline(); throw new Error(`${error.message} · ${copy('uncertain')}`); }
  if (revision !== version) throw new Error(copy('uncertain'));
  if (!result.ok) {
    if (result.state === 'pending' || result.state === 'unknown') { offline(); throw new Error(copy('uncertain')); }
    throw new Error(result.error || copy('uncertain'));
  }
  if (fields.action === 'create') { conversationId = result.conversation.id; olderMessages = []; olderCursor = undefined; }
  if (['archive', 'delete', 'create'].includes(fields.action)) { await clearAttachments(); clearArtifacts(); }
  if (['archive', 'restore', 'delete'].includes(fields.action)) clearArchived();
  if (['archive', 'delete'].includes(fields.action)) { conversationId = null; snapshot = null; olderMessages = []; olderCursor = undefined; selectedChats.clear(); }
  await refresh(); await watch();
  return result;
}
function showDialog(title, hint, fields, action, prepared = false) {
  if (busy && !prepared) return;
  elements.dialogTitle.textContent = title; elements.dialogHint.textContent = hint; elements.dialogError.textContent = ''; elements.fields.replaceChildren();
  const revision = version;
  for (const field of fields) {
    const label = document.createElement('label'); label.textContent = copy(field.key); label.htmlFor = `field-${field.key}`;
    const input = document.createElement(field.options ? 'select' : 'input'); input.id = label.htmlFor; input.name = field.key; input.required = !field.optional;
    if (field.options) input.append(...field.options.map(option => new Option(option.name, option.id ?? '')));
    else { input.type = field.secret ? 'password' : 'text'; input.maxLength = field.key === 'path' ? 1024 : 200; input.autocomplete = 'off'; }
    if (field.value !== undefined) input.value = field.value;
    elements.fields.append(label, input);
  }
  dialogAction = async () => { if (revision !== version) throw new Error(copy('uncertain')); await action(Object.fromEntries(new FormData(elements.dialogForm))); };
  elements.submit.textContent = copy('confirm'); elements.dialog.showModal();
}
elements.dialogForm.onsubmit = event => { event.preventDefault(); void run(async () => {
  try { await dialogAction(); elements.dialog.close(); }
  catch (error) { elements.dialogError.textContent = error.message; throw error; }
}); };
elements.cancel.onclick = () => elements.dialog.close();
elements.device.onchange = () => run(async () => {
  await clearAttachments(); clearArtifacts(); clearArchived(); selectedChats.clear();
  version++; selected = elements.device.value; conversationId = null; olderMessages = []; olderCursor = undefined; snapshot = null; info = null; chats = []; nextOffset = null; elements.prompt.value = ''; elements.notice.textContent = ''; offline();
  elements.targetName.textContent = currentDevice()?.name || copy('choose'); renderTree(); renderChat(); await call('unwatch');
  if (selected) { await refresh(); await watch(); }
});
elements.refresh.onclick = () => run(async () => { await state(); if (selected) { await refresh(); await watch(); } });
elements.networkRefresh.onclick = () => run(state);
elements.networkStart.onclick = () => run(async () => {
  await call('network-start'); await state();
  elements.networkPanel.open = true;
  elements.notice.textContent = networkState === 'Running' ? copy('networkReadyHint') : copy('networkLoginHint');
});
elements.openLogin.onclick = () => run(() => call('open-login'));
elements.add.onclick = () => {
  if (pendingPair) {
    showDialog(copy('check'), copy('pending'), [], async () => { const result = await call('claim', { id: pendingPair }); if (result.state !== 'approved') throw new Error(copy('pending')); pendingPair = null; await state(); });
    return;
  }
  if (networkState !== 'Running') {
    elements.networkPanel.open = true;
    elements.error.textContent = copy('networkFirst');
    return;
  }
  showDialog(copy('add'), copy('boundary'), [{ key: 'deviceName' }, { key: 'address', value: 'http://100.' }, { key: 'clientName', value: 'Camellia desktop' }, { key: 'code', secret: true }], async values => {
    let result;
    try { result = await call('pair', values); } catch (error) { throw new Error(embeddedNetworkError(error)); }
    pendingPair = result.id; elements.notice.textContent = copy('pending'); elements.cancelPair.hidden = false; elements.add.textContent = copy('check');
  });
};
elements.cancelPair.onclick = () => run(async () => { await call('cancel-pair', { id: pendingPair }); pendingPair = null; elements.notice.textContent = ''; await state(); });
elements.forget.onclick = () => showDialog(`${copy('forget')} · ${currentDevice().name}`, copy('forgetHint'), [], async () => { await clearAttachments(); clearArtifacts(); clearArchived(); selectedChats.clear(); await call('forget', { id: selected }); version++; selected = ''; info = snapshot = null; chats = []; conversationId = null; olderMessages = []; olderCursor = undefined; offline(); await state(); renderTree(); renderChat(); elements.targetName.textContent = copy('choose'); });
elements.newWorkspace.onclick = () => showDialog(`${copy('newWorkspace')} · ${currentDevice().name}`, copy('boundary'), [{ key: 'name' }, { key: 'path' }], values => command(null, { action: 'create-workspace', ...values }));
function nativeDocument() {
  if (nativeDocumentId) nativeDrafts.set(nativeDocumentId, elements.nativeText.value);
  const doc = nativeView?.files.find(file => file.id === elements.nativeDocument.value);
  nativeDocumentId = doc?.id || null;
  elements.nativeText.value = doc ? nativeDrafts.get(doc.id) ?? doc.text : ''; elements.nativeFormat.textContent = doc?.format?.toUpperCase() || '';
  elements.nativeConfirm.checked = false; elements.nativeError.textContent = '';
}
elements.nativeSettings.onclick = () => showDialog(`${copy('nativeSettings')} · ${currentDevice().name}`, copy('nativeWarning'), [{ key: 'engine', options: info.engines.map(id => ({ id, name: id })) }], async values => {
  const revision = version, deviceId = selected;
  const result = await call('native-settings-get', { deviceId, engine: values.engine });
  if (revision !== version) throw new Error(copy('uncertain'));
  nativeView = result; nativeTarget = deviceId; nativeRevision = revision; nativeDocumentId = null; nativeDrafts.clear();
  elements.nativeTitle.textContent = `${copy('nativeSettings')} · ${currentDevice().name} · ${result.engine}`;
  elements.nativeWarning.textContent = copy('nativeWarning');
  elements.nativeDocument.replaceChildren(...result.files.map(file => new Option(file.label, file.id)));
  nativeDocument(); elements.nativeDialog.showModal();
});
elements.nativeDocument.onchange = nativeDocument;
elements.nativeCancel.onclick = () => elements.nativeDialog.close();
elements.nativeDialog.addEventListener('close', () => { elements.nativeText.value = ''; nativeView = null; nativeTarget = null; nativeDocumentId = null; nativeDrafts.clear(); });
elements.nativeForm.onsubmit = event => { event.preventDefault(); void run(async () => {
  try {
    if (!online || selected !== nativeTarget || version !== nativeRevision || !elements.nativeConfirm.checked) throw new Error(copy('uncertain'));
    const doc = nativeView.files.find(file => file.id === elements.nativeDocument.value);
    const result = await call('native-settings-save', { deviceId: nativeTarget, settings: { engine: nativeView.engine, id: doc.id, text: elements.nativeText.value, revision: doc.revision, confirmed: true } });
    if (!result.ok) throw new Error(copy('uncertain'));
    elements.notice.textContent = copy('nativeSaved'); elements.nativeDialog.close(); await refresh();
  } catch (error) { elements.nativeError.textContent = error.message; throw error; }
}); };
elements.messages.addEventListener('click', event => {
  const link = event.target.closest('a[data-remote-link]');
  if (!link) return;
  event.preventDefault();
  const url = link.dataset.remoteLink;
  showDialog(copy('openLink'), `${copy('openLinkWarning')}\n${url}`, [], () => call('open-output-link', { url }));
});
elements.importApi.onclick = () => run(async () => {
  const deviceId = selected, revision = version;
  const preview = await call('import-preview', { deviceId });
  if (revision !== version) { await call('import-cancel', { id: preview.id }); return; }
  const format = (key, data) => copy(key).replace(/\{(\w+)\}/g, (_match, name) => String(data[name] ?? ''));
  const cancel = () => { void call('import-cancel', { id: preview.id }).catch(() => {}); };
  elements.dialog.addEventListener('close', cancel, { once: true });
  showDialog(`${copy('importApi')} · ${currentDevice().name}`, format('importHint', preview), [], async () => {
    let result;
    try { result = await call('import-apply', { deviceId, id: preview.id }); }
    catch (error) { throw new Error(`${error.message} · ${copy('importUnknown')}`); }
    if (!result.ok) throw new Error(copy(result.state === 'failed' ? 'importFailed' : 'importUnknown'));
    elements.notice.textContent = format('importDone', result) + (result.enabled === false ? ` ${copy('importDisabled')}` : '');
    await refresh();
  }, true);
});
elements.newChat.onclick = () => {
  if (!info?.engines?.length) { elements.error.textContent = copy('noEngine'); return; }
  showDialog(`${copy('newChat')} · ${currentDevice().name}`, copy('boundary'), [{ key: 'workspace', optional: true, options: [{ id: '', name: copy('independent') }, ...info.workspaces] }, { key: 'engine', options: info.engines.map(engine => ({ id: engine, name: engine })) }], values => command(null, { action: 'create', workspaceId: values.workspace || null, engine: values.engine }));
};
elements.composer.onsubmit = event => { event.preventDefault(); void run(async () => { const text = elements.prompt.value; await command(conversationId, { action: 'send', prompt: text, expectedSeq: snapshot.conversation.seq }, attachments.map(file => file.id)); attachments = []; renderAttachments(); elements.prompt.value = ''; }); };
elements.attach.onclick = () => run(async () => {
  const revision = version, id = conversationId;
  const result = await call('attachments-select', { deviceId: selected, conversationId });
  if (revision !== version || id !== conversationId || !online) { await call('attachments-remove', { ids: result.files.map(file => file.id) }); return; }
  const combined = [...attachments, ...result.files];
  if (combined.length > 9 || combined.reduce((total, file) => total + file.size, 0) > 8 * 1024 * 1024) {
    await call('attachments-remove', { ids: result.files.map(file => file.id) }); throw new Error(copy('attachmentLimit'));
  }
  attachments = combined; renderAttachments();
});
elements.loadArtifacts.onclick = () => run(() => loadArtifacts());
elements.moreArtifacts.onclick = () => run(() => loadArtifacts(true));
elements.loadArchived.onclick = () => run(() => loadArchived());
elements.moreArchived.onclick = () => run(() => loadArchived(true));
elements.selectChats.onclick = () => { selecting = !selecting; selectedChats.clear(); elements.deleteSelected.hidden = !selecting; renderTree(); };
elements.deleteSelected.onclick = () => {
  const targets = chats.filter(chat => selectedChats.has(chat.id)).map(chat => ({ id: chat.id, seq: chat.seq }));
  if (!targets.length) return;
  showDialog(`${copy('delete')} (${targets.length}) · ${currentDevice().name}`, copy('deleteHint') + '\n' + chats.filter(chat => selectedChats.has(chat.id)).map(chat => chat.title).join('\n'), [], () => command(null, { action: 'delete', targets }));
};
elements.stop.onclick = () => run(() => command(conversationId, { action: 'stop', runId: snapshot.live.runId }));
elements.rename.onclick = () => showDialog(`${copy('rename')} · ${currentDevice().name}`, snapshot.conversation.title, [{ key: 'name', value: snapshot.conversation.title }], values => command(null, { action: 'rename', targets: [{ id: conversationId, seq: snapshot.conversation.seq }], title: values.name }));
elements.pin.onclick = () => run(() => command(null, { action: 'pin', targets: [{ id: conversationId, seq: snapshot.conversation.seq }], pinned: !snapshot.conversation.pinned }));
elements.archive.onclick = () => showDialog(`${copy('archive')} · ${currentDevice().name}`, snapshot.conversation.title, [], () => command(null, { action: 'archive', conversationId, expectedSeq: snapshot.conversation.seq }));
elements.deleteChat.onclick = () => showDialog(`${copy('delete')} · ${currentDevice().name} · ${snapshot.conversation.title}`, copy('deleteHint'), [], () => command(null, { action: 'delete', targets: [{ id: conversationId, seq: snapshot.conversation.seq }] }));
elements.configure.onclick = () => {
  const settings = snapshot.settings;
  if (!settings.models.length) { elements.error.textContent = copy('noModels'); return; }
  const expectedSettings = settings.version;
  const selectedModel = settings.models.find(model => model.id === settings.model);
  const fields = [{ key: 'model', options: settings.models, value: settings.model }, { key: 'permission', options: settings.permissionLevels.map(id => ({ id, name: copy(id) })), value: settings.permissionMode }];
  fields.push({ key: 'thinking', optional: true, options: [{ id: '', name: copy('default') }, ...(selectedModel?.thinking || []).map(id => ({ id, name: id }))], value: settings.thinking || '' });
  showDialog(`${copy('configure')} · ${currentDevice().name}`, snapshot.conversation.title, fields, values => command(conversationId, { action: 'configure', expectedSettings,
    settings: { model: values.model, permissionMode: values.permission, thinking: values.thinking } }));
  elements.fields.querySelector('[name="model"]').onchange = event => {
    const model = settings.models.find(model => model.id === event.target.value);
    const input = elements.fields.querySelector('[name="thinking"]');
    input.replaceChildren(new Option(copy('default'), ''), ...(model?.thinking || []).map(id => new Option(id, id)));
  };
};
elements.more.onclick = () => run(() => refresh(true));
elements.older.onclick = () => run(async () => {
  if (!online || !snapshot) return;
  const revision = version, id = conversationId;
  const before = olderCursor === undefined ? snapshot.nextBefore : olderCursor;
  if (before == null) return;
  const result = await call('snapshot', { deviceId: selected, conversationId: id, before });
  if (revision !== version || id !== conversationId || result.instanceId !== info.instanceId) throw new Error(copy('uncertain'));
  olderMessages = [...result.messages, ...olderMessages.filter(row => !result.messages.some(message => message.seq === row.seq))];
  olderCursor = result.nextBefore; renderChat();
});
function queueRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!selected || !online) return;
    if (busy || elements.dialog.open || elements.nativeDialog.open) { queueRefresh(); return; }
    void run(() => refresh());
  }, 350);
}
bridge.onEvent(event => {
  if (event.deviceId && (event.deviceId !== selected || event.watchId !== watchId)) return;
  if (event.type === 'offline') { offline(); return; }
  queueRefresh();
});
bridge.onTransfer(updateTransfer);
window.addEventListener('beforeunload', () => { clearTimeout(refreshTimer); });
let started = false;
function start() {
  if (started) { if (!busy && !elements.dialog.open && !elements.nativeDialog.open) void run(async () => { await state(); if (selected) { await refresh(); await watch(); } }); return; }
  started = true;
  void run(state);
}
if (embedded) window.cliDevicesUI = {
  setVisible(value) { if (value) start(); },
  refresh() { if (!busy) void run(async () => { await state(); if (selected) { await refresh(); await watch(); } }); },
};
else start();
})();
