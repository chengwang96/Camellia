'use strict';

const phases = ['scan', 'copy', 'verify-copy', 'rewrite', 'verify-rewrite', 'verify-final', 'verify-source', 'cleanup'];
const labels = {
  en: { title: 'Moving your Camellia data', detail: 'Large data folders can take a while. This window shows the current step.',
    scan: 'Checking the old folder', copy: 'Copying data', 'verify-copy': 'Verifying the copy', rewrite: 'Updating saved paths',
    'verify-rewrite': 'Verifying updated data', 'verify-final': 'Verifying the new folder', 'verify-source': 'Checking the original data',
    cleanup: 'Removing the old folder', done: 'Migration completed', doneDetail: 'Your data has been verified. Camellia is starting.',
    inventory: 'Finding saved paths and internal links', prepare: 'Preparing path updates', 'verify-prepared': 'Checking prepared updates',
    move: 'Renaming the data directory', 'verify-updates': 'Verifying changed metadata', activate: 'Activating the new directory',
    error: 'Migration stopped', warning: 'Data moved; cleanup needs attention', cancel: 'Cancel migration',
    cancelling: 'Canceling…', wait: 'Waiting for the current file to finish.', hint: 'Original data is retained until migration completes.',
    cleanupHint: 'Switching and verifying the new directory. This step cannot be canceled.', elapsed: 'Elapsed', items: 'items', from: 'From', to: 'To', close: 'Close' },
  'zh-CN': { title: '正在迁移 Camellia 数据', detail: '数据目录较大时可能需要较长时间，这里会显示当前步骤和处理进度。',
    scan: '检查旧目录', copy: '复制数据', 'verify-copy': '校验复制结果', rewrite: '更新保存的路径',
    'verify-rewrite': '校验更新后的数据', 'verify-final': '校验新目录', 'verify-source': '复核原始数据', cleanup: '移除旧目录',
    inventory: '查找保存的路径和内部链接', prepare: '准备路径更新', 'verify-prepared': '复核已准备的更新',
    move: '更改数据目录名称', 'verify-updates': '校验已更新的元数据', activate: '启用新目录',
    done: '迁移完成', doneDetail: '数据已通过校验，正在启动 Camellia。', error: '迁移已停止', warning: '数据已迁移，清理尚未完成', cancel: '取消迁移', cancelling: '正在取消…', wait: '正在等待当前文件处理完成。',
    hint: '迁移完成前保留原始数据用于恢复。', cleanupHint: '正在切换并校验新目录，此阶段不可取消。', elapsed: '已用时', items: '项', from: '原目录', to: '新目录', close: '关闭' },
};
const el = id => document.getElementById(id);
let latest = null, cancelling = false;
const size = bytes => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes || 0, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return value.toFixed(unit > 0 ? 1 : 0) + ' ' + units[unit];
};
window.updateMigrationProgress = state => {
  latest = state;
  const t = labels[state.language] || labels.en;
  const complete = ['done', 'error', 'warning'].includes(state.stage);
  document.documentElement.lang = state.language === 'zh-CN' ? 'zh-CN' : 'en';
  el('title').textContent = complete ? t[state.stage] : t.title;
  el('detail').textContent = (state.error || (state.stage === 'done' ? t.doneDetail : t.detail))
    + (state.rollbackError ? '\n' + state.rollbackError : '');
  el('stage').textContent = cancelling && !complete ? t.cancelling : t[state.stage] || t.scan;
  const activePhases = state.phases || phases;
  el('step').textContent = complete ? '' : (activePhases.indexOf(state.stage) + 1) + ' / ' + activePhases.length;
  let fraction = state.totalBytes > 0 && state.stage !== 'rewrite' ? state.processedBytes / state.totalBytes
    : state.totalEntries > 0 ? state.processedEntries / state.totalEntries : null;
  if (state.phaseComplete || ['done', 'warning'].includes(state.stage)) fraction = 1;
  if (state.stage === 'error') fraction = 0;
  if (fraction === null) el('progress').removeAttribute('value');
  else el('progress').value = Math.max(0, Math.min(100, fraction * 100));
  el('count').textContent = complete ? '' : (state.processedEntries || 0).toLocaleString() + (state.totalEntries ? ' / ' + state.totalEntries.toLocaleString() : '')
    + ' ' + t.items + ' · ' + size(state.processedBytes) + (state.totalBytes ? ' / ' + size(state.totalBytes) : '');
  el('current').textContent = state.current || '';
  el('current').title = state.current || '';
  for (const [id, label] of [['source', t.from], ['destination', t.to]]) {
    el(id).textContent = label + ': ' + state[id];
    el(id).title = state[id];
  }
  el('hint').textContent = complete ? '' : cancelling ? t.wait : state.cancellable === false ? t.cleanupHint : t.hint;
  el('cancel').textContent = complete ? t.close : cancelling ? t.cancelling : t.cancel;
  el('cancel').disabled = !complete && (cancelling || state.cancellable === false);
  const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  el('elapsed').textContent = t.elapsed + ' ' + Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
};
el('cancel').addEventListener('click', () => {
  cancelling = !['done', 'error', 'warning'].includes(latest?.stage);
  window.camelliaMigration.cancel();
  if (latest) window.updateMigrationProgress(latest);
});
setInterval(() => { if (latest) window.updateMigrationProgress(latest); }, 1000);
