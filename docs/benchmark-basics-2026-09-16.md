# Built-in benchmark v2 validation

The original five-minute preview began with a Unicode normalization task. Several harnesses using the same model scored 11/12 because their combining-mark range omitted `U+1AB0`. That remains a useful edge case, but it was a poor first check of basic file editing and test execution.

Built-in set `camellia-bench-2` starts with `slug-basic`: trim ASCII whitespace, lowercase ASCII letters, and collapse internal whitespace. The task supplies `node check.cjs` with six public acceptance cases, while an independent checker grades the resulting function. The preview still has three tasks (text formatting, transaction processing, and multi-file invoice repair); the original Unicode task remains in the seven-task Standard set. Saved v1 reports retain their tasks and scores.

On 2026-09-16, one authorized Ollama Cloud `deepseek-v4.1-flash` run used five native API harnesses, one attempt per task, 250K tokens per task, and 270 seconds shared across each harness's three tasks. All 15 attempts passed; the whole run took 187.882 seconds. Each engine passed the entry task's 6/6 checks.

| Harness | Entry task | Three tasks | Reported tokens, three tasks |
| --- | ---: | ---: | ---: |
| Claude Code 2.1.270 | 28.812 s | 181.659 s | 341,765 |
| Codex CLI 0.147.0 | 22.591 s | 125.518 s | 224,645 |
| DSH 0.1.5-rc.1 | 47.933 s | 185.863 s | 150,234 |
| Kimi Code 0.43.0 | 38.822 s | 171.705 s | 318,029 |
| Antigravity SDK 0.1.16 | 45.604 s | 187.751 s | 222,893 |

The run reported 1,257,566 tokens overall. Some invoice-task tool calls failed and were retried successfully; a passing final check does not mean every intermediate tool call succeeded. Evidence is in `dist/benchmark-audit/live-1789560825684/`. The set SHA-256 was `6e14e649dbf624f2186b9d99c8c5f07bffa5a5f215d76428026211e493f5c824`. Reproduction with `node scripts/benchmark-live-audit.cjs --use-configured-api --model=deepseek-v4.1-flash --preview` consumes configured API quota. This one basic integration run does not predict other models or harder tasks.
