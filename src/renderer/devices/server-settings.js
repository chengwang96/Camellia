'use strict';

(function () {
  window.createServerSettings = ({ root, call, device, language, nativeSettings, syncApi, archived }) => {
    const dialog = root.querySelector('#serverSettings');
    const nav = root.querySelector('#serverSettingsNav');
    const body = root.querySelector('#serverSettingsBody');
    const status = root.querySelector('#serverSettingsStatus');
    let page = 'runtimes', busy = false, timer = null, state = null, archiveNode = null;
    const archiveHome = root.querySelector('#archivePanel').parentElement;
    const archiveNext = root.querySelector('#archivePanel').nextSibling;
    function restoreArchive() { if (archiveNode) { archiveNode.hidden = false; archiveHome.insertBefore(archiveNode, archiveNext); } }
    const text = (zh, en) => language() === 'en' ? en : zh;
    const pages = { runtimes: ['运行时', 'Runtimes'], engines: ['引擎设置', 'Engine settings'], usage: ['用量', 'Usage'], archived: ['已归档', 'Archived'] };
    const names = { codex: 'Codex CLI', claude: 'Claude Code', dsh: 'DeepSeek Harness', kimi: 'Kimi Code', antigravity: 'Antigravity', pi: 'Pi' };
    function element(tag, content, className) {
      const node = document.createElement(tag); if (content) node.textContent = content; if (className) node.className = className; return node;
    }
    function button(label, action, parent = body) {
      const node = element('button', label); node.type = 'button'; node.onclick = action; parent.append(node); return node;
    }
    function controls() { for (const node of body.querySelectorAll('button, select, input')) node.disabled = busy; }
    async function job(action, payload = {}) {
      const deviceId = device().id;
      let result = await call('server-manage', { deviceId, request: { action, payload, requestId: crypto.randomUUID() } });
      const deadline = Date.now() + 10 * 60_000;
      while (result.state === 'running') {
        status.textContent = text('服务器正在处理，可关闭设置；操作仍在服务器继续。', 'Working on the server. Closing settings does not cancel the operation.');
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (Date.now() > deadline) throw new Error(text('操作仍可能在服务器运行，请刷新状态后再决定是否重试。', 'Operation may still be running. Refresh its state before retrying.'));
        result = await call('server-job', { deviceId, id: result.id });
      }
      if (result.state !== 'complete') throw new Error(result.error || 'Server operation failed');
      return result.result;
    }
    async function run(action) {
      if (busy) return;
      const activePage = page;
      busy = true; controls(); status.textContent = text('正在读取服务器…', 'Reading server…');
      try { await action(); status.textContent = ''; }
      catch (error) { status.textContent = /HTTP (400|404)/.test(error.message)
        ? text('服务器或本机网络组件不支持此设置接口。请更新 CLI 服务端和两端 camellia-tailnet 后重启，不要重新配对。', 'Update the CLI server and both camellia-tailnet helpers, then restart; this settings endpoint is unavailable. No re-pairing is needed.')
        : error.message; }
      finally { busy = false; controls(); if (activePage !== page && dialog.open) void run(render); }
    }
    function confirm(label, action) {
      const box = root.querySelector('#serverConfirm');
      root.querySelector('#serverConfirmText').textContent = `${device().name} · ${label}`;
      root.querySelector('#serverConfirmCancel').onclick = () => box.close();
      root.querySelector('#serverConfirmAccept').onclick = () => { box.close(); void run(action); };
      box.showModal();
    }
    async function render() {
      clearTimeout(timer);
      if (archiveNode && body.contains(archiveNode)) restoreArchive();
      body.replaceChildren();
      for (const node of nav.children) node.setAttribute('aria-current', String(node.dataset.page === page));
      if (page === 'runtimes') {
        const rows = await job('runtime-state');
        button(text('检查更新', 'Check updates'), () => run(async () => {
          const updates = await job('runtime-check');
          const list = element('div');
          for (const update of updates) list.append(element('p', `${update.name} · ${update.installed || '—'} → ${update.latest || '—'} ${update.error || ''}`));
          body.append(list);
        }));
        for (const row of rows) {
          const item = element('article', '', 'server-setting');
          const labels = { ready: text('已安装', 'Installed'), missing: text('未安装', 'Not installed'), installing: text('安装中', 'Installing'), failed: text('失败', 'Failed'), error: text('出错', 'Error') };
          item.append(element('strong', names[row.id] || row.name), element('span', `${labels[row.status] || row.status} · ${row.version || '—'} ${labels[row.operation] || ''} ${row.error || ''}`));
          const actions = element('div', '', 'actions');
          const perform = action => confirm(`${names[row.id]} · ${action} — ${text('仅修改此服务器运行时，保留会话与账号。', 'Changes this server runtime only; keeps conversations and accounts.')}`, async () => {
            await job(action, { engine: row.id, confirmed: true, connection: row.mode || 'api' }); await render();
          });
          button(text('安装', 'Install'), () => perform('runtime-install'), actions);
          if (row.status === 'ready' && !row.external) {
            button(text('更新', 'Update'), () => perform('runtime-update'), actions);
            button(text('卸载', 'Uninstall'), () => perform('runtime-uninstall'), actions);
          }
          item.append(actions); body.append(item);
        }
        if (rows.some(row => row.operation === 'installing' || row.status === 'installing')) timer = setTimeout(() => { if (dialog.open) void run(render); }, 2000);
      } else if (page === 'engines') {
        state = await job('settings');
        body.append(element('p', text('供应商与 Key 由本机 GUI 同步，服务器不单独编辑。', 'Providers and keys are synchronized from this GUI, not edited on the server.'), 'hint'));
        button(text('从 GUI 同步供应商和 Key', 'Sync providers and keys from GUI'), () => { dialog.close(); syncApi(); });
        button(text('高级原生设置', 'Advanced native settings'), () => { dialog.close(); nativeSettings(); });
        for (const engine of state.engines) {
          const row = element('article', '', 'server-setting');
          const select = element('select'); select.setAttribute('aria-label', names[engine.id]);
          select.append(new Option(text('选择模型', 'Choose model'), ''), ...state.api.models.map(model => new Option(model, model)));
          select.value = engine.model;
          const permission = element('select'); permission.setAttribute('aria-label', text('权限', 'Permissions'));
          permission.append(new Option(text('询问', 'Ask'), 'ask'), new Option(text('自动', 'Auto'), 'auto'), new Option(text('完全访问', 'Full access'), 'full')); permission.value = engine.permissionMode || 'ask';
          const thinking = element('select'); thinking.setAttribute('aria-label', text('思考级别', 'Thinking level'));
          const levels = () => { thinking.replaceChildren(new Option(text('默认思考级别', 'Default thinking'), ''), ...(engine.models?.find(model => model.id === select.value)?.thinking || []).map(value => new Option(value, value))); };
          levels(); thinking.value = engine.thinkingBudget || ''; select.onchange = levels;
          row.append(element('strong', names[engine.id]), select, permission, thinking);
          button(text('保存引擎设置', 'Save engine settings'), () => confirm(text('更新此服务器的新会话默认值？已有会话不变。', 'Update new-conversation defaults on this server? Existing conversations are unchanged.'), async () => { await job('engine-settings', { engine: engine.id, model: select.value, connection: 'api', permissionMode: permission.value, thinkingBudget: thinking.value }); }), row);
          body.append(row);
        }
      } else if (page === 'usage') {
        const usage = await job('usage');
        body.append(element('p', text('统计此服务器的 API 请求及订阅轮次。订阅金额按标准 API 单价折算，不代表实际账单。', 'API requests and subscription turns on this server. Subscription amounts are standard API equivalents, not your bill.'), 'hint'));
        const accounts = (usage.subscriptionUsage?.accounts || []).filter(account => account.usage);
        if (!usage.providers.length && !accounts.length) body.append(element('p', text('暂无用量', 'No usage yet')));
        for (const provider of usage.providers) {
          const row = element('article', '', 'server-setting');
          row.append(element('strong', provider.name), element('span', `${text('请求', 'Requests')} ${provider.requests} · ${text('失败', 'Failures')} ${provider.failures}`), element('span', `Tokens ${provider.inputTokens} / ${provider.outputTokens}`)); body.append(row);
        }
        for (const account of accounts) {
          const row = element('article', '', 'server-setting');
          row.append(element('strong', account.label || account.id));
          for (const [model, value] of Object.entries(account.usage.byModel || {})) {
            const amount = value.pricedTokens > 0 ? `USD ${value.estimatedCostUsd.toFixed(4)}` : text('未定价', 'Unpriced');
            row.append(element('span', `${model} · Tokens ${value.inputTokens} / ${value.outputTokens} · ${amount}${value.unpricedTokens || value.unreported ? text('（部分用量未定价或缺失）', ' (unpriced or missing usage)') : ''}`));
          }
          body.append(row);
        }
      } else if (page === 'archived') {
        archiveNode = archived(); archiveNode.hidden = false; body.append(archiveNode);
        const cleanup = element('section', '', 'server-setting');
        cleanup.append(element('h3', text('空间清理', 'Space cleanup')));
        cleanup.append(element('p', text('仅清理服务器内可验证的过期残留，不删除项目、账号、运行时或正常会话。', 'Only verified stale server remnants are cleaned; projects, accounts, runtimes and active conversations are preserved.'), 'hint'));
        button(text('扫描可清理文件', 'Scan unused files'), () => run(async () => {
          const scan = await job('storage-scan');
          const preview = element('div');
          for (const file of scan.candidates) preview.append(element('p', `${file.path} · ${file.bytes} B`));
          if (!scan.candidates.length) preview.append(element('p', text('没有可清理文件', 'No unused files')));
          else button(text('确认清理以上文件', 'Clean listed files'), () => confirm(text('永久删除以上扫描到的残留文件？', 'Permanently remove the scanned remnants?'), async () => {
            const result = await job('storage-clean', { token: scan.token, confirmed: true });
            await render(); body.append(element('p', `${text('已删除文件', 'Files removed')}: ${result.files} · ${result.bytes} B · ${text('跳过', 'Skipped')}: ${result.skipped}`));
          }), preview);
          cleanup.append(preview);
        }), cleanup);
        body.append(cleanup);
      }
    }
    root.querySelector('#serverSettingsClose').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { clearTimeout(timer); restoreArchive(); });
    return { async ensureRuntime(capabilities, engine) {
      if (!capabilities.includes('server-management')) return true;
      const rows = await job('runtime-state');
      const runtime = rows.find(row => row.id === engine);
      if (runtime?.status === 'ready' && runtime.operation !== 'installing') return true;
      page = 'runtimes';
      this.open(capabilities);
      return false;
    }, open(capabilities) {
      root.querySelector('#serverSettingsTitle').textContent = `${device().name} · ${text('服务器设置', 'Server settings')}`;
      nav.replaceChildren();
      for (const [id, labels] of Object.entries(pages)) {
        const node = button(text(...labels), () => { page = id; if (!busy) void run(render); }, nav); node.dataset.page = id;
      }
      dialog.showModal();
      if (!capabilities.includes('server-management')) { body.replaceChildren(element('p', text('请更新 CLI 服务端及两端网络组件后使用远程设置。', 'Update the CLI server and both network helpers to use remote settings.'))); return; }
      void run(render);
    } };
  };
})();
