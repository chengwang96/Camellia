'use strict';

const PALETTE = { accent: '#679efe', muted: '#adb2b8', text: '#cfd3d6', danger: '#f25a5a' };
const CAT = ['⠀⢀⣴⣆', '⠀⠈⢙⣿⣄', '⠀⠀⢾⣿⣿⣷⣦⡀', '⢀⡀⠈⡟⣿⣿⣿⡇', '⠘⠢⢴⣃⣛⡿⠿⠃'];
const ASCII_CAT = ['   /\\', '  /  |_ ', '  \\   \\', '   |    )', '  (____/'];
const pair = (zh, en) => ({ zh, en });
const row = (label, value) => ({ label, value });
const action = (id, label, title, lines, danger = false) => ({ id, label, title, lines, danger });

const PAGES = [
  {
    id: 'providers', title: pair('服务商与密钥', 'Providers & Keys'),
    subtitle: pair('API 设置可以导入；订阅身份只保存在这台服务器。', 'Import API routes; subscription identities stay on this server.'),
    rows: [row(pair('API 路由', 'API routes'), pair('3 个服务商 / 7 个密钥（演示）', '3 providers / 7 keys (demo)')),
      row(pair('密钥显示', 'Key display'), pair('始终隐藏，不写入日志', 'Hidden; never written to logs')),
      row(pair('订阅账号', 'Subscription accounts'), pair('尚未登录（演示）', 'Not signed in (demo)'))],
    actions: [
      action('import', pair('预览：从桌面导入 API 设置', 'Preview: import desktop API settings'), pair('导入到 gpu-lab-01', 'Import into gpu-lab-01'), [
        pair('在已配对的 GUI 中点击「导入本机 API 设置」。', 'Choose "Import local API settings" in the paired desktop GUI.'),
        pair('确认页显示来源设备、目标设备、服务商与密钥数量。', 'Review source, destination, provider count and key count.'),
        pair('默认合并：新增缺失项，冲突项保留服务器设置。', 'Merge by default: add missing entries, keep server conflicts.'),
        pair('覆盖冲突项须单独确认；失败时整体回滚。', 'Replacing conflicts needs confirmation; failures roll back.'),
        pair('只导入服务商、端点、模型映射和 API 密钥。', 'Import only providers, endpoints, model mappings and API keys.'),
        pair('不导入订阅 token、Cookie、会话、监听端口或用量。', 'Never import subscription tokens, cookies, chats, ports or usage.'),
        pair('此处仅展示流程，没有读取或传输任何密钥。', 'This preview does not read or transfer any keys.'),
      ]),
      action('auth', pair('预览：在服务器登录订阅', 'Preview: server subscription sign-in'), pair('订阅登录留在服务器', 'Sign in on the server'), [
        pair('通过 SSH 打开这台服务器的 Camellia 账号菜单。', 'Open the Camellia account menu on this server over SSH.'),
        pair('选择引擎，再进入该引擎支持的原生登录流程。', 'Choose an engine and use its supported native login flow.'),
        pair('支持设备码的引擎显示网址和设备码；其他引擎给出指引。', 'Show a device code when supported; otherwise explain the flow.'),
        pair('浏览器可在别处打开，但登录凭据仅写入服务器。', 'The browser may be elsewhere; credentials stay on the server.'),
        pair('GUI 只能查看登录状态，不能导入桌面的订阅凭据。', 'The GUI can view status, not import desktop subscription credentials.'),
      ]),
    ],
  },
  {
    id: 'usage', title: pair('用量', 'Usage'),
    subtitle: pair('仅显示当前 CLI 设备的用量，不混入本机统计。', 'Usage belongs to this CLI device, not the controlling desktop.'),
    rows: [row(pair('设备', 'Device'), 'gpu-lab-01'), row(pair('统计范围', 'Scope'), pair('API 请求 / 引擎 / 模型', 'API requests / engine / model')),
      row(pair('当前数据', 'Current data'), pair('暂无真实用量（设计预览）', 'No live usage (design preview)'))], actions: [],
  },
  {
    id: 'general', title: pair('通用', 'General'),
    subtitle: pair('保留 Camellia 的名称、猫咪与安静的蓝灰色。', 'Camellia branding, the familiar cat, and quiet blue-grey accents.'),
    rows: [row(pair('设备名称', 'Device name'), 'gpu-lab-01'), row(pair('语言', 'Language'), pair('简体中文 / English', 'English / Simplified Chinese')),
      row(pair('外观', 'Appearance'), pair('终端默认背景 + Camellia 蓝', 'Terminal background + Camellia blue')),
      row(pair('默认权限', 'Default permission'), pair('询问后执行', 'Ask before executing')),
      row(pair('当前上下文', 'Current context'), pair('此 CLI 设备；不是控制它的电脑', 'This CLI device, not the controlling computer'))],
    actions: [action('appearance', pair('预览：外观与键盘操作', 'Preview: appearance & keyboard'), pair('终端不是缩小的网页', 'Designed for a terminal'), [
      pair('宽终端：左侧分类，右侧设置；窄终端：单栏。', 'Wide terminal: sidebar and settings. Narrow terminal: one column.'),
      pair('方向键或 j/k 切换；Tab 切换焦点；Enter 查看流程。', 'Arrows or j/k navigate; Tab changes focus; Enter opens a flow.'),
      pair('Esc 返回；q 退出预览；退出不会停止未来的后台服务。', 'Esc goes back; q exits the preview, not the future service.'),
      pair('支持 NO_COLOR、ASCII 模式，以及中英文切换。', 'Supports NO_COLOR, ASCII mode, and Chinese or English.'),
      pair('字符猫来自现有坐姿侧面 logo，不换成通用猫脸。', 'The character cat follows the existing seated silhouette.'),
    ])],
  },
  {
    id: 'engines', title: pair('引擎设置', 'Engine Settings'),
    subtitle: pair('连接、模型、思考级别和权限沿用桌面概念。', 'Keep desktop concepts: connection, model, thinking and permission.'),
    rows: [row(pair('引擎', 'Engine'), 'Claude / Codex / DSH / Kimi / Antigravity'),
      row(pair('连接来源', 'Connection'), pair('API / 此服务器的订阅账号', 'API / subscription on this server')),
      row(pair('模型与思考', 'Model & thinking'), pair('由已配置引擎提供，不预填不存在的选项', 'From the configured engine, not hard-coded options')),
      row(pair('权限', 'Permissions'), pair('询问 / 自动 / 完全访问', 'Ask / Auto / Full access')),
      row(pair('生效范围', 'Applies to'), pair('服务器默认设置；会话可单独覆盖', 'Server defaults; conversations may override'))], actions: [],
  },
  {
    id: 'runtimes', title: pair('运行时', 'Runtime'),
    subtitle: pair('服务器不安装 Electron，只下载需要的引擎。', 'No Electron on the server; download only the engines you need.'),
    rows: [row(pair('目标平台', 'Target platform'), 'Linux x64 / arm64'),
      row(pair('运行时列表', 'Runtime list'), pair('引擎 / 版本 / 状态 / 更新', 'Engine / version / status / updates')),
      row(pair('下载连接', 'Download connection'), pair('直接连接 / 代理', 'Direct / proxy')),
      row(pair('网络组件', 'Networking'), pair('内置 Tailscale helper，无需桌面环境', 'Embedded Tailscale helper; no desktop required')),
      row(pair('注意', 'Note'), pair('每个引擎需分别通过 Linux 验证', 'Each engine needs separate Linux verification'))], actions: [],
  },
  {
    id: 'workspaces', title: pair('工作区与会话', 'Workspaces & Conversations'),
    subtitle: pair('路径、文件、引擎进程和会话都属于这台服务器。', 'Paths, files, engine processes and conversations live on this server.'),
    rows: [row('paper-agent', '/srv/projects/paper-agent'), row('inference', '/srv/projects/inference'),
      row(pair('独立会话', 'Independent conversations'), pair('2 个会话（演示）', '2 conversations (demo)')),
      row(pair('离线时', 'When offline'), pair('只读缓存，禁止发送和排队写操作', 'Read-only cache; no sends or queued writes'))],
    actions: [
      action('create', pair('预览：新建工作区 / 会话', 'Preview: new workspace / conversation'), pair('在 gpu-lab-01 新建', 'Create on gpu-lab-01'), [
        pair('新建工作区填写服务器绝对路径，不能打开本机文件选择器。', 'Use an absolute server path, never a local desktop folder picker.'),
        pair('默认选择已有目录；新建目录必须是独立确认的操作。', 'Use an existing folder by default; folder creation is a separate action.'),
        pair('新建会话可选择工作区，或明确选择「独立会话」。', 'Choose a workspace or explicitly choose "Independent conversation".'),
        pair('引擎和模型选项从服务器获取；本机设置不会自动覆盖。', 'Fetch engines and models from the server; do not copy local defaults.'),
      ]),
      action('delete', pair('预览：移除工作区', 'Preview: remove workspace'), pair('移除 paper-agent？', 'Remove paper-agent?'), [
        pair('仅移除 Camellia 中的工作区记录，不删除服务器文件。', 'Remove only the Camellia workspace record, never server files.'),
        pair('默认把会话转为独立会话；可单独选择归档。', 'Keep conversations as independent; archiving is an explicit option.'),
        pair('原有会话保留工作目录，不悄悄改到其他目录。', 'Existing conversations retain their working directories.'),
        pair('工作区中有运行、审批、任务检查或 Goal 时拒绝移除。', 'Refuse removal during runs, approvals, task checks or active goals.'),
        pair('确认按钮必须显示服务器名称和工作区名称。', 'The confirmation names both the server and the workspace.'),
      ], true),
    ],
  },
  {
    id: 'archived', title: pair('已归档', 'Archived'),
    subtitle: pair('恢复和永久删除只影响当前服务器。', 'Restore and permanent deletion affect only the selected server.'),
    rows: [row(pair('当前列表', 'Current list'), pair('暂无归档会话（演示）', 'No archived conversations (demo)')),
      row(pair('可用操作', 'Actions'), pair('恢复 / 永久删除（再次确认）', 'Restore / permanently delete (confirm again)')),
      row(pair('不会删除', 'Never deletes'), pair('工作区的真实文件', 'Actual workspace files'))], actions: [],
  },
  {
    id: 'storage', title: pair('空间清理', 'Space cleanup'),
    subtitle: pair('先预览，再清理；密钥和会话不会当作缓存。', 'Preview before cleanup; credentials and chats are not cache.'),
    rows: [row(pair('清理范围', 'Cleanup scope'), pair('下载缓存 / 过期日志 / 临时文件', 'Download cache / expired logs / temporary files')),
      row(pair('受保护数据', 'Protected data'), pair('会话 / 订阅凭据 / API 密钥 / Tailscale 状态', 'Chats / subscription credentials / API keys / Tailscale state')),
      row(pair('预计释放', 'Estimated savings'), pair('未扫描（设计预览）', 'Not scanned (design preview)'))], actions: [],
  },
  {
    id: 'network', title: pair('网络与设备', 'Network & Devices'),
    subtitle: pair('先登录 Tailscale，再配对可信的 GUI 客户端。', 'Sign into Tailscale, then pair a trusted GUI client.'),
    rows: [row('Tailscale', pair('已登录（演示，未连接网络）', 'Signed in (demo; no network connection)')),
      row(pair('设备地址', 'Device address'), '100.92.14.8:43127 (demo)'),
      row(pair('已授权客户端', 'Authorized clients'), 'MacBook Pro (demo)'),
      row(pair('授权范围', 'Permission scope'), pair('整台设备控制，含未来工作区与独立会话', 'Full-device control, including future workspaces and chats'))],
    actions: [
      action('login', pair('预览：登录 Tailscale', 'Preview: Tailscale sign-in'), pair('无浏览器也可以登录', 'Sign in without a server browser'), [
        pair('CLI 显示内置 Tailscale 返回的 HTTPS 登录链接。', 'Show the HTTPS login link returned by embedded Tailscale.'),
        pair('在任意可信浏览器完成授权，再回到终端查看状态。', 'Authorize in a trusted browser, then check status in the terminal.'),
        pair('登录 Tailscale 不等于授权 Camellia 会话访问。', 'Tailscale sign-in alone does not authorize Camellia access.'),
        pair('设备只有完成 Camellia 配对后才能操作会话。', 'A client must also complete Camellia pairing to control chats.'),
      ]),
      action('pair', pair('预览：添加 GUI 客户端', 'Preview: pair a GUI client'), pair('两端确认，才能开始控制', 'Both devices confirm pairing'), [
        pair('1. CLI 生成 5 分钟有效的一次性配对码。', '1. CLI generates a single-use code, valid for 5 minutes.'),
        pair('2. GUI：设备 > 添加 CLI 设备，输入地址和配对码。', '2. GUI: Devices > Add CLI device; enter its address and code.'),
        pair('3. CLI 显示客户端名称与权限，请人工确认。', '3. CLI shows the client name and scope for local approval.'),
        pair('4. GUI 获取独立设备凭据，进入服务器工作区列表。', '4. GUI receives a device credential and lists server workspaces.'),
        pair('客户端名称不是身份证明；仅批准刚刚发起的配对。', 'A name is not proof of identity; approve only your own request.'),
        pair('本预览不会生成可用的配对码或自动授权。', 'This preview creates no usable pairing code or authorization.'),
      ]),
      action('revoke', pair('预览：撤销客户端授权', 'Preview: revoke a client'), pair('撤销 MacBook Pro？', 'Revoke MacBook Pro?'), [
        pair('立即关闭该客户端事件流，拒绝后续读取和命令。', 'Close its event streams and reject subsequent reads and commands.'),
        pair('取消尚未开始的控制请求；已运行的引擎不默认停止。', 'Cancel pending control requests; do not silently stop running engines.'),
        pair('不删除服务器会话，不退出 Tailscale，不清除 API 设置。', 'Keep chats, Tailscale sign-in and API configuration intact.'),
        pair('如需停止已有响应，必须明确执行「停止运行」。', 'Use an explicit stop action to interrupt an existing response.'),
      ], true),
    ],
  },
  {
    id: 'service', title: pair('后台服务', 'Background service'),
    subtitle: pair('CLI 菜单是控制台，后台进程才是服务。', 'The CLI is a console; the background process owns the service.'),
    rows: [row(pair('服务状态', 'Service status'), pair('运行中（演示）', 'Running (demo)')),
      row(pair('进程权限', 'Process privileges'), pair('普通用户，不要求 root', 'Unprivileged user; no root required')),
      row(pair('服务管理', 'Service manager'), pair('systemd --user / 前台运行', 'systemd --user / foreground')),
      row(pair('SSH 断开后', 'After SSH disconnects'), pair('需用户服务常驻策略支持', 'Requires a persistent user-service policy'))],
    actions: [action('restart', pair('预览：重启服务', 'Preview: restart service'), pair('重启前检查进行中的工作', 'Check active work before restarting'), [
      pair('先列出进行中的响应、审批、Goal 和任务检查。', 'List active responses, approvals, goals and task checks first.'),
      pair('默认等待空闲；强制停止必须再次确认。', 'Wait until idle by default; stopping work requires confirmation.'),
      pair('重启后 GUI 重新鉴权和拉取快照，不自动重发消息。', 'After restart, reauthenticate and fetch snapshots; never replay sends.'),
      pair('退出菜单不是停止服务；停止服务也不是退出账号。', 'Exiting the menu is not stopping the service or signing out.'),
    ], true)],
  },
  {
    id: 'diagnostics', title: pair('诊断与关于', 'Diagnostics & About'),
    subtitle: pair('可解释的状态，不暴露敏感内容。', 'Explain system health without exposing secrets.'),
    rows: [row(pair('产品', 'Product'), 'Camellia / Server CLI'),
      row(pair('诊断项', 'Checks'), pair('网络 / 存储权限 / 引擎 / 服务', 'Network / storage permissions / engines / service')),
      row(pair('日志默认隐藏', 'Log redaction'), pair('密钥 / token / 配对码 / 会话正文', 'Keys / tokens / pairing codes / conversation text')),
      row(pair('当前版本', 'Current build'), pair('设置设计原型；不是服务器发行版', 'Settings design prototype, not a server release'))], actions: [],
  },
];

