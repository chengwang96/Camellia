'use strict';

(function () {
  const root = document.getElementById('cliDevicesRoot');
  const bridge = window.dshDesktop.camelliaDevices;
  const elements = Object.fromEntries([...root.querySelectorAll('[id]')].map(element => [element.id.slice(4), element]));
  const chinese = Object.fromEntries([...root.querySelectorAll('[data-copy]')].map(element => [element.dataset.copy, element.textContent]));
  const english = { intro: 'Manage connections here. Open a server from Home to use its independent workbench.', network: 'Local Tailscale connection', networkHint: 'Shares the same Tailscale identity as Mobile access. Sign in once; disconnect or sign out from Mobile access.', login: 'Start / Sign in', browser: 'Open sign-in link', refresh: 'Refresh', servers: 'Paired servers', add: 'Add CLI server', defaultHint: 'One entry per server on Home. The default harness applies to new conversations only.', deviceName: 'Server name', address: 'Tailscale address', clientName: 'This computer name', code: 'One-time pairing code', cancel: 'Cancel', pair: 'Pair', forget: 'Forget server' };
  Object.assign(english, { address: 'Tailscale IP', port: 'Port' });
  const harnesses = { codex: 'Codex CLI', claude: 'Claude Code', dsh: 'DeepSeek Harness', kimi: 'Kimi Code', antigravity: 'Antigravity', pi: 'Pi' };
  let language = 'zh-CN', busy = false, pending = null, forgotten = null, networkState = '';
  const text = (zh, en) => language === 'en' ? en : zh;
  async function call(action, payload) {
    const result = await bridge.call(action, payload);
    if (!result.ok) throw new Error(result.error);
    return result.result;
  }
  async function run(operation) {
    if (busy) return;
    busy = true; elements.error.textContent = '';
    for (const control of root.querySelectorAll('button, input, select')) control.disabled = true;
    try { await operation(); }
    catch (error) {
      const message = error.message.startsWith('Embedded network helper is outdated')
        ? text('本机内置网络组件版本过旧，尚不支持连接 CLI 服务器。请更新并完全退出、重新启动 Camellia；源码运行需先执行 npm run build:tailnet。这不是配对码错误。', error.message)
        : error.message;
      elements.error.textContent = message; if (elements.pairDialog.open) elements.pairStatus.textContent = message;
    }
    finally { busy = false; for (const control of root.querySelectorAll('button, input, select')) control.disabled = false; }
  }
  async function refresh() {
    const state = await call('state'); language = state.language; networkState = state.network.state;
    for (const element of root.querySelectorAll('[data-copy]')) element.textContent = (language === 'en' ? english : chinese)[element.dataset.copy];
    const labels = { Running: text('已连接', 'Connected'), NeedsLogin: text('需要登录', 'Sign-in required'), Starting: text('启动中', 'Starting'), Stopped: text('未启动', 'Not started'), Error: text('连接出错', 'Connection error') };
    elements.networkState.textContent = labels[networkState] || networkState;
    elements.openLogin.hidden = !state.network.loginUrl;
    elements.servers.replaceChildren();
    if (!state.devices.length) {
      const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = text('尚未添加服务器。连接 Tailscale 后，使用服务器配对码添加。', 'No servers yet. Connect Tailscale, then add a server using its pairing code.'); elements.servers.append(empty);
    }
    for (const device of state.devices) {
      const row = document.createElement('article'); row.className = 'server-setting';
      const details = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = device.name;
      const address = document.createElement('p'); address.className = 'hint'; address.textContent = device.address;
      const stateLabel = document.createElement('p'); stateLabel.className = 'hint'; stateLabel.textContent = text('已配对 · 从首页连接', 'Paired · Connect from Home'); details.append(title, address, stateLabel);
      const label = document.createElement('label'); label.textContent = text('默认 Harness', 'Default harness');
      const select = document.createElement('select'); select.setAttribute('aria-label', `${device.name} · ${label.textContent}`);
      select.append(new Option(text('服务器可用引擎', 'Available server engine'), ''), ...Object.entries(harnesses).map(([id, name]) => new Option(name, id)));
      select.value = device.defaultHarness || '';
      select.onchange = () => run(async () => { try { await call('preferences', { deviceId: device.id, defaultHarness: select.value }); } finally { await refresh(); } });
      label.append(select);
      const forget = document.createElement('button'); forget.className = 'danger'; forget.textContent = text('忘记', 'Forget');
      forget.onclick = () => { forgotten = device.id; elements.forgetHint.textContent = `${device.name} · ${text('仅移除本机凭据，不删除服务器文件或会话，也不撤销服务器授权。已打开的服务器窗口将关闭。', 'Removes local credentials only. Server files, conversations and authorization remain. The server window will close.')}`; elements.forgetDialog.showModal(); };
      row.append(details, label, forget); elements.servers.append(row);
    }
  }
  elements.refresh.onclick = () => run(refresh);
  elements.networkStart.onclick = () => run(async () => { await call('network-start'); await refresh(); });
  elements.openLogin.onclick = () => run(() => call('open-login'));
  elements.add.onclick = () => {
    if (networkState !== 'Running') { elements.error.textContent = text('请先启动 Tailscale 并完成登录，然后刷新连接状态。', 'Start Tailscale and sign in first, then refresh connection status.'); return; }
    elements.code.required = !pending; elements.pairStatus.textContent = ''; elements.pairDialog.showModal();
  };
  elements.pairForm.onsubmit = event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(elements.pairForm));
    values.address = `http://${values.address.trim()}:${values.port.trim()}`;
    delete values.port;
    void run(async () => {
      if (!pending) { const result = await call('pair', values); pending = result.id; elements.code.value = ''; }
      else {
        const result = await call('claim', { id: pending });
        if (result.state === 'approved') { pending = null; elements.pairDialog.close(); elements.pairForm.reset(); await refresh(); return; }
      }
      elements.code.required = false;
      elements.pairStatus.textContent = text('等待服务器批准。请在 CLI 批准后点击「检查授权」。', 'Approve this request on the CLI server, then check approval.');
      elements.pairSubmit.textContent = text('检查授权', 'Check approval');
    });
  };
  function cancelPair() { void run(async () => { if (pending) await call('cancel-pair', { id: pending }); pending = null; elements.pairDialog.close(); elements.pairForm.reset(); elements.code.required = true; await refresh(); }); }
  elements.cancel.onclick = cancelPair;
  elements.pairDialog.addEventListener('cancel', event => { event.preventDefault(); cancelPair(); });
  elements.forgetCancel.onclick = () => elements.forgetDialog.close();
  elements.forgetForm.onsubmit = event => { event.preventDefault(); void run(async () => { await call('forget', { id: forgotten }); elements.forgetDialog.close(); await refresh(); }); };
  window.cliDevicesUI = { setVisible(value) { if (value) void run(refresh); }, refresh() { void run(refresh); } };
})();
