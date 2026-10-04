# Native sessions by model binding

Implemented as of 2026-10-01. A conversation's public transcript remains the append-only source of truth, while each `(engine, connection, model, subscription account)` binding can retain its own native session. This prevents an `A → B → A` model switch from resuming model B inside model A's native thread, which previously triggered Codex's recorded-model warning and repeated prefill.

```text
bindingKey = [engine, connection || 'api', model || '', subscriptionId || null]
```

`src/engines/shared-conversations.js` parks the old segment and restores a matching one with its own history cursor. Public turns added while that binding was inactive are passed through a short bridge: sufficiently long absent history can be summarized, while shorter history is replayed. Bridge files under `bridges/` record their covered sequence. A parked segment expires after `sessionTtlMinutes` (default 30, allowed 1–1440) or can be retired when its engine exceeds `sessionLimit` (default 4, allowed 1–20). Forking copies the binding map. Context-window estimates and route priority are excluded from the binding key because they affect replay budget, not native session identity.

**Settings → Model settings** stores a quick-switch default model and reasoning level per engine. A double click in the model selector applies that pair when available; a single click opens the full menu. The selector reads fresh settings, so changing defaults does not require reloading a chat page.

Changing the model or reasoning level while a reply is running saves it for the **next** turn. The running turn retains a launch-time settings snapshot. Queued messages use the settings in force when each message is actually sent, including a change made after queueing. Engine, connection, and permission changes still wait for the running turn to finish. Native reasoning and cache state never migrate between bindings or engines.

Verification: `tests/shared-conversations.test.js`, `tests/shared-chat-ui.py`, and the optional quota-consuming `node tests/model-switch-router-smoke.cjs <model-a> <model-b>`.
