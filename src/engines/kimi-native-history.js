'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { nativeHistoryModule } = require('./native-history-module');

// The official engine owns undo, including checkpoint/compaction validation
// and derived-state reconciliation. Only expose that engine operation over
// ACP; do not splice its event log or reproduce its state machine here.
const handlers = `
function camelliaHistoryParams(params) {
  if (!params || typeof params.sessionId !== "string")
    throw RequestError$1.invalidParams(params, "sessionId is required");
  return params;
}
async function camelliaHistoryState(server, params) {
  await server.ensureAuthed();
  if (!server.getSession(params.sessionId)) throw RequestError$1.invalidParams(params, "Session must be loaded");
  const history = (await server.klient.session(params.sessionId).agent("main").getContext()).history;
  const check = precheckUndo(history, 1);
  if (!check.ok) return { unavailable: check.reason };
  const anchor = history.findLast(isUndoAnchor);
  const text = anchor?.content?.filter(part => part.type === "text").map(part => part.text).join("\\n") || "";
  const { createHash } = await import("node:crypto");
  return { undoCount: 1, undoDigest: createHash("sha256").update(JSON.stringify(history)).digest("hex"), text };
}
async function camelliaForkUndo(server, params) {
  if (params.undoCount !== 1 || !/^[a-f0-9]{64}$/.test(params.undoDigest || ""))
    throw RequestError$1.invalidParams(params, "An exact undo boundary is required");
  const boundary = await camelliaHistoryState(server, params);
  if (boundary.unavailable || boundary.undoDigest !== params.undoDigest)
    throw RequestError$1.invalidParams(undefined, "Native history changed or crossed a compaction boundary");
  let child;
  try {
    child = await server.unstable_forkSession({ sessionId: params.sessionId });
    await server.camelliaUndo(child.sessionId);
    await server.closeSession({ sessionId: child.sessionId });
    const rebound = await server.resumeSession({ sessionId: child.sessionId, mcpServers: params.mcpServers || [] });
    return { ...child, ...rebound };
  } catch (error) {
    if (child) await server.closeSession({ sessionId: child.sessionId }).catch(() => {});
    throw error;
  }
}
`;

function patchKimiHistory(source) {
  const anchor = 'function createAcpAgentApp(getServer) {';
  const chain = 'return agent({ name: "kimi-code-acp" })';
  const owner = '\tlet closePromise;\n\tconst close = async () => {';
  // Pin the integration to the verified engine/ACP contracts. A changed
  // runtime retains portable editing instead of guessing at private APIs.
  if (source.split(anchor).length !== 2 || source.split(chain).length !== 2 || source.split(owner).length !== 2
      || !source.includes('async undoHistory(count = 1)') || !source.includes('function precheckUndo(history, count)')
      || !source.includes('async unstable_forkSession(params)')) return null;
  return source.replace(owner, `
  server.camelliaUndo = async sessionId => {
    const session = getLiveSessionById(core.accessor, sessionId);
    const agent = session?.accessor.get(IAgentLifecycleService).handleOf("main");
    if (!agent) throw new Error("Forked main agent is not live");
    await agent.accessor.get(IAgentConversationUndoService).undo(1);
  };
` + owner).replace(anchor, handlers + '\n' + anchor).replace(chain, chain
    + '.onRequest("session/camellia_history_boundary", camelliaHistoryParams, ctx => camelliaHistoryState(getServer(), ctx.params))'
    + '.onRequest("session/camellia_fork_undo", camelliaHistoryParams, ctx => camelliaForkUndo(getServer(), ctx.params))');
}

const cache = new Map();
function prepareKimiHistory(runtime) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.resolve(path.dirname(runtime), '../package.json'), 'utf8'));
    if (metadata.name !== '@moonshot-ai/kimi-code' || metadata.version !== '2.4.0') return null;
    const stat = fs.statSync(runtime), key = runtime + ':' + stat.size + ':' + stat.mtimeMs;
    if (cache.has(key) && fs.existsSync(cache.get(key))) return cache.get(key);
    const source = fs.readFileSync(runtime, 'utf8'), patched = patchKimiHistory(source);
    if (!patched) return null;
    const file = nativeHistoryModule(runtime, patched);
    cache.set(key, file);
    return file;
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EROFS'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

module.exports = { prepareKimiHistory, patchKimiHistory };
