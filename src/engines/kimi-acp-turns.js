'use strict';

// Kimi 2.4 queues prompts behind turns started by background-task completion
// and maps most failed turns to end_turn. Wait for the submitted prompt and
// forward failures over ACP's error channel, leaving native scheduling intact.
function patchKimiAcpTurns(source) {
  const replacements = [
    ['return this.driveLaunch(this.agent.prompt({ input }));', `const promptId = globalThis.crypto.randomUUID();
      return this.driveLaunch(this.agent.prompt({ input, promptId }), promptId);`],
    ['driveLaunch(launch) {', 'driveLaunch(launch, promptId) {'],
    ['settled: false,\n\t\t\t\t\tearly: []', 'settled: false,\n\t\t\t\t\tpromptId,\n\t\t\t\t\tearly: []'],
    ['if (launched === void 0) {\n\t\t\t\t\t\tthis.settleDriver', `if (launched === void 0) {
            if (promptId !== void 0) {
              if (driver.cancelRequested) this.camelliaCancelPrompt(promptId);
              else if (driver.turnId === void 0) this.emit({ sessionId: this.sessionId, update: {
                sessionUpdate: "agent_message_chunk", _meta: { camelliaQueuedPrompt: true },
                content: { type: "text", text: "Kimi is finishing background work; this request is queued.\\n\\n" }
              } });
              return;
            }
            this.settleDriver`],
    ['driver.turnId = launched.turn_id;', 'if (driver.turnId === void 0) driver.turnId = launched.turn_id;'],
    ['driver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error) });', `if (event.reason === "failed" && error?.code !== "provider.filtered") {
          driver.reject(RequestError$1.internalError({ code: error?.code,
            statusCode: error?.details?.statusCode, retryable: error?.retryable },
            error?.message || "Kimi turn failed"));
          return;
        }
        driver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error) });`],
    ['const events = this.agent.events;\n\t\t\tthis.subscriptions.push', `const events = this.agent.events;
      Object.assign(events.registrations ||= {}, {
        "task.started": { kind: "stream", name: "events", type: "task.started",
          schema: looseObject({ type: literal("task.started"), agentId: string(), info: looseObject({}) }) },
        "task.terminated": { kind: "stream", name: "events", type: "task.terminated",
          schema: looseObject({ type: literal("task.terminated"), agentId: string(), info: looseObject({}) }) }
      });
      const forwardBackgroundTask = (event, terminated) => {
        const info = event.info;
        this.emit({ sessionId: this.sessionId, update: { sessionUpdate: "camellia_background_task", terminated,
          task: { id: info.taskId, description: info.description, kind: info.kind, status: info.status } } });
      };
      this.subscriptions.push(events.on("turn.started", event => {
        if (["task", "background_task"].includes(event.origin?.kind)) {
          const finish = result => {
            this.camelliaBackgroundDriver = undefined;
            this.emit({ sessionId: this.sessionId, update: { sessionUpdate: "camellia_background_turn",
              state: "ended", turnId: event.turnId, ...result } });
          };
          this.camelliaBackgroundDriver = { turnId: event.turnId, settled: false,
            resolve: finish, reject: error => finish({ stopReason: "error", error: error.message }) };
          this.emit({ sessionId: this.sessionId, update: { sessionUpdate: "camellia_background_turn",
            state: "started", turnId: event.turnId } });
          return;
        }
        const driver = this.driver;
        if (driver?.promptId === void 0 || driver.promptId !== event.promptId || driver.settled) return;
        driver.turnId = event.turnId;
        if (driver.cancelRequested) this.agent.cancel({ turnId: event.turnId }).catch(() => {});
      }), events.on("prompt.completed", event => this.camelliaPromptEnded(event, false)),
        events.on("prompt.aborted", event => this.camelliaPromptEnded(event, true)),
        events.on("task.started", event => forwardBackgroundTask(event, false)),
        events.on("task.terminated", event => forwardBackgroundTask(event, true)));
      this.subscriptions.push`],
    ['driver.early.push({', `if (driver.promptId !== void 0) return;
        driver.early.push({`],
    ['driverFor(turnId) {', `driverFor(turnId) {
      if (this.camelliaBackgroundDriver?.turnId === turnId) return this.camelliaBackgroundDriver;`],
    ['dispatchTurnEvent(turnId, dispatch) {', `dispatchTurnEvent(turnId, dispatch) {
      if (this.camelliaBackgroundDriver?.turnId === turnId) { dispatch(); return; }`],
    ['for (const pending of this.pendingPromptAborts) pending.aborted = true;', `for (const pending of this.pendingPromptAborts) pending.aborted = true;
      if (this.camelliaBackgroundDriver) this.agent.cancel({ turnId: this.camelliaBackgroundDriver.turnId }).catch(() => {});`],
    ['/** The active driver, but only for events of ITS turn. */', `camelliaPromptEnded(event, aborted) {
      const driver = this.driver;
      if (!driver || driver.promptId !== event.promptId || driver.turnId !== void 0) return;
      this.settleDriver(driver, () => {
        if (aborted || driver.cancelRequested) driver.resolve({ stopReason: "cancelled" });
        else if (event.reason === "blocked") driver.resolve({ stopReason: "refusal" });
        else driver.reject(RequestError$1.internalError(void 0, "Kimi prompt ended without launching a turn"));
      });
    }
    /** The active driver, but only for events of ITS turn. */`],
    ['driver.cancelRequested = true;\n\t\t\t\tthis.agent.cancel()', `driver.cancelRequested = true;
        if (driver.promptId !== void 0) {
          // Submission may still be updating metadata; retry cancellation when
          // its launch acknowledgement arrives if the prompt is not queued yet.
          try { this.camelliaCancelPrompt(driver.promptId); } catch {}
          return;
        }
        this.agent.cancel()`],
    ['\tlet closePromise;\n\tconst close = async () => {', `
  server.camelliaPrompt = (params, signal) => {
    const acpSession = server.getSession(params.sessionId);
    if (acpSession) acpSession.camelliaCancelPrompt = promptId => {
      const live = getLiveSessionById(core.accessor, params.sessionId);
      const agent = live?.accessor.get(IAgentLifecycleService).handleOf("main");
      if (!agent) throw new Error("Main agent is not live");
      agent.accessor.get(IAgentLoopService).cancel({ promptId });
    };
    return server.prompt(params, signal);
  };
\tlet closePromise;
\tconst close = async () => {`],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) return null;
    source = source.replace(before, after);
  }
  const legacyPrompt = 'getServer().prompt(ctx.params, ctx.signal)';
  const asyncPrompt = '(await getServer()).prompt(ctx.params, ctx.signal)';
  const legacy = source.split(legacyPrompt).length === 2, modern = source.split(asyncPrompt).length === 2;
  if (legacy === modern) return null;
  return source.replace(legacy ? legacyPrompt : asyncPrompt,
    legacy ? 'getServer().camelliaPrompt(ctx.params, ctx.signal)' : '(await getServer()).camelliaPrompt(ctx.params, ctx.signal)');
}

module.exports = { patchKimiAcpTurns };
