# Scheduled experiment checks

Open an existing shared conversation and use `/tasks`, or click **Tasks** beside the composer when it has unfinished tasks. Describe an already-running experiment, its log/checkpoint paths, completion evidence, and any permitted recovery. Choose a fixed interval, a one-time check, or a daily check. All schedules have a check limit, a lifetime and a recovery allowance. No recovery is allowed by default.

## Schedules

- **Fixed interval:** every 1–1,440 minutes. Defaults to 10 minutes, 24 checks and a 24-hour deadline. Without check time or delays, those 24 checks cover about **four hours**, not 24 hours. The editor previews the first check, estimated end and deadline. The count limit and deadline apply independently; whichever is reached first stops scheduling.
- **One time:** choose a future date and time in the device's local time. The saved instant includes an explicit UTC offset, so the host and a paired client agree. Defaults to one check and a seven-day lifetime. After a successful structured `continue` or `complete` result, this schedule ends; a `continue` result does not claim that the experiment itself finished. Errors and blocked reports still pause it.
- **Daily:** choose `HH:mm` and an IANA time zone such as `Asia/Hong_Kong`. Defaults to seven checks and a seven-day lifetime. The selected zone is retained even if the host or phone changes zones. At a daylight-saving transition, a nonexistent local minute is skipped and a repeated minute runs only once per local calendar date.

For daily and one-time checks, the lifetime defaults to seven days and can be extended up to **8,760 hours (one year)**. Interval checks retain the same maximum. Extending the lifetime alone does not add checks; raise **Maximum checks** (up to 1,000) as well, or the check limit will still stop the task first.

Every first check must fit **before** the deadline. Creation, editing and resume reject impossible schedules. Limits remain relative to original creation when editing. Missed interval/daily checks are not replayed in a burst. After sleep, an already-due check runs once when the host is available, then the next daily check uses the next eligible local date. Restart still requires manual resume. Explicitly resuming a missed one-time check runs it immediately if its lifetime and remaining check allowance permit it.

The model tools accept `scheduleType` (`interval`, `once`, `daily`), `intervalMinutes`, `runAt` (ISO date with offset), `dailyTime` (`HH:mm`) and `timeZone`. Older callers and saved records without a schedule remain fixed-interval tasks. The panel can edit every schedule type; editing never resumes a paused task implicitly.

The panel keeps its close button visible while its contents scroll. Click outside it, press Escape, or use the close button to dismiss it. Instructions show a two-line preview; expand an instruction or **Recent checks** to read the complete text. Task updates preserve these expanded sections. **Create task** opens a separate collapsible form; it opens automatically when no tasks exist. Editing a paused task opens the same form with its current values.

The **×** beside **Tasks** cancels all unfinished scheduled tasks in the current conversation, including paused tasks, and removes the composer control. To cancel just one task, click **Tasks** and use that task's **Cancel task** button. Cancellation stops a scheduled model check that is currently running and prevents later checks; it leaves the separately running experiment and saved task history in place.

A model can create a task from a natural-language request such as `The training run has started; could you check its logs every ten minutes?` No command prefix, fixed wording or first-line placement is required. The model interprets intent and asks a natural-language clarification if needed. Creating a task does not itself launch or detach an experiment.

Goal requests likewise accept natural language, for example `Set a goal to finish and verify this task` or a goal request later in a multiline message. The harness/model decides whether the user is actually requesting automation rather than discussing, quoting or negating it. The backend checks that `user_request` comes from the current user message; this is a provenance check, not a semantic authorization classifier. Current-turn tokens, automatic-turn restrictions, scheduling bounds, recovery authorization and independent Goal completion verification still apply.

## Behavior

- The main process stores tasks under `conversations/tasks/state.json` and owns the timer. Waiting consumes no model tokens. **Every actual check invokes the model**; this first version does not include process/log-only probes or a monetary/token budget. Check count and wall-clock limits bound scheduling, not the cost of an individual model turn.
- Checks use the bound conversation, workspace and engine. They wait while a user turn, Goal, handoff or compaction owns the conversation; checks never overlap in one conversation. Intervals start after the previous check finishes, and missed checks are not replayed in a burst.
- The panel identifies whether a due check is waiting for Goal, another reply, compaction, review or another scheduled check. It warns about an active Goal before scheduling. Waiting does not extend the deadline. Goal is never paused automatically.
- The model must report `continue`, `complete` or `blocked` through a current-turn authenticated tool. The scheduler commits that outcome only after a successful turn. Errors, missing reports, blocked reports and exhausted limits pause monitoring; completed tasks stop. Completion is model-reported evidence, not independent Goal verification.
- Recovery requires an explicitly authorized nonzero allowance and a successful reservation through `camellia_task_repair` before each attempt. At most one attempt is reserved per check. Reservations remain consumed if the attempt fails or the application exits. **Recovery instructions are a model policy, not a command sandbox**: native engine permissions remain authoritative. Use ask-before-acting permissions for sensitive experiments. The scheduler does not inspect every shell command to enforce read-only behavior.
- Pause/cancel stops the scheduled model check, not the separately running experiment. The chat Stop action also pauses this conversation's scheduled tasks. A paused task can be edited and resumed from the panel. Increasing lifetime changes the deadline relative to original creation, not relative to resume.
- Pause/cancel shows **Stopping check** until the current check exits. An unresponsive engine uses the normal conversation stop watchdog and process cleanup; stopping one task does not pause the conversation's other tasks. Cancellation also works during pre-send context compaction. A failure to confirm termination remains visible. Restart, deadline, check exhaustion, blocked reports and check errors have separate lifecycle reasons, while the last structured check evidence is preserved.
- Tasks and the last 30 lifecycle/check records persist. Restart pauses unfinished tasks and requires manual resume. Camellia must remain running and the computer awake; there is no OS service, wake timer or cloud worker. Status and results appear in the conversation and Tasks panel, not external push notifications.
- Archiving a conversation or removing its workspace pauses monitoring. Changing engines prevents the next check; create a new task for the new engine. Deleting a conversation removes its tasks.

## Scope

Available in shared conversations on connections supporting Camellia MCP tools. Antigravity subscription connections currently cannot run these tasks. Goal and scheduled tasks coordinate through the conversation lock; this version does not automatically suspend/resume Goal around experiment execution. Pause Goal yourself before waiting for periodic checks.

## Mobile

Paired Android and iOS clients read tasks from the conversation snapshot, including the full instruction (up to 12,000 characters), schedule type and daily time zone, check/recovery counts, next check, deadline, lifecycle notice, last result and the 10 most recent records. On Android, tap the conversation's status footer to open **Work status**; long instructions and results can be expanded there. On iOS, tap a task's instruction above the composer to open its details. Unfinished tasks offer pause/resume and cancellation, including while waiting between checks. Cancellation asks for confirmation and stops scheduled checks, not the experiment. Read-only, offline, pending-command and stopping states disable these controls.

Mobile clients do not have the desktop task creation/editing form. Request new tasks or changes in the conversation, or use the desktop panel. Checks still run on the paired host, which must remain open and awake; keeping the phone open does not run the scheduler.

## Verification

`node --test tests/task-schedule.test.js tests/scheduled-tasks.test.js tests/shared-conversations.test.js tests/goal-tool-bridge.test.js tests/remote-access.test.js`

`python tests/scheduled-tasks-ui.py`