function localize(value, language) { return typeof value === 'string' ? value : value[language === 'en' ? 'en' : 'zh']; }
function clean(value) { return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
function cellWidth(character) {
  const code = character.codePointAt(0);
  if (/\p{Mark}/u.test(character)) return 0;
  return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf
    || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff
    || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60
    || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300) ? 2 : 1;
}
function width(value) { return [...value].reduce((total, character) => total + cellWidth(character), 0); }
function fit(value, limit) {
  let result = '', used = 0;
  for (const character of clean(value)) {
    const size = cellWidth(character);
    if (used + size > limit) break;
    result += character; used += size;
  }
  return result;
}
function pad(value, limit) { const fitted = fit(value, limit); return fitted + ' '.repeat(Math.max(0, limit - width(fitted))); }
function wrap(value, limit) {
  const result = [];
  let remaining = clean(value);
  while (width(remaining) > limit) {
    let part = fit(remaining, limit);
    const space = part.lastIndexOf(' ');
    if (space > part.length / 2) part = part.slice(0, space);
    if (/^[，。！？；：、）】》]/.test(remaining.slice(part.length))) {
      const characters = [...part];
      if (characters.length > 1) part = characters.slice(0, -1).join('');
    }
    result.push(part);
    remaining = remaining.slice(part.length).trimStart();
  }
  if (remaining) result.push(remaining);
  return result;
}
function paint(value, tone, enabled) {
  if (!enabled || !PALETTE[tone]) return value;
  const hex = PALETTE[tone];
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return `\x1b[38;2;${channels.join(';')}m${value}\x1b[0m`;
}
function initialState(page = 'general') {
  const pageIndex = PAGES.findIndex(candidate => candidate.id === page);
  if (pageIndex < 0) throw new Error(`Unknown page: ${clean(page)}`);
  return { pageIndex, focus: 'nav', actionIndex: 0, detail: false, scroll: 0 };
}
function transition(state, key) {
  const next = { ...state };
  if (['q', 'ctrl-c'].includes(key)) return { ...next, quit: true };
  if (key === 'escape' || key === 'left') return { ...next, detail: false, focus: 'nav', scroll: 0 };
  const direction = key === 'up' || key === 'k' ? -1 : key === 'down' || key === 'j' ? 1 : 0;
  if (next.detail) {
    next.scroll = Math.max(0, next.scroll + direction);
    return next;
  }
  const page = PAGES[next.pageIndex];
  if (key === 'tab' || key === 'right') next.focus = next.focus === 'nav' && page.actions.length ? 'actions' : 'nav';
  if (direction && next.focus === 'nav') {
    next.pageIndex = (next.pageIndex + direction + PAGES.length) % PAGES.length;
    next.actionIndex = 0; next.scroll = 0;
  } else if (direction && page.actions.length) {
    next.actionIndex = (next.actionIndex + direction + page.actions.length) % page.actions.length;
  }
  if (key === 'return' && page.actions.length) return { ...next, focus: 'actions', detail: true, scroll: 0 };
  return next;
}

