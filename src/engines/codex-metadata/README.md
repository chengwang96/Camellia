# Codex native model metadata

These unmodified files come from OpenAI Codex `rust-v0.154.0` and are covered by the included Apache 2.0 license:

- `models.json`: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/models.json
- `fallback-prompt.md`: https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/prompt.md

`codex-models.js` copies the pinned CLI's unknown-model descriptor from
`codex-rs/models-manager/src/model_info.rs`, changing `apply_patch_tool_type`
from `null` to `freeform`. Its instructions, shell type, reasoning defaults,
context window and truncation policy stay the same. The generated catalog also
retains the native entries. Known native models and user-supplied catalogs keep
their own configuration. Subscription connections do not use this catalog.

This exposes Codex's existing patch handler to third-party API models. Patch
parsing, file-change events and permission enforcement still run inside Codex.
It avoids the Windows `apply_patch.bat` argument path, which can truncate
multiline patches. The Responses adapter encodes the raw patch in one JSON
string for Chat Completions providers and decodes it without shell escaping.

When updating the pinned Codex runtime, refresh these files and compare the
fallback descriptor with upstream. Run `node tests/codex-smoke.cjs` to check
the actual binary's patch, permission, resume and cancellation behavior.
