# Unified settings and optional runtimes

Implemented beginning 2026-09-16. Home and every desktop harness open the same settings window. **Engine Settings** manages installation, updates, effective paths, account connection, and native configuration for the six engines. **Model Settings** holds quick-switch defaults and native-session retention; **General** holds the shared Python interpreter. Providers, usage, balances, and networking keep their own pages.

| Engine | Native configuration scope | Default location |
| --- | --- | --- |
| DSH | Native YAML, plugins and agent presets; model routing through Camellia | `~/.dsh/settings.yaml` |
| Claude Code | Native JSON, MCP and instructions | `~/.claude/settings.json`, the `mcpServers` part of `~/.claude.json`, and `~/.claude/CLAUDE.md` |
| Codex CLI | ChatGPT or shared API connection, approval, sandbox, TOML/MCP and AGENTS.md | Isolated `<app-data>/codex`, not personal `~/.codex` |
| Kimi Code | Native TOML, MCP, terminal preferences and session defaults | `~/.kimi-code/config.toml`, `mcp.json`, and `tui.toml` |
| Antigravity | Google CLI or API SDK connection, permissions, MCP and skills | API settings under `<app-data>/antigravity`; Google mode under `~/.gemini/` |
| Pi | Shared API routes and its own native settings | Camellia-managed runtime and app data |

`DSH_HOME`, `CLAUDE_CONFIG_DIR`, and `KIMI_CODE_HOME` are respected where supported. Common controls use forms, while advanced native files remain editable with syntax and concurrent-change checks. Before first overwrite of an existing global native file, Camellia saves a `.workbench.bak` beside it and does not overwrite that original backup later. Claude MCP saving touches only `mcpServers`. Codex uses isolated app data. Project-local configuration still follows the engine's own precedence.

Camellia does not copy real provider keys into native config. Managed API sessions use a local router address and placeholder credential; the desktop must remain running for that route. Switching same-model keys or providers follows router policy, while a different model is never substituted automatically. The **Network** page offers direct, detected system proxy, and auto modes plus a read-only connectivity test; the test does not change the saved mode.

Running from source uses `npm ci` then `npm start`. Initial install and startup checks do not download all engines. Choose **Download & open** in the UI or run `npm run setup:runtimes -- dsh kimi` for named development runtimes; `--all` is explicit. Managed installs do not add global npm or Python packages. Desktop packages contain common Node/npm and pinned runtime manifests, with chosen engines downloaded into app data. Antigravity API mode also prepares a dedicated Python and SDK; Google mode installs the official CLI.

Verification entry points include `npm test`, `python tests/engine-settings-ui.py`, `node tests/native-settings-electron.cjs`, and `node tests/electron-smoke.cjs`. Fixture checks use temporary data directories and a local model endpoint; they do not validate a paid account.
