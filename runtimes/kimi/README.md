# Kimi Code runtime

Official runtime: [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), MIT.
This workbench pins `@moonshot-ai/kimi-code` to **0.43.1** and talks to its ACP stdio server.

Kimi is an optional download. Choose it on the home screen or in Settings → Runtime,
or run `npm run setup:kimi` from source. Root dependency installation does not download it.
Use Node.js 22.19+ in the 22.x series, or Node.js 24+, with Git Bash on Windows or
the native shell on macOS. Apple Silicon builds use ARM64 Node.js. Optional TUI clipboard/PTY
packages are omitted; ACP uses the runtime's own filesystem and shell tools.
No global npm install is needed. Desktop packages include only the download manifest;
the selected runtime is installed under application data and reused across launches.

For API mode, `KIMI_CODE_HOME` points to `<Electron userData>/kimi-code`. Its generated
`config.toml` retains native preferences from the globally managed Kimi config, plus only the selected model and the local router address with
a placeholder token. MCP servers are synchronized too; transcripts stay isolated. Configure real API credentials in the workbench. A runtime
restart reapplies the workbench model, permission and thinking selection.

Subscription mode uses a separate `<Electron userData>/kimi-subscription` home.
Camellia invokes the official `kimi login --region mainland-cn|global` device
flow when the user clicks Sign in. The CLI owns token persistence, refresh and
ACP logout. Native OAuth model metadata and search services remain in this
home; API provider overrides and API secondary models are excluded. Account
verification uses ACP authenticate and a temporary empty session, which is
deleted afterward. No model prompt is sent during verification. The account
panel exposes only public models and the pending authorization code/link.
Existing sessions retain their API or subscription home when the new-session
connection setting changes. An external CLI login is not imported.

Native Kimi transcripts remain in this isolated home. `<userData>/kimi-history`
contains a display cache, used to browse history even when the router is offline.
Existing sessions have a fixed execution directory in ACP 0.43.0. Create a new
session to use another workspace. Removing a sidebar workspace retains all
sessions, their original execution directories and files.

Runtime permission IDs follow the engine toggles: `default` = manual, `plan` =
planning, `yolo` = ask when needed, `auto` = never ask. The ACP mode descriptions
in this version disagree with its engine mapping; the workbench follows the
engine and CLI flag behavior. Thinking controls appear only when ACP advertises
them for the selected model. In API mode the configurable context window
defaults to 131072 tokens; set it to the actual limit of the selected model.
Subscription context limits come from the account's official model metadata.
