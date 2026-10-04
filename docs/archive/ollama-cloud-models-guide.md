# Archived Ollama Cloud and DSH configuration notes

These notes reflect a local Ollama 0.32.15 / DSH 0.1.0-rc.7 setup from 2026-08-25. Camellia's unified provider and same-model route pool later replaced the old single-provider proxy workflow. Use the current [configuration guide](../configuration.md) for new installations. Model availability, context limits, role behavior, and upstream endpoints in this archive were observations at the time, not a current compatibility promise.

## Historical connection pattern

An Ollama `:cloud` pull stored a small local pointer while inference ran through the cloud account. The local daemon offered an OpenAI-compatible endpoint at `http://127.0.0.1:11434/v1`; DSH could target that endpoint through `llm-pi-ai.providers.ollama`. DSH's old provider adapter required a placeholder credential name even though the local Ollama daemon did not authenticate that endpoint.

```yaml
llm-pi-ai:
  providers:
    ollama:
      displayName: Ollama (cloud)
      apiKeyEnv: OLLAMA_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      models:
        - id: "kimi-k3:cloud"
          name: Kimi K3 (cloud)
          reasoningEfforts: false
```

In the old `.credentials.yaml`, `OLLAMA_API_KEY: ollama` was a placeholder, not a secret accepted by the local daemon. Do not copy old model IDs, context windows, or reasoning settings into a current installation without testing them. The old `opencode-proxy.json` multi-key configuration contained sensitive keys and was never meant for Git.

## Role and model tests

The historical adapter sent system instructions as a `developer` role for models marked as reasoning-capable and as a `system` role otherwise. In the local tests, two DeepSeek cloud variants followed both roles, while Kimi K3, GPT-OSS 120B, and GLM-5.2 cloud variants followed `system` but appeared to ignore `developer`. Marking those latter models with `reasoningEfforts: false` kept the system-role path. This was a response-behavior probe, not a guarantee about current upstream implementations or hidden model reasoning.

Before adding a model, test whether it follows a short `system` instruction and a separate `developer` instruction through the **actual** endpoint and adapter. Also test the selected tool-call format, image support, maximum output, and cancellation. A listed model name or a successful catalog request is not proof that an account can infer with it.

## Lessons carried forward

- Match the real protocol path (`openai-completions`, Responses, or another adapter) to the endpoint. An OpenAI-compatible label does not imply every feature or role works.
- Keep an account key in its intended provider scope. A custom relay key must not be sent to an official domain merely because display names match.
- Test both successful and failing routes, including retry eligibility, usage attribution, and whether a fallback stays on the **same model**.
- Treat balances, subscription windows, and locally observed token use as separate measures. An undocumented usage endpoint may change.
- Save no plaintext key in source, screenshots, or diagnostic exports. Prefer Camellia's current provider UI and encrypted device migration flow over the historical manual DSH file edits.
