'use strict';

const { createInterface } = require('node:readline');
const { requestControl } = require('./local-control');
const { CAT, fit } = require('./settings-preview');

const COPY = {
  en: {
    title: 'Live server settings', live: 'Live data from this server. Changes apply immediately after confirmation.',
    quitHint: 'q: close settings (the server keeps running)', choose: 'Choose', cancel: 'Enter to cancel',
    yes: 'Type YES to confirm', cancelled: 'Cancelled. No changes sent.', done: 'Done.', failed: 'Operation failed',
    network: 'Network & Devices', api: 'Providers & Keys', workspaces: 'Workspaces & Conversations', general: 'General', diagnostics: 'Diagnostics & About',
    refresh: 'Refresh status', start: 'Start networking / sign in', login: 'Request login link', stop: 'Disable remote networking', logout: 'Sign out of Tailscale',
    invite: 'Generate pairing invitation', approve: 'Approve a pending GUI', reject: 'Reject a pending GUI', revoke: 'Revoke an authorized GUI',
    pending: 'Pending requests', trusted: 'Authorized devices', empty: 'None', back: 'Back',
    fullControl: 'Grants full control of all current and future workspaces and independent conversations, including API settings. A name is not proof of identity. Only approve your own request.',
    revokeHint: 'Immediately disconnect this client. Conversations and running engines remain on this server.',
    stopHint: 'Disconnect all remote clients. This does not stop the service or running engines.',
    logoutHint: 'Sign out of Tailscale and disconnect clients. A new network sign-in will be required.',
    invitationHint: 'Single-use code, expires in five minutes. Enter it in GUI > CLI devices, then approve the request here. Do not share terminal logs.',
    route: 'API routing', enabled: 'enabled', disabled: 'disabled', providers: 'Providers', keys: 'Keys (hidden)',
    importHint: 'In the paired desktop, choose Import local API settings. Subscription credentials are never copied.',
    subscriptions: 'Subscription identity stays on this server. Use Engines & Accounts for sign-in and runtime installation.',
    enable: 'Enable API routing', disable: 'Disable API routing', model: 'Default model', selectModel: 'Choose a configured default model',
    routingHint: 'Changes routing for this server only. No request is sent. Active work must be stopped first.',
    modelHint: 'Applies to new conversations only; existing conversations keep their settings. Permission defaults to Ask.',
    createWorkspace: 'Add an existing server folder', removeWorkspace: 'Remove a workspace record', createChat: 'Create a conversation',
    name: 'Workspace name', path: 'Absolute existing server folder', independent: 'Independent conversation',
    removeHint: 'Remove only the workspace record. Keep project files and conversation working directories. Conversations become independent.',
    language: 'Language', directory: 'Data directory', engines: 'Available engines', conversations: 'Conversations', busy: 'Active work',
    limitations: 'Five API engines and server-local subscription entry points are wired. Real provider and tailnet acceptance is still required.',
    sensitive: 'Network keys use private local files; copying the entire data directory can expose the identity.',
    noService: 'Cannot read server settings. Start serve first in another terminal, using the same --data-dir.',
  },
  'zh-CN': {
    title: '服务器实时设置', live: '当前服务器的真实数据；确认后才发送更改。', quitHint: 'q：退出设置（后台服务继续运行）', choose: '选择', cancel: '直接回车取消',
    yes: '输入 YES 确认', cancelled: '已取消，未发送更改。', done: '完成。', failed: '操作失败',
    network: '网络与设备', api: '服务商与密钥', workspaces: '工作区与会话', general: '通用', diagnostics: '诊断与关于',
    refresh: '刷新状态', start: '启动网络 / 登录', login: '获取登录链接', stop: '关闭远程网络', logout: '退出 Tailscale 账号',
    invite: '生成配对邀请', approve: '批准待配对 GUI', reject: '拒绝待配对 GUI', revoke: '撤销已授权 GUI',
    pending: '待审批请求', trusted: '已授权设备', empty: '暂无', back: '返回',
    fullControl: '授予全部现有及未来工作区、独立会话和 API 设置的控制权限。名称不是身份证明，仅批准自己刚发起的请求。',
    revokeHint: '立即断开该客户端。服务器会话和运行中的引擎保留。',
    stopHint: '断开所有远程客户端，不停止服务器服务或引擎。', logoutHint: '退出 Tailscale 并断开客户端，之后需要重新登录网络。',
    invitationHint: '配对码仅用一次，五分钟有效。在 GUI > CLI devices 输入，再回到此处批准。不要分享含配对码的终端日志。',
    route: 'API 路由', enabled: '已启用', disabled: '未启用', providers: '服务商', keys: '密钥（不显示内容）',
    importHint: '在已配对 GUI 中选择“导入本机 API 设置”。订阅凭据不会复制。',
    subscriptions: '订阅身份保存在这台服务器。通过“引擎与账号”安装运行时、登录和选择连接。',
    enable: '启用 API 路由', disable: '停用 API 路由', model: '默认模型', selectModel: '选择已配置的默认模型',
    routingHint: '只更改本服务器路由状态，不发送模型请求。必须先停止正在进行的工作。',
    modelHint: '仅影响新会话；已有会话保留设置，默认权限为询问。',
    createWorkspace: '添加服务器已有目录', removeWorkspace: '移除工作区记录', createChat: '新建会话',
    name: '工作区名称', path: '服务器已有目录的绝对路径', independent: '独立会话',
    removeHint: '只移除记录，保留项目文件和原会话工作目录；会话变为独立会话。',
    language: '语言', directory: '数据目录', engines: '可用引擎', conversations: '会话数量', busy: '正在进行的工作',
    limitations: '五种 API 引擎与服务器本地订阅登录入口已接入，仍需真实供应商和 tailnet 验收。',
    sensitive: '网络密钥使用受权限保护的本地文件；复制整个数据目录可能暴露网络身份。',
    noService: '无法读取服务器设置。请在另一终端启动 serve，并使用同一个 --data-dir。',
  },
};
COPY.en.nativeSettings = 'Edit native configuration';
COPY['zh-CN'].nativeSettings = '编辑原生配置';
Object.assign(COPY.en, { accounts: 'Engines & Accounts', install: 'Install selected runtime', accountState: 'Account status / login progress', accountRefresh: 'Refresh account models', accountLogin: 'Start account login', accountCancel: 'Cancel login', accountLogout: 'Sign out', connection: 'Set connection and default model', connectionPrompt: 'Connection (api/subscription)', modelPrompt: 'Model ID (from configured API routes or your subscription)', accountWarning: 'Changes only the selected server account or runtime; never copies desktop subscription credentials. Downloads/login may contact the provider.', nativeHint: 'From another SSH terminal run: node scripts/camellia-server.cjs native-login --payload', installing: 'Installation started. Reopen this page to check status.' });
Object.assign(COPY['zh-CN'], { accounts: '引擎与账号', install: '安装选中运行时', accountState: '账号状态 / 登录进度', accountRefresh: '刷新账号模型', accountLogin: '启动账号登录', accountCancel: '取消登录', accountLogout: '退出账号', connection: '设置连接与默认模型', connectionPrompt: '连接类型（api/subscription）', modelPrompt: '模型 ID（来自 API 配置或本人订阅）', accountWarning: '只更改当前服务器的账号或运行时，不复制桌面订阅凭据。下载/登录可能连接供应商。', nativeHint: '在另一 SSH 终端执行：node scripts/camellia-server.cjs native-login --payload', installing: '已启动安装，重新进入此页查看进度。' });

