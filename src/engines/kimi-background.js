'use strict';

// Expose the native session's task API over ACP. The engine still owns task
// cancellation, process trees and completion notifications.
const handlers = `
function camelliaBackgroundParams(params) {
  if (!params || typeof params.sessionId !== "string" || !params.sessionId
      || !Array.isArray(params.taskIds) || !params.taskIds.length || params.taskIds.length > 100
      || params.taskIds.some(id => typeof id !== "string" || !id))
    throw RequestError$1.invalidParams(params, "sessionId and taskIds are required");
  return params;
}
async function camelliaStopBackground(server, params) {
  await server.ensureAuthed?.();
  if (!server.getSession(params.sessionId)) throw RequestError$1.invalidParams(params, "Session must be loaded");
  const agent = server.klient.session(params.sessionId).agent("main");
  await Promise.all(params.taskIds.map(taskId => agent.stopTask({ taskId, reason: "User initiated stop" })));
  return {};
}
async function camelliaReadBackground(server, params) {
  await server.ensureAuthed?.();
  if (!server.getSession(params.sessionId)) throw RequestError$1.invalidParams(params, "Session must be loaded");
  const ids = new Set(params.taskIds);
  const tasks = await server.klient.session(params.sessionId).agent("main").getTasks({ activeOnly: false });
  return { tasks: tasks.filter(task => ids.has(task.taskId)).map(task => ({
    id: task.taskId, description: task.description, kind: task.kind, status: task.status
  })) };
}
`;

function patchKimiBackground(source) {
  const anchor = 'function createAcpAgentApp(getServer) {';
  const chain = 'return agent({ name: "kimi-code-acp" })';
  if (source.includes('session/camellia_stop_background')
      || [anchor, chain, 'stopTask: async (input) => {', 'getTasks: (input) =>'].some(marker => source.split(marker).length !== 2)) return null;
  return source.replace(anchor, handlers + '\n' + anchor).replace(chain, chain
    + '.onRequest("session/camellia_stop_background", camelliaBackgroundParams, async ctx => camelliaStopBackground(await getServer(), ctx.params))'
    + '.onRequest("session/camellia_read_background", camelliaBackgroundParams, async ctx => camelliaReadBackground(await getServer(), ctx.params))');
}

module.exports = { patchKimiBackground };
