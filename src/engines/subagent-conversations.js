'use strict';

const { FLAGS } = require('./conversation-history');
const { mergeTask } = require('../shared/subagents');
const { approval, answer } = require('../main/remote/approvals');
const { projectOutput } = require('../shared/mobile-output');

// Tool-created conversations are real independent runs. Their copied fork
// prefix is context, so only rows after that prefix belong to the child's work.
function view(manager, parentId) {
  const meta = manager.workspaces.sessionMeta();
  return [...manager.items.values()].filter(child => child.controlParentId === parentId).map(child => {
    const rows = [];
    for (const row of manager.historyRows(child, { mask: FLAGS.public, reverse: true, after: child.controlHistoryBoundary || 0 })) {
      rows.unshift(row);
      if (rows.length >= 40) break;
    }
    const active = manager.active.get(child.id) || manager.recovering.get(child.id);
    const request = child.controlSends?.at(-1);
    const last = rows.findLast(row => row.role === 'assistant');
    const busy = manager.busy(child.id), archived = Boolean(meta.archived[child.id]);
    const rawApprovals = active ? [...active.permissions.values()].map(event => ({ ...event, subagentId: 'conversation:' + child.id })) : [];
    const status = active ? rawApprovals.length ? 'waiting' : active.internal ? 'starting' : 'running'
      : busy ? 'starting' : child.interrupted ? last?.runResult?.is_error || request?.state === 'error' ? 'failed' : 'stopped'
      : request?.state === 'error' ? 'failed' : last || request?.state === 'finished' ? 'completed' : 'ready';
    const live = active?.events?.length ? projectOutput(active.events).text : active?.text || active?.assistant?.join('\n\n') || '';
    const task = mergeTask(null, { id: 'conversation:' + child.id, title: meta.titles[child.id] || child.title,
      goal: child.controlSends?.[0]?.prompt || rows.find(row => row.role === 'user')?.text || '', status,
      progress: live || last?.mobileText || last?.text || request?.error || '',
      result: !active && last ? last.mobileText || last.text || last.runResult?.result || '' : '',
      turnId: active ? 'run:' + active.facade.gen : 'seq:' + child.seq,
      history: rows.map(row => ({ type: row.role, text: row.mobileText || row.text || '' })),
      artifacts: rows.filter(row => row.role === 'assistant').flatMap(row => row.artifacts || []),
      canReply: !busy && !archived, canStop: busy && !archived, approvals: rawApprovals.map(approval),
    }, { engine: active?.engine || child.currentEngine, userSeq: child.controlUserSeq, at: child.updatedAt });
    return { ...task, createdAt: child.createdAt, connected: !archived, managedConversationId: child.id, cwd: child.cwd };
  });
}

function notify(manager, childId) {
  const child = manager.items.get(childId);
  if (!child?.controlParentId || !manager.items.has(child.controlParentId)) return;
  try { manager.onEvent({ type: 'gui:subagent', session_id: child.controlParentId,
    engine: manager.get(child.controlParentId).currentEngine, tasks: manager.subagentView(child.controlParentId) }); }
  catch (error) { manager.log('Could not publish child conversation status: ' + error.message); }
}

async function command(manager, parentId, task, payload) {
  const child = manager.get(task.managedConversationId);
  if (child.controlParentId !== parentId || manager.workspaces.sessionMeta().archived[child.id]) throw new Error('This child conversation is unavailable');
  if (payload.expectedTurnId !== task.turnId) throw new Error('This subtask changed; refresh before operating');
  if (payload.operation === 'stop' && task.canStop) return manager.cancel({ sessionId: child.id });
  if (payload.operation === 'reply' && task.canReply) {
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 32000) throw new Error('Enter a child message of at most 32000 characters');
    const run = await manager.send(child.currentEngine, { sessionId: child.id, prompt: payload.prompt });
    if (!run.ok) throw new Error(run.error || 'The child did not accept the message');
    // The independent run completes asynchronously, like a normal conversation.
    return { ok: true };
  }
  if (payload.operation === 'approve') {
    const active = manager.active.get(child.id);
    const event = active?.permissions.get(payload.approvalId);
    if (!event) throw new Error('This child request is no longer pending');
    const response = answer({ ...event, subagentId: task.id }, payload);
    const result = await manager.command(active.engine, 'control-respond', { sessionId: child.id,
      runId: active.facade.gen, requestId: event.requestId, ...response });
    if (!result.ok) throw new Error('The child request changed before the answer was accepted');
    return result;
  }
  throw new Error('This child action is unavailable');
}

module.exports = { view, notify, command };