function terminalText(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

function header({ columns = 80, color = false, ascii = false, language = 'zh-CN' } = {}) {
  const copy = COPY[language] || COPY['zh-CN'];
  const lines = ascii ? ['Camellia / Server CLI', copy.title] : CAT.map((line, index) => line + (index === 0 ? '   Camellia' : index === 1 ? '   Server CLI' : index === 3 ? `   ${copy.title}` : ''));
  const rendered = lines.map(line => fit(line, Math.max(20, columns))).join('\n');
  return color ? `\x1b[38;2;103;158;254m${rendered}\x1b[0m` : rendered;
}

async function settingsSession({ request, ask, write, columns = 80, color = false, ascii = false, language }) {
  let state, selectedLanguage = language || 'zh-CN';
  const text = key => COPY[selectedLanguage][key];
  const out = value => write(terminalText(value) + '\n');
  const question = async prompt => {
    const value = await ask(`${terminalText(prompt)} > `);
    if (value === null) throw Object.assign(new Error('Console closed'), { code: 'CONSOLE_CLOSED' });
    return value.trim();
  };
  const call = async (action, payload = {}) => {
    const reply = await request(action, payload);
    if (!reply?.ok) throw new Error(reply?.error || text('failed'));
    return reply.result;
  };
  const refresh = async () => {
    state = await call('settings');
    selectedLanguage = language || (state.language === 'en' ? 'en' : 'zh-CN');
  };
  const confirm = async description => {
    out(description);
    return (await question(text('yes'))) === 'YES';
  };
  const choose = async (items, label = text('choose')) => {
    if (!items.length) { out(text('empty')); return null; }
    items.forEach((item, index) => out(`${index + 1}. ${item.name}`));
    const value = await question(`${label} (${text('cancel')})`);
    if (!/^[1-9]\d*$/.test(value)) return null;
    return items[Number(value) - 1] || null;
  };
  const network = async () => {
    await refresh();
    out(`Tailscale: ${state.network.state}  ${state.address || ''}`);
    if (state.network.loginUrl) out(state.network.loginUrl);
    for (const [label, entries] of [[text('pending'), state.pending], [text('trusted'), state.devices]]) {
      out(label + ':'); entries.forEach(entry => out(`  ${entry.name} [${entry.id}]`)); if (!entries.length) out(text('empty'));
    }
    const action = await choose(['refresh', 'start', 'login', 'invite', 'approve', 'reject', 'revoke', 'stop', 'logout'].map(id => ({ id, name: text(id) })));
    if (!action) return;
    if (action.id === 'refresh') return;
    if (['approve', 'reject', 'revoke'].includes(action.id)) {
      const entry = await choose(action.id === 'revoke' ? state.devices : state.pending);
      if (!entry) return;
      const warning = action.id === 'approve' ? text('fullControl') : action.id === 'revoke' ? text('revokeHint') : text('reject');
      if (!await confirm(`${entry.name} [${entry.id}]\n${warning}`)) { out(text('cancelled')); return; }
      await call(action.id, { id: entry.id }); out(text('done')); return;
    }
    if (action.id === 'stop' || action.id === 'logout') {
      if (!await confirm(text(action.id === 'stop' ? 'stopHint' : 'logoutHint'))) { out(text('cancelled')); return; }
    }
    if (action.id === 'invite' && !await confirm(text('fullControl'))) { out(text('cancelled')); return; }
    const result = await call(action.id);
    if (action.id === 'invite') {
      out(text('invitationHint')); out(`${result.address}  ${result.code}`); out(new Date(result.expiresAt).toISOString());
    } else { out(text('done')); await refresh(); out(`Tailscale: ${state.network.state}`); if (state.network.loginUrl) out(state.network.loginUrl); }
  };
  const api = async () => {
    await refresh();
    out(`${text('route')}: ${text(state.api.enabled ? 'enabled' : 'disabled')} | ${text('providers')}: ${state.api.providers} | ${text('keys')}: ${state.api.keys}`);
    out(text('importHint')); out(text('subscriptions'));
    for (const engine of state.engines) out(`${engine.id} / ${text('model')}: ${engine.model || '—'} / ${engine.permissionMode}`);
    const action = await choose([{ id: 'toggle', name: text(state.api.enabled ? 'disable' : 'enable') }, { id: 'model', name: text('selectModel') }]);
    if (!action) return;
    if (action.id === 'toggle') {
      if (!await confirm(`${action.name}. ${text('routingHint')}`)) { out(text('cancelled')); return; }
      await call('set-api-enabled', { enabled: !state.api.enabled });
    } else {
      const engine = await choose(state.engines.map(entry => ({ ...entry, name: entry.id })));
      if (!engine) return;
      const model = await choose(state.api.models.map(id => ({ id, name: id })));
      if (!model || !await confirm(`${engine.id}: ${model.name}. ${text('modelHint')}`)) { out(text('cancelled')); return; }
      await call('set-model', { engine: engine.id, model: model.id });
    }
    out(text('done'));
  };
  const workspaces = async () => {
    const entries = await call('workspaces');
    entries.forEach(entry => out(`${entry.name} [${entry.id}] ${entry.path}`));
    const conversations = await call('conversations');
    out(`${text('conversations')}: ${conversations.length}`);
    for (const entry of conversations) out(`  ${entry.title} | ${entry.workspaceName || text('independent')} | ${entry.engine}`);
    const action = await choose(['createWorkspace', 'removeWorkspace', 'createChat'].map(id => ({ id, name: text(id) })));
    if (!action) return;
    if (action.id === 'createWorkspace') {
      const name = await question(text('name')); if (!name) return;
      const path = await question(text('path')); if (!path) return;
      if (!await confirm(`${text('createWorkspace')}: ${name} / ${path}`)) { out(text('cancelled')); return; }
      await call('create-workspace', { name, path });
    } else if (action.id === 'removeWorkspace') {
      const entry = await choose(entries);
      if (!entry || !await confirm(`${entry.name} [${entry.id}] ${entry.path}\n${text('removeHint')}`)) { out(text('cancelled')); return; }
      await call('delete-workspace', { id: entry.id });
    } else {
      const entry = await choose([{ id: null, name: text('independent') }, ...entries]);
      if (!entry) return;
      const engine = await choose(state.engines.map(engine => ({ id: engine.id, name: engine.id })));
      if (!engine || !await confirm(`${text('createChat')}: ${entry.name} / ${engine.name}`)) { out(text('cancelled')); return; }
      await call('create-conversation', { engine: engine.id, workspaceId: entry.id });
    }
    out(text('done'));
  };
  const accounts = async () => {
    const runtimes = await call('runtime-state');
    for (const runtime of runtimes) out(`${runtime.id}: ${runtime.operation || runtime.status} ${runtime.version || ''} ${runtime.error || ''}`);
    const engine = await choose(state.engines.map(entry => ({ id: entry.id, name: entry.id })));
    if (!engine) return;
    const actions = ['install', 'accountState', 'accountRefresh', 'accountLogin', 'accountCancel', 'accountLogout', 'connection', 'nativeSettings'];
    const action = await choose(actions.map(id => ({ id, name: text(id) })));
    if (!action) return;
    if (action.id === 'nativeSettings') {
      const view = await call('native-settings-get', { engine: engine.id });
      const document = await choose(view.files.map(file => ({ id: file.id, name: `${file.label} (${file.format})` })));
      if (document) out(`node scripts/camellia-server.cjs native-edit --payload '${JSON.stringify({ engine: engine.id, id: document.id })}' --data-dir '${state.dataDir.replace(/'/g, "'\\''")}'`);
      return;
    }
    if (action.id === 'install') {
      let connection = 'api';
      if (engine.id === 'antigravity') { connection = await question(text('connectionPrompt')); if (!['api', 'subscription'].includes(connection)) return; }
      if (!await confirm(`${engine.id}: ${text('accountWarning')}`)) return;
      await call('runtime-install', { engine: engine.id, connection }); out(text('installing')); return;
    }
    if (action.id === 'connection') {
      const connection = await question(text('connectionPrompt'));
      if (!['api', 'subscription'].includes(connection)) return;
      const model = await question(text('modelPrompt')); if (!model) return;
      if (!await confirm(`${engine.id} / ${connection} / ${model}. ${text('modelHint')}`)) return;
      await call('engine-settings', { engine: engine.id, connection, model }); out(text('done')); return;
    }
    if ((action.id === 'accountLogin' && ['claude', 'codex', 'antigravity'].includes(engine.id)) || engine.id === 'claude' || engine.id === 'antigravity' && action.id === 'accountLogout') {
      const nativeAction = engine.id === 'antigravity' ? 'login' : action.id === 'accountLogout' ? 'logout' : ['accountState', 'accountRefresh'].includes(action.id) ? 'status' : 'login';
      out(`${text('nativeHint')} '${JSON.stringify({ engine: engine.id, action: nativeAction })}' --data-dir '${state.dataDir.replace(/'/g, "'\\''")}'`);
      return;
    }
    const operation = { accountState: 'state', accountRefresh: 'refresh', accountLogin: 'login', accountCancel: 'cancel', accountLogout: 'logout' }[action.id];
    if (!['state', 'refresh'].includes(operation) && !await confirm(`${engine.id}: ${text('accountWarning')}`)) return;
    const result = await call('account', { engine: engine.id, action: operation });
    out(`${engine.id} | signedIn: ${result.signedIn} | loginPending: ${result.loginPending}`);
    if (result.loginUrl) out(result.loginUrl);
    if (result.login) { out(result.login.verificationUrl || ''); out(result.login.userCode || ''); }
    for (const model of result.models || []) out(`${model.id} / ${model.name}`);
  };
  try {
    try { await refresh(); }
    catch (error) { out(text('noService')); throw error; }
    for (;;) {
      write('\n' + header({ columns, color, ascii, language: selectedLanguage }) + '\n');
      out(text('live')); out(`${state.hostname || 'Camellia server'} | ${state.dataDir}`); out(text('quitHint'));
      const pages = ['network', 'api', 'workspaces', 'general', 'diagnostics', 'accounts'];
      pages.forEach((key, index) => out(`${index + 1}. ${text(key)}`));
      const value = await question(text('choose'));
      if (['q', 'quit', 'exit'].includes(value.toLowerCase())) return;
      try {
        if (value === '1') await network();
        else if (value === '2') await api();
        else if (value === '3') await workspaces();
        else if (value === '4') {
          const entry = await choose([{ id: 'zh-CN', name: '简体中文' }, { id: 'en', name: 'English' }], text('language'));
          if (entry) { await call('set-language', { language: entry.id }); language = undefined; }
        } else if (value === '6') await accounts();
        else if (value === '5') {
          await refresh(); out(`${text('directory')}: ${state.dataDir}`); out(`Tailscale: ${state.network.state}`);
          out(`${text('engines')}: ${state.engines.map(engine => engine.id).join(', ')}`);
          out(`${text('conversations')}: ${state.conversationCount} / ${text('busy')}: ${state.busy}`);
          out(text('limitations')); out(text('sensitive'));
        }
        await refresh();
      } catch (error) {
        if (error.code === 'CONSOLE_CLOSED') throw error;
        out(`${text('failed')}: ${error.message}`);
      }
    }
  } catch (error) { if (error.code !== 'CONSOLE_CLOSED') throw error; }
}

async function runSettings({ dataDir, language, ascii = false, input = process.stdin, output = process.stdout }) {
  if (!input.isTTY || !output.isTTY) throw new Error('Live settings requires an interactive terminal; use state/settings JSON commands for automation');
  const readline = createInterface({ input, output, terminal: true, historySize: 0 });
  let closed = false, resolveQuestion;
  const close = () => { closed = true; resolveQuestion?.(null); resolveQuestion = null; };
  readline.on('close', close);
  readline.on('SIGINT', () => readline.close());
  try {
    await settingsSession({ request: (action, payload) => requestControl(dataDir, action, payload),
      ask: prompt => closed ? Promise.resolve(null) : new Promise(resolve => {
        resolveQuestion = resolve;
        readline.question(prompt, answer => { resolveQuestion = null; resolve(answer); });
      }),
      write: value => output.write(value), columns: output.columns || 80, language, ascii: ascii || process.env.TERM === 'dumb',
      color: !Object.hasOwn(process.env, 'NO_COLOR') && process.env.TERM !== 'dumb' });
  } finally { readline.close(); }
}

module.exports = { runSettings, settingsSession, terminalText, header };
