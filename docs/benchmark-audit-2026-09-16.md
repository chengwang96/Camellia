# Benchmark audit — 2026-09-16

This is a historical integration audit. Equal scores across harnesses had several causes; they do not by themselves establish equal model or harness ability. The audit confirmed evaluation defects and flaws in two SciCode source questions. The check scorer still awards partial credit by passed checks and does not loosen official numerical tolerances.

## Confirmed findings

| Finding | Evidence and resolution |
| --- | --- |
| SciCode comparison dependency missing in older reports | Five harnesses had scored 4/14 with `ModuleNotFoundError: No module named 'scicode'`. The same saved answers scored 7/14 after the dependency fix. Environment failures are now separated from incorrect answers. |
| SciCode #46 depends on an arbitrary random trajectory | Replaying the official subproblem sequence scored saved answers 7, 7, 7, 6, and 7 of 14. Changing one mathematically equivalent acceptance test from `u < p` to `1-u < p` made DSH's answer score 14/14. The original task and scoring remain; #46 is moved to the end of short sampling. |
| SciCode #15 omits a physical constant coefficient | The fixed upstream problem states `hbar = × 10^-34`. The short sample excludes it; full-library runs show a warning rather than silently changing the problem. |
| Python `-I` broke a model's local self-test import | Model-facing self-tests now use `-E -s -X utf8`; the independent grader keeps `-I`. |
| Splitting checks reset shared state | SciCode checks retain order and namespace within a subproblem; DS-1000 retains its original execution loop. Partial checks are still recorded individually. |
| A Codex timeout could leave open output pipes | After terminating the native process, Camellia closes inherited pipes and does not signal an already-exited PID. |
| Saved evidence truncated Python answers | Reports now prefer complete `solution.py` content and SHA-256, omitting binary cache files. |

The updated grader is `python-checks-3`; SciCode short sampling is `camellia-sample-2-known-issues-last`. The full SciCode test split still has 65 questions. Historical reports retain their original question IDs and scores. This audit did not independently validate every scientific definition or execute all 1,000 DS-1000 reference answers.

## Local and live verification

The local checks included 186 Node tests, SciCode dependency and numerical-key checks for 65 test questions, a reference answer from each of seven DS-1000 libraries, three SciCode development answers, stateful and Unicode regressions, UI automation, and five native harnesses using a local fake API. Fake API results were not counted as model scores.

With authorized Ollama `deepseek-v4.1-flash` use, the final SciCode #74 round gave five engines five minutes each. Claude finished in 188 seconds and scored 3/3; Codex, DSH, Kimi, and Antigravity timed out and scored zero. Offline checks of their saved answers later scored 2/3, 3/3, 3/3, and 2/3 respectively; these checks did **not** replace the timed-out scores. Across the audit there were 25 live task attempts, 172 API requests, and 2,647,734 reported tokens including cached input, with incomplete usage for 18 requests. The audit directories are `dist/benchmark-audit/live-1789509436349/`, `live-1789509995020/`, and `live-1789510600958/`.

Use `npm run test:benchmark:science`, `node tests/benchmark-native-smoke.cjs --science`, and `python tests/benchmark-ui.py` for local checks. `node scripts/benchmark-live-audit.cjs --use-configured-api --science-only --timeout-seconds=300` makes real model requests. A one-question diagnostic cannot rank harnesses: model behavior, tools, task choice, and time budget all affect the score.
