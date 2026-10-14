# Goals

Goal mode keeps working toward one objective until completion is independently verified or repeated failures block progress. Start it from the composer or ask naturally, such as `Set a goal to finish and verify this task`. The model uses `camellia_create_goal`, `camellia_get_goal` and `camellia_update_goal` on connections that support Camellia tools.

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

Use `camellia_update_goal` with `status` (`complete` or `blocked`) and `reason` to report an outcome separately from a revision. Outcome reports apply at the end of the owned Goal turn. Completion still requires independent verification against the current objective and criterion. Revising a goal discards a pending outcome for its old content; report a fresh outcome after checking the revised work.

## Validation

`node --test tests/claude-goal.test.js tests/goal-tool-bridge.test.js tests/shared-conversations.test.js`
