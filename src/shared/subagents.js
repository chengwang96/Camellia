'use strict';

const STATES = new Set(['ready', 'starting', 'running', 'waiting', 'completed', 'failed', 'stopped', 'unavailable']);
const clip = (value, max = 16000) => typeof value === 'string' ? value.slice(-max) : '';
function mergeTask(previous, update, { engine, userSeq, at = Date.now() } = {}) {
  if (!update || typeof update.id !== 'string' || !/^[a-zA-Z0-9_./:-]{1,200}$/.test(update.id)) return null;
  const task = { ...previous, id: update.id, engine: previous?.engine || engine,
    userSeq: previous?.userSeq ?? userSeq, createdAt: previous?.createdAt || at, updatedAt: at };
  for (const key of ['title', 'goal', 'progress', 'result', 'turnId', 'parentId']) if (update[key] !== undefined) task[key] = clip(update[key], key === 'title' ? 180 : ['turnId', 'parentId'].includes(key) ? 200 : 16000);
  task.title ||= task.goal?.split('\n')[0]?.slice(0, 90) || 'Subtask';
  if (STATES.has(update.status)) task.status = update.status;
  task.status ||= 'starting';
  if (Array.isArray(update.history)) task.history = update.history.slice(-40).map(row => ({ type: clip(row.type, 80), text: clip(row.text, 1800) }));
  if (Array.isArray(update.artifacts)) task.artifacts = update.artifacts.slice(0, 100).filter(file => typeof file?.path === 'string').map(file => ({ path: clip(file.path, 2000) }));
  if (Array.isArray(update.approvals)) task.approvals = update.approvals.slice(0, 12);
  if (typeof update.canReply === 'boolean') task.canReply = update.canReply;
  if (typeof update.canStop === 'boolean') task.canStop = update.canStop;
  return task;
}
function forkTasks(tasks, boundary) {
  return (tasks || []).filter(task => Number.isSafeInteger(task.userSeq) && task.userSeq < boundary)
    .map(task => ({ ...structuredClone(task), canReply: false, canStop: false, approvals: [], status:
      ['starting', 'running', 'waiting'].includes(task.status) ? 'unavailable' : task.status }));
}
module.exports = { mergeTask, forkTasks };
