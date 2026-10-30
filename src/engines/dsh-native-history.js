'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { nativeHistoryModule } = require('./native-history-module');

// Adapt ACP's per-session model/MCP composition to the installed Host's real
// fork command. Host owns event cuts, inherited counts and synthetic closers.
const handlers = `
  async function camelliaBoundary(params) {
    assertOpen();
    const source = await ctx.sessionQuery.observeSession(params.sessionId);
    try {
      const user = source.events.findLast(event => event.type === "user/message" && event.data.source.kind === "user");
      return { atSeq: user ? user.seq - 1 : -1,
        text: user?.data.content?.filter(part => part.type === "text").map(part => part.text).join("\\n") || "" };
    } finally { source[Symbol.dispose](); }
  }
  async function camelliaFork(params, signal) {
    assertOpen();
    validateWorkspaceParams(params);
    if (params.atSeq !== undefined && (!Number.isSafeInteger(params.atSeq) || params.atSeq < 0))
      throw invalidParams("atSeq must be a non-negative safe integer");
    const source = await ctx.sessionQuery.observeSession(params.sessionId);
    try {
      if (source.header.origin === "subagent" || !await sameDirectory(source.header.cwd, params.cwd))
        throw invalidParams("Fork source must be an ordinary session in the same workspace");
    } finally { source[Symbol.dispose](); }
    let handle, record, id;
    const modelControl = new AcpModelControl(ctx.llm, initialSelection(config));
    const setup = async agentCtx => {
      modelControl.install(agentCtx);
      await mountAcpMcpServers(agentCtx, params.mcpServers || [], params.cwd);
    };
    // SharedConversations owns the workspace mapping. ACP does not mount the
    // Host UI's workspace registry; keep the native cwd and fork lineage.
    const controller = new CamelliaHostFork({
      sessionQuery: ctx.sessionQuery,
      workspaceRegistry: { list: () => [] },
      agentDefaultModel: { currentSelection: () => ({ provider: config.provider, model: config.model }) },
      agents: { create: async options => {
        handle = await ctx.agents.create({ ...options, signal });
        return handle;
      } }
    }, { presetForObservation: () => undefined, composeAgent: async () => ({ setup }) }, params.cwd);
    try {
      const result = await controller.fork({ sessionId: params.sessionId, ...(params.atSeq === undefined ? {} : { atSeq: params.atSeq }) });
      id = result.sessionId;
      record = new AcpSession(ctx, handle, modelControl, notify);
      if (closed || signal?.aborted) throw internalError("Fork canceled");
      sessions.set(id, record);
      await ctx.sessions.flush(record.agent.session);
      return { sessionId: id, configOptions: await record.configOptions(signal) };
    } catch (error) {
      if (id) sessions.delete(id);
      if (record) await record.close("fork activation failed");
      else if (handle) await handle.dispose();
      throw internalError(error.message);
    }
  }
`;

function patchDshHistory(source, hostFile) {
  const apply = '\tconst implementation = {';
  const chain = 'agent({ name: "deepseek-harness-acp" })';
  const resume = 'persisted.origin === "subagent" || persisted.parentSession !== void 0';
  const listing = 'header.origin === "subagent" || header.parentSession !== void 0';
  const capability = '\t\t\t\t\t\tresume: {}';
  const inject = '\t"sessionPersistence",';
  if ([apply, chain, resume, listing, capability, inject].some(marker => source.split(marker).length !== 2)) return null;
  return 'import { SessionCommandController as CamelliaHostFork } from ' + JSON.stringify(pathToFileURL(hostFile).href) + ';\n'
    + source.replace(inject, inject + '\n\t"sessionQuery",')
      .replace(resume, 'persisted.origin === "subagent" || persisted.parentSession !== void 0 && !persisted.isSeeded')
      .replace(listing, 'header.origin === "subagent" || header.parentSession !== void 0 && !header.isSeeded')
      .replace(capability, capability + ',\n\t\t\t\t\t\tfork: {}')
      .replace(apply, handlers + '\n' + apply)
      .replace(chain, chain
        + '.onRequest("session/camellia_history_boundary", params => params, ({ params }) => camelliaBoundary(params))'
        + '.onRequest("session/camellia_fork", params => params, ({ params, signal }) => camelliaFork(params, signal))'
        + '.onRequest(methods.agent.session.fork, ({ params, signal }) => camelliaFork(params, signal))');
}

const cache = new Map();
function prepareDshHistory(runtime) {
  try {
    const requireNative = createRequire(path.resolve(runtime.file));
    const acpFile = requireNative.resolve('@deepseek-ai/dsh-acp');
    const hostFile = requireNative.resolve('@deepseek-ai/dsh-api-session-controller');
    const metadata = file => JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), '../package.json'), 'utf8'));
    if (metadata(acpFile).version !== '0.2.1-rc.2' || metadata(hostFile).version !== '0.2.1-rc.2') return null;
    const stats = [acpFile, hostFile].map(file => { const s = fs.statSync(file); return file + ':' + s.size + ':' + s.mtimeMs; }).join('|');
    if (cache.has(stats) && fs.existsSync(cache.get(stats))) return cache.get(stats);
    const host = fs.readFileSync(hostFile, 'utf8');
    if (!host.includes('var SessionCommandController = class') || !host.includes('const seed = buildForkSeed(source.events, boundary);')) return null;
    const derivedHost = nativeHistoryModule(hostFile, host + '\nexport { SessionCommandController };\n');
    const patched = patchDshHistory(fs.readFileSync(acpFile, 'utf8'), derivedHost);
    if (!patched) return null;
    const file = nativeHistoryModule(acpFile, patched);
    cache.set(stats, file);
    return file;
  } catch (error) {
    if (['ENOENT', 'MODULE_NOT_FOUND', 'EACCES', 'EPERM', 'EROFS'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

module.exports = { patchDshHistory, prepareDshHistory };
