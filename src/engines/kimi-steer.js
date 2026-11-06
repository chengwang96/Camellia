'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { nativeHistoryModule } = require('./native-history-module');
const { patchKimiHistory } = require('./kimi-native-history');

const handlers = `
function camelliaSteerParams(params) {
  if (!params || typeof params.sessionId !== "string" || params.sessionId.length === 0 || !Array.isArray(params.prompt))
    throw RequestError$1.invalidParams(params, "sessionId and prompt content are required");
  return params;
}
async function camelliaSteer(server, params) {
  await server.ensureAuthed?.();
  const acpSession = server.getSession(params.sessionId);
  if (!acpSession) throw RequestError$1.invalidParams(params, "Session must be loaded");
  const driver = acpSession.driver, expectedTurnId = driver?.turnId;
  if (!driver || driver.settled || !Number.isSafeInteger(expectedTurnId))
    throw RequestError$1.invalidParams(params, "The active turn is not ready or has already finished");
  const input = await acpSession.preparePromptContent(params.prompt);
  if (input === void 0) throw RequestError$1.invalidParams(params, "The active turn was cancelled");
  if (acpSession.driver !== driver || driver.settled || driver.turnId !== expectedTurnId)
    throw RequestError$1.invalidParams(params, "The active turn changed before the instruction was accepted");
  return server.camelliaSteer(params.sessionId, input, expectedTurnId);
}
`;

function patchKimiSteer(source) {
  const anchor = 'function createAcpAgentApp(getServer) {';
  const chain = 'return agent({ name: "kimi-code-acp" })';
  const owner = '\tlet closePromise;\n\tconst close = async () => {';
  const contracts = [
    'IAgentPromptChannel = createDecorator("agentPromptService")',
    'async submitSteer(payload)',
    'activeTurnId: this.active?.id',
    'async preparePromptContent(blocks)',
  ];
  if (source.includes('session/camellia_steer')
      || [anchor, chain, owner, ...contracts].some(marker => source.split(marker).length !== 2)) return null;
  return source.replace(owner, `
  server.camelliaSteer = async (sessionId, input, expectedTurnId) => {
    const native = getLiveSessionById(core.accessor, sessionId);
    const agent = native?.accessor.get(IAgentLifecycleService).handleOf("main");
    const loop = agent?.accessor.get(IAgentLoopService);
    const status = loop?.snapshot();
    if (status?.state !== "running" || status.activeTurnId !== expectedTurnId || status.activePromptId === void 0)
      throw RequestError$1.invalidParams({ sessionId }, "The active turn changed or is unavailable");
    const { id } = loop.submit({
      message: { role: "user", content: [...input] },
      meta: { origin: { kind: "user" }, tracked: true }
    }, { steerIfActive: true });
    const handle = loop.promptHandle(id);
    if (!handle || ["blocked", "failed", "cancelled"].includes(handle.state))
      throw new Error("Kimi did not accept the instruction for the expected turn. Check the conversation before retrying.");
    return { turnId: expectedTurnId, promptId: id };
  };
` + owner).replace(anchor, handlers + '\n' + anchor).replace(chain, chain
    + '.onRequest("session/camellia_steer", camelliaSteerParams, async ctx => camelliaSteer(await getServer(), ctx.params))');
}

const cache = new Map();
function prepareKimiRuntime(runtime) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.resolve(path.dirname(runtime), '../package.json'), 'utf8'));
    const supported = metadata.name === '@moonshot-ai/kimi-code' && ['2.4.0', '2.4.1', '2.5.1'].includes(metadata.version);
    const stat = fs.statSync(runtime), key = runtime + ':' + stat.size + ':' + stat.mtimeMs;
    if (cache.has(key) && fs.existsSync(cache.get(key).file)) return cache.get(key);
    const source = fs.readFileSync(runtime, 'utf8');
    const history = supported ? patchKimiHistory(source) : null;
    const steered = supported ? patchKimiSteer(history || source) : null;
    const patched = steered || history;
    const result = {
      file: patched ? nativeHistoryModule(runtime, patched) : runtime,
      nativeHistory: Boolean(history),
      nativeSteer: Boolean(steered),
    };
    cache.set(key, result);
    return result;
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EROFS'].includes(error.code) || error instanceof SyntaxError)
      return { file: runtime, nativeHistory: false, nativeSteer: false };
    throw error;
  }
}

module.exports = { patchKimiSteer, prepareKimiRuntime };
