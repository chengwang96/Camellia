# Kimi Code runtime

Official runtime: [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), MIT.
This workbench pins `@moonshot-ai/kimi-code` to **0.43.0** and talks to its ACP stdio server.

The root `npm install` prepares this runtime automatically; `npm run setup:kimi` remains available for explicit reinstalls.
Use Node.js 22.19+ in the 22.x series, or Node.js 24+, with Git Bash on Windows or
the native shell on macOS. Apple Silicon builds use ARM64 Node.js. Optional TUI clipboard/PTY
packages are omitted; ACP uses the runtime's own filesystem and shell tools.
No global npm install is needed. Electron packaging copies the runtime next to
`app.asar`, so the external Node process can read it.

`KIMI_CODE_HOME` points to `<Electron userData>/kimi-code`. Its generated
`config.toml` retains native preferences from the globally managed Kimi config, plus only the selected model and the local router address with
a placeholder token. MCP servers are synchronized too; transcripts stay isolated. Configure real API credentials in the workbench. A runtime
restart reapplies the workbench model, permission and thinking selection.

Native Kimi transcripts remain in this isolated home. `<userData>/kimi-history`
contains a display cache, used to browse history even when the router is offline.
Existing sessions have a fixed execution directory in ACP 0.43.0. Create a new
session to use another workspace. Removing a sidebar workspace retains all
sessions, their original execution directories and files.

Runtime permission IDs follow the engine toggles: `default` = manual, `plan` =
planning, `yolo` = ask when needed, `auto` = never ask. The ACP mode descriptions
in this version disagree with its engine mapping; the workbench follows the
engine and CLI flag behavior. Thinking controls appear only when ACP advertises
them for the selected model. The configurable context window defaults to 131072
tokens; set it to the actual limit of the selected model.
