# API model thinking controls

Audited 2026-10-31. Scope: every built-in API preset in `api-router-config.js`.
Custom providers and subscription-account catalogs are outside this audit.

The composer and quick-switch menus consume the router's `modelThinking`.
Missing metadata means the provider default, not that the model cannot reason.
A model that reasons does not necessarily expose a switch or effort levels.

| Built-in preset | Capability source and behavior |
| --- | --- |
| Command Code | Use `/provider/v1/models?view=client`, the catalog used by the official CLI. Parse `reasoningEfforts`; normalize `off` to the composer's `none`. A null list means no selectable effort. Fall back to the standard list if the client view is unavailable. |
| OpenCode Zen | Parse `capabilities.reasoning.effort`, `toggle`, and `default.value` from the live catalog. A reasoning-support flag alone does not establish adjustable effort. |
| OpenCode Go | Same schema as Zen, but use Go's own catalog. Its levels can differ from Zen for the same model. |
| Ollama Cloud | Keep the existing native `/api/show` discovery. Preserve the exact reported `thinking.values` and default. |
| Kimi / Moonshot | Parse live `support_efforts` and capability flags when present. Documented first-party fallback: K3/K3.1 Pro have low/high/max; K2.5/K2.6 have an on/off switch; fixed-thinking models do not get invented effort levels. |
| Kimi Code API key | Documented ID-specific fallback for K3.1 Pro, K3, K2.8 Preview (`kimi-for-coding`) and the fixed-effort Highspeed variant. Do not offer Off when it would reject the request or route to a different model. |
| DeepSeek | Keep the first-party documented low/high/max and Off fallback. Chat Completions and Messages use `thinking.type` to turn reasoning off; `none` is not a native effort. |
| MiMo pay-as-you-go | Keep the documented boolean thinking switch on exact first-party model IDs. |
| MiMo Token Plan China | Same switch, scoped to `token-plan-cn.xiaomimimo.com`. |
| MiMo Token Plan Singapore | Same switch, scoped to `token-plan-sgp.xiaomimimo.com`. |
| MiMo Token Plan Europe | Same switch, scoped to `token-plan-ams.xiaomimimo.com`. |
| Google Gemini | Use live levels when reported, otherwise exact documented model IDs and OpenAI-compatible effort names. Offer Off only for the documented 2.5 Flash variants; do not infer support for image, audio, embedding or future models. |
| QClaw local | Keep model discovery excluded: the gateway exposes a runtime-managed agent rather than an independently configurable model effort catalog. |

Live valid metadata, including an explicit empty list, takes precedence over
documented fallbacks. First-party fallbacks do not transfer to similarly named
models on arbitrary relays. Background discovery updates already configured
models and persists their metadata without adding new routes. Command Code's
hidden client-catalog entries do not enter the Add models picker; existing
configured hidden routes can still receive capability updates.

Request adaptation also matters: boolean-only models receive a native thinking
switch rather than a fabricated effort; explicit disabled thinking remains off
even when a harness also sends a named effort. DeepSeek Off removes the effort and
sets `thinking.type: disabled`; Kimi K3 receives its effort without an
unsupported generic `thinking` field; Gemini converts native disabled thinking
to `reasoning_effort: none` before removing the generic field.

## Evidence

- [Command Code Provider API](https://commandcode.ai/docs/provider) documents the standard catalog and native request formats. The richer `?view=client` catalog was verified against the public endpoint and the published official `command-code` npm package, v1.88.2. No npm package code was executed.
- [OpenCode Zen catalog](https://opencode.ai/zen/v1/models) and [Go catalog](https://opencode.ai/zen/go/v1/models) were read directly without credentials. Representative model shapes are covered in `tests/builtin-provider-thinking.test.js`.
- [Ollama thinking metadata](https://docs.ollama.com/capabilities/thinking).
- [Kimi thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models) and [Kimi Code model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html).
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai/#thinking) and [model-specific thinking levels](https://ai.google.dev/gemini-api/docs/thinking#controlling_thinking).

## Validation

Regression coverage checks every preset, distinct per-provider levels, missing
and malformed catalogs, explicit live overrides, first-party host boundaries,
background publication and request bodies across client protocols. The browser
test `tests/model-thinking-ui.py` starts from production-parsed Command Code and
OpenCode catalog fixtures and checks all six engine composers. Public catalog
checks do not establish that a provider honored an effort during inference;
this audit does not send paid model requests.
