# Configuration

[Back to Camellia](../README.md) · [Documentation index](README.md)

Camellia separates the engine that executes a task from the provider that supplies inference. Connections and routing are managed centrally; each engine retains its own history and native options.

## Providers and API keys

Open **Settings → Providers & Keys**.

1. Choose a preset or enter a custom API endpoint.
2. Add keys individually or paste a batch. Give keys recognizable labels.
3. Fetch the provider's model catalog and select the models to expose. Enter models manually when no catalog is available.
4. Save, then validate each key against the models you intend to use.

Presets cover Ollama Cloud, DeepSeek, Kimi / Moonshot, Kimi Code subscriptions, Command Code GOAT, OpenCode Go, and OpenCode Zen. They provide connection defaults; access and quotas depend on the account.

Model discovery and validation are separate operations. Validation sends a short inference request, may incur a charge, and is excluded from business usage statistics.

DSH exposes the pool as the **API route pool** provider. Claude and Kimi model menus read directly from the shared pool.

## Same-model failover

A canonical model ID groups routes serving the same model and version. Each route maps that ID to the provider's upstream model name.

- Keep different versions and variants, such as Pro and Flash, in separate groups. Treat moving aliases such as `latest` separately.
- Providers and keys are tried in configured order. A successful route remains active for subsequent requests.
- Quota exhaustion, rate limits, invalid credentials, and eligible transient errors can trigger another route in the group.
- Rate-limit cooldowns apply to the affected model. Invalid credentials block the key until it is replaced or reset.
- Retry timing respects applicable upstream retry hints.
- Exhausting a group returns an error; it does not select another model.
- Once content has started, the request is not replayed automatically. Interrupted streams are reported as errors.

The router bridges OpenAI Chat Completions and Anthropic Messages for text, images, streaming, and common tool calls. Provider-specific content blocks and tools are not guaranteed to work across protocols.

## Settings pages

| Page | Purpose |
| --- | --- |
| Providers & Keys | Endpoints, credentials, model catalogs, validation, and route order |
| Usage | Request and token filters, trends, detailed records, and CSV export |
| Balances & Quotas | Account balances, subscription windows, reset times, and observed trends |
| Engine Settings | DSH's native panel, and common or advanced Claude/Kimi configuration |
| Runtime | Versions, installation sources, preparation status, and retries |
| General | Theme, automatic balance refresh, application data, and logs |

Common engine options have dedicated controls. Other native options are available through advanced configuration editors.

### Global CLI configuration

Saving engine settings updates global CLI files and can affect other CLI sessions. The settings page displays the actual paths.

| Engine | Managed global files by default |
| --- | --- |
| DSH | `~/.dsh/settings.yaml` |
| Claude | `~/.claude/settings.json`, the `mcpServers` section of `~/.claude.json`, and `~/.claude/CLAUDE.md` |
| Kimi | `~/.kimi-code/config.toml`, `mcp.json`, and `tui.toml` |

Before the first managed overwrite of an existing file, Camellia keeps a sibling `.workbench.bak` backup. Later saves preserve it. Claude MCP edits preserve account fields outside `mcpServers`.

DSH native controls save immediately. Claude and Kimi use **Save engine settings**. Project-level configuration continues to follow each engine's precedence rules.

Engine configurations receive a loopback router URL and placeholder credentials. Real provider keys stay in the central pool. CLI sessions using the managed route require Camellia to remain running. Codex is not currently integrated and its configuration is not managed.

## Usage statistics

Usage records cover business requests passing through the local router, with provider, key, model, and date filters.

- Daily records cover the most recent 90 days; cumulative model totals are retained. CSV export uses the selected filters.
- Successes, failures, and cancellations are recorded separately. Tokens reported by failed attempts remain attributed to the key that incurred them.
- Input tokens include cache reads/writes. Cache-read counts are a subset, not an additional total.
- Missing token counts remain unavailable rather than becoming zero.
- Legacy aggregates are retained without inventing historical model attribution.

Account queries, connection validation, and token-counting requests are not business usage.

## Balances and subscription quotas

Account APIs may include spending from other clients. Their values should not be equated with local request statistics.

