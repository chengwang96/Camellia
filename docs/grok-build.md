# Grok Build integration

Camellia runs the official Grok Build CLI as a native ACP agent over stdin/stdout and supports both subscription and shared API connections.

## Runtime and connections

Install Grok Build from **Settings → Engine Settings → Grok Build**, or use automatic detection for an existing native `grok` executable. Camellia pins `@xai-official/grok` and manages installation, updates, custom paths, and removal. The official postinstall uses an isolated runtime home rather than the personal `~/.grok` directory.

The composer offers two model groups:

- **Subscription**: sign in with Grok OAuth. This consumes the included subscription allowance and any separately enabled additional usage, not xAI API prepaid credits.
- **API**: use a model from Providers & Keys. The shared router can target xAI, another OpenAI-compatible provider, or a local model. Its normal provider billing rules apply.

Each subscription account has an isolated `GROK_HOME`, model catalog, native sessions, and account binding. Existing conversations keep their original connection and account; only new conversations use quota-aware automatic selection.

## Login, models, and quota

Open **Settings → Subscription accounts → Grok account · Grok Build** to start device-code login, add or rename accounts, switch accounts, refresh model metadata, or sign out. Camellia does not read or display OAuth access or refresh tokens. Login and quota output is never written to application logs.

Account cards use the official ACP model and billing extensions. They can show the plan, included usage percentage and reset time, prepaid additional-usage balance, and on-demand availability. Prepaid balance is distinct from the included weekly allowance. A failed refresh preserves the last successful reading and does not sign the account out.

Model metadata includes the default model, context window, supported reasoning efforts, and image capability. Reasoning is applied through Grok's native `reasoning_effort` option. Permission levels map to Grok's `default`, `auto`, and `bypassPermissions` ACP modes; new sessions also receive the matching `autoMode` or `yoloMode` metadata. Plan mode is available where the runtime advertises it.

## Sessions and tools

Grok runs its own agent loop, tools, session persistence, permission requests, and model usage reporting. Camellia maps those events into the shared conversation UI, including text and thinking streams, tools, plans, images, stop, resume, fork, and permission responses. Native session IDs are not transferred between accounts.

Camellia's Goal, scheduled-task, web, file-search, and conversation tools are supplied through the same conversation-scoped MCP bridge as the other ACP engines. Global instructions are passed with Grok's `--rules` option rather than overwriting account files.

Subscription usage statistics are separate from provider balance queries. Any API-equivalent cost shown in Usage is an estimate from reported token metadata, not the actual subscription invoice or remaining balance.

## Remote and discussion behavior

Headless servers expose the same dual connections and account operations. Mobile clients receive only public engine, model, session, and quota metadata; OAuth credentials never enter the remote protocol or data export.

Discussion members can use shared API routes or a verified Grok subscription. Each member uses an isolated home. Camellia copies only the current access credential required for that member and removes it during cleanup; shared refresh credentials are not copied between members. Connection verification is required before native-tools dispatch.

Data export excludes `GROK_HOME` credentials, account state, subscription usage, and account bindings. Portable engine preferences may be exported independently, but subscriptions must be connected again on the destination device.
