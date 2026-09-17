# Benchmark modes and candidate libraries

Assessed on 2026-09-16. The application currently runs the built-in coding tasks, DS-1000 and SciCode. The four libraries below are assessed candidates, not implemented adapters or selectable downloads.

## Five-minute first result

The default **5-minute preview** uses three fixed built-in tasks: basic text formatting, transaction reconciliation and a multi-file invoice repair. All five engines receive the same tasks and limits: one attempt, 250K reported tokens per attempt, and a 300-second whole-run deadline. Each engine's three tasks share 270 seconds from the run start. A slower task can use the remaining allowance without a shorter fixed per-task cutoff. Agent execution stops at 270 seconds, leaving 30 seconds for final checks and cleanup; unstarted tasks are skipped. Engines work concurrently and each engine processes its own queue sequentially. Downloads complete before the timer starts. Cleanup may take a few extra seconds after cancellation.

Built-in v2 introduces `slug-basic` as the first task. Its input domain is explicitly ASCII letters, digits and whitespace, and all six acceptance cases are supplied in `check.cjs`. Agents read the files, repair the function and run `node check.cjs`; the independent grader still checks the result directly, so changing the self-test cannot fabricate a pass. The original `slug` question and its Unicode checks remain in the seven-task Standard suite. This separates an approachable tool-use entry point from Unicode boundary coverage. New reports record `camellia-bench-2` and a new suite hash; history uses each report's saved tasks, version and scores.

This provides an initial view of a model and harness working together: can it read files, make a correct change, use tools and complete a short task efficiently? It cannot isolate model quality from harness quality, and does not measure scientific expertise, vision or long-term memory. Short time limits also expose provider latency and rate limiting. An unavailable or slow API can leave too little evidence to assess capability.

Scores appear as attempts finish. An incomplete engine shows **Preliminary check score**, completed/expected counts, coverage, elapsed time and tokens. Pending or unstarted tasks do not become incorrect answers. A started task that runs out of time receives zero under the recorded time budget. Grader errors leave scores unavailable. Comparisons require matching tasks and limits; 100 points on one easy task is not evidence that an engine outperforms another on a larger set.

## Full-library unattended runs

**Full library** selects every question in the chosen installed library. It keeps the existing library-specific time and token recommendations and removes the preview deadline. **Custom sample** exposes smaller samples and manual limits. Both preserve equal per-engine limits, independent workspaces, saved artifacts and per-attempt reports.

The setup page displays the sum of per-task execution and verification allowances for one engine, because all five engines overlap in time. This is an allowance total, not an ETA: startup and cleanup are extra, and most tasks can finish sooner. The app must remain open and the computer awake. Closing the app cancels execution; it never silently resumes billable work.

## Candidate assessment

| Benchmark | Capability and published format | Recommended place in Camellia |
| --- | --- | --- |
| OCRBench | Reading text in images, document questions, information extraction and handwritten mathematical expressions. Original OCRBench has 1,000 question/answer pairs; v2 is a different 10,000-pair benchmark with more tasks. [Official repository](https://github.com/Yuliang-Liu/MultimodalOCR) | A future **vision** library, with a small sample and a separately selectable full version. Pin the benchmark version. It needs image-capable models and equivalent image delivery through every compared engine. |
| MMMU-Pro Vision | Questions and options embedded in images, combining perception with subject knowledge and reasoning. The current `vision` test configuration has 1,730 examples; the dataset records corrections to answer labels and options. [Official dataset](https://huggingface.co/datasets/MMMU/MMMU_Pro/blob/main/README.md) | A future **visual reasoning** library, useful for scientific diagrams as well as other subjects. Use the Vision configuration explicitly and pin a corrected revision. A tiny sample can check the integration; it cannot reproduce the full leaderboard. |
| BEAM (1M) | Long-conversation memory: fact extraction, updates, temporal reasoning, preferences and other memory abilities. The 1M bucket contains 35 conversations; the released evaluation uses an LLM judge. [Official repository](https://github.com/mohammadtavakoli78/BEAM) | A future **memory** stress test, primarily unattended. A model receiving the full transcript and a harness maintaining its own memory are different experimental conditions and must receive separate labels and scores. Truncating it to a short context would not measure BEAM 1M. |
| DeepSWE | Long-horizon engineering in real repositories; the current corpus has 113 tasks. The official runner uses Pier/Harbor-compatible tasks, and its leaderboard standardizes on mini-swe-agent. [Official run guide](https://deepswe.datacurve.ai/run), [benchmark description](https://deepswe.datacurve.ai/) | The strongest fit among these four for a future **engineering harness** comparison. Needs repository environments, isolation, engine adapters and behavioral verifier support. Full runs belong in unattended mode. Running Camellia's five engines would produce a distinct comparison from the published mini-swe-agent leaderboard. |

BEAM should not be advertised as a five-minute test: Moonshot's public 1M evaluation implementation describes generation taking hours and separates resumable generation from judging. [Implementation notes](https://github.com/MoonshotAI/Kimi-Vendor-Verifier/blob/main/beam/README.md)

## Integration order and interpretation

Our recommendation is to prioritize **DeepSWE** for engineering comparisons, then **OCRBench / MMMU-Pro Vision** as separate image-based tracks, then **BEAM** once native memory and session-ingestion behavior can be measured consistently. These are implementation priorities, not claims about benchmark quality.

For future vision tests, unsupported model/engine combinations should be marked unsupported before starting. Do not quietly replace the image with text from another OCR model. For memory tests, record the context length, truncation policy, memory mode and judge configuration. For repository tests, preserve the original behavioral verifier and record environment revisions.

A future direct-model track would help answer whether the model itself is strong, while same-model runs through different harnesses would show the effect of their tools, prompting and execution policies. The current app only implements the latter. Keep each capability's results separate; do not blend OCR, memory and code checks into one unexplained overall number.