| Provider | Information exposed by the account adapter |
| --- | --- |
| DeepSeek | Available balance and returned balance components |
| Kimi / Moonshot | Available balance, cash, and voucher components |
| Kimi Code | Subscription usage windows and reset times |
| OpenCode Go | Subscription usage windows and reset times |
| Command Code / GOAT | Credits and returned subscription, organization, or model limits |
| Ollama Cloud | Returned usage windows and model activity, through an undocumented endpoint |
| OpenCode Zen and custom endpoints | Local usage only; no account-balance adapter currently implemented |

DeepSeek and Moonshot adapters use documented balance APIs. Kimi Code, OpenCode Go, and Command Code adapters are based on official client or service implementations. Apart from a prior read-only Ollama check, account adapters have been tested against response fixtures rather than individually validated with live subscriptions. Endpoint evidence is recorded in the [provider adapter reference](design/provider-balances.md) (Simplified Chinese).

Balances refresh automatically every 15 minutes by default; disable this in General settings if needed. Manual refresh is also available.

Charts retain locally observed values for 30 days, starting when observations are collected. They do not reconstruct earlier history. Multiple keys may share an account, so balances are not summed across cards. Cash, credits, and percentages retain their own units. Failed refreshes preserve the last successful value and its timestamp.

## Workspaces and sessions

The Claude and Kimi sidebar groups pinned sessions, folder workspaces, and standalone conversations. Adding a workspace registers a local folder. Its `+` action creates a session in that folder; the top-level new-session action can start a standalone conversation.

| Operation | Claude Code | Kimi Code |
| --- | --- | --- |
| Workspace and standalone sessions | Supported | Supported |
| Pin, rename, archive, fork, and resume | Supported | Supported |
| Change an existing session's execution directory | Move through the selector or session menu; applies to the next message | Start a new session; ACP retains the execution directory |
| Remove a workspace from the sidebar | Sessions become standalone; files remain | Sessions and their execution directory remain; files remain |

DSH uses its native project model. History is not converted between engines. Permission and reasoning controls reflect the selected engine and model.

## Data locations

The application data directory is `%APPDATA%/dsh-desktop` on Windows and `~/Library/Application Support/dsh-desktop` on macOS. In the table below, `<app-data>` refers to that directory and `~` refers to the user's home directory (`%USERPROFILE%` on Windows).

| Default path | Contents |
| --- | --- |
| `<app-data>` | Application preferences, workspace metadata, observation cache, and logs |
| `~/.dsh` | DSH configuration and history; `ollama-proxy.json` contains the shared route pool, keys, and usage records |
| `~/.claude` | Claude configuration and native history; MCP settings also use `~/.claude.json` |
| `~/.kimi-code` | Centrally managed Kimi global configuration |
| `<app-data>/kimi-code` | Workbench Kimi runtime configuration and native history; `kimi-history` is a sibling display-cache directory |
| `<app-data>/runtimes` | Automatically installed runtimes; source runs prefer the repository's `runtimes/` |

`DSH_HOME`, `CLAUDE_CONFIG_DIR`, and `KIMI_CODE_HOME` can change engine configuration locations. The settings interface shows effective paths.

The `dsh-desktop` data directory and original application identity are retained for compatibility. Existing sessions, settings, and browser data remain available after renaming. Explicit application-data directories are preserved.

Provider keys are stored in local configuration files, not a system credential vault. The UI and status responses mask them. Exclude these files from public repositories and shared diagnostic bundles.

## Troubleshooting

**Runtime installation failed.** Retry in Settings → Runtime or run `npm run setup:runtimes`. Initial installation needs package-registry access. Managed installation does not add global npm packages.

**DSH takes longer to open.** Its web backend initializes plugins and assembles frontend resources before the page is ready. First use can also initialize runtime module links. Later visits in the same application process reuse the backend. Settings → General provides access to startup logs.

**Running the portable build.** Extract the entire ZIP before opening `Camellia.exe`, and keep the extracted files together. Later launches run directly from that folder.

**A catalog model fails to respond.** Validate the key against that model and check its upstream mapping, protocol, account entitlement, and quota. Catalog visibility alone does not guarantee inference access.
