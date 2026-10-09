# Documentation

Start with the [English README](../README.md) or [Simplified Chinese README](../README.zh-CN.md). The two READMEs provide the same short product overview; the guides and records below are in English.

## Use Camellia

| Guide | Covers |
| --- | --- |
| [Configuration](configuration.md) | Providers, accounts, same-model routing, benchmarks, settings, usage, and data locations. |
| [Android](../android/README.md) | Native app, local chat, remote pairing, attachments, build, and tests. |
| [Desktop remote access](remote-access.md) | Embedded Tailnet, device approval, protocol, security, and discussion controls. |
| [Linux server preview](linux-server-preview.md) | Headless host, one-terminal pairing, systemd user service, package, and checks. |
| [Linux acceptance record](linux-server-acceptance.md) | Tested artifact and remaining live host acceptance. |
| [Conversation control](conversation-tools.md) | Child conversations and device-wide read-only history tools. |
| [Conversation work panel](conversation-work-panel.md) | Desktop subtasks/artifacts, mobile child pages, active forks, and engine limits. |
| [Scheduled checks](scheduled-tasks.md) | Natural-language scheduling, recovery, and task scope. |
| [File finding](file-find.md) | `/find`, recent files, name/content search, and phone downloads. |
| [Artifact previews](artifact-previews.md) | File cards and desktop preview behavior. |
| [Storage maintenance](storage-maintenance.md) | Manual cleanup and protected data. |
| [Runtime troubleshooting](troubleshooting-runtimes.md) | Engines missing or failing to launch. |
| [Development](development.md) | Code layout, runtime preparation, testing, and packaging. |

## Design and implementation records

These explain current structures and past decisions. Check the guide and current code before using a dated record as a product claim.

| Area | Records |
| --- | --- |
| Shared chat and context | [Shared conversations](design/shared-conversations.md), [native model bindings](design/model-switch-segments.md), [context capacity](design/context-capacity.md). |
| Discussion groups | [Coordinator design](design/group-chat-discussion.md), [implementation and acceptance](design/group-chat-implementation-plan.md), [rich interaction](design/group-chat-rich-interaction-plan.md), [capability and isolation audit](design/group-chat-capabilities.md). |
| Engines and settings | [Unified settings](design/unified-settings.md), [harness integration](design/harness-integration.md), [provider balances](design/provider-balances.md). |
| Server and benchmarks | [Linux CLI design](design/linux-server-cli.md), [benchmark modes](design/benchmark-modes.md). |

## Dated investigations

- [Benchmark audit](benchmark-audit-2026-09-16.md), [built-in basic set](benchmark-basics-2026-09-16.md), [preview timeouts](benchmark-preview-timeouts-2026-09-16.md), [Codex patch retries](benchmark-codex-patch-2026-09-16.md), and [SciCode errors](benchmark-errors-2026-09-16.md).
- [Native harness tool calls](harness-tools-audit-2026-09-16.md) and the [WBL API connectivity record](wbl-api.md).
- [v0.1.0 release note](releases/v0.1.0.md) and [archived planning documents](archive/README.md).

`images/` contains current README screenshots captured from the renderer with local demonstration data. Run `python scripts/capture-readme-screenshots.py` from the repository root with Playwright and Chromium installed to regenerate them. Ignored `images/local/` reference captures are not part of the public documentation.
