'use strict';

(() => {
const labels = {
  zh: { button: '连接诊断', title: '连接路径诊断', hint: '手机使用要测试的网络，打开这台电脑并保持 Camellia 在前台。将连续探测 10 次，观察是否从中继切换为直连。',
    note: '探测方向为电脑 → 手机。这里的直连表示 UDP 点对点；探测延迟与手机的应用请求延迟不同。',
    direct: 'UDP 点对点直连', derp: 'DERP 官方中继', 'peer-relay': '节点中继', unknown: '路径未知', unreachable: '超时或不可达',
    count: '次数', time: '时间', path: '路径', latency: '延迟', running: '正在检测', complete: '检测完成', stopped: '已停止', failed: '检测未完成',
    stop: '停止检测', retry: '重新检测', copy: '复制报告', copied: '报告已复制', close: '关闭', report: 'Camellia 连接路径诊断', computer: '电脑', device: '设备',
    started: '开始', direction: '探测方向：电脑 → 手机 · 内置 Tailscale', counts: '路径次数', empty: '尚无探测结果',
    phoneFirst: '请先在手机上打开这台电脑，再重新检测。', enableFirst: '请先开启手机访问。', restart: '请完全退出 Camellia（包括托盘）并重新启动，以加载更新后的网络诊断。',
    changed: '设备连接已改变，请重新检测。', busy: '已有探测正在运行，请稍后重新检测。', invalid: '无法读取诊断结果，请重启 Camellia 后重试。' },
  en: { button: 'Connection diagnostics', title: 'Connection path diagnostics', hint: 'Keep Camellia open on the phone, connected to this computer over the network you want to test. Ten probes show whether the path changes from a relay to direct UDP.',
    note: 'Probes run from computer to phone. Direct means UDP peer-to-peer; these timings differ from mobile application request latency.',
    direct: 'Direct UDP', derp: 'DERP relay', 'peer-relay': 'Peer relay', unknown: 'Unknown path', unreachable: 'Timed out or unreachable',
    count: 'Probe', time: 'Time', path: 'Path', latency: 'Latency', running: 'Testing', complete: 'Complete', stopped: 'Stopped', failed: 'Incomplete',
    stop: 'Stop testing', retry: 'Test again', copy: 'Copy report', copied: 'Report copied', close: 'Close', report: 'Camellia connection path diagnostics', computer: 'Computer', device: 'Device',
    started: 'Started', direction: 'Direction: computer → phone · embedded Tailscale', counts: 'Path counts', empty: 'No probe results yet',
    phoneFirst: 'Open this computer on the phone, then test again.', enableFirst: 'Enable mobile access first.', restart: 'Fully quit Camellia, including the tray, and restart it to load the updated network diagnostics.',
    changed: 'The device connection changed. Test again.', busy: 'Another probe is running. Try again shortly.', invalid: 'Unable to read the diagnostic result. Restart Camellia and retry.' },
};
let current = null;
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function timestamp(value) {
  const date = new Date(value), pad = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
async function copyText(value, root) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const field = node('textarea'); field.value = value; field.readOnly = true; field.className = 'diagnostic-copy-field';
  root.append(field); field.select();
  try { if (!document.execCommand('copy')) throw new Error('Clipboard unavailable'); }
  finally { field.remove(); }
}
function open({ root, device, computerName, language, probe }) {
  if (current) { current.focus(); return; }
  const text = labels[language === 'en' ? 'en' : 'zh'];
  const dialog = node('dialog', undefined, 'tailnet-diagnostics'); current = dialog;
  dialog.setAttribute('aria-label', text.title);
  const title = node('h2', `${text.title} · ${device.name}`);
  const hint = node('p', text.hint, 'diagnostic-hint');
  const status = node('p', '', 'diagnostic-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const summary = node('p', '', 'diagnostic-hint');
  const error = node('p', '', 'diagnostic-error'); error.setAttribute('role', 'alert');
  const wrapper = node('div', undefined, 'diagnostic-table');
  const table = node('table'), head = node('thead'), heading = node('tr'), body = node('tbody');
  for (const label of [text.count, text.time, text.path, text.latency]) { const cell = node('th', label); cell.scope = 'col'; heading.append(cell); }
  head.append(heading); table.append(head, body); wrapper.append(table);
  const note = node('p', text.note, 'diagnostic-hint');
  const actions = node('div', undefined, 'diagnostic-actions');
  const retry = node('button', text.retry), stop = node('button', text.stop), copy = node('button', text.copy), close = node('button', text.close);
  for (const button of [retry, stop, copy, close]) button.type = 'button';
  actions.append(retry, stop, copy, close);
  dialog.append(title, hint, status, summary, wrapper, error, note, actions);
  let samples = [], active = false, aborted = false, closed = false, startedAt = Date.now(), fatal = '', wake = null;
  const pathText = sample => {
    if (sample.path === 'direct') return `${text.direct} · ${sample.endpoint || '—'}`;
    if (sample.path === 'derp') return `${text.derp} · ${[sample.derpRegionCode, sample.derpRegionName].filter(Boolean).join(' / ') || sample.derpRegionId || '—'}`;
    if (sample.path === 'peer-relay') return `${text['peer-relay']} · ${sample.peerRelay || '—'}`;
    return text[sample.path] || text.unknown;
  };
  const latencyText = sample => typeof sample.latencyMs === 'number' && Number.isFinite(sample.latencyMs) && sample.latencyMs >= 0 ? `${sample.latencyMs.toFixed(1)} ms` : '—';
  const counts = () => [...new Set(samples.map(sample => sample.path))].map(path => `${text[path] || text.unknown} ${samples.filter(sample => sample.path === path).length}`).join(' · ');
  const outcome = () => fatal ? text.failed : aborted ? text.stopped : active ? text.running : text.complete;
  const report = () => [text.report, `${text.computer}: ${computerName || 'Camellia'}`, `${text.device}: ${device.name}`, `${text.started}: ${timestamp(startedAt)}`,
    text.direction, `${outcome()} (${samples.length}/10)`, `${text.counts}: ${counts() || text.empty}`,
    ...samples.map((sample, index) => `${index + 1}. ${timestamp(sample.checkedAt)} | ${sample.peerAddress} | ${pathText(sample)} | ${latencyText(sample)}`),
    ...(fatal ? [fatal] : []), text.note].join('\n');
  function update() {
    status.textContent = `${outcome()} (${samples.length}/10)`;
    summary.textContent = counts() || text.empty;
    error.textContent = fatal;
    retry.disabled = active; stop.disabled = !active || aborted; copy.disabled = !samples.length;
  }
  function append(sample) {
    samples.push(sample);
    const row = node('tr');
    for (const value of [samples.length, new Date(sample.checkedAt).toLocaleTimeString(language === 'en' ? 'en-GB' : 'zh-CN', { hour12: false }), pathText(sample), latencyText(sample)]) row.append(node('td', value));
    row.dataset.path = sample.path; body.append(row);
  }
  function errorText(error) {
    return ({ 'Open this computer on the phone first': text.phoneFirst, 'Enable mobile access first': text.enableFirst,
      'Network diagnostics are unavailable': text.restart, 'Invalid device': text.changed,
      'The device connection changed; run diagnostics again': text.changed, 'A connection probe is already running': text.busy,
      'Network diagnostics require the updated helper. Fully quit Camellia, including the tray, and restart it.': text.restart })[error.message] || error.message;
  }
  async function run() {
    if (active || closed) return;
    active = true; aborted = false; fatal = ''; samples = []; startedAt = Date.now(); body.replaceChildren(); copy.textContent = text.copy; update();
    try {
      for (let index = 0; index < 10 && !aborted && !closed; index++) {
        const sample = await probe();
        if (aborted || closed) break;
        if (!sample || !['direct', 'derp', 'peer-relay', 'unknown', 'unreachable'].includes(sample.path)
            || !Number.isFinite(sample.checkedAt) || typeof sample.peerAddress !== 'string') throw new Error(text.invalid);
        append(sample); update();
        if (index < 9) await new Promise(resolve => {
          const timer = setTimeout(() => { wake = null; resolve(); }, 1000);
          wake = () => { clearTimeout(timer); wake = null; resolve(); };
        });
      }
    } catch (failure) { if (!aborted && !closed) fatal = errorText(failure); }
    finally { active = false; if (!closed) update(); }
  }
  function cancel() { aborted = true; wake?.(); update(); }
  stop.addEventListener('click', cancel);
  retry.addEventListener('click', () => { void run(); });
  copy.addEventListener('click', async () => {
    try { await copyText(report(), dialog); copy.textContent = text.copied; }
    catch (failure) { error.textContent = failure.message; }
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { closed = true; aborted = true; wake?.(); dialog.remove(); if (current === dialog) current = null; });
  root.append(dialog); dialog.showModal(); void run();
}
window.CamelliaNetworkDiagnostics = { open, close: () => current?.close() };
})();
