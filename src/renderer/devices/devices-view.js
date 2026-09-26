'use strict';

// One markup source for both hosts: the standalone devices.html debugging page
// and the in-settings CLI devices page. The settings host prefixes every id so
// the page can coexist with the other settings sections in one document.
(function (root) {
  const TEMPLATE = prefix => `
<aside>
  <header class="brand"><img src="../../../assets/icon-256.png" width="38" height="38" alt="Camellia cat"><div>Camellia<small data-copy="devices">CLI 设备</small></div></header>
  <label for="${prefix}device" data-copy="target">目标设备</label><select id="${prefix}device"><option value="" data-copy="choose">选择 CLI 设备</option></select>
  <button id="${prefix}add" data-copy="add">＋ 添加 CLI 设备</button>
  <button id="${prefix}cancelPair" hidden data-copy="cancel">取消</button>
  <details id="${prefix}networkPanel"><summary data-copy="network">本机 Tailscale 连接</summary><p id="${prefix}networkState"></p><p class="hint" data-copy="networkHint">与「手机访问」共用同一个内置 Tailscale 身份，登录一次两边生效；仅启动网络不会开启本机远程访问。断开或退出登录请到“手机访问”页面操作。</p>
    <div class="actions"><button id="${prefix}networkStart" data-copy="login">启动 / 登录</button><button id="${prefix}openLogin" data-copy="browser">打开登录链接</button><button id="${prefix}networkRefresh" data-copy="refresh">刷新</button></div>
  </details>
  <div class="actions"><button id="${prefix}newWorkspace" data-write data-copy="newWorkspace">新建工作区</button><button id="${prefix}newChat" data-write data-copy="newChat">新建会话</button></div>
  <button id="${prefix}importApi" data-write data-copy="importApi">导入本机 API 设置</button>
  <button id="${prefix}nativeSettings" data-write data-copy="nativeSettings">服务器原生设置</button>
  <div class="actions"><button id="${prefix}selectChats" data-copy="selectChats">多选</button><button id="${prefix}deleteSelected" data-write data-copy="deleteSelected" hidden>删除选中</button></div>
  <nav id="${prefix}tree" class="tree" aria-label="Remote workspaces"></nav>
  <button id="${prefix}more" hidden data-copy="more">加载更多会话</button>
  <details id="${prefix}archivePanel"><summary data-copy="archived">已归档</summary><button id="${prefix}loadArchived" data-copy="refresh">刷新</button><div id="${prefix}archived"></div><button id="${prefix}moreArchived" data-copy="more" hidden>更多</button></details>
  <footer><button id="${prefix}forget" data-copy="forget">忘记设备</button><p class="hint" data-copy="localHint">本机会话保留在原工作台，不会合并到这里。</p></footer>
</aside>
<main>
  <header class="page-head"><div><p class="eyebrow" data-copy="remote">远程工作台 · 开发预览</p><h1 id="${prefix}targetName" data-copy="choose">选择 CLI 设备</h1><p id="${prefix}connection" class="connection" role="status" data-copy="offline">未连接 · 禁止写操作</p></div><button id="${prefix}refresh" data-copy="reconnect">连接 / 刷新</button></header>
  <p id="${prefix}error" class="cli-error" role="alert"></p><p id="${prefix}notice" role="status"></p>
  <section id="${prefix}transfers" class="transfers" aria-live="polite"></section>
  <section id="${prefix}empty" class="empty"><img src="../../../assets/icon-256.png" width="80" height="80" alt=""><h2 data-copy="emptyTitle">把服务器的工作带到这里</h2><p data-copy="emptyBody">登录本机 Tailscale，添加 CLI 设备，再在服务器批准配对。</p><p class="hint" data-copy="boundary">文件、会话与引擎均在服务器运行。订阅登录仍需在服务器完成。</p></section>
  <section id="${prefix}chat" hidden>
    <div class="chat-head"><h2 id="${prefix}chatTitle"></h2><div class="actions"><button id="${prefix}pin" data-write data-copy="pin">置顶</button><button id="${prefix}rename" data-write data-copy="rename">重命名</button><button id="${prefix}archive" data-write data-copy="archive">归档</button><button id="${prefix}deleteChat" data-write class="danger" data-copy="delete">删除会话</button></div></div>
    <button id="${prefix}older" data-copy="older" hidden>加载更早消息</button><div id="${prefix}messages" class="messages" aria-live="polite"></div><p id="${prefix}historyHint" class="hint"></p><div id="${prefix}approvals"></div>
    <details id="${prefix}artifactPanel" class="artifact-panel"><summary data-copy="artifacts">产物文件</summary><button id="${prefix}loadArtifacts" data-copy="refreshFiles">刷新文件</button><div id="${prefix}artifacts" class="artifacts"></div><button id="${prefix}moreArtifacts" data-copy="moreFiles" hidden>更多文件</button></details>
    <form id="${prefix}composer" class="composer"><label for="${prefix}prompt" data-copy="message">发送到当前服务器</label><div id="${prefix}attachmentTray" class="attachment-tray"></div><textarea id="${prefix}prompt" maxlength="16000" rows="3" required></textarea><div class="actions"><button id="${prefix}attach" type="button" data-write data-copy="attach">附件</button><button id="${prefix}configure" type="button" data-write data-copy="configure">模型与权限</button><button id="${prefix}stop" type="button" data-write data-copy="stop">停止响应</button><button id="${prefix}send" type="submit" data-write class="primary" data-copy="send">发送</button></div></form>
  </section>
</main>
<dialog id="${prefix}dialog" class="dialog"><form id="${prefix}dialogForm"><h2 id="${prefix}dialogTitle"></h2><p id="${prefix}dialogHint" class="hint"></p><div id="${prefix}fields" class="fields"></div><p id="${prefix}dialogError" class="cli-error" role="alert"></p><div class="actions"><button id="${prefix}cancel" type="button" data-copy="cancel">取消</button><button id="${prefix}submit" type="submit" class="primary" data-copy="confirm">确认</button></div></form></dialog>
<dialog id="${prefix}nativeDialog" class="native-dialog"><form id="${prefix}nativeForm"><h2 id="${prefix}nativeTitle"></h2><p id="${prefix}nativeWarning" class="native-warning"></p><label for="${prefix}nativeDocument" data-copy="document">配置文档</label><select id="${prefix}nativeDocument"></select><label for="${prefix}nativeText" id="${prefix}nativeFormat"></label><textarea id="${prefix}nativeText" class="native-text" spellcheck="false" rows="18"></textarea><label class="native-confirm"><input id="${prefix}nativeConfirm" type="checkbox" required><span data-copy="nativeConfirm">我确认修改这台服务器的配置，命令、MCP、hooks 可能执行代码。</span></label><p id="${prefix}nativeError" class="cli-error" role="alert"></p><div class="actions"><button id="${prefix}nativeCancel" type="button" data-copy="cancel">取消</button><button id="${prefix}nativeSave" type="submit" class="primary" data-copy="save">保存</button></div></form></dialog>`;

  function mount() {
    const host = document.getElementById('cliDevicesRoot');
    if (!host) return;
    const embedded = Boolean(document.getElementById('devicesPage'));
    host.classList.add('cli-devices', embedded ? 'embedded' : 'standalone');
    if (!embedded) document.body.classList.add('cli-devices-standalone');
    host.innerHTML = TEMPLATE(embedded ? 'cli-' : '');
    host.dataset.embedded = String(embedded);
  }
  const api = { template: TEMPLATE, mount, prefix: () => document.getElementById('devicesPage') ? 'cli-' : '' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CamelliaDevicesView = api;
  if (typeof document !== 'undefined') mount();
})(typeof window === 'undefined' ? globalThis : window);
