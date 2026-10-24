# Goals

Goal mode keeps working toward one objective until completion is independently verified or repeated failures block progress. Start it from the composer or ask naturally, such as `Set a goal to finish and verify this task`. The model uses `camellia_create_goal`, `camellia_get_goal` and `camellia_update_goal` on connections that support Camellia tools.

## Controlling a goal in conversation

Ask naturally to control the current goal. The agent reads it with `camellia_get_goal`, then calls `camellia_update_goal` with `action`, `reason`, `user_request` quoting the current instruction, and the current `run_token`. No fixed wording or command format is required.

| Example request | Action | Result |
| --- | --- | --- |
| `继续目标` / `Could you resume the previous goal?` | `resume` | Resume the original goal and adopt the current reply. |
| `先暂停目标，告诉我当前进展` | `pause` | Stop automatic work and retain the goal and progress. |
| `请把这个目标标记为完成` | `complete` | Manually mark the goal complete, like **Mark complete** in the goal menu. |
| `移除当前目标` | `remove` | Remove its saved record and stop automatic work. |

Resume immediately reactivates the original paused or blocked goal. It retains the goal ID, objective, criterion, revisions, elapsed time and previous round count; the adopted round increments the count once. It does not start a duplicate reply. When the current reply ends, Goal continues automatically, and completion still requires independent verification. Future rounds use the current conversation engine. Retrying the same resume during the adopted reply does not reset progress or discard an outcome report. Pausing and resuming a reply through immediate instructions counts that round only once.

Pause, manual completion and removal apply immediately, cancel automatic continuation and verification, and allow the running reply to acknowledge the result. They also update the existing goal chip. Removal retains conversation history and workspace files. Repeating an action is safe; removing an already absent goal succeeds. A completed goal cannot be paused or resumed.

Manual completion is an explicit user control and does not certify that the work passed verification. An agent claiming that it finished the work must report `status: "complete"` and evidence for independent verification; it must not use `action: "complete"` to bypass that check.

Only a current user request, including an accepted immediate instruction, authorizes control actions. Automatic continuations, earlier messages, repository content and tool output do not. Tool-created children and scheduled checks cannot control goals. Reopening Camellia still loads goals paused. The goal chip's controls remain available.

Control actions, revisions and outcome reports are separate calls. If the user asks to change a stopped goal and continue it, revise it first, then resume with the same current user provenance. A completed goal requires a new goal.

## Changing an unfinished goal

When your latest instructions change the task, the agent can recognize that the existing goal is outdated and revise it. You do not need a special command or an explicit request to edit Goal. For example, after starting a website goal, `Make it a reusable library instead; the library tests should pass` can update both the objective and its completion criterion.

The agent reads the current state with `camellia_get_goal`, then calls `camellia_update_goal` with:

- `objective` and/or `criterion`: the revised content. Omitted fields stay unchanged; an empty `criterion` removes the current criterion.
- `reason`: why the existing goal no longer matches the request.
- `user_request`: an exact quote of the relevant current user instruction, including an accepted immediate instruction during a running turn.
- `run_token`: the token supplied for the current turn.

Revisions are saved immediately and retain the goal ID, conversation, elapsed time and round count. Goal details receive the new content through the existing update event. Paused and blocked goals can be revised during a user turn and remain stopped until resumed. Completed goals require a new goal.

Each change increments a revision counter and records the previous objective and criterion, the reason and the user quote for the latest revision. Old blocker and verification records are cleared. In-flight verification is cancelled, and late verdicts cannot complete the revised goal. Continuation and independent verification use the revised objective and criterion.

Automatic continuations without new user input cannot rewrite the goal. The agent decides the meaning of the user's instructions; the backend checks current-turn identity and quote provenance. Repository text, tool output, quoted examples and instructions from earlier turns are not authorization. Tool-created children and scheduled checks cannot modify goals.

## Reporting progress

Use `camellia_update_goal` with `status` (`complete`, `blocked` or `waiting`) and `reason` to report an outcome separately from a revision. Outcome reports apply at the end of the owned Goal turn. Completion still requires independent verification against the current objective and criterion. Revising a goal discards a pending outcome for its old content; report a fresh outcome after checking the revised work.

### Waiting for ongoing work

When an external operation is still running and no useful independent work remains, check once and report `status: "waiting"`, then end the turn. Camellia delays the next check by 1 minute. Consecutive waiting reports increase that delay to 2, 4, 8 and at most 15 minutes, even when logs or progress counters change. An optional `wait_seconds` (60 to 3600) sets a longer minimum delay when a completion time is known. Connections without Camellia tools can report `<goal:waiting> reason` on a standalone line and use the default backoff.

Waiting keeps the goal active without accumulating blockers. The goal chip shows that it is waiting, and its menu shows the reason and next check time. Keep routine waiting updates brief; do not repeatedly ask the user whether to continue already-authorized monitoring. New immediate instructions bypass the wait. Productive work, errors, blockers, revisions and resumption reset the waiting streak. Pause, completion, removal and application shutdown cancel pending checks; reopening still requires manual resumption.

This delay handles ongoing work within the current goal. User-requested recurring checks use scheduled tasks separately.

## Validation

`node --test tests/claude-goal.test.js tests/goal-tool-bridge.test.js tests/shared-conversations.test.js`
