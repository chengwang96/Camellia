'use strict';

const { createInterface } = require('node:readline');
const { terminalText } = require('./settings-console');
const { requestControl, listenControl } = require('./local-control');
const { createHeadlessHost } = require('./host');

async function launchSession({ request, ask, write, language = 'zh-CN', owned = false, isClosed = () => false }) {
  const text = (zh, en) => language === 'en' ? en : zh;
  const out = value => write(terminalText(value) + '\n');
  const call = async (action, payload = {}) => {
    if (isClosed()) throw Object.assign(new Error('Console closed'), { code: 'CONSOLE_CLOSED' });
    const reply = await request(action, payload);
    if (!reply?.ok) throw new Error(reply?.error || 'Server operation failed');
    return reply.result;
  };
  const question = async prompt => {
    const answer = await ask(terminalText(prompt) + ' > ');
    if (answer === null) throw Object.assign(new Error('Console closed'), { code: 'CONSOLE_CLOSED' });
    return answer.trim();
  };
  let invitation = null;
  out('Camellia · Server');
  out(text('一个终端即可完成连接。Harness、模型和 API 配置请在 GUI 管理。', 'Connect from this terminal. Manage harnesses, models and API settings in the GUI.'));
  out(owned ? text('服务在当前终端运行；关闭终端、q 或 Ctrl+C 会停止服务。', 'The server runs in this terminal. Closing it, q or Ctrl+C stops the server.')
    : text('已连接到现有服务；退出此向导不会停止服务。', 'Attached to the existing server. Leaving this wizard does not stop it.'));
  try {
    let state = await call('state');
    if (!state.running || state.network.state !== 'Running') {
      out(text('正在启动 Tailscale…', 'Starting Tailscale…'));
      state = await call('start');
    }
    while (!state.running || state.network.state !== 'Running') {
      out(`Tailscale: ${state.network.state}`);
      if (state.network.loginUrl) out(text('在浏览器完成登录：', 'Sign in using your browser: ') + state.network.loginUrl);
      const answer = await question(text('登录完成后按回车刷新；q 退出', 'Press Enter after sign-in to refresh; q to exit'));
      if (answer.toLowerCase() === 'q') return;
      state = await call('state');
    }
    const invite = async () => {
      invitation = await call('invite');
      out(text('在 GUI「设置 → CLI 设备 → 添加」填写：', 'In GUI Settings → CLI devices → Add, enter:'));
      out(text('服务器地址：', 'Server address: ') + (invitation.address || state.address));
      out(text('一次性配对码：', 'One-time pairing code: ') + invitation.code);
      out(text('配对码五分钟有效，请勿分享终端日志。提交后回到这里按回车。', 'Code expires in five minutes. Do not share terminal logs. Submit in the GUI, then press Enter here.'));
    };
    if (!state.devices?.length && !state.pending?.length) await invite();
    for (;;) {
      out(text('服务器已就绪：', 'Server ready: ') + state.address);
      if (state.devices?.length) out(text('已授权：', 'Authorized: ') + state.devices.map(device => terminalText(device.name)).join(', '));
      if (state.pending?.length) {
        for (const [index, pending] of state.pending.entries()) out(`${index + 1}. ${terminalText(pending.name)} [${pending.id}]`);
        out(text('只批准自己刚发起的请求。名称不是身份证明，授权可控制此服务器全部工作区。', 'Approve only your own request. A name is not proof of identity; authorization grants control of all server workspaces.'));
      }
      const answer = await question(text('回车刷新 · 数字批准待配对设备 · p 新配对码 · q 退出', 'Enter: refresh · number: approve pending device · p: new pairing code · q: exit'));
      if (answer.toLowerCase() === 'q') return;
      if (answer.toLowerCase() === 'p') { await invite(); continue; }
      if (/^[1-9]\d*$/.test(answer)) {
        const pending = state.pending?.[Number(answer) - 1];
        if (!pending) { out(text('请选择列表中的设备。', 'Choose a device from the list.')); continue; }
        const confirm = await question(`${terminalText(pending.name)} [${pending.id}] · ${text('输入 YES 确认授权', 'Type YES to authorize')}`);
        if (confirm === 'YES') {
          try { await call('approve', { id: pending.id }); out(text('已批准。回到 GUI 点击「检查授权」，之后从首页打开服务器。', 'Approved. Click Check approval in the GUI, then open the server from Home.')); }
          catch (error) { out(error.message); }
        } else out(text('已取消授权。', 'Authorization cancelled.'));
      }
      state = await call('state');
      if (!state.running) out(text('远程网络已停止，可退出并重新运行 ./camellia 连接。', 'Remote networking stopped. Exit and run ./camellia again to connect.'));
    }
  } catch (error) { if (error.code !== 'CONSOLE_CLOSED') throw error; }
}

async function runLaunch(options, { input = process.stdin, output = process.stdout, signals = process,
  connect = requestControl, createHost = createHeadlessHost, listen = listenControl, session = launchSession } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Quick launch requires an interactive terminal; use serve --restore-network for a service');
  let host = null, control = null, readline = null, closed = false, resolveQuestion;
  const stop = () => { if (closed) return; closed = true; resolveQuestion?.(null); resolveQuestion = null; readline?.close(); };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  try {
    let request = (action, payload) => connect(options.dataDir, action, payload);
    try {
      const reply = await request('state');
      if (!reply?.ok) throw new Error(reply?.error || 'Cannot read running server state');
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (closed) return;
      host = createHost(options);
      control = await listen({ dataDir: options.dataDir, command: host.command });
      request = host.command;
    }
    if (closed) return;
    readline = createInterface({ input, output, terminal: true, historySize: 0 });
    readline.on('close', stop); readline.on('SIGINT', stop);
    await session({ request, owned: Boolean(host), language: options.language, isClosed: () => closed,
      write: value => output.write(value),
      ask: prompt => closed ? Promise.resolve(null) : new Promise(resolve => {
        resolveQuestion = resolve; readline.question(prompt, answer => { resolveQuestion = null; resolve(answer); });
      }) });
  } finally {
    stop(); signals.off('SIGINT', stop); signals.off('SIGTERM', stop);
    try { await control?.close(); } finally { await host?.close(); }
  }
}

module.exports = { launchSession, runLaunch };
