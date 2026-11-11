'use strict';

// A model can finish a turn after an interim update that only announces the
// next step. The native Codex protocol labels those messages commentary; this
// narrow pattern keeps ordinary short answers, including ones a provider
// mislabels as commentary, from starting another turn.
const ACTION = '(?:start|begin|check|scan|look|inspect|run|search|read|open|analy[sz]e|review|'
  + 'migrate|move|clean|find|list|verify|test|update|fix|create|remove|install|download|fetch|'
  + 'compare|continue|try|see|pull|go ahead)';
const BOUNDARY = '(?:^|[.!?,;，。！？；\\n])\\s*';
const PENDING_WORK = [
  new RegExp(`${BOUNDARY}(?:I(?:'ll| will)|I(?:'m| am) going to|We(?:'ll| will)|We(?:'re| are) going to)`
    + `\\s+(?:now\\s+|first\\s+|quickly\\s+)?${ACTION}\\b`, 'i'),
  new RegExp(`${BOUNDARY}(?:First|Next|Then),?\\s+I(?:'ll| will| am going to|'m going to)\\s+${ACTION}\\b`, 'i'),
  new RegExp(`\\bLet me\\s+(?!know\\b)${ACTION}\\b`, 'i'),
  /(?:^|[，,。！？!?\n])\s*(?:我(?:先|这就|马上|现在|接下来|下面|会先|会去|要先去)|让我(?:先)?|这就|马上|接下来|下面)(?:我)?(?:会|要|将)?(?:先)?(?:去|来)?(?:扫|查|检查|查看|扫描|运行|执行|读取|打开|搜索|找|分析|比较|迁移|移动|清理|整理|下载|安装|修改|更新|创建|删除|看看|看一下|判断|确认|列出|列一下)/,
];
// A message that reports an outcome is a final answer even when its provider
// labels it commentary, so it must not start another native turn.
const COMPLETED = /\b(?:is|are|was|were|all|now|task|work)\s+(?:complete|completed|done|finished|ready)\b|\b(?:completed|finished|fixed|updated|created|deleted|moved|copied|removed|verified|confirmed)\b|^\s*(?:done|finished|complete)[.!。！]?\s*$|(?:已|已经)(?:完成|迁移|扫描|检查|修复|更新|创建|删除|移动|复制|清理)|(?:完成|搞定)了|结果如下|总结如下/i;

function announcesPendingWork(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 2000 || COMPLETED.test(text)) return false;
  return PENDING_WORK.some(pattern => pattern.test(text));
}

module.exports = { announcesPendingWork };