function render(state, { columns = 104, rows = 40, language = 'zh', color = false, ascii = false } = {}) {
  const size = Math.max(1, Math.min(120, Math.floor(columns) || 104));
  const height = Math.max(1, Math.floor(rows) || 40);
  const text = value => localize(value, language);
  if (size < 40 || height < 18) {
    return [fit('Camellia / DESIGN PREVIEW', size), fit(text(pair('请放大终端至 40 列、18 行；q 退出。', 'Resize to 40 columns / 18 rows; q exits.')), size)].slice(0, height).join('\n');
  }
  const page = PAGES[state.pageIndex];
  const wide = size >= 96;
  const sidebarWidth = wide ? 32 : 0;
  const contentWidth = size - sidebarWidth;
  const selected = page.actions[state.actionIndex];
  const mark = ascii ? '>' : '›';
  const separator = ascii ? '|' : '│';
  const rule = (ascii ? '-' : '─').repeat(size);
  const header = [
    'Camellia', 'Server CLI / gpu-lab-01',
    text(pair('设计预览 · 演示数据 · 不连接真实设备', 'DESIGN PREVIEW / DEMO DATA / NO LIVE DEVICE')),
    text(pair('当前范围：CLI 服务器，不是本机', 'Scope: CLI server, not this desktop')),
    text(pair('猫咪与桌面版同源 / Linux x64 + arm64', 'Same Camellia cat / Linux x64 + arm64')),
  ];
  const logo = ascii ? ASCII_CAT : CAT;
  const output = size >= 78 && height >= 24
    ? logo.map((line, index) => paint(pad(line, 11), 'accent', color) + paint(fit(header[index], size - 11), index === 0 ? 'accent' : 'muted', color))
    : [paint(fit(header[0] + ' / Server CLI', size), 'accent', color), fit(header[2], size)];
  output.push(paint(rule, 'muted', color));
  if (!wide) output.push(paint(fit(`${state.pageIndex + 1}/${PAGES.length}  ${text(page.title)}`, size), 'accent', color));
  const content = [];
  const append = (value, tone = 'text') => content.push(...wrap(value, contentWidth).map(line => ({ line, tone })));
  if (state.detail && selected) {
    append(text(selected.title), selected.danger ? 'danger' : 'accent');
    append(text(pair('流程说明，不执行操作', 'Flow preview; no actions are executed')), 'muted');
    content.push({ line: '' });
    for (const line of selected.lines) { append(text(line)); content.push({ line: '' }); }
  } else {
    append(text(page.title), 'accent');
    append(text(page.subtitle), 'muted');
    content.push({ line: '' });
    for (const entry of page.rows) {
      append(`${text(entry.label)}  ${text(entry.value)}`);
      content.push({ line: '' });
    }
    page.actions.forEach((entry, index) => {
      const start = content.length;
      append(`${state.focus === 'actions' && index === state.actionIndex ? mark : ' '} ${text(entry.label)}`, entry.danger ? 'danger' : 'accent');
      if (index === state.actionIndex) content[start].selected = true;
    });
  }
  const bodyHeight = height - output.length - 4;
  const maxScroll = Math.max(0, content.length - bodyHeight);
  let scroll = state.detail ? Math.min(state.scroll, maxScroll) : 0;
  if (!state.detail && state.focus === 'actions') {
    const selectedLine = content.findIndex(item => item.selected);
    scroll = Math.min(maxScroll, Math.max(0, selectedLine - bodyHeight + 2));
  }
  const navOffset = Math.max(0, state.pageIndex - bodyHeight + 1);
  for (let index = 0; index < bodyHeight; index++) {
    const item = content[index + scroll];
    const navIndex = index + navOffset;
    const nav = PAGES[navIndex];
    const label = nav ? `${navIndex === state.pageIndex ? mark : ' '} ${text(nav.title)}` : '';
    const left = wide ? paint(pad(label, sidebarWidth - 3), navIndex === state.pageIndex ? 'accent' : 'muted', color) + ` ${separator} ` : '';
    output.push(left + (item ? paint(item.line, item.tone, color) : ''));
  }
  output.push(paint(rule, 'muted', color));
  output.push(fit(text(pair('演示环境：不会保存设置、登录、配对或传输密钥。', 'Demo only: no settings, sign-ins, pairing or key transfers.')), size));
  output.push(fit(state.detail
    ? text(pair('上下 / j k 滚动 · Esc 返回 · q 退出', 'Up/Down / j k scroll · Esc back · q quit'))
    : text(pair('上下切换 · Tab 操作区 · Enter 查看 · q 退出', 'Up/Down navigate · Tab actions · Enter preview · q quit')), size));
  output.push(fit(`${text(pair('焦点', 'Focus'))}: ${state.detail ? text(pair('流程', 'Flow')) : state.focus === 'nav' ? text(pair('分类', 'Categories')) : text(pair('操作', 'Actions'))}${maxScroll ? ` | ${scroll + 1}-${Math.min(scroll + bodyHeight, content.length)}/${content.length}` : ''}`, size));
  const result = output.join('\n');
  return ascii ? result.replace(/·/g, '|') : result;
}

module.exports = { PAGES, PALETTE, CAT, initialState, transition, render, width, fit, clean };
