// Observe the pinned DSH lifecycle inside its own process. Do not wrap tools,
// change scheduling, acquire session leases, or modify native task records.
export function apply(ctx) {
  const tasks = new Map();
  const words = blocks => (blocks || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const send = (record, patch) => {
    record.task = { ...record.task, ...patch };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: record.root, update: { sessionUpdate: 'camellia_subagent', task: record.task },
    } }) + '\n');
  };
  const start = info => {
    const child = ctx.agents.get(info.id), header = child?.session.header;
    if (!header?.parentSession || header.origin !== 'subagent') return;
    let root = header.parentSession;
    const seen = new Set([info.id]);
    while (!seen.has(root)) {
      seen.add(root);
      const parent = ctx.agents.get(root)?.session.header.parentSession;
      if (!parent) break;
      root = parent;
    }
    if (root === info.id || seen.size > 32) return;
    const record = { root, task: { id: info.id, parentId: header.parentSession, turnId: info.runId,
      title: 'Subtask', status: 'running', canReply: false, canStop: false, history: [] } };
    tasks.set(info.id, record); send(record, {});
  };
  ctx.on('subagent/start', start);
  ctx.on('subagent/end', info => {
    const record = tasks.get(info.id); if (!record || record.task.turnId !== info.runId) return;
    const result = words(info.lastAssistantMessage);
    send(record, { status: info.stopReason === 'completed' ? 'completed' : info.stopReason === 'aborted' ? 'stopped' : 'failed',
      ...(result ? { result, progress: result } : {}) });
  });
  ctx.on('session/event', (session, event) => {
    const record = tasks.get(session.id); if (!record) return;
    let progress;
    if (event.type === 'user/message') {
      const goal = words(event.data.message?.content);
      if (goal) send(record, { goal, title: goal.split('\n')[0].slice(0, 90) });
    } else if (event.type === 'assistant/message') progress = words(event.data.message?.content);
    else if (event.type === 'tool/call') progress = event.data.name;
    else if (event.type === 'tool/result') progress = words(event.data.message?.content);
    if (progress) send(record, { progress: progress.slice(-16000), history: [
      ...record.task.history, { type: event.type, text: progress.slice(-1800) },
    ].slice(-40) });
  });
}
