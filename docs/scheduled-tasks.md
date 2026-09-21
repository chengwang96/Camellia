# Scheduled experiment checks

Open an existing shared conversation and click **Tasks** beside the composer, or use `/tasks`. Describe an already-running experiment, its log/checkpoint paths, completion evidence, and any permitted recovery. Configure the interval, maximum checks, lifetime and allowed recovery attempts. The default is every 10 minutes, up to 24 checks over 24 hours, with no automatic recovery.

A model can create a task after a direct current request such as `创建定时任务：每隔 10 分钟检查训练日志，最多检查 24 次，异常时允许自动恢复一次。` or `Create a scheduled task: check the training logs every 10 minutes.` Ambiguous requests should use the panel. Creating a task does not itself launch or detach an experiment.

## Behavior

- The main process stores tasks under `conversations/tasks/state.json` and owns the timer. Waiting consumes no model tokens. **Every actual check invokes the model**; this first version does not include process/log-only probes or a monetary/token budget. Check count and wall-clock limits bound scheduling, not the cost of an individual model turn.
- Checks use the bound conversation, workspace and engine. They wait while a user turn, Goal, handoff or compaction owns the conversation; checks never overlap in one conversation. Intervals start after the previous check finishes, and missed checks are not replayed in a burst.
- The model must report `continue`, `complete` or `blocked` through a current-turn authenticated tool. The scheduler commits that outcome only after a successful turn. Errors, missing reports, blocked reports and exhausted limits pause monitoring; completed tasks stop. Completion is model-reported evidence, not independent Goal verification.
- Recovery requires an explicitly authorized nonzero allowance and a successful reservation through `camellia_task_repair` before each attempt. At most one attempt is reserved per check. Reservations remain consumed if the attempt fails or the application exits. **Recovery instructions are a model policy, not a command sandbox**: native engine permissions remain authoritative. Use ask-before-acting permissions for sensitive experiments. The scheduler does not inspect every shell command to enforce read-only behavior.
- Pause/cancel stops the scheduled model check, not the separately running experiment. The chat Stop action also pauses this conversation's scheduled tasks. A paused task can be edited and resumed from the panel. Increasing lifetime changes the deadline relative to original creation, not relative to resume.
- Tasks and the last 30 lifecycle/check records persist. Restart pauses unfinished tasks and requires manual resume. Camellia must remain running and the computer awake; there is no OS service, wake timer or cloud worker. Status and results appear in the conversation and Tasks panel, not external push notifications.
- Archiving a conversation or removing its workspace pauses monitoring. Changing engines prevents the next check; create a new task for the new engine. Deleting a conversation removes its tasks.

## Scope

Available in shared conversations on connections supporting Camellia MCP tools. Antigravity subscription connections currently cannot run these tasks. Goal and scheduled tasks coordinate through the conversation lock; this version does not automatically suspend/resume Goal around experiment execution. Pause Goal yourself before waiting for periodic checks.

## Verification

`node --test tests/scheduled-tasks.test.js tests/shared-conversations.test.js tests/goal-tool-bridge.test.js`

`python tests/scheduled-tasks-ui.py`
